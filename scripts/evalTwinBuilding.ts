/**
 * Regression eval for the photo-set twin (docs/digital-twin-plan.md §32): each candidate model writes the
 * scene program of the same photo sets with the callable's own contract (functions/src/twinBuilding.ts —
 * the photos picked and named as analyzeTwinBuilding picks and names them, its prompt, schema, parser and
 * blocker), and the program is then run in Node with the frame's own API — in a vm context of its own,
 * cut off after 10 s (twinProgramNode.ts runTwinProgram) — to see what the viewer would make of it: the
 * parts it builds, how many meshes, what it has to set down and which roofs leave walls bare (§29). With
 * --landmarks each thermal photo's landmark call is made too and its camera fitted (twinCamera.ts), as
 * phase 2 does. Nothing is written to Firestore: the prompts, the answers and a summary go to a run folder,
 * every answer in the fixture format (functions/src/__fixtures__/twinBuilding), so a run can be replayed
 * offline — against the parser and the API as they are then — or kept as a fixture.
 *
 *   npx tsx scripts/evalTwinBuilding.ts [--ids=exp1,exp2] [--models=deepseek,gpt56|all] [--limit=5] [--trash]
 *       [--instructions="…"] [--landmarks] [--dry] [--replay=<file|folder>] [--keep] [--timeout=360]
 *       [--out=eval-twin]
 *
 *     --ids           photo-set experiments to build (default: the newest photo sets).
 *     --models        comma list of model keys, or "all" (default: deepseek, the callable's default).
 *     --limit         at most N sets when discovering (default 5).
 *     --trash         include trashed experiments when discovering.
 *     --instructions  the owner's request, quoted to every model as the build form sends it.
 *     --landmarks     also place each thermal photo's landmarks and fit its camera (one more call a photo).
 *     --dry           read the sets and write the prompts; call no model.
 *     --replay        no network at all: analyse answers saved by an earlier run — a run folder, one saved
 *                     answer, or the fixtures folder — with the parser and the frame's API as they are now.
 *     --keep          copy each answer that parsed, was not blocked, built without an error and left no
 *                     promise rejected into functions/src/__fixtures__/twinBuilding, as
 *                     <set>-<model>-<day>-<hash>.json (its tests then run it on every change).
 *     --timeout       seconds each model call may take (default 360, the Function's whole budget).
 *     --out           output root (default ./eval-twin, git-ignored); each run gets a timestamped folder.
 *
 * Reads production Storage/Firestore through ./serviceAccount.json (read-only, like evalTwinScene.ts).
 * Model keys come from functions/.secret.local (OPENAI_API_KEY / GOOGLE_API_KEY / XAI_API_KEY /
 * DEEPSEEK_API_KEY); environment variables of the same names override. Every model call costs real money —
 * a scene program is tens of thousands of tokens on DeepSeek, which reasons first; the summary prints the
 * token counts. The calls are not streamed (the callable streams them to show progress; the answer is the
 * same).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodeFrame } from '../functions/src/thermal';
import {
  FLIR_VFOV_DEG,
  TWIN_BUILDING_JSON_SCHEMA,
  buildTwinBuildingPrompt,
  describeViewpoint,
  imageSize,
  parseTwinBuildingCode,
  pickTwinPhotos,
  pictureLabel,
  readBuildInstructions,
  twinBuildingBlocker,
  type TwinBuildingCode,
} from '../functions/src/twinBuilding';
import {
  TWIN_LANDMARK_JSON_SCHEMA,
  buildTwinLandmarkPrompt,
  fitPhotoCamera,
  parseTwinLandmarks,
} from '../functions/src/twinCamera';
import { normalizePhotoOrder } from '../functions/src/photoSet';
import { runTwinProgram, type TwinProgramRun } from '../src/pages/experimentAnalyzer/twin/twinProgramNode';
import { describeSettled, readSettled } from '../src/pages/experimentAnalyzer/twin/twinFrameGeometry';

// ---------------------------------------------------------------------------------------------------
// CLI

const arg = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const IDS = (arg('ids') ?? '').split(',').filter(Boolean);
const LIMIT = Number(arg('limit') ?? 5);
const INCLUDE_TRASH = flag('trash');
// The request as the callable takes it (readBuildInstructions: tidied, capped).
const asked = readBuildInstructions(arg('instructions'));
if ('error' in asked) throw new Error(`--instructions: ${asked.error}`);
const INSTRUCTIONS = asked.instructions ?? undefined;
const LANDMARKS = flag('landmarks');
const DRY = flag('dry');
const REPLAY = arg('replay');
const KEEP = flag('keep');
const TIMEOUT_MS = Number(arg('timeout') ?? 360) * 1000;
const OUT_ROOT = arg('out') ?? 'eval-twin';
const FIXTURES = path.resolve('functions/src/__fixtures__/twinBuilding');

// ---------------------------------------------------------------------------------------------------
// Models — mirror resolveOpenAiProvider, QA_MODELS, TWIN_BUILDING_MAX_TOKENS and TWIN_TRACE_MAX_TOKENS in
// functions/src/index.ts: keep them in step, or the eval measures another call than the app makes.

type ProviderKey = 'openai' | 'google' | 'xai' | 'deepseek';
interface Provider {
  url: string;
  keyName: string;
  maxTokensParam: string;
  /** Whether the endpoint honours response_format json_schema; without it the prompt spells the shape out. */
  jsonSchema: boolean;
  /** Whether an image part may carry OpenAI's `detail`. */
  imageDetail: boolean;
  /** twinExtras: DeepSeek Flash answers a scene program in about a minute at low effort, and nothing at high. */
  extras: Record<string, unknown>;
  /** The phase-1 answer's cap and the tracing calls' — reasoning counts inside both. */
  buildTokens: number;
  traceTokens: number;
}
const PROVIDERS: Record<ProviderKey, Provider> = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    keyName: 'OPENAI_API_KEY',
    maxTokensParam: 'max_completion_tokens',
    jsonSchema: true,
    imageDetail: true,
    extras: {},
    buildTokens: 40000,
    traceTokens: 6000,
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyName: 'GOOGLE_API_KEY',
    maxTokensParam: 'max_tokens',
    jsonSchema: true,
    imageDetail: false,
    extras: {},
    buildTokens: 60000,
    traceTokens: 16000,
  },
  xai: {
    url: 'https://api.x.ai/v1/chat/completions',
    keyName: 'XAI_API_KEY',
    maxTokensParam: 'max_tokens',
    jsonSchema: true,
    imageDetail: false,
    extras: {},
    buildTokens: 60000,
    traceTokens: 16000,
  },
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    keyName: 'DEEPSEEK_API_KEY',
    maxTokensParam: 'max_tokens',
    jsonSchema: false,
    imageDetail: false,
    extras: { reasoning_effort: 'low' },
    buildTokens: 60000,
    traceTokens: 40000,
  },
};
const MODELS: Record<string, { provider: ProviderKey; model: string }> = {
  deepseek: { provider: 'deepseek', model: 'deepseek-flash' },
  gpt56: { provider: 'openai', model: 'gpt-5.6-luna' },
  gpt52: { provider: 'openai', model: 'gpt-5.2' },
  gemini: { provider: 'google', model: 'gemini-2.5-pro' },
  grok: { provider: 'xai', model: 'grok-4.5' },
};
const modelsArg = arg('models') ?? 'deepseek';
const MODEL_KEYS = (modelsArg === 'all' ? Object.keys(MODELS) : modelsArg.split(',')).filter((k) => {
  if (!MODELS[k]) console.warn(`unknown model key "${k}" — skipped (known: ${Object.keys(MODELS).join(', ')})`);
  return !!MODELS[k];
});

function loadSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = path.resolve('functions/.secret.local');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  }
  for (const k of Object.values(PROVIDERS).map((pr) => pr.keyName)) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

// ---------------------------------------------------------------------------------------------------
// What a run saves of each answer — the fixture format (functions/src/__fixtures__/twinBuilding): the
// photos as the model was shown them (stored number, place on the strip, size) and its answer, raw.

interface SavedPhoto {
  photo: number;
  place?: number;
  width: number;
  height: number;
  thermal?: boolean;
}
interface SavedAnswer {
  about: string;
  source: 'photos';
  expId?: string;
  title?: string;
  modelKey: string;
  model: string;
  at?: string;
  photos: SavedPhoto[];
  instructions?: string;
  text: string;
  finishReason?: string | null;
  mode?: string;
  latencyMs?: number;
  usage?: { prompt: number | null; completion: number | null };
  /** The landmark answer of each thermal photo, by stored number (--landmarks). */
  landmarks?: Record<string, { text: string; finishReason?: string | null; latencyMs?: number } | { error: string }>;
}

const isSaved = (v: unknown): v is SavedAnswer =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as SavedAnswer).text === 'string' &&
  Array.isArray((v as SavedAnswer).photos) &&
  typeof (v as SavedAnswer).modelKey === 'string';

// ---------------------------------------------------------------------------------------------------
// Model calls — callModelForTwinScene's ladder, unstreamed: json_schema, then json_object, then plain
// text; a rung the endpoint refuses (HTTP 400) or answers empty steps down.

type Image = { data: Buffer; mediaType: string; detail?: 'low' | 'high' };
interface CallResult {
  text: string;
  mode: string;
  finishReason: string | null;
  latencyMs: number;
  usage: { prompt: number | null; completion: number | null };
}

async function callModel(
  secrets: Record<string, string>,
  modelKey: string,
  prompt: { system: string; user: string },
  images: Image[],
  format: { name: string; schema: unknown; maxTokens: number },
): Promise<CallResult> {
  const { provider, model } = MODELS[modelKey];
  const p = PROVIDERS[provider];
  const apiKey = secrets[p.keyName];
  if (!apiKey) throw new Error(`${p.keyName} not set (functions/.secret.local or env)`);
  const content: unknown[] = [{ type: 'text', text: prompt.user }];
  for (const img of images)
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${img.mediaType};base64,${img.data.toString('base64')}`,
        ...(img.detail && p.imageDetail ? { detail: img.detail } : {}),
      },
    });
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content },
  ];
  const responseFormat = (mode: string): Record<string, unknown> =>
    mode === 'json_schema'
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: format.name, strict: provider === 'openai', schema: format.schema },
          },
        }
      : mode === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : {};
  const failures: string[] = [];
  for (const mode of p.jsonSchema ? ['json_schema', 'json_object', 'text'] : ['json_object', 'text']) {
    const started = Date.now();
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        [p.maxTokensParam]: format.maxTokens,
        messages,
        ...p.extras,
        ...responseFormat(mode),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
      if (res.status === 400 && mode !== 'text') {
        failures.push(`${mode}: ${errText}`);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content;
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    const finishReason = json.choices?.[0]?.finish_reason ?? null;
    if (!text.trim()) {
      failures.push(`${mode}: empty answer (${finishReason ?? '?'})`);
      continue;
    }
    return {
      text,
      mode,
      finishReason,
      latencyMs: Date.now() - started,
      usage: { prompt: json.usage?.prompt_tokens ?? null, completion: json.usage?.completion_tokens ?? null },
    };
  }
  throw new Error(`no usable answer: ${failures.join(' | ')}`);
}

/** Run `fn` over `items`, at most `width` at a time, results in input order. */
async function pool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The sets, read as analyzeTwinBuilding reads them (loadTwinPhotoAssets): a thermal photo's picture is its
// visible photo, else its render; a picture-only photo is its data_N.png.

interface LoadedPhoto extends SavedPhoto {
  place: number;
  thermal: boolean;
  picture: Image;
  vis: Image | null;
  render: Image | null;
  /** The FLIR One's 3:4 frame and a data_N.dat: phase 2 would trace it. */
  traceable: boolean;
}
interface SetTarget {
  expId: string;
  title: string;
  description: string;
  photos: LoadedPhoto[];
}

function mediaTypeOf(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}
const asImage = (buf: Buffer | null): Image | null => {
  const mediaType = buf ? mediaTypeOf(buf) : null;
  return buf && mediaType ? { data: buf, mediaType } : null;
};

async function loadTargets(): Promise<SetTarget[]> {
  const { cert, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getStorage } = await import('firebase-admin/storage');
  const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
  initializeApp({ credential: cert(sa), storageBucket: 'infrared-explorer.appspot.com' });
  const db = getFirestore();
  const bucket = getStorage().bucket();
  const download = async (p: string): Promise<Buffer | null> => {
    try {
      return (await bucket.file(p).download())[0];
    } catch {
      return null;
    }
  };

  const docs: { id: string; data: FirebaseFirestore.DocumentData }[] = [];
  if (IDS.length) {
    const snaps = await db.getAll(...IDS.map((id) => db.collection('experiments').doc(id)));
    for (const s of snaps) {
      const e = s.data();
      if (e?.sourceType === 'photos' && e.recordingId) docs.push({ id: s.id, data: e });
      else console.warn(`experiment ${s.id}: not found or not a photo set — skipped`);
    }
  } else {
    const snap = await db.collection('experiments').orderBy('createdAt', 'desc').limit(400).get();
    for (const d of snap.docs) {
      if (docs.length >= LIMIT) break;
      const e = d.data();
      if (e.sourceType !== 'photos' || !e.recordingId || !(Number(e.photoCount) >= 1)) continue;
      if (e.trash && !INCLUDE_TRASH) continue;
      docs.push({ id: d.id, data: e });
    }
  }

  const targets: SetTarget[] = [];
  for (const { id, data: e } of docs) {
    const count = Math.floor(Number(e.photoCount) || 0);
    const flags = Array.isArray(e.photoThermal) ? (e.photoThermal as unknown[]) : null;
    const order = normalizePhotoOrder(e.photoOrder, count);
    const placeOf = new Map(order.map((slot, i) => [slot + 1, i + 1]));
    const prefix = `recordings/${e.recordingId}`;
    const photos: LoadedPhoto[] = [];
    for (const k of pickTwinPhotos(count, undefined, order)) {
      const thermal = !flags || flags[k - 1] !== false;
      const [png, vis, dat] = await Promise.all([
        download(`${prefix}/data_${k}.png`),
        thermal ? download(`${prefix}/vis_${k}.jpg`) : Promise.resolve(null),
        thermal ? download(`${prefix}/data_${k}.dat`) : Promise.resolve(null),
      ]);
      // Phase 2 traces a photo whose thermal frame decodes whole (loadTwinPhotoAssets), in the camera's shape.
      let frameReads = false;
      try {
        frameReads = !!dat && decodeFrame(new Uint8Array(dat)).complete;
      } catch {
        frameReads = false;
      }
      const render = asImage(png);
      const visible = asImage(vis);
      const picture = visible ?? render;
      const size = picture ? imageSize(picture.data) : null;
      if (!picture || !size) {
        console.warn(`${id} photo ${k}: nothing readable — left out, as the callable leaves it out`);
        continue;
      }
      photos.push({
        photo: k,
        place: placeOf.get(k) ?? k,
        width: size.width,
        height: size.height,
        thermal,
        picture,
        vis: visible,
        render: visible ? render : null,
        traceable: thermal && frameReads && Math.abs(size.width / size.height - 0.75) <= 0.02,
      });
    }
    if (photos.length)
      targets.push({ expId: id, title: String(e.displayName ?? ''), description: String(e.description ?? ''), photos });
  }
  return targets;
}

// ---------------------------------------------------------------------------------------------------
// What an answer comes to: parsed and gated as the callable does, run as the frame runs it, and — with its
// landmark answers — each photo's camera fitted as phase 2 fits it.

interface CameraRow {
  photo: number;
  landmarks: number;
  inliers: number;
  rmsPct: number | null;
  ok: boolean;
  reason: string | null;
}
interface Row {
  set: string;
  title: string;
  modelKey: string;
  ok: boolean;
  error: string | null;
  seconds: number | null;
  tokens: string;
  finishReason: string | null;
  repairs: string[];
  blocker: string | null;
  confidence: number | null;
  subjectKind: string | null;
  views: number;
  photos: number;
  declared: number;
  unbuilt: string[];
  meshes: number;
  unnamedMeshes: number;
  programError: string | null;
  stoppedAt: string | null;
  moved: number;
  maxMoveM: number;
  bareRoofs: number;
  worstBareM: number;
  settledSays: string | null;
  cameras: CameraRow[] | null;
  keepable: boolean;
}

function fitCameras(saved: SavedAnswer, answer: TwinBuildingCode): CameraRow[] | null {
  if (!saved.landmarks) return null;
  const rows: CameraRow[] = [];
  for (const [key, got] of Object.entries(saved.landmarks)) {
    const photo = Number(key);
    const shot = saved.photos.find((p) => p.photo === photo);
    if (!shot) continue;
    if ('error' in got) {
      rows.push({ photo, landmarks: 0, inliers: 0, rmsPct: null, ok: false, reason: `call failed: ${got.error}` });
      continue;
    }
    const { landmarks, errors } = parseTwinLandmarks(got.text, answer.parts, shot.width, shot.height);
    const view = answer.views.find((v) => v.photo === photo);
    if (!view) {
      rows.push({ photo, landmarks: landmarks.length, inliers: 0, rmsPct: null, ok: false, reason: 'no view' });
      continue;
    }
    if (!landmarks.length) {
      rows.push({ photo, landmarks: 0, inliers: 0, rmsPct: null, ok: false, reason: errors[0] ?? 'no landmarks' });
      continue;
    }
    const fit = fitPhotoCamera(
      landmarks,
      shot.width / shot.height,
      { position: [view.x, view.y, view.z], target: [view.targetX, view.targetY, view.targetZ] },
      { fovV: FLIR_VFOV_DEG },
    );
    rows.push({
      photo,
      landmarks: landmarks.length,
      inliers: fit.agreeing,
      rmsPct: fit.rms === null ? null : Math.round(fit.rms * 1000) / 10,
      ok: !!fit.camera,
      reason: fit.reason ?? null,
    });
  }
  return rows;
}

/** Promises a program left rejected in its context, counted as the process reports them. Left alone, one
 *  would end the run; kept as a fixture, it would fail the test file that runs it. */
let rejections = 0;
process.on('unhandledRejection', (e) => {
  rejections++;
  console.warn('a program left a promise rejected:', e);
});
/** One program at a time, each followed by a turn of the event loop, so a promise one leaves rejected is
 *  counted against it and not against the next. */
let programLane: Promise<unknown> = Promise.resolve();
function runProgram(code: string, declared: string[]): Promise<{ run: TwinProgramRun; rejected: boolean }> {
  const next = programLane.then(async () => {
    const before = rejections;
    const run = runTwinProgram(code, declared);
    await new Promise((resolve) => setImmediate(resolve));
    return { run, rejected: rejections > before };
  });
  programLane = next.catch(() => undefined);
  return next;
}

async function analyse(saved: SavedAnswer, set: string): Promise<Row> {
  const base: Row = {
    set,
    title: saved.title ?? '',
    modelKey: saved.modelKey,
    ok: false,
    error: null,
    seconds: saved.latencyMs ? Math.round(saved.latencyMs / 1000) : null,
    tokens: saved.usage ? `${saved.usage.prompt ?? '?'}/${saved.usage.completion ?? '?'}` : '',
    finishReason: saved.finishReason ?? null,
    repairs: [],
    blocker: null,
    confidence: null,
    subjectKind: null,
    views: 0,
    photos: saved.photos.length,
    declared: 0,
    unbuilt: [],
    meshes: 0,
    unnamedMeshes: 0,
    programError: null,
    stoppedAt: null,
    moved: 0,
    maxMoveM: 0,
    bareRoofs: 0,
    worstBareM: 0,
    settledSays: null,
    cameras: null,
    keepable: false,
  };
  const places = saved.photos.every((p) => typeof p.place === 'number')
    ? saved.photos.map((p) => p.place as number)
    : undefined;
  const parsed = parseTwinBuildingCode(
    saved.text,
    saved.photos.map((p) => p.photo),
    places,
  );
  if (!parsed.answer) return { ...base, error: `unreadable: ${parsed.errors.join('; ')}`, repairs: parsed.errors };
  const answer = parsed.answer;
  const { run, rejected } = await runProgram(
    answer.code,
    answer.parts.map((p) => p.name),
  );
  const settled = readSettled(run.settled);
  const blocker = twinBuildingBlocker(answer);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    ...base,
    ok: true,
    repairs: parsed.errors,
    blocker,
    confidence: answer.confidence,
    subjectKind: answer.subjectKind,
    views: answer.views.length,
    declared: answer.parts.length,
    unbuilt: answer.parts.map((p) => p.name).filter((n) => !run.parts.some((b) => b.name === n)),
    meshes: run.meshes,
    unnamedMeshes: run.parts.find((p) => p.name === 'unnamed')?.meshes ?? 0,
    programError: run.error ?? (rejected ? 'left a promise rejected' : null),
    stoppedAt: run.stoppedAt,
    moved: settled?.moved.length ?? 0,
    maxMoveM: round2(Math.max(0, ...(settled?.moved ?? []).map((m) => Math.hypot(m.dx, m.dy, m.dz)))),
    bareRoofs: settled?.uncovered.length ?? 0,
    worstBareM: round2(Math.max(0, ...(settled?.uncovered ?? []).flatMap((u) => Object.values(u.sides)))),
    settledSays: describeSettled(settled),
    cameras: fitCameras(saved, answer),
    keepable: !blocker && !run.error && !rejected,
  };
}

// ---------------------------------------------------------------------------------------------------
// Report

const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ');
function summaryMd(rows: Row[]): string {
  const lines = [
    '| set | model | ok | s | tokens in/out | end | repairs | blocker | conf | views | parts (unbuilt) | meshes (unnamed) | program | set down (max m) | bare roofs (worst m) | cameras |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const cams = r.cameras
      ? `${r.cameras.filter((c) => c.ok).length}/${r.cameras.length} (${r.cameras
          .map((c) => (c.ok ? `${c.photo}: ${c.inliers}/${c.landmarks} ${c.rmsPct}%` : `${c.photo}: ${c.reason}`))
          .join('; ')})`
      : '';
    lines.push(
      `| ${cell(`${r.set} ${r.title.slice(0, 24)}`)} | ${r.modelKey} | ${r.ok ? '✓' : `✗ ${cell((r.error ?? '').slice(0, 80))}`} | ${r.seconds ?? ''} | ${r.tokens} | ${r.finishReason ?? ''} | ${r.repairs.length || ''} | ${cell(r.blocker ?? '')} | ${r.confidence ?? ''} | ${r.ok ? `${r.views}/${r.photos}` : ''} | ${r.ok ? `${r.declared}${r.unbuilt.length ? ` (${cell(r.unbuilt.join(', '))})` : ''}` : ''} | ${r.ok ? `${r.meshes}${r.unnamedMeshes ? ` (${r.unnamedMeshes})` : ''}` : ''} | ${cell(r.programError ?? (r.stoppedAt ? `stopped: ${r.stoppedAt}` : r.ok ? 'ran' : ''))} | ${r.moved ? `${r.moved} (${r.maxMoveM})` : ''} | ${r.bareRoofs ? `${r.bareRoofs} (${r.worstBareM})` : ''} | ${cell(cams)} |`,
    );
  }
  return lines.join('\n');
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);

/** An answer of the run, with what came of it; `source` is the file a replayed one was read from. */
interface Entry {
  tag: string;
  answer: SavedAnswer;
  row: Row;
  source?: string;
}

/** Where a kept answer goes: its set, its model, its day and a hash of its text — two answers of one set
 *  by one model are two fixtures, and the same answer kept twice is one. */
const fixtureName = ({ tag, answer }: Entry) =>
  `${tag}-${answer.modelKey}-${answer.at ?? 'undated'}-${createHash('sha1').update(answer.text).digest('hex').slice(0, 6)}.json`;

function writeRun(runDir: string, entries: Entry[]) {
  const rows = entries.map((e) => e.row);
  writeFileSync(path.join(runDir, 'summary.md'), summaryMd(rows) + '\n');
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(rows, null, 2));
  for (const r of rows) {
    const repairs = r.repairs.length ? `\n  repairs: ${r.repairs.join(' · ')}` : '';
    console.log(
      `${r.set} · ${r.modelKey}: ${r.ok ? `${r.meshes} meshes, ${r.declared} parts${r.blocker ? `, blocked: ${r.blocker}` : ''}${r.programError ? `, ${r.programError}` : ''}${r.settledSays ? `\n  ${r.settledSays}` : ''}` : r.error}${repairs}`,
    );
  }
  if (KEEP) {
    mkdirSync(FIXTURES, { recursive: true });
    for (const entry of entries) {
      const { tag, answer, row, source } = entry;
      if (source && path.resolve(path.dirname(source)) === FIXTURES) continue; // a fixture already
      if (!answer.text || !row.keepable) {
        console.log(`not kept: ${tag}_${answer.modelKey} (${row.error ?? row.blocker ?? row.programError})`);
        continue;
      }
      const to = path.join(FIXTURES, fixtureName(entry));
      try {
        writeFileSync(to, JSON.stringify(answer, null, 2) + '\n', { flag: 'wx' });
        console.log(`kept as ${path.relative(process.cwd(), to)}`);
      } catch (e) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e;
        console.log(`already kept: ${path.relative(process.cwd(), to)}`);
      }
    }
  }
  console.log(`\n${summaryMd(rows)}\n\nrun: ${runDir}`);
}

// ---------------------------------------------------------------------------------------------------

function readReplay(target: string): { tag: string; answer: SavedAnswer; source: string }[] {
  const files = statSync(target).isDirectory()
    ? readdirSync(target)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(target, f))
    : [target];
  const out: { tag: string; answer: SavedAnswer; source: string }[] = [];
  for (const f of files) {
    const v = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    if (!isSaved(v)) continue;
    out.push({ tag: v.expId ? slug(v.expId) : path.basename(f, '.json'), answer: v, source: f });
  }
  return out;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const runDir = path.resolve(OUT_ROOT, `building-${stamp}`);
  mkdirSync(runDir, { recursive: true });

  if (REPLAY) {
    const saved = readReplay(path.resolve(REPLAY));
    if (!saved.length) throw new Error(`no saved answers in ${REPLAY}`);
    console.log(`replaying ${saved.length} answer(s) from ${REPLAY} · out ${runDir}\n`);
    const entries: Entry[] = [];
    for (const s of saved) entries.push({ ...s, row: await analyse(s.answer, s.tag) });
    writeRun(runDir, entries);
    return;
  }

  const secrets = loadSecrets();
  const targets = await loadTargets();
  if (!targets.length) throw new Error('no photo sets — nothing to do');
  console.log(`${targets.length} photo set(s) · models ${DRY ? '(dry run)' : MODEL_KEYS.join(', ')} · out ${runDir}\n`);
  const entries: Entry[] = [];
  for (const target of targets) {
    const tag = slug(target.expId);
    const photos: SavedPhoto[] = target.photos.map(({ photo, place, width, height, thermal }) => ({
      photo,
      place,
      width,
      height,
      thermal,
    }));
    const promptFor = (shapeInPrompt: boolean) =>
      buildTwinBuildingPrompt({
        photos: target.photos.map(({ photo, width, height, place }) => ({ photo, width, height, place })),
        title: target.title || undefined,
        description: target.description || undefined,
        source: 'photos',
        shapeInPrompt,
        ...(INSTRUCTIONS ? { instructions: INSTRUCTIONS } : {}),
      });
    for (const [name, prompt] of [
      ['schema', promptFor(false)],
      ['spelled', promptFor(true)],
    ] as const)
      writeFileSync(path.join(runDir, `${tag}_prompt_${name}.txt`), `${prompt.system}\n\n---\n\n${prompt.user}\n`);
    console.log(
      `${target.title || '(untitled)'} · ${target.expId} · photos ${target.photos.map((p) => `${p.photo}@${p.place}${p.thermal ? '' : ' (picture only)'}`).join(', ')}`,
    );
    if (DRY) continue;

    // The models run side by side: independent endpoints, and the report is what waits.
    await Promise.all(
      MODEL_KEYS.map(async (modelKey) => {
        const provider = PROVIDERS[MODELS[modelKey].provider];
        const answer: SavedAnswer = {
          about: `Photo set "${target.title}" (${target.photos.length} photos), the phase-1 answer of ${MODELS[modelKey].model}, from scripts/evalTwinBuilding.ts.`,
          source: 'photos',
          expId: target.expId,
          title: target.title,
          modelKey,
          model: MODELS[modelKey].model,
          at: new Date().toISOString().slice(0, 10),
          photos,
          ...(INSTRUCTIONS ? { instructions: INSTRUCTIONS } : {}),
          text: '',
        };
        try {
          const call = await callModel(
            secrets,
            modelKey,
            promptFor(!provider.jsonSchema),
            target.photos.map((p) => p.picture),
            { name: 'twin_building', schema: TWIN_BUILDING_JSON_SCHEMA, maxTokens: provider.buildTokens },
          );
          Object.assign(answer, {
            text: call.text,
            finishReason: call.finishReason,
            mode: call.mode,
            latencyMs: call.latencyMs,
            usage: call.usage,
          });
        } catch (e) {
          const row = await analyse({ ...answer, text: '' }, tag);
          entries.push({ tag, answer, row: { ...row, error: `call failed: ${(e as Error).message.slice(0, 300)}` } });
          return;
        }
        if (LANDMARKS) {
          const parsed = parseTwinBuildingCode(
            answer.text,
            photos.map((p) => p.photo),
            photos.map((p) => p.place as number),
          ).answer;
          // Phase 2 runs on a model that is shown and declares parts (analyzeTwinBuilding).
          if (parsed && !twinBuildingBlocker(parsed) && parsed.parts.length) {
            // Phase 2's landmark call for every photo it would trace that has a view, four at a time.
            const traced = target.photos.filter((p) => p.traceable && parsed.views.some((v) => v.photo === p.photo));
            const results = await pool(traced, 4, async (p) => {
              const ordinal = target.photos.indexOf(p) + 1;
              const picture: 'vis' | 'render' = p.vis ? 'vis' : 'render';
              const withRender = picture === 'vis' && !!p.render;
              const prompt = buildTwinLandmarkPrompt({
                subject: parsed.subject || parsed.name,
                subjectKind: parsed.subjectKind,
                parts: parsed.parts,
                code: parsed.code,
                photo: ordinal,
                label: pictureLabel(ordinal, p.place, 'photos'),
                width: p.width,
                height: p.height,
                viewpoint: describeViewpoint(parsed.views.find((v) => v.photo === p.photo)),
                picture,
                withRender,
              });
              const images: Image[] =
                picture === 'vis'
                  ? [{ ...p.vis!, detail: 'high' }, ...(withRender ? [{ ...p.render!, detail: 'low' as const }] : [])]
                  : [{ ...p.picture, detail: 'high' }];
              try {
                const call = await callModel(secrets, modelKey, prompt, images, {
                  name: 'twin_landmarks',
                  schema: TWIN_LANDMARK_JSON_SCHEMA,
                  maxTokens: provider.traceTokens,
                });
                return [
                  String(p.photo),
                  { text: call.text, finishReason: call.finishReason, latencyMs: call.latencyMs },
                ] as const;
              } catch (e) {
                return [String(p.photo), { error: (e as Error).message.slice(0, 300) }] as const;
              }
            });
            answer.landmarks = Object.fromEntries(results);
          }
        }
        writeFileSync(path.join(runDir, `${tag}_${modelKey}.json`), JSON.stringify(answer, null, 2) + '\n');
        const row = await analyse(answer, tag);
        const code = parseTwinBuildingCode(
          answer.text,
          photos.map((p) => p.photo),
        ).answer?.code;
        if (code) writeFileSync(path.join(runDir, `${tag}_${modelKey}_program.js`), code + '\n');
        entries.push({ tag, answer, row });
      }),
    );
  }
  if (DRY) {
    console.log(`\nprompts: ${runDir}`);
    return;
  }
  entries.sort((a, b) =>
    a.tag === b.tag ? a.answer.modelKey.localeCompare(b.answer.modelKey) : a.tag.localeCompare(b.tag),
  );
  writeRun(runDir, entries);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
