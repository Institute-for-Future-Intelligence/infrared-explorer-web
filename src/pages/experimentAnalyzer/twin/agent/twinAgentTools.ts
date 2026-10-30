/**
 * The twin agent's browser tools (docs/digital-twin-plan.md §43.5): look and run_code are the
 * Experiments' own (labProjects/browserTools.ts); build_scene and verify_scene are the twin's. A build
 * runs the program in an off-screen viewer frame (twinFrameHost.ts), projects the reference frame
 * through the camera the agent says the recording was made with (functions/src/twinAgent/camera.ts,
 * plan §44.1), asks the frame for the ID mask and scores it against the frame's own objects
 * (utils/twinAlignment.ts) — the very check the Measured view shows — and answers with the report, the
 * overlay and a picture of the model. A verify scores the last build against another frame. The budget
 * (TWIN_AGENT_MAX_BUILDS) is kept here: past it a build is refused and the model told to finish.
 */
import { runBrowserTool } from '../../../../labProjects/browserTools';
import type { OutImage, PendingCall, PhoneToolResult, Take } from '../../../../labProjects/core/types';
import { fetchRecordingFrameBufferCached } from '../../../../utils/recordingFrame';
import { getDecodedFrame } from '../../../../utils/thermalFrame';
import {
  ALIGN_H,
  ALIGN_W,
  type AlignmentReport,
  alignmentReport,
  alignmentSentence,
  overlayRgba,
  partInstances,
  segmentThermal,
} from '../../../../utils/twinAlignment';
import { THERMAL_H, THERMAL_W, type TwinProjectionPhoto, maskTemps } from '../../../../utils/twinProjection';
import {
  type AgentCamera,
  agentCameraRecord,
  describeAgentCamera,
  readAgentCamera,
} from '../../../../../functions/src/twinAgent/camera';
import { describeSettled, readSettled } from '../twinFrameGeometry';
import { TwinFrameHost } from './twinFrameHost';

export const TWIN_AGENT_BROWSER_TOOLS = ['look', 'run_code', 'build_scene', 'verify_scene'] as const;
/** Mirrors functions/src/twinAgent/prompt.ts TWIN_AGENT_MAX_BUILDS. */
export const TWIN_AGENT_MAX_BUILDS = 3;
const MAX_VERIFIES = 6;

interface AgentBuildState {
  host: TwinFrameHost | null;
  builds: number;
  verifies: number;
  /** The last build, for verify_scene. */
  last: { code: string; parts: { name: string; kind: string }[]; camera: AgentCamera; built: unknown } | null;
}
const states = new Map<string, AgentBuildState>();
const stateOf = (expId: string): AgentBuildState => {
  let s = states.get(expId);
  if (!s) states.set(expId, (s = { host: null, builds: 0, verifies: 0, last: null }));
  return s;
};

/** A new build starts the count over and drops the last frame. */
export function resetTwinAgentTools(expId: string): void {
  const s = states.get(expId);
  s?.host?.close();
  states.delete(expId);
}
export function closeTwinAgentTools(expId: string): void {
  const s = states.get(expId);
  s?.host?.close();
  if (s) s.host = null;
}

type Json = Record<string, unknown>;
const parseArgs = (raw: string): Json => {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Json) : {};
  } catch {
    return {};
  }
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const ok = (callId: string, payload: Json, images: OutImage[] = []): PhoneToolResult => ({
  callId,
  ok: true,
  text: JSON.stringify(payload),
  images,
});
const fail = (callId: string, message: string): PhoneToolResult => ({ callId, ok: false, text: message });

/** A data URL's picture as a tool image, or null unless it really is one: a canvas of no size answers
 *  toDataURL with "data:," and a stripped prefix would leave that as the "base64" — which, stored and
 *  replayed to the model, fails every later call of the conversation with an invalid image. */
function imageOf(dataUrl: string | null, caption: string): OutImage | null {
  const m = dataUrl ? /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl) : null;
  if (!m || m[2].length < 200) return null;
  return { mime: m[1] as OutImage['mime'], b64: m[2], caption };
}

/** A frame through the camera the agent gave: every frame of the recording goes through the same one. */
function photoThrough(frame: number, camera: AgentCamera, temps: Float32Array): TwinProjectionPhoto {
  return {
    photo: frame,
    label: `frame ${frame}`,
    ...agentCameraRecord(camera),
    dx: 0,
    dy: 0,
    w: THERMAL_W,
    h: THERMAL_H,
    temps,
  };
}

async function frameTemps(recordingId: string, frame: number): Promise<Float32Array> {
  const buffer = await fetchRecordingFrameBufferCached(recordingId, frame);
  const f = getDecodedFrame(buffer);
  if (!f.complete || f.width !== THERMAL_W || f.height !== THERMAL_H) throw new Error(`frame ${frame} is incomplete`);
  return maskTemps(f.temps, THERMAL_W, THERMAL_H, null, 'apparatus');
}

function overlayPng(report: { overlay: Uint8ClampedArray }): string | null {
  const small = document.createElement('canvas');
  small.width = ALIGN_W;
  small.height = ALIGN_H;
  const sg = small.getContext('2d');
  if (!sg) return null;
  sg.putImageData(new ImageData(report.overlay, ALIGN_W, ALIGN_H), 0, 0);
  const big = document.createElement('canvas');
  big.width = ALIGN_W * 3;
  big.height = ALIGN_H * 3;
  const bg = big.getContext('2d');
  if (!bg) return null;
  bg.imageSmoothingEnabled = false;
  bg.drawImage(small, 0, 0, big.width, big.height);
  return big.toDataURL('image/png');
}

function reportJson(r: AlignmentReport): Json {
  const round = (v: number, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
  return {
    verdict: r.verdict,
    sentence: alignmentSentence(r),
    ...(r.reason ? { reason: r.reason } : {}),
    worstCentroidPx: round(r.worstCentroidPx, 1),
    // Of the frame's readable pixels, the share that lands on the model at all: what the viewer can paint.
    coverage: round(r.coverage),
    objects: r.objects.map((o) => ({
      object: {
        id: o.blob.id,
        cx: round(o.blob.cx, 1),
        cy: round(o.blob.cy, 1),
        rEq: round(o.blob.rEq, 1),
        area: o.blob.area,
        meanC: round(o.blob.meanC, 1),
      },
      parts: o.parts,
      instances: o.instances.map((p) => ({
        name: p.name,
        instance: p.instance,
        cx: round(p.cx, 1),
        cy: round(p.cy, 1),
        rEq: round(p.rEq, 1),
        area: p.area,
      })),
      iou: round(o.iou),
      centroidErrPx: round(o.centroidErrPx, 1),
      areaRatio: round(o.areaRatio),
      pass: o.pass,
    })),
    missing: r.missing.map((b) => ({ id: b.id, cx: round(b.cx, 1), cy: round(b.cy, 1), rEq: round(b.rEq, 1) })),
    extra: r.extra.map((p) => ({
      name: p.name,
      instance: p.instance,
      cx: round(p.cx, 1),
      cy: round(p.cy, 1),
      area: p.area,
    })),
    shared: r.shared,
    segmentation: {
      polarity: r.segmentation.polarity,
      thresholdC: round(r.segmentation.thresholdC, 1),
      gapC: round(r.segmentation.gapC, 1),
      blobs: r.segmentation.blobs.length,
    },
  };
}

async function score(host: TwinFrameHost, recordingId: string, frame: number, camera: AgentCamera) {
  const temps = await frameTemps(recordingId, frame);
  await host.photos([photoThrough(frame, camera, temps)]);
  const verified = await host.verify(frame);
  if (!verified.mask) throw new Error('the viewer could not draw the model from the camera');
  const segmentation = segmentThermal(temps);
  const model = partInstances(verified.mask, verified.names);
  const report = alignmentReport(segmentation, model);
  const overlay = overlayRgba(segmentation, model);
  return { report, overlay };
}

export async function runTwinAgentTool(
  call: PendingCall,
  take: Take,
  recordingId: string,
  expId: string,
): Promise<PhoneToolResult> {
  if (call.name !== 'build_scene' && call.name !== 'verify_scene') return runBrowserTool(call, [take], `exp:${expId}`);
  const s = stateOf(expId);
  const args = parseArgs(call.args);
  try {
    if (call.name === 'build_scene') {
      if (s.builds >= TWIN_AGENT_MAX_BUILDS)
        return fail(
          call.id,
          `The build budget (${TWIN_AGENT_MAX_BUILDS}) is spent: call finish with the best program so far.`,
        );
      const code = typeof args.code === 'string' ? args.code : '';
      if (!code.trim()) return fail(call.id, 'code is empty.');
      const parts = (Array.isArray(args.parts) ? args.parts : [])
        .map((p) => (p && typeof p === 'object' ? (p as Json) : {}))
        .filter((p) => typeof p.name === 'string' && p.name)
        .map((p) => ({ name: String(p.name), kind: typeof p.kind === 'string' ? p.kind : 'other' }));
      const camera = readAgentCamera(args.camera);
      if ('error' in camera) return fail(call.id, camera.error);
      const frame = num(args.referenceFrame);
      if (frame === null || frame < 1) return fail(call.id, 'referenceFrame must be a frame number (1-based).');
      s.builds += 1;
      if (!s.host) s.host = new TwinFrameHost();
      await s.host.open(); // one document per program (§30.3)
      const built = await s.host.build(code, parts);
      s.last = { code, parts, camera, built };
      const { report, overlay } = await score(s.host, recordingId, Math.round(frame), camera);
      const settled = describeSettled(readSettled(built.settled));
      const images: OutImage[] = [];
      const png = imageOf(
        overlayPng({ overlay }),
        `Build ${s.builds}: overlay of frame ${Math.round(frame)} (its objects red, the model blue, agreement purple)`,
      );
      if (png) images.push(png);
      const shot = imageOf(await s.host.snapshot(), `Build ${s.builds}: the model as rendered`);
      if (shot) images.push(shot);
      return ok(
        call.id,
        {
          build: s.builds,
          buildsLeft: TWIN_AGENT_MAX_BUILDS - s.builds,
          frame: Math.round(frame),
          camera: describeAgentCamera(camera),
          built: {
            meshes: built.meshes,
            unnamedMeshes: built.unnamedMeshes,
            parts: built.parts.map((p) => ({
              name: p.name,
              kinds: p.kinds,
              centre: p.center.map((v) => Math.round(v * 1000) / 1000),
              size: p.max.map((v, i) => Math.round((v - p.min[i]) * 1000) / 1000),
            })),
            ...(settled ? { settled } : {}),
          },
          alignment: reportJson(report),
        },
        images,
      );
    }
    // verify_scene
    if (!s.last || !s.host) return fail(call.id, 'Nothing has been built yet: call build_scene first.');
    if (s.verifies >= MAX_VERIFIES) return fail(call.id, `The verify budget (${MAX_VERIFIES}) is spent.`);
    const frame = num(args.frame);
    if (frame === null || frame < 1) return fail(call.id, 'frame must be a frame number (1-based).');
    s.verifies += 1;
    const { report, overlay } = await score(s.host, recordingId, Math.round(frame), s.last.camera);
    const images: OutImage[] = [];
    const png = imageOf(
      overlayPng({ overlay }),
      `Verify: overlay of frame ${Math.round(frame)} (its objects red, the model blue, agreement purple)`,
    );
    if (png) images.push(png);
    return ok(
      call.id,
      { frame: Math.round(frame), camera: describeAgentCamera(s.last.camera), alignment: reportJson(report) },
      images,
    );
  } catch (e) {
    return fail(call.id, `${call.name} failed: ${(e as Error)?.message ?? String(e)}`.slice(0, 600));
  }
}
