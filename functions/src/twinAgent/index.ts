/**
 * The digital twin's agent build (docs/digital-twin-plan.md §43.5): the recording AI's conversation
 * loop (recordingAi/turn.ts) run with the twin agent's tools and prompt. The model measures the
 * recording with the browser's look and run_code, builds a scene with build_scene (the browser runs
 * the program in the twin viewer and scores it against the thermal frame), and ends with finish, the
 * one server tool here, which writes the scene as the experiment's twin — through a fixed camera
 * straight above the bench, so the viewer paints it with any frame the player shows (§43.3).
 *
 * One conversation per user and recording (experiments/{expId}/twinAgent/{uid}); a new build clears it
 * (input.kind 'message' with `fresh`). Owner and staff only, as the twin builder is. Rate-limited as a
 * report run: the first message is charged, the browser's tool results and a resume are not.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, type DocumentData } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { requireAiAccess, type AiRateSlot, type AiTier } from '../aiAccess';
import { DEFAULT_MODEL_KEY, QA_MODELS, offeredModelKey, type QaModelKey } from '../aiModels';
import { CHAT_SECRETS } from '../aiSecrets';
import type { ChatModelSpec } from '../labCore/config';
import {
  acquireLock,
  deleteConvo,
  emptyConvo,
  loadConvo,
  newId,
  releaseLock,
  twinConvo,
  updateConvo,
} from '../recordingAi/store';
import type { ServerToolContext, ToolOutcome } from '../recordingAi/tools';
import { isChargedInput, parseInput, runTurn, type TurnOutcome, type TurnToolset } from '../recordingAi/turn';
import { celsiusAtIndex, decodeFrame } from '../thermal';
import { FLIR_VFOV_DEG, TWIN_BUILDING_VERSION, TWIN_PART_KINDS } from '../twinBuilding';
import { TWIN_AGENT_MAX_BUILDS, twinAgentPrompt } from './prompt';
import { TWIN_PHONE_TOOLS, TWIN_SCHEMAS, TWIN_SERVER_TOOLS } from './schemas';

export interface TwinAgentDeps {
  db: Firestore;
  requireStaff(auth: CallableRequest['auth']): string;
  enforceAiRateLimit(mongoId: string, tier: AiTier): Promise<AiRateSlot>;
  refundAiRateLimit(slot: AiRateSlot): Promise<void>;
}

const CODE_MAX = 60_000;
const PARTS_MAX = 40;
const OBJECTS_MAX = 40;
const TEXT_MAX = 2000;
/** Frames pooled for the record's colour scale (recordingRange), and how many download at once. */
const RANGE_SAMPLE_FRAMES = 20;
const RANGE_FETCH_PARALLEL = 5;
/** The recording clock (web utils/frameTime.ts FPS), for a document without a frame count. */
const RECORDING_FPS = 5;

/** The recording's last frame number (1-based, data_N.dat): the document's frameCount, else its
 *  duration at the recording clock (web utils/frameTime.ts lastFrameIndexOf + 1). */
export function lastFrameOf(exp: DocumentData): number {
  const n = exp.frameCount;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.floor(n);
  const d = typeof exp.duration === 'number' && Number.isFinite(exp.duration) ? exp.duration : 0;
  return Math.max(1, Math.round(d * RECORDING_FPS));
}

const str = (v: unknown, max = TEXT_MAX): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function specFor(key: QaModelKey): ChatModelSpec {
  const m = QA_MODELS[key];
  if (m.provider === 'anthropic') throw new HttpsError('failed-precondition', 'This model is not offered here.');
  return { provider: m.provider, model: m.model };
}

/** The camera every frame of a still recording is projected through: straight above the picture's
 *  centre, the FLIR's vertical field of view, the thermal grid's aspect (plan §43.5). */
export function canonicalCamera(heightM: number): Record<string, unknown> {
  return {
    position: [0, heightM, 0],
    yaw: 0,
    pitch: -Math.PI / 2,
    roll: 0,
    fovV: FLIR_VFOV_DEG,
    aspect: 0.75,
    rms: 0,
    inliers: 0,
  };
}

/** The finish tool's arguments, checked: the record is written from these and nothing else. */
export function readFinish(args: Record<string, unknown>): { record: DocumentData; frame: number } | { error: string } {
  const code = str(args.code, CODE_MAX);
  if (!code) return { error: 'code is empty.' };
  const partsRaw = Array.isArray(args.parts) ? args.parts.slice(0, PARTS_MAX) : [];
  const parts = partsRaw.flatMap((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const name = str(o.name, 60);
    if (!name) return [];
    const kind = str(o.kind, 30).toLowerCase();
    return [
      {
        name,
        kind: (TWIN_PART_KINDS as readonly string[]).includes(kind) ? kind : 'other',
        description: str(o.description, 300),
      },
    ];
  });
  if (!parts.length) return { error: 'parts is empty: declare every part the program builds with api.part.' };
  const height = num(args.cameraHeightM);
  if (height === null || height < 0.05 || height > 5)
    return { error: 'cameraHeightM must be between 0.05 and 5 metres.' };
  const frame = num(args.referenceFrame);
  if (frame === null || frame < 1 || !Number.isInteger(frame))
    return { error: 'referenceFrame must be a frame number (1-based).' };
  const objects = (Array.isArray(args.objects) ? args.objects.slice(0, OBJECTS_MAX) : []).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const cx = num(o.cx);
    const cy = num(o.cy);
    if (cx === null || cy === null) return [];
    return [
      {
        name: str(o.name, 60),
        shape: str(o.shape, 20) || 'blob',
        cx,
        cy,
        rx: num(o.rx) ?? 0,
        ry: num(o.ry) ?? 0,
        from: str(o.from, 10) === 'vis' ? 'vis' : 'thermal',
        ...(Array.isArray(o.frames)
          ? {
              frames: o.frames
                .map(num)
                .filter((n): n is number => n !== null)
                .slice(0, 2),
            }
          : {}),
        ...(num(o.appears) !== null ? { appears: num(o.appears) } : {}),
        ...(num(o.disappears) !== null ? { disappears: num(o.disappears) } : {}),
        ...(str(o.note, 300) ? { note: str(o.note, 300) } : {}),
      },
    ];
  });
  const assumptions = (Array.isArray(args.assumptions) ? args.assumptions : [])
    .map((a) => str(a, 300))
    .filter(Boolean)
    .slice(0, 20);
  const subjectKind = str(args.subjectKind, 20).toLowerCase();
  const record: DocumentData = {
    kind: 'building',
    version: TWIN_BUILDING_VERSION,
    source: 'orbit',
    framesPicked: true,
    photosSent: [frame],
    renderable: true,
    reason: '',
    confidence: 0.8,
    subject: str(args.subject, 500),
    subjectKind: ['apparatus', 'building', 'interior', 'vehicle', 'person', 'other'].includes(subjectKind)
      ? subjectKind
      : 'apparatus',
    name: str(args.name, 120) || 'Digital twin',
    description: str(args.description, 1000),
    parts,
    code,
    views: [],
    blocker: null,
    // The agent's own account of the build (plan §43.5): the measured objects, every assumption, the
    // camera height the scale rests on and the last score, for the panel and the regression set.
    agent: {
      objects,
      assumptions,
      cameraHeightM: height,
      alignment: str(args.alignment, 200),
      builds: 0, // filled in by the callable from the conversation's turns
    },
  };
  return { record, frame };
}

export function twinAgentFunctions(deps: TwinAgentDeps) {
  const { db } = deps;
  const bucket = () => getStorage().bucket();

  /** The readable pixels of one frame, °C; null when the frame is missing or incomplete. */
  async function framePixels(recordingId: string, frame: number): Promise<number[] | null> {
    let dat: Buffer;
    try {
      dat = (await bucket().file(`recordings/${recordingId}/data_${frame}.dat`).download())[0];
    } catch {
      return null;
    }
    const f = decodeFrame(new Uint8Array(dat));
    if (!f.complete) return null;
    const values: number[] = [];
    for (let k = 0; k < f.w * f.h; k++) {
      const c = celsiusAtIndex(f, k);
      if (c > -200) values.push(c);
    }
    return values.length < 100 ? null : values;
  }

  /** The record's colour scale: the temperature span of the WHOLE recording (plan §43.5), not of one
   *  frame. The heat map follows the player, and an experiment changes — ice at −7 °C after the salt
   *  would saturate a scale taken from the first frame — so RANGE_SAMPLE_FRAMES frames spread evenly
   *  over the recording, the reference frame among them, are pooled and their p01–p99 taken: one scale
   *  under which the same colour means the same temperature at any time. Null when the reference frame
   *  itself cannot be read (the camera's frame must exist); other frames that fail to load are skipped. */
  async function recordingRange(
    recordingId: string,
    referenceFrame: number,
    lastFrame: number,
  ): Promise<[number, number] | null> {
    const wanted = new Set<number>([referenceFrame]);
    const n = Math.max(1, lastFrame);
    for (let i = 0; i < RANGE_SAMPLE_FRAMES; i++)
      wanted.add(Math.max(1, Math.min(n, Math.round(1 + ((n - 1) * i) / Math.max(1, RANGE_SAMPLE_FRAMES - 1)))));
    const frames = [...wanted].sort((a, b) => a - b);
    const loaded = new Map<number, number[]>();
    for (let i = 0; i < frames.length; i += RANGE_FETCH_PARALLEL) {
      const slice = frames.slice(i, i + RANGE_FETCH_PARALLEL);
      const got = await Promise.all(slice.map((fr) => framePixels(recordingId, fr)));
      slice.forEach((fr, k) => {
        const px = got[k];
        if (px) loaded.set(fr, px);
      });
    }
    if (!loaded.has(referenceFrame)) return null;
    const values = ([] as number[]).concat(...loaded.values());
    values.sort((a, b) => a - b);
    const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
    return [Math.round(at(0.01) * 10) / 10, Math.round(at(0.99) * 10) / 10];
  }

  const twinAgentTurn = onCall(
    { secrets: CHAT_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
    async (request, response) => {
      const mongoId = deps.requireStaff(request.auth);
      const uid = request.auth!.uid;
      const token = request.auth!.token as Record<string, unknown>;
      const d = (request.data ?? {}) as Record<string, unknown>;
      const expId = typeof d.expId === 'string' ? d.expId.trim() : '';
      if (!expId || expId.includes('/') || expId.length > 200) throw new HttpsError('invalid-argument', 'Bad expId.');
      const input = parseInput(d.input);
      if (input.kind === 'report') throw new HttpsError('invalid-argument', 'A twin build takes no report request.');
      const browserTools = Array.isArray(d.browserTools)
        ? d.browserTools.filter((x): x is string => typeof x === 'string')
        : [];
      const emit = (chunk: Record<string, unknown>) => {
        if (request.acceptsStreaming && response) {
          try {
            void response.sendChunk(chunk);
          } catch {
            // the client went away; the request still finishes and is persisted
          }
        }
      };

      const expRef = db.doc(`experiments/${expId}`);
      const exp = (await expRef.get()).data();
      if (!exp) throw new HttpsError('not-found', 'Recording not found.');
      if (exp.sourceType !== 'recording' || typeof exp.recordingId !== 'string')
        throw new HttpsError('failed-precondition', 'The agent builds a twin of a recording only.');
      if (exp.ownerId !== mongoId)
        throw new HttpsError('permission-denied', 'Only the recording owner can build its twin.');
      const recordingId = exp.recordingId as string;
      const title =
        typeof exp.displayName === 'string' && exp.displayName.trim() ? exp.displayName.trim() : 'Recording';

      const { tier } = await requireAiAccess(db, token, mongoId);
      const charged = isChargedInput(input.kind) ? await deps.enforceAiRateLimit(mongoId, tier) : null;
      let modelCalls = 0;
      try {
        const now = Date.now();
        const convo = twinConvo(expId, uid);
        // A new build starts a fresh conversation: the old one goes, pictures and all.
        if (input.kind === 'message' && d.fresh === true) await deleteConvo(convo).catch(() => undefined);
        const existing = input.kind === 'message' && d.fresh === true ? null : await loadConvo(convo);
        const modelKey: QaModelKey =
          existing && existing.seq > 0
            ? (offeredModelKey(existing.model) ?? DEFAULT_MODEL_KEY)
            : (offeredModelKey(d.model) ?? DEFAULT_MODEL_KEY);
        const create = existing ? null : emptyConvo('twin', { uid, mongoId, expId, model: modelKey }, now);
        if (existing && existing.model !== modelKey) await updateConvo(convo, { model: modelKey });
        const spec = specFor(modelKey);
        const lockId = newId('lock');
        const locked = await acquireLock(convo, lockId, create);
        if (!locked)
          return { status: 'busy', pending: [], model: modelKey } satisfies TurnOutcome & Record<string, unknown>;
        try {
          let finished = false;
          const toolset: TurnToolset = {
            phoneTools: TWIN_PHONE_TOOLS,
            extraSchemas: TWIN_SCHEMAS,
            serverTools: [],
            systemPrompt: () => twinAgentPrompt({ expId, title }),
            serverTool: async (ctx: ServerToolContext, name: string, rawArgs: string): Promise<ToolOutcome | null> => {
              if (!(TWIN_SERVER_TOOLS as readonly string[]).includes(name)) return null;
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
              } catch {
                return { ok: false, text: 'finish: the arguments are not JSON.', images: [] };
              }
              const read = readFinish(args);
              if ('error' in read) return { ok: false, text: `finish: ${read.error}`, images: [] };
              const range = await recordingRange(recordingId, read.frame, lastFrameOf(exp));
              if (!range)
                return {
                  ok: false,
                  text: `finish: frame ${read.frame} of the recording could not be read.`,
                  images: [],
                };
              const builds = Math.min(TWIN_AGENT_MAX_BUILDS, countBuilds(ctx));
              const record: DocumentData = {
                ...read.record,
                model: spec.model,
                modelKey,
                surfaceModelKey: modelKey,
                thermal: {
                  photos: [
                    {
                      photo: read.frame,
                      picture: 'render',
                      status: 'ok',
                      registration: null,
                      landmarks: [],
                      camera: canonicalCamera(read.record.agent.cameraHeightM as number),
                    },
                  ],
                  surfaces: [],
                  range,
                },
                agent: { ...(read.record.agent as Record<string, unknown>), builds, at: Date.now() },
                analyzedAt: FieldValue.serverTimestamp(),
              };
              await expRef.update({ twinScene: record, twinEdits: FieldValue.delete() });
              finished = true;
              emit({ t: 'twin', record: { ...record, analyzedAt: Date.now() } });
              return {
                ok: true,
                text: `The twin is saved: "${record.name}", ${(record.parts as unknown[]).length} parts, frame ${read.frame} as its camera's frame, colour scale ${range[0]}–${range[1]} °C over the whole recording. The user sees it now. Say in one or two sentences what was built and what was assumed, then stop.`,
                images: [],
              };
            },
          };
          const outcome = await runTurn({
            convo,
            doc: locked,
            input,
            spec,
            browserTools,
            setting: { kind: 'thread', recording: { expId, title, kind: 'recording' }, report: null },
            report: null,
            editNote: null,
            tier,
            emit,
            toolset,
            onModelCall: () => (modelCalls += 1),
          });
          return { ...outcome, model: modelKey, finished };
        } finally {
          await releaseLock(convo, lockId);
        }
      } finally {
        if (charged && modelCalls === 0) await deps.refundAiRateLimit(charged);
      }
    },
  );

  return { twinAgentTurn };
}

/** How many build_scene calls the conversation holds so far — the turns are not in the tool context,
 *  so this reads the convo's turns count by name through Firestore lazily; kept simple: counted on the
 *  client as well, which enforces the budget. */
function countBuilds(ctx: ServerToolContext): number {
  // The context carries the images of the conversation; builds are counted by the client (budget) and
  // only recorded here from what the images say: each build returns an overlay captioned "Build N".
  let n = 0;
  for (const im of ctx.images) if (/^Build \d+/.test(im.caption ?? '')) n += 1;
  return n;
}
