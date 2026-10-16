/*
 * A take's data in the browser, for the tools the AI runs here (look,
 * run_code — browserTools.ts) and for the overview sent when a take joins
 * the conversation (overview.ts). The website's version of the app's
 * lib/labProjects/takeData.ts: a take has no file here — it is the cloud
 * copy of the capture, an experiment (`experiments/{expId}`) whose frames
 * live under `recordings/{recordingId}/` in Storage (data_N.dat, the
 * pako-deflated 120 × 160 centikelvin grid; vis_N.jpg, the visible-light
 * picture, when the take kept one; frame-stats.bin, the block means the
 * camera-motion detector reads). A photo set is the same layout, one photo
 * a frame, with no time axis.
 *
 * Everything reads through the website's own decoders (utils/thermalFrame.ts,
 * utils/temperatureReader.ts), so a number the AI is given is the number the
 * analyzer shows. A frame is one HTTP request: at most 8 are in flight at
 * once, the deflated bodies are kept in an in-memory LRU and in the Cache
 * API (`labProjects-frames`), so the second read of a take is local.
 */

import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import Pako from 'pako';
import { firebaseDatabase, firebaseStorage } from '../services/firebase';
import useCommonStore from '../stores/common';
import { ExperimentType, MeasuringAreaType, Visibility, type ExperimentDoc, type Thermometer } from '../types';
import { FPS } from '../utils/constants';
import { getTemperatureAtPosition, getThermometerValue } from '../utils/temperatureReader';
import { getDecodedFrame } from '../utils/thermalFrame';
import { parseFrameStats, type FrameStatsFile } from './core/frameSelection';
import type { Take } from './core/types';
import type { Mark } from './render';

/** A frame could not be read (missing from the cloud copy, or not a frame). */
export class FrameUnreadable extends Error {}

/** The take cannot be opened in the browser at all. */
export class TakeUnavailable extends Error {}

/** The line every tool answers for a take that has no copy in the cloud. */
export const PHONE_ONLY_TEXT =
  "This capture is on the user's phone and not in the cloud; it cannot be read in the browser.";

/** A sensor of the experiment: a thermometer of the analyzer (a point or an area), or a temperature line (a T(l) transect). */
export interface CloudSensor {
  label: string;
  kind: 'spot' | 'line';
  /** The analyzer's thermometer, as its doc holds it (read with the website's own reader). */
  thermometer?: Thermometer;
  /** A spot: where it reads and its area, in the app's shape. */
  x?: number;
  y?: number;
  area?: { kind: 'point' | 'rect' | 'ellipse'; w: number; h: number };
  /** A line's ends. */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ----------------------------------------------------------------- fetches

const bucket = firebaseStorage.app.options.storageBucket ?? '';

/** The public URL of a file under the recording's prefix (the storage rules let anyone read recordings/**). */
const fileUrl = (recordingId: string, name: string): string =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(`recordings/${recordingId}/${name}`)}?alt=media`;

const CACHE_NAME = 'labProjects-frames';
let cacheOpen: Promise<Cache | null> | null = null;

function frameCache(): Promise<Cache | null> {
  if (!cacheOpen) {
    cacheOpen = (async () => {
      try {
        return typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null;
      } catch {
        return null;
      }
    })();
  }
  return cacheOpen;
}

/** How many frame requests go out at once. */
const CONCURRENCY = 8;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= CONCURRENCY) {
    await new Promise<void>((res) => waiting.push(res));
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

/**
 * One file of the recording's prefix as bytes, or null when it is not there
 * (404). The Cache API keeps the body between sessions; a failure of the
 * cache is never a failure of the read.
 */
async function fetchFile(url: string): Promise<ArrayBuffer | null> {
  return withSlot(async () => {
    const cache = await frameCache();
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) {
          return await hit.arrayBuffer();
        }
      } catch {
        // the cache is a convenience
      }
    }
    const res = await fetch(url);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (cache) {
      try {
        await cache.put(url, res.clone());
      } catch {
        // not kept, then
      }
    }
    return res.arrayBuffer();
  });
}

/** The most recent deflated frame bodies, by file, across every take. */
const FRAME_LRU_MAX = 600;
const frameLru = new Map<string, Promise<ArrayBuffer | null>>();

function fetchFrameFile(url: string): Promise<ArrayBuffer | null> {
  const hit = frameLru.get(url);
  if (hit) {
    frameLru.delete(url);
    frameLru.set(url, hit);
    return hit;
  }
  const p = fetchFile(url).catch((e) => {
    frameLru.delete(url);
    throw e;
  });
  frameLru.set(url, p);
  while (frameLru.size > FRAME_LRU_MAX) {
    const oldest = frameLru.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    frameLru.delete(oldest);
  }
  return p;
}

// ---------------------------------------------------------------- the take

export class CloudTake {
  readonly expId: string;
  readonly recordingId: string;
  readonly kind: 'recording' | 'photo';
  /** Frames the take has (photos, for a set). */
  readonly frameCount: number;
  readonly timelapse: boolean;
  readonly timelapseSpec: { intervalSec: number; plannedSec?: number; pausedSec?: number } | null;
  /** Real seconds between frames; 0 for a photo set (no time axis). */
  readonly secondsPerFrame: number;
  /** Real seconds the take covers. */
  readonly spanSec: number;
  readonly emissivity: number | null;
  readonly cameraModel: string | null;
  /** When the take started, epoch ms, when the doc says. */
  readonly startedAt: number | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly sensors: CloudSensor[];
  /** Recording-frame numbers (1-based) of each player index: a clipped copy keeps only its segments' frames. */
  private readonly frames: number[] | null;
  private visibleBlobs = new Map<number, Promise<Blob | null>>();
  private visibleImages = new Map<number, Promise<HTMLImageElement | null>>();
  private stats: Promise<FrameStatsFile | null> | null = null;

  constructor(
    readonly take: Take,
    expId: string,
    d: ExperimentDoc,
    sensors: CloudSensor[],
  ) {
    this.expId = expId;
    this.recordingId = d.recordingId ?? '';
    const photos = d.sourceType === ExperimentType.Photos;
    this.kind = photos ? 'photo' : 'recording';
    const interval = d.timelapse?.intervalSec;
    this.timelapse = !photos && typeof interval === 'number' && Number.isFinite(interval) && interval > 0;
    this.timelapseSpec = this.timelapse ? d.timelapse! : null;
    this.secondsPerFrame = photos ? 0 : this.timelapse ? interval! : 1 / FPS;
    // a clipped copy: its frames are the segments' (recording-frame indexes, both ends included)
    const segments = Array.isArray(d.segments)
      ? d.segments.filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end))
      : [];
    if (!photos && segments.length > 0) {
      const list: number[] = [];
      for (const s of segments) {
        for (let n = Math.max(0, Math.floor(s.start)); n <= Math.floor(s.end); n++) {
          list.push(n + 1);
        }
      }
      this.frames = list;
      this.frameCount = list.length;
    } else {
      this.frames = null;
      const n = photos ? d.photoCount : d.frameCount;
      this.frameCount =
        typeof n === 'number' && Number.isFinite(n) && n >= 1
          ? Math.floor(n)
          : photos
            ? 0
            : Math.max(0, Math.round((Number.isFinite(d.duration) ? d.duration : 0) * FPS));
    }
    this.spanSec = photos
      ? 0
      : this.timelapse
        ? Math.max(0, this.frameCount - 1) * this.secondsPerFrame
        : this.frameCount / FPS;
    const em = (d as { emissivity?: unknown }).emissivity;
    this.emissivity = typeof em === 'number' && Number.isFinite(em) ? em : null;
    this.cameraModel = typeof d.cameraModel === 'string' && d.cameraModel.trim() ? d.cameraModel.trim() : null;
    this.startedAt =
      typeof d.startedAt === 'number' && Number.isFinite(d.startedAt) && d.startedAt > 0 ? d.startedAt : null;
    this.title = typeof d.displayName === 'string' && d.displayName.trim() ? d.displayName.trim() : null;
    this.description = typeof d.description === 'string' && d.description.trim() ? d.description.trim() : null;
    this.sensors = sensors;
  }

  /** The take has temperature data to read. */
  get hasData(): boolean {
    return this.recordingId !== '' && this.frameCount > 0;
  }

  /** Seconds of player index `i` (0-based). */
  timeOf(i: number): number {
    return this.kind === 'photo' ? 0 : Math.max(0, i) * this.secondsPerFrame;
  }

  /** The player index (0-based) nearest to `t` seconds; a photo set reads `t` as the photo's number. */
  frameAt(t: number): number {
    if (this.frameCount <= 1) {
      return 0;
    }
    const i = this.kind === 'photo' ? Math.round(t) - 1 : Math.round(Math.max(0, t) / this.secondsPerFrame);
    return Math.min(this.frameCount - 1, Math.max(0, i));
  }

  /** The recording-frame number (1-based, the file's N) of player index `i`. */
  recordingIndex(i: number): number {
    return this.frames ? (this.frames[i] ?? i + 1) : i + 1;
  }

  private url(i: number, ext: 'dat' | 'jpg'): string {
    const n = this.recordingIndex(i);
    return fileUrl(this.recordingId, ext === 'dat' ? `data_${n}.dat` : `vis_${n}.jpg`);
  }

  /** The deflated body of frame `i`'s data_N.dat (the object the website's decoders key their caches on). */
  async deflated(i: number): Promise<ArrayBuffer> {
    if (!this.hasData || i < 0 || i >= this.frameCount) {
      throw new FrameUnreadable(`There is no frame ${i} in this take.`);
    }
    let buf: ArrayBuffer | null;
    try {
      buf = await fetchFrameFile(this.url(i, 'dat'));
    } catch (e) {
      throw new FrameUnreadable(`Frame ${i} could not be read (${(e as Error)?.message ?? e}).`);
    }
    if (!buf) {
      throw new FrameUnreadable(`Frame ${i} is missing from the cloud copy.`);
    }
    return buf;
  }

  /** The inflated .dat body of frame `i` (four bytes a cell), as the sandbox's frame codec takes it. */
  async inflated(i: number): Promise<Uint8Array> {
    const buf = await this.deflated(i);
    try {
      return Pako.inflate(buf);
    } catch {
      throw new FrameUnreadable(`Frame ${i} is not a thermal frame.`);
    }
  }

  /** Frame `i`'s temperatures (°C, 120 × 160 row-major). */
  async celsius(i: number): Promise<Float32Array> {
    const buf = await this.deflated(i);
    try {
      return getDecodedFrame(buf).temps;
    } catch {
      throw new FrameUnreadable(`Frame ${i} is not a thermal frame.`);
    }
  }

  /** One sensor's reading on frame `i`, as the analyzer reads it: a spot's value, a line's highest reading. */
  async sensorValue(s: CloudSensor, i: number): Promise<number> {
    const buf = await this.deflated(i);
    if (s.thermometer) {
      return getThermometerValue(buf, s.thermometer);
    }
    if (s.x1 != null && s.y1 != null && s.x2 != null && s.y2 != null) {
      let m = -Infinity;
      for (const p of linePoints(s.x1, s.y1, s.x2, s.y2)) {
        const v = getTemperatureAtPosition(buf, p.fx, p.fy);
        if (Number.isFinite(v) && v > m) {
          m = v;
        }
      }
      return Number.isFinite(m) ? m : NaN;
    }
    return NaN;
  }

  private visibleBlob(i: number): Promise<Blob | null> {
    const hit = this.visibleBlobs.get(i);
    if (hit) {
      return hit;
    }
    const p = (async () => {
      if (!this.hasData || i < 0 || i >= this.frameCount) {
        return null;
      }
      const buf = await fetchFile(this.url(i, 'jpg'));
      return buf ? new Blob([buf], { type: 'image/jpeg' }) : null;
    })().catch(() => {
      // a failed read is not kept: the next look asks again
      this.visibleBlobs.delete(i);
      return null;
    });
    this.visibleBlobs.set(i, p);
    // the blobs of a long take are not all kept
    if (this.visibleBlobs.size > 120) {
      const oldest = this.visibleBlobs.keys().next().value;
      if (oldest !== undefined && oldest !== i) {
        this.visibleBlobs.delete(oldest);
      }
    }
    return p;
  }

  /** Frame `i`'s visible-light picture, decoded for a canvas; null when the take kept none (a 404, remembered). */
  visible(i: number): Promise<HTMLImageElement | null> {
    const hit = this.visibleImages.get(i);
    if (hit) {
      return hit;
    }
    const p = this.visibleBlob(i).then((blob) => (blob ? loadImage(blob) : null));
    this.visibleImages.set(i, p);
    if (this.visibleImages.size > 120) {
      const oldest = this.visibleImages.keys().next().value;
      if (oldest !== undefined && oldest !== i) {
        this.visibleImages.delete(oldest);
      }
    }
    return p;
  }

  /** Frame `i`'s visible-light picture as a data URL (what the sandbox's `visible(i)` is answered with); null when none. */
  async visibleDataUrl(i: number): Promise<string | null> {
    const blob = await this.visibleBlob(i);
    return blob ? blobToDataUrl(blob) : null;
  }

  /** The take kept visible-light pictures (its first frame has one). */
  async visibleLightKept(): Promise<boolean> {
    return this.frameCount > 0 && (await this.visibleBlob(0)) != null;
  }

  /** The recording's block statistics (frame-stats.bin), when the upload carried them. Null for a photo set or without the file. */
  frameStats(): Promise<FrameStatsFile | null> {
    if (!this.stats) {
      this.stats = (async () => {
        if (this.kind !== 'recording' || !this.hasData) {
          return null;
        }
        try {
          const buf = await fetchFile(fileUrl(this.recordingId, 'frame-stats.bin'));
          return buf ? parseFrameStats(new Uint8Array(buf)) : null;
        } catch {
          return null;
        }
      })();
    }
    return this.stats;
  }
}

function loadImage(blob: Blob): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** Measure points along a line: one per pixel of its length, at least 2, at most 160 (as the app's linePoints). */
export function linePoints(x1: number, y1: number, x2: number, y2: number): { fx: number; fy: number }[] {
  const len = Math.hypot((x2 - x1) * 120, (y2 - y1) * 160);
  const count = Math.max(2, Math.min(160, Math.round(len)));
  const out: { fx: number; fy: number }[] = [];
  for (let k = 0; k < count; k++) {
    const f = k / (count - 1);
    out.push({ fx: x1 + (x2 - x1) * f, fy: y1 + (y2 - y1) * f });
  }
  return out;
}

// --------------------------------------------------------------- sensors

/** The experiment's sensors in the app's shape: its thermometers (T1, T2, … in the analyzer's order), then its temperature lines (L1, …). */
async function readSensors(expId: string, d: ExperimentDoc): Promise<CloudSensor[]> {
  const out: CloudSensor[] = [];
  try {
    const me = useCommonStore.getState().user?.id;
    const coll = collection(firebaseDatabase, `experiments/${expId}/thermometers`);
    // "rules are not filters": the query matches the read rule (own docs, or the shared ones)
    const q =
      me && me === d.ownerId
        ? query(coll, where('ownerId', '==', me))
        : query(coll, where('visibility', 'in', [Visibility.Public, Visibility.Unlisted]));
    const snap = await getDocs(q);
    snap.docs.forEach((s, i) => {
      const t = s.data() as Thermometer;
      if (typeof t.x !== 'number' || typeof t.y !== 'number') {
        return;
      }
      const shaped =
        t.measuringAreaType === MeasuringAreaType.Rectangle || t.measuringAreaType === MeasuringAreaType.Ellipse;
      out.push({
        label: t.name?.trim() || `T${i + 1}`,
        kind: 'spot',
        thermometer: t,
        x: t.x,
        y: t.y,
        area: shaped
          ? {
              kind: t.measuringAreaType === MeasuringAreaType.Rectangle ? 'rect' : 'ellipse',
              w: t.measuringAreaWidth ?? 0.15,
              h: t.measuringAreaHeight ?? 0.15,
            }
          : undefined,
      });
    });
  } catch {
    // no sensors, then: the overview says none
  }
  (Array.isArray(d.profileLines) ? d.profileLines : []).forEach((l, i) => {
    if ([l.x1, l.y1, l.x2, l.y2].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      out.push({ label: l.name?.trim() || `L${i + 1}`, kind: 'line', x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 });
    }
  });
  return out;
}

/** The sensors as marks for the pictures (render.ts). */
export function marksOf(d: CloudTake): Mark[] {
  return d.sensors.map((s) =>
    s.kind === 'line'
      ? { label: s.label, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }
      : { label: s.label, x: s.x, y: s.y, shape: s.area?.kind ?? 'point', w: s.area?.w, h: s.area?.h },
  );
}

/** Where a sensor reads, rounded, for the overview's JSON. */
export const sensorPlace = (s: CloudSensor): Record<string, unknown> =>
  s.kind === 'line'
    ? { label: s.label, line: [s.x1!, s.y1!, s.x2!, s.y2!].map(r3) }
    : { label: s.label, at: [r3(s.x!), r3(s.y!)], area: s.area && s.area.kind !== 'point' ? s.area : null };

// ------------------------------------------------------------- take cache

const opened = new Map<string, { at: number; data: Promise<CloudTake> }>();

/**
 * The take's cloud copy, opened at most once in five minutes (the tools of
 * one turn share it). A take with no copy in the cloud cannot be opened
 * here at all.
 */
export function openCloudTake(take: Take): Promise<CloudTake> {
  const expId = take.cloud?.expId;
  if (!expId) {
    return Promise.reject(new TakeUnavailable(PHONE_ONLY_TEXT));
  }
  const hit = opened.get(take.takeId);
  if (hit && Date.now() - hit.at < 5 * 60_000) {
    return hit.data;
  }
  const data = (async () => {
    const snap = await getDoc(doc(firebaseDatabase, 'experiments', expId)).catch((e) => {
      throw new TakeUnavailable(`The cloud copy of "${take.name}" could not be read (${(e as Error)?.message ?? e}).`);
    });
    if (!snap.exists()) {
      throw new TakeUnavailable(`The cloud copy of "${take.name}" is gone.`);
    }
    const d = snap.data() as ExperimentDoc;
    if (d.sourceType !== ExperimentType.Recording && d.sourceType !== ExperimentType.Photos) {
      throw new TakeUnavailable(`The cloud copy of "${take.name}" is not a recording or a photo set.`);
    }
    return new CloudTake(take, expId, d, await readSensors(expId, d));
  })();
  opened.set(take.takeId, { at: Date.now(), data });
  data.catch(() => opened.delete(take.takeId));
  return data;
}

/** Drop the opened copy (the take changed). */
export function forgetCloudTake(takeId: string): void {
  opened.delete(takeId);
}

// ---------------------------------------------------------------- reading

const r2 = (x: number) => Math.round(x * 100) / 100;

const spanCache = new Map<string, Promise<{ min: number; max: number }>>();

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  return n === 0 ? NaN : sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
}

/**
 * One colour scale for a whole take: the 0.5th–99.5th percentile of every
 * pixel over a dozen frames spread across it (a still: its one frame) — the
 * app's takeSpan, so a thermal picture is coloured the same on both.
 */
export function takeSpan(d: CloudTake): Promise<{ min: number; max: number }> {
  const hit = spanCache.get(d.take.takeId);
  if (hit) {
    return hit;
  }
  const p = (async () => {
    const count = Math.min(d.frameCount, 12);
    const picks: number[] = [];
    for (let k = 0; k < count; k++) {
      picks.push(count <= 1 ? 0 : Math.round((k * (d.frameCount - 1)) / (count - 1)));
    }
    const values: number[] = [];
    const frames = await Promise.all(picks.map((i) => d.celsius(i).catch(() => null)));
    for (const c of frames) {
      if (!c) {
        continue;
      }
      for (let i = 0; i < c.length; i += 3) {
        if (Number.isFinite(c[i])) {
          values.push(c[i]);
        }
      }
    }
    values.sort((a, b) => a - b);
    let min = percentile(values, 0.005);
    let max = percentile(values, 0.995);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 15;
      max = 35;
    }
    if (max - min < 2) {
      const mid = (max + min) / 2;
      min = mid - 1;
      max = mid + 1;
    }
    return { min: r2(min), max: r2(max) };
  })();
  spanCache.set(d.take.takeId, p);
  p.catch(() => spanCache.delete(d.take.takeId));
  return p;
}

/**
 * Read frames `indexes` (player indexes) through `fn`, in order, at most
 * CONCURRENCY in flight; a frame that cannot be read gives `fn` null.
 * `onProgress` hears how many are done.
 */
export async function readFrames<T>(
  d: CloudTake,
  indexes: readonly number[],
  fn: (i: number, celsius: Float32Array | null, deflated: ArrayBuffer | null) => T | Promise<T>,
  onProgress?: (done: number) => void,
): Promise<T[]> {
  const out: T[] = new Array(indexes.length);
  const BATCH = CONCURRENCY * 4;
  for (let b = 0; b < indexes.length; b += BATCH) {
    const slice = indexes.slice(b, b + BATCH);
    await Promise.all(
      slice.map(async (i, k) => {
        let buf: ArrayBuffer | null = null;
        let c: Float32Array | null = null;
        try {
          buf = await d.deflated(i);
          c = getDecodedFrame(buf).temps;
        } catch {
          buf = null;
          c = null;
        }
        out[b + k] = await fn(i, c, buf);
      }),
    );
    onProgress?.(Math.min(indexes.length, b + BATCH));
  }
  return out;
}
