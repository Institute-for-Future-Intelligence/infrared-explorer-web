/**
 * Bake-off for the digital-twin scene analysis (docs/digital-twin-plan.md §13): run the same
 * visible-light + thermal frame through each candidate vision model with the shared contract
 * (functions/src/twinScene.ts — prompt, JSON schema, parser) and write a side-by-side report for human
 * scoring: the photo with every model's boxes drawn over it, next to each model's JSON and cost.
 *
 *   npx tsx scripts/evalTwinScene.ts [--ids=exp1,exp2] [--rec=recId,...] [--frame=N|mid]
 *       [--models=gpt56,gemini,gpt52,grok|all] [--limit=10] [--trash] [--context] [--no-ir] [--dry]
 *       [--out=eval-twin]
 *
 *     --ids / --rec   which experiments (by experiment id) or recordings (by recordingId) to analyse.
 *                     Default: discover the newest app-captured recordings that carry vis_N.jpg frames.
 *     --frame         recording-frame index to analyse, or "mid" (default) for the middle frame.
 *     --models        comma list of QA_MODELS keys, or "all" (default: gpt56,gemini).
 *     --limit         at most N recordings when discovering (default 10).
 *     --trash         include trashed experiments when discovering (the July test recordings are trashed).
 *     --context       also tell the model the experiment title/description (default: pixels only, so
 *                     recognition is judged on the image and not on the owner's caption).
 *     --no-ir         send only the visible photo (measures how much the thermal render helps).
 *     --dry           download frames and build the report without calling any model (corpus check).
 *     --out           output root (default ./eval-twin, git-ignored); each run gets a timestamped folder.
 *
 * Reads production Storage/Firestore through ./serviceAccount.json (read-only, like evalReports.ts).
 * Model keys come from functions/.secret.local (OPENAI_API_KEY / GOOGLE_API_KEY / XAI_API_KEY);
 * environment variables of the same names override. Every model call costs real money — a few cents per
 * frame per model; the summary prints token counts so the bill is not a surprise.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH, celsiusAtIndex, decodeFrame } from '../functions/src/thermal';
import {
  TWIN_SCENE_JSON_SCHEMA,
  buildTwinScenePrompt,
  parseTwinScene,
  twinRenderBlocker,
  type TwinFrameStats,
  type TwinScene,
} from '../functions/src/twinScene';

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
const RECS = (arg('rec') ?? '').split(',').filter(Boolean);
const FRAME = arg('frame') ?? 'mid';
const LIMIT = Number(arg('limit') ?? 10);
const INCLUDE_TRASH = flag('trash');
const WITH_CONTEXT = flag('context');
const WITH_IR = !flag('no-ir');
const DRY = flag('dry');
const OUT_ROOT = arg('out') ?? 'eval-twin';

// ---------------------------------------------------------------------------------------------------
// Models — mirrors QA_MODELS / resolveOpenAiProvider in functions/src/index.ts (the OpenAI-compatible
// set; Claude is deliberately not a candidate — plan §0). Colours are for the report overlay.

type ProviderKey = 'openai' | 'google' | 'xai';
const PROVIDERS: Record<ProviderKey, { url: string; keyName: string; maxTokensParam: string; strict: boolean }> = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    keyName: 'OPENAI_API_KEY',
    maxTokensParam: 'max_completion_tokens',
    strict: true,
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyName: 'GOOGLE_API_KEY',
    maxTokensParam: 'max_tokens',
    strict: false,
  },
  xai: {
    url: 'https://api.x.ai/v1/chat/completions',
    keyName: 'XAI_API_KEY',
    maxTokensParam: 'max_tokens',
    strict: false,
  },
};
const MODELS: Record<string, { provider: ProviderKey; model: string; color: string }> = {
  gpt56: { provider: 'openai', model: 'gpt-5.6-luna', color: '#1f77b4' },
  gpt52: { provider: 'openai', model: 'gpt-5.2', color: '#9467bd' },
  gemini: { provider: 'google', model: 'gemini-2.5-pro', color: '#2ca02c' },
  grok: { provider: 'xai', model: 'grok-4.5', color: '#d62728' },
};
const modelsArg = arg('models') ?? 'gpt56,gemini';
const MODEL_KEYS = (modelsArg === 'all' ? Object.keys(MODELS) : modelsArg.split(',')).filter((k) => {
  if (!MODELS[k]) console.warn(`unknown model key "${k}" — skipped (known: ${Object.keys(MODELS).join(', ')})`);
  return !!MODELS[k];
});

// ---------------------------------------------------------------------------------------------------
// Credentials

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
  for (const k of Object.values(PROVIDERS).map((p) => p.keyName)) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}
const SECRETS = loadSecrets();

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa), storageBucket: 'infrared-explorer.appspot.com' });
const db = getFirestore();
const bucket = getStorage().bucket();

// ---------------------------------------------------------------------------------------------------
// Targets

interface Target {
  expId: string;
  recordingId: string;
  title: string;
  description: string;
  palette: string | null;
  trash: boolean;
  frameCount: number; // number of vis_N.jpg frames
}

const recPath = (recordingId: string, name: string) => `recordings/${recordingId}/${name}`;
const exists = async (p: string) => (await bucket.file(p).exists())[0];

async function countVisFrames(recordingId: string): Promise<number> {
  const [files] = await bucket.getFiles({ prefix: recPath(recordingId, 'vis_') });
  return files.length;
}

function targetFromDoc(id: string, e: FirebaseFirestore.DocumentData): Omit<Target, 'frameCount'> | null {
  if (e.sourceType !== 'recording' || !e.recordingId) return null;
  return {
    expId: id,
    recordingId: String(e.recordingId),
    title: String(e.displayName ?? ''),
    description: String(e.description ?? ''),
    palette: e.palette ? String(e.palette) : null,
    trash: !!e.trash,
  };
}

async function discoverTargets(): Promise<Target[]> {
  const found: Omit<Target, 'frameCount'>[] = [];
  if (IDS.length) {
    const snaps = await db.getAll(...IDS.map((id) => db.collection('experiments').doc(id)));
    for (const s of snaps) {
      const t = s.exists ? targetFromDoc(s.id, s.data()!) : null;
      if (t) found.push(t);
      else console.warn(`experiment ${s.id}: not found or not a recording — skipped`);
    }
  } else if (RECS.length) {
    for (const rec of RECS) {
      const snap = await db.collection('experiments').where('recordingId', '==', rec).limit(5).get();
      const live = snap.docs.find((d) => !d.data().trash) ?? snap.docs[0];
      const t = live ? targetFromDoc(live.id, live.data()) : null;
      found.push(t ?? { expId: '', recordingId: rec, title: '', description: '', palette: null, trash: false });
    }
  } else {
    // Newest first; app-captured recordings are the recent ones. The 400 oldest have no vis frames at all.
    const snap = await db.collection('experiments').orderBy('createdAt', 'desc').limit(400).get();
    const seen = new Set<string>();
    for (const d of snap.docs) {
      if (found.length >= LIMIT) break;
      const t = targetFromDoc(d.id, d.data());
      if (!t || seen.has(t.recordingId)) continue;
      if (t.trash && !INCLUDE_TRASH) continue;
      if (!(await exists(recPath(t.recordingId, 'vis_1.jpg')))) continue;
      seen.add(t.recordingId);
      found.push(t);
    }
  }
  const targets: Target[] = [];
  for (const t of found) {
    const frameCount = await countVisFrames(t.recordingId);
    if (frameCount === 0) {
      console.warn(`${t.recordingId}: no vis_N.jpg frames — skipped (legacy recording?)`);
      continue;
    }
    targets.push({ ...t, frameCount });
  }
  return targets;
}

// ---------------------------------------------------------------------------------------------------
// Frames

interface FrameBundle {
  index: number;
  visJpg: Buffer;
  irPng: Buffer | null;
  stats: TwinFrameStats | null;
}

function frameStats(dat: Buffer): TwinFrameStats | null {
  const f = decodeFrame(new Uint8Array(dat));
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < IR_ARRAY_WIDTH * IR_ARRAY_HEIGHT; i++) {
    const c = celsiusAtIndex(f, i);
    if (c < -100) continue; // truncated-frame sentinel
    if (c < min) min = c;
    if (c > max) max = c;
    sum += c;
    n++;
  }
  return n ? { minC: min, maxC: max, meanC: sum / n } : null;
}

async function loadFrame(t: Target): Promise<FrameBundle> {
  let index = FRAME === 'mid' ? Math.max(1, Math.ceil(t.frameCount / 2)) : Math.max(1, Number(FRAME) || 1);
  if (!(await exists(recPath(t.recordingId, `vis_${index}.jpg`)))) {
    console.warn(`${t.recordingId}: vis_${index}.jpg missing → frame 1`);
    index = 1;
  }
  const dl = async (name: string) => (await bucket.file(recPath(t.recordingId, name)).download())[0];
  const [visJpg, irPng, dat] = await Promise.all([
    dl(`vis_${index}.jpg`),
    WITH_IR ? dl(`data_${index}.png`).catch(() => null) : Promise.resolve(null),
    dl(`data_${index}.dat`).catch(() => null),
  ]);
  return { index, visJpg, irPng, stats: dat ? frameStats(dat) : null };
}

// ---------------------------------------------------------------------------------------------------
// Model calls

type ResponseMode = 'json_schema' | 'json_object' | 'text';

interface CallResult {
  text: string;
  mode: ResponseMode;
  latencyMs: number;
  usage: { prompt: number | null; completion: number | null };
  downgrades: string[];
}

async function callModel(
  modelKey: string,
  prompt: { system: string; user: string },
  frame: FrameBundle,
): Promise<CallResult> {
  const { provider, model } = MODELS[modelKey];
  const p = PROVIDERS[provider];
  const apiKey = SECRETS[p.keyName];
  if (!apiKey) throw new Error(`${p.keyName} not set (functions/.secret.local or env)`);

  const content: unknown[] = [{ type: 'text', text: prompt.user }];
  content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.visJpg.toString('base64')}` } });
  if (frame.irPng)
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${frame.irPng.toString('base64')}` } });
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content },
  ];

  const responseFormat = (mode: ResponseMode): Record<string, unknown> => {
    if (mode === 'json_schema')
      return {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'twin_scene', strict: p.strict, schema: TWIN_SCENE_JSON_SCHEMA },
        },
      };
    if (mode === 'json_object') return { response_format: { type: 'json_object' } };
    return {};
  };

  const downgrades: string[] = [];
  const modes: ResponseMode[] = ['json_schema', 'json_object', 'text'];
  for (const mode of modes) {
    const body = { model, [p.maxTokensParam]: 6000, messages, ...responseFormat(mode) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 240_000);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 400);
      // A 4xx that mentions the response format is the endpoint refusing this mode: try the next one.
      if (res.status === 400 && mode !== 'text') {
        downgrades.push(`${mode} rejected (${res.status}): ${errText.replace(/\s+/g, ' ')}`);
        continue;
      }
      throw new Error(`${modelKey} HTTP ${res.status}: ${errText}`);
    }
    const json: any = await res.json();
    const choice = json.choices?.[0];
    const text: string =
      typeof choice?.message?.content === 'string'
        ? choice.message.content
        : JSON.stringify(choice?.message?.content ?? '');
    if (!text.trim() && mode !== 'text') {
      downgrades.push(`${mode} returned empty content (finish_reason=${choice?.finish_reason ?? '?'})`);
      continue;
    }
    return {
      text,
      mode,
      latencyMs,
      usage: { prompt: json.usage?.prompt_tokens ?? null, completion: json.usage?.completion_tokens ?? null },
      downgrades,
    };
  }
  throw new Error(`${modelKey}: every response mode failed — ${downgrades.join(' | ')}`);
}

// ---------------------------------------------------------------------------------------------------
// Results + report

interface Row {
  target: Target;
  frame: number;
  stats: TwinFrameStats | null;
  modelKey: string;
  model: string;
  ok: boolean;
  error?: string;
  mode?: ResponseMode;
  downgrades: string[];
  latencyMs: number;
  usage: { prompt: number | null; completion: number | null };
  parseErrors: string[];
  scene: TwinScene | null;
  blocker: string | null;
  rawText: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const short = (id: string) => id.slice(0, 8);

function overlaySvg(rows: Row[]): string {
  // Rects in a 0..1 viewBox stretched over the image; labels are HTML so they are not stretched with it.
  const rects: string[] = [];
  const labels: string[] = [];
  for (const r of rows) {
    if (!r.scene) continue;
    const color = MODELS[r.modelKey].color;
    r.scene.objects.forEach((o, i) => {
      const { x, y, w, h } = o.bbox;
      rects.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-dasharray="${r.modelKey === rows[0].modelKey ? '' : '6 3'}"/>`,
      );
      rects.push(
        `<line x1="${x}" y1="${o.footprintY}" x2="${x + w}" y2="${o.footprintY}" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
      );
      labels.push(
        `<div class="lbl" style="left:${(x * 100).toFixed(2)}%;top:${(y * 100).toFixed(2)}%;background:${color}">${esc(r.modelKey)}·${i + 1} ${esc(o.kind)} ${(o.confidence * 100).toFixed(0)}%</div>`,
      );
    });
  }
  return `<svg viewBox="0 0 1 1" preserveAspectRatio="none">${rects.join('')}</svg>${labels.join('')}`;
}

function objectsTable(scene: TwinScene): string {
  if (!scene.objects.length) return '<p class="muted">no objects</p>';
  const tr = scene.objects
    .map(
      (o, i) =>
        `<tr><td>${i + 1}</td><td>${esc(o.id)}</td><td><b>${esc(o.kind)}</b><br><span class="muted">${esc(o.label)}</span></td><td>${(o.confidence * 100).toFixed(0)}%</td><td>${esc(o.restingOn)}</td><td>${o.sizeCm.height}×${o.sizeCm.width}</td><td>${esc(o.material)}</td><td>${o.fill.level ? `${(o.fill.level * 100).toFixed(0)}% ${esc(o.fill.content)}` : ''}</td><td>${esc(o.thermal.role)}<br><span class="muted">${esc(o.thermal.note)}</span></td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>#</th><th>id</th><th>kind</th><th>conf</th><th>restingOn</th><th>cm h×w</th><th>material</th><th>fill</th><th>thermal</th></tr></thead><tbody>${tr}</tbody></table>`;
}

function reportHtml(groups: { target: Target; frame: FrameBundle; rows: Row[] }[], runDir: string): string {
  const legend = MODEL_KEYS.map(
    (k) =>
      `<span class="chip" style="border-color:${MODELS[k].color}"><i style="background:${MODELS[k].color}"></i>${k} · ${MODELS[k].model}</span>`,
  ).join(' ');
  const sections = groups
    .map(({ target, frame, rows }) => {
      const vis = `data:image/jpeg;base64,${frame.visJpg.toString('base64')}`;
      const ir = frame.irPng ? `data:image/png;base64,${frame.irPng.toString('base64')}` : null;
      const stats = frame.stats
        ? `min ${frame.stats.minC.toFixed(1)} / max ${frame.stats.maxC.toFixed(1)} / mean ${frame.stats.meanC.toFixed(1)} °C`
        : 'no .dat';
      const cards = rows
        .map((r) => {
          const head = `<h4 style="border-left:6px solid ${MODELS[r.modelKey].color}">${esc(r.modelKey)} <span class="muted">${esc(r.model)}</span></h4>`;
          if (!r.ok) return `<div class="card">${head}<p class="err">${esc(r.error ?? 'failed')}</p></div>`;
          const s = r.scene!;
          const verdict = r.blocker
            ? `<span class="bad">blocked: ${esc(r.blocker)}</span>`
            : `<span class="good">renderable</span>`;
          const meta = `${r.latencyMs} ms · tokens ${r.usage.prompt ?? '?'} in / ${r.usage.completion ?? '?'} out · mode ${r.mode}${r.downgrades.length ? ` (${r.downgrades.length} downgrade)` : ''}`;
          const errs = r.parseErrors.length
            ? `<details><summary>${r.parseErrors.length} parse repairs</summary><ul>${r.parseErrors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>`
            : '';
          const dg = r.downgrades.length
            ? `<details><summary>downgrades</summary><ul>${r.downgrades.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>`
            : '';
          return `<div class="card">${head}<p>${verdict} · confidence ${(s.confidence * 100).toFixed(0)}% · camera ${esc(s.camera.pitch)}/${esc(s.camera.distanceHint)} · support ${esc(s.support.kind)} (far edge y=${s.support.farEdgeY})</p>${s.reason ? `<p class="muted">reason: ${esc(s.reason)}</p>` : ''}<p class="muted">${esc(meta)}</p>${objectsTable(s)}${errs}${dg}<details><summary>raw answer</summary><pre>${esc(r.rawText)}</pre></details></div>`;
        })
        .join('');
      return `<section><h2>${esc(target.title || '(untitled)')} <span class="muted">exp ${esc(target.expId || '—')} · rec ${esc(target.recordingId)} · frame ${frame.index}/${target.frameCount}${target.trash ? ' · TRASHED' : ''}</span></h2><p class="muted">${esc(stats)}${target.palette ? ` · palette ${esc(target.palette)}` : ''}</p><div class="imgs"><div class="wrap"><img src="${vis}" alt="visible">${overlaySvg(rows.filter((r) => r.ok))}</div>${ir ? `<div class="wrap"><img src="${ir}" alt="thermal"></div>` : ''}</div>${cards}</section>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Twin scene bake-off ${esc(path.basename(runDir))}</title><style>
body{font:14px system-ui,sans-serif;margin:0;padding:16px 24px;background:#fafafa;color:#222}
h2{margin:32px 0 4px;font-size:18px}h4{margin:12px 0 6px;padding-left:8px;font-size:15px}
.muted{color:#777;font-weight:normal;font-size:12px}.good{color:#1a7f37;font-weight:600}.bad{color:#b42318;font-weight:600}.err{color:#b42318}
.imgs{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0}.wrap{position:relative;width:min(45vw,540px);aspect-ratio:3/4;background:#000}
.wrap img{position:absolute;inset:0;width:100%;height:100%;object-fit:fill}.wrap svg{position:absolute;inset:0;width:100%;height:100%}
.lbl{position:absolute;transform:translateY(-100%);color:#fff;font-size:11px;padding:1px 4px;border-radius:2px;white-space:nowrap;opacity:.92}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:8px 12px;margin:8px 0}
table{border-collapse:collapse;font-size:12px;width:100%}th,td{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;vertical-align:top}
pre{white-space:pre-wrap;font-size:11px;background:#f4f4f4;padding:8px;border-radius:6px;max-height:320px;overflow:auto}
.chip{display:inline-block;border:2px solid;border-radius:14px;padding:2px 10px;margin:2px 4px 2px 0;font-size:12px}.chip i{display:inline-block;width:10px;height:10px;border-radius:5px;margin-right:6px}
details{margin:6px 0}summary{cursor:pointer;color:#555;font-size:12px}
</style></head><body><h1 style="font-size:20px;margin:0 0 6px">Twin scene bake-off <span class="muted">${esc(path.basename(runDir))}</span></h1>
<p>Solid boxes: first model in the list; dashed: the others. The thin line inside each box is the model's footprintY. ${legend}</p>
<p class="muted">${esc(`models=${MODEL_KEYS.join(',')} frame=${FRAME} context=${WITH_CONTEXT} ir=${WITH_IR} dry=${DRY}`)}</p>${sections}</body></html>`;
}

function summaryMd(rows: Row[]): string {
  const lines = [
    '| recording | frame | model | ok | mode | ms | tok in/out | renderable | blocker | objects | repairs |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const objs = r.scene
      ? r.scene.objects.map((o) => `${o.kind}${o.restingOn !== 'support' ? `→${o.restingOn}` : ''}`).join(', ')
      : '';
    lines.push(
      `| ${short(r.target.recordingId)} ${r.target.title.slice(0, 24)} | ${r.frame} | ${r.modelKey} | ${r.ok ? '✓' : '✗ ' + (r.error ?? '').slice(0, 60)} | ${r.mode ?? ''} | ${r.latencyMs || ''} | ${r.usage.prompt ?? ''}/${r.usage.completion ?? ''} | ${r.scene ? (r.scene.renderable ? 'yes' : 'no') : ''} | ${r.blocker ?? ''} | ${objs} | ${r.parseErrors.length} |`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------

async function main() {
  const targets = await discoverTargets();
  if (!targets.length) {
    console.error('no targets — nothing to do');
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const runDir = path.resolve(OUT_ROOT, stamp);
  mkdirSync(runDir, { recursive: true });
  console.log(`${targets.length} recording(s) · models ${DRY ? '(dry run)' : MODEL_KEYS.join(', ')} · out ${runDir}`);

  const groups: { target: Target; frame: FrameBundle; rows: Row[] }[] = [];
  const allRows: Row[] = [];
  for (const target of targets) {
    const frame = await loadFrame(target);
    const tag = `${short(target.recordingId)}_f${frame.index}`;
    writeFileSync(path.join(runDir, `${tag}_vis.jpg`), frame.visJpg);
    if (frame.irPng) writeFileSync(path.join(runDir, `${tag}_ir.png`), frame.irPng);
    const prompt = buildTwinScenePrompt({
      frameStats: frame.stats,
      palette: target.palette,
      title: WITH_CONTEXT ? target.title : undefined,
      description: WITH_CONTEXT ? target.description : undefined,
      withThermal: !!frame.irPng,
    });
    writeFileSync(path.join(runDir, `${tag}_prompt.txt`), `${prompt.system}\n\n---\n\n${prompt.user}\n`);
    console.log(
      `\n${target.title || '(untitled)'} · ${target.recordingId} · frame ${frame.index}/${target.frameCount}`,
    );

    const rows: Row[] = [];
    if (!DRY) {
      // Models run in parallel per frame — they are independent endpoints, and the report is what waits.
      const results = await Promise.all(
        MODEL_KEYS.map(async (modelKey): Promise<Row> => {
          const base = {
            target,
            frame: frame.index,
            stats: frame.stats,
            modelKey,
            model: MODELS[modelKey].model,
            downgrades: [] as string[],
            latencyMs: 0,
            usage: { prompt: null, completion: null } as Row['usage'],
            parseErrors: [] as string[],
            scene: null as TwinScene | null,
            blocker: null as string | null,
            rawText: '',
          };
          try {
            const call = await callModel(modelKey, prompt, frame);
            const parsed = parseTwinScene(call.text);
            const row: Row = {
              ...base,
              ok: !!parsed.scene,
              error: parsed.scene ? undefined : parsed.errors.join('; '),
              mode: call.mode,
              downgrades: call.downgrades,
              latencyMs: call.latencyMs,
              usage: call.usage,
              parseErrors: parsed.errors,
              scene: parsed.scene,
              blocker: parsed.scene ? twinRenderBlocker(parsed.scene) : null,
              rawText: call.text,
            };
            console.log(
              `  ${modelKey.padEnd(7)} ${String(row.latencyMs).padStart(6)} ms  ${row.ok ? (row.blocker ? `blocked: ${row.blocker}` : `renderable · ${row.scene!.objects.length} objects: ${row.scene!.objects.map((o) => o.kind).join(', ')}`) : `parse failed: ${row.error}`}`,
            );
            return row;
          } catch (e) {
            const msg = (e as Error).message;
            console.log(`  ${modelKey.padEnd(7)} FAILED ${msg.slice(0, 200)}`);
            return { ...base, ok: false, error: msg };
          }
        }),
      );
      rows.push(...results);
    }
    for (const r of rows) {
      writeFileSync(
        path.join(runDir, `${tag}_${r.modelKey}.json`),
        JSON.stringify({ ...r, target: { ...r.target }, rawText: r.rawText }, null, 2),
      );
    }
    groups.push({ target, frame, rows });
    allRows.push(...rows);
  }

  writeFileSync(path.join(runDir, 'report.html'), reportHtml(groups, runDir));
  writeFileSync(path.join(runDir, 'summary.md'), summaryMd(allRows));
  writeFileSync(
    path.join(runDir, 'summary.json'),
    JSON.stringify(
      allRows.map(({ rawText: _raw, ...r }) => r),
      null,
      2,
    ),
  );
  console.log(`\n${summaryMd(allRows)}\n\nreport: ${path.join(runDir, 'report.html')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
