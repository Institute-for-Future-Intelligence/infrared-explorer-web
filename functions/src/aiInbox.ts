/**
 * The AI report's request container — what the phone packs for a recording that was never uploaded
 * (app repo docs/proposals/ai-report-latency.md §3.A; AiReportPacker.kt writes it, src/lib/aiReportPack.ts
 * decides its contents) — parsed and checked here before a report run spends anything on it.
 *
 * Layout (little-endian): [uint32 headerLength][header JSON, UTF-8][blob 0][blob 1]…
 * header.blobs[i] = { offset, length } from the end of the header; every other index field names a
 * blob by its position in that list. A .dat blob is the frame file exactly as it is on disk (zlib);
 * a photo blob is a JPEG the phone encoded; the sidecar blob is frame-stats.bin whole.
 *
 * VALIDATION BEFORE QUOTA. A malformed or oversized container is refused with invalid-argument before
 * the rate-limit slot is taken and before any blob is decoded: a container is cheap to construct and
 * expensive to analyse, so the shape is checked first and the limits are hard. Nothing in the header is
 * trusted for analysis — the server computes every number from the blobs; the header only says which
 * frame is which, where the probes are and what the student wrote.
 */

export const INBOX_VERSION = 1;
/** The limits a container must respect (also the packer's budget on the phone). */
export const INBOX_LIMITS = {
  /** The whole object (the Storage rule caps it too). */
  bytes: 24 * 1024 * 1024,
  headerBytes: 1024 * 1024,
  frames: 400,
  datBytes: 64 * 1024,
  /** A pool photo (long edge ≤ 400). */
  photoBytes: 96 * 1024,
  /** A pose photo (long edge ≤ 640) or the contact sheet. */
  largePhotoBytes: 400 * 1024,
  sidecarBytes: 2 * 1024 * 1024,
  frameCount: 200_000,
  thermometers: 24,
  profileLines: 24,
  annotations: 60,
  keyMoments: 60,
  posePhotos: 40,
  text: 2000,
} as const;

export class InboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxError';
  }
}

export interface InboxThermometer {
  label: string;
  name: string | null;
  aiPlaced: boolean;
  x: number;
  y: number;
  measuringAreaType?: string;
  measuringAreaWidth?: number;
  measuringAreaHeight?: number;
}

export interface InboxProfileLine {
  name: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lengthCm: number | null;
}

export interface InboxAnnotation {
  x: number;
  y: number;
  note: string;
  from?: number;
  to?: number;
}

export interface InboxKeyMoment {
  tSeconds: number;
  endTSeconds?: number;
  text: string;
}

export interface InboxHeader {
  v: number;
  /** The phone's uuid for this report; the server stores it as {ownerId}_{uuid}. */
  reportId: string;
  recording: { durationSec: number; fps: number; frameCount: number };
  /** The selected frames, ascending, with their blobs. */
  frames: { n: number; dat: number; vis: number | null }[];
  /** The phone's selection record — informative only; the server selects on the sidecar itself. */
  selection: Record<string, unknown> | null;
  thermometers: InboxThermometer[];
  profileLines: InboxProfileLine[];
  annotations: InboxAnnotation[];
  keyMoments: InboxKeyMoment[];
  title: string;
  description: string;
  subject: string | null;
  posePhotos: { n: number; jpeg: number }[];
  contactSheet: number | null;
  sidecar: number | null;
  /** The phone's attitude at record start (experiments.capturePose on an upload), when recorded. */
  capturePose: { pitchDeg: number; rollDeg: number; azimuthDeg: number } | null;
  /** The emissivity the camera converted with (experiments.emissivity on an upload), when recorded. */
  emissivity: number | null;
  blobs: { offset: number; length: number }[];
}

export interface InboxContainer {
  header: InboxHeader;
  /** A blob's bytes, as a view onto the container. */
  blob(index: number): Uint8Array;
  /** The .dat bytes of frame n, or null when the container does not carry that frame. */
  dat(n: number): Uint8Array | null;
  /** The pool photo of frame n, or null. */
  photo(n: number): Uint8Array | null;
  /** The frame numbers present, ascending. */
  frameNumbers: number[];
  totalBytes: number;
}

const fail = (message: string): never => {
  throw new InboxError(message);
};

const num = (v: unknown, what: string, min = -Infinity, max = Infinity): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${what} is not a number in range`);
  return v as number;
};
const int = (v: unknown, what: string, min: number, max: number): number => {
  const n = num(v, what, min, max);
  if (!Number.isInteger(n)) fail(`${what} is not an integer`);
  return n;
};
const text = (v: unknown, max: number = INBOX_LIMITS.text): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
const optionalText = (v: unknown, max: number = INBOX_LIMITS.text): string | null => {
  const t = text(v, max);
  return t ? t : null;
};
const unit = (v: unknown, what: string): number => num(v, what, 0, 1);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isInboxReportId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Parse and validate a container. Throws InboxError on anything a well-behaved packer never produces. */
export function parseInboxContainer(bytes: Uint8Array): InboxContainer {
  if (bytes.length > INBOX_LIMITS.bytes) fail(`container is ${bytes.length} bytes, over the limit`);
  if (bytes.length < 4) fail('container is empty');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  if (headerLength <= 1 || headerLength > INBOX_LIMITS.headerBytes || 4 + headerLength > bytes.length) {
    fail('container header length is invalid');
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as Record<string, unknown>;
  } catch {
    return fail('container header is not JSON');
  }
  if (!raw || typeof raw !== 'object') fail('container header is not an object');
  if (raw.v !== INBOX_VERSION) fail(`container version ${String(raw.v)} is not supported`);
  if (!isInboxReportId(raw.reportId)) fail('reportId is not a uuid');

  const blobsRaw = Array.isArray(raw.blobs) ? raw.blobs : fail('blobs missing');
  const blobArea = bytes.length - 4 - headerLength;
  const blobs = blobsRaw.map((b, i) => {
    const o = b as { offset?: unknown; length?: unknown };
    const offset = int(o.offset, `blob ${i} offset`, 0, blobArea);
    const length = int(o.length, `blob ${i} length`, 0, Number.MAX_SAFE_INTEGER);
    if (offset + length > blobArea) fail(`blob ${i} runs past the container`);
    return { offset, length };
  });
  const blobOf = (v: unknown, what: string): number => int(v, what, 0, blobs.length - 1);
  const sized = (idx: number, max: number, what: string) => {
    if (blobs[idx].length > max) fail(`${what} is ${blobs[idx].length} bytes, over the limit`);
  };

  const rec = (raw.recording ?? {}) as {
    durationSec?: unknown;
    fps?: unknown;
    frameCount?: unknown;
    timelapse?: unknown;
  };
  if (rec.timelapse) fail('time-lapse recordings are not supported by the AI report yet');
  const frameCount = int(rec.frameCount, 'recording.frameCount', 1, INBOX_LIMITS.frameCount);
  const fps = num(rec.fps, 'recording.fps', 0.01, 120);
  const durationSec = num(rec.durationSec, 'recording.durationSec', 0, 1e7);

  const framesRaw = Array.isArray(raw.frames) ? raw.frames : fail('frames missing');
  if (framesRaw.length < 1 || framesRaw.length > INBOX_LIMITS.frames) fail(`frames has ${framesRaw.length} entries`);
  const seen = new Set<number>();
  const frames = framesRaw.map((f, i) => {
    const o = f as { n?: unknown; dat?: unknown; vis?: unknown };
    const n = int(o.n, `frames[${i}].n`, 1, frameCount);
    if (seen.has(n)) fail(`frame ${n} listed twice`);
    seen.add(n);
    const dat = blobOf(o.dat, `frames[${i}].dat`);
    sized(dat, INBOX_LIMITS.datBytes, `frame ${n}`);
    let vis: number | null = null;
    if (o.vis != null) {
      vis = blobOf(o.vis, `frames[${i}].vis`);
      sized(vis, INBOX_LIMITS.photoBytes, `photo ${n}`);
    }
    return { n, dat, vis };
  });
  frames.sort((a, b) => a.n - b.n);

  const posesRaw = Array.isArray(raw.posePhotos) ? raw.posePhotos : [];
  if (posesRaw.length > INBOX_LIMITS.posePhotos) fail('too many pose photos');
  const posePhotos = posesRaw.map((p, i) => {
    const o = p as { n?: unknown; jpeg?: unknown };
    const n = int(o.n, `posePhotos[${i}].n`, 1, frameCount);
    const jpeg = blobOf(o.jpeg, `posePhotos[${i}].jpeg`);
    sized(jpeg, INBOX_LIMITS.largePhotoBytes, `pose photo ${n}`);
    return { n, jpeg };
  });
  let contactSheet: number | null = null;
  if (raw.contactSheet != null) {
    contactSheet = blobOf(raw.contactSheet, 'contactSheet');
    sized(contactSheet, INBOX_LIMITS.largePhotoBytes, 'contact sheet');
  }
  let sidecar: number | null = null;
  if (raw.sidecar != null) {
    sidecar = blobOf(raw.sidecar, 'sidecar');
    sized(sidecar, INBOX_LIMITS.sidecarBytes, 'sidecar');
  }

  const thermsRaw = Array.isArray(raw.thermometers) ? raw.thermometers : [];
  if (thermsRaw.length > INBOX_LIMITS.thermometers) fail('too many thermometers');
  const thermometers: InboxThermometer[] = thermsRaw.map((t, i) => {
    const o = t as Record<string, unknown>;
    const areaType = typeof o.measuringAreaType === 'string' ? o.measuringAreaType : undefined;
    return {
      label: `T${i + 1}`,
      name: optionalText(o.name, 120),
      aiPlaced: o.aiPlaced === true,
      x: unit(o.x, `thermometers[${i}].x`),
      y: unit(o.y, `thermometers[${i}].y`),
      ...(areaType === 'rectangle' || areaType === 'ellipse'
        ? {
            measuringAreaType: areaType,
            measuringAreaWidth: unit(o.measuringAreaWidth ?? 0.15, `thermometers[${i}].measuringAreaWidth`),
            measuringAreaHeight: unit(o.measuringAreaHeight ?? 0.15, `thermometers[${i}].measuringAreaHeight`),
          }
        : {}),
    };
  });

  const linesRaw = Array.isArray(raw.profileLines) ? raw.profileLines : [];
  if (linesRaw.length > INBOX_LIMITS.profileLines) fail('too many profile lines');
  const profileLines: InboxProfileLine[] = linesRaw.map((l, i) => {
    const o = l as Record<string, unknown>;
    const lengthCm =
      typeof o.lengthCm === 'number' && Number.isFinite(o.lengthCm) && o.lengthCm > 0 ? o.lengthCm : null;
    return {
      name: optionalText(o.name, 120),
      x1: unit(o.x1, `profileLines[${i}].x1`),
      y1: unit(o.y1, `profileLines[${i}].y1`),
      x2: unit(o.x2, `profileLines[${i}].x2`),
      y2: unit(o.y2, `profileLines[${i}].y2`),
      lengthCm,
    };
  });

  const annRaw = Array.isArray(raw.annotations) ? raw.annotations : [];
  if (annRaw.length > INBOX_LIMITS.annotations) fail('too many annotations');
  const annotations: InboxAnnotation[] = [];
  for (const a of annRaw) {
    const o = a as Record<string, unknown>;
    const note = text(o.note, 500);
    if (!note || typeof o.x !== 'number' || typeof o.y !== 'number') continue;
    const item: InboxAnnotation = { x: unit(o.x, 'annotation.x'), y: unit(o.y, 'annotation.y'), note };
    if (typeof o.from === 'number' && typeof o.to === 'number') {
      item.from = num(o.from, 'annotation.from', 0, 1e7);
      item.to = num(o.to, 'annotation.to', 0, 1e7);
    }
    annotations.push(item);
  }

  const momentsRaw = Array.isArray(raw.keyMoments) ? raw.keyMoments : [];
  if (momentsRaw.length > INBOX_LIMITS.keyMoments) fail('too many key moments');
  const keyMoments: InboxKeyMoment[] = [];
  for (const m of momentsRaw) {
    const o = m as Record<string, unknown>;
    const t = text(o.text, 500);
    if (!t || typeof o.tSeconds !== 'number') continue;
    const item: InboxKeyMoment = { tSeconds: num(o.tSeconds, 'keyMoment.tSeconds', 0, 1e7), text: t };
    if (typeof o.endTSeconds === 'number') item.endTSeconds = num(o.endTSeconds, 'keyMoment.endTSeconds', 0, 1e7);
    keyMoments.push(item);
  }

  // The capture setup: optional, and dropped rather than refused when malformed — neither is needed to
  // analyse the frames, both only tell the model how the picture was taken.
  let capturePose: InboxHeader['capturePose'] = null;
  const poseRaw = raw.capturePose as Record<string, unknown> | undefined;
  if (poseRaw && typeof poseRaw === 'object') {
    const angles = ['pitchDeg', 'rollDeg', 'azimuthDeg'].map((k) => poseRaw[k]);
    if (angles.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 360)) {
      capturePose = { pitchDeg: angles[0] as number, rollDeg: angles[1] as number, azimuthDeg: angles[2] as number };
    }
  }
  const emissivity =
    typeof raw.emissivity === 'number' && Number.isFinite(raw.emissivity) && raw.emissivity > 0 && raw.emissivity <= 1
      ? raw.emissivity
      : null;

  const header: InboxHeader = {
    v: INBOX_VERSION,
    reportId: (raw.reportId as string).toLowerCase(),
    recording: { durationSec, fps, frameCount },
    frames,
    selection: raw.selection && typeof raw.selection === 'object' ? (raw.selection as Record<string, unknown>) : null,
    thermometers,
    profileLines,
    annotations,
    keyMoments,
    title: text(raw.title, 200),
    description: text(raw.description, INBOX_LIMITS.text),
    subject: optionalText(raw.subject, 60),
    posePhotos,
    contactSheet,
    sidecar,
    capturePose,
    emissivity,
    blobs,
  };

  const base = 4 + headerLength;
  const blob = (index: number): Uint8Array => {
    const b = blobs[index];
    if (!b) fail(`blob ${index} does not exist`);
    return bytes.subarray(base + b.offset, base + b.offset + b.length);
  };
  const byFrame = new Map(frames.map((f) => [f.n, f]));
  return {
    header,
    blob,
    dat: (n) => {
      const f = byFrame.get(n);
      return f ? blob(f.dat) : null;
    },
    photo: (n) => {
      const f = byFrame.get(n);
      return f && f.vis != null ? blob(f.vis) : null;
    },
    frameNumbers: frames.map((f) => f.n),
    totalBytes: bytes.length,
  };
}

/** Build a container (the packer's format) — for tests and for any server-side tooling that needs one. */
export function encodeInboxContainer(
  header: Omit<InboxHeader, 'blobs'> & { blobs?: undefined },
  blobs: Uint8Array[],
): Uint8Array {
  let offset = 0;
  const index = blobs.map((b) => {
    const entry = { offset, length: b.length };
    offset += b.length;
    return entry;
  });
  const headerBytes = new TextEncoder().encode(JSON.stringify({ ...header, blobs: index }));
  const out = new Uint8Array(4 + headerBytes.length + offset);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  let at = 4 + headerBytes.length;
  for (const b of blobs) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
