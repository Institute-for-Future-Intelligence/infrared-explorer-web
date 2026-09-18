/*
 * Street-view bake — the one-file artefacts behind an APP-UPLOADED panorama.
 *
 * An upload from the app is 4 × N objects under streetviews/{svId}/ (the recording contract,
 * app src/lib/recordingUpload.ts): data_N.dat (120×160 temperatures), data_N.png (the palette
 * render of that grid, upsampled to the camera's 1080×1440), and the optional mix_N.jpg
 * (MSX blend) / vis_N.jpg (visible light) the FLIR camera also produced. Nothing in that set
 * is something a viewer can LOOK AROUND in: the app's panorama player and the web viewer both
 * scrub ONE mp4 (app streetViewBrowse.ts stream path; web streetViewViewer.tsx 'video' mode),
 * and an upload had none — so both fell back to fetching one ~400 KB frame per drag step,
 * served `private, max-age=0`, 110 round trips for a turn. Measured on the first upload
 * (Greenleaf st, 110 shots, 2026-09-18): 242 ms per frame from a wired desktop, ~27 s of
 * network for one 360°, the app clamping look-around to the frames that had landed so far —
 * "the view does not move, then jumps", identically in both clients.
 *
 * The seeded map never had this problem because its 236 legacy clips were baked OFFLINE
 * (scripts/streamAll.mjs → stream.mp4; scripts/stitchAll.mjs → pano.jpg). This module is the
 * same all-intra recipe applied to an upload: run by a Cloud Function when the doc is created
 * (index.ts onStreetViewCreated), by the daily sweeper for anything that slipped through, and
 * by scripts/bakeStreetViews.mjs for backfill. See docs/street-view-bake.md.
 *
 * Written under streetviews/{svId}/ (same prefix, so takedown/quarantine/delete already
 * cover the bakes):
 *   stream_mix.mp4  the MSX blend       (when every mix_N.jpg exists) — 720 px wide
 *   stream_ir.mp4   the palette render  (always: data_N.png is the contract) — 480 px wide,
 *                   already 4× the 120×160 sensor behind it
 *   stream_vis.mp4  visible light       (when every vis_N.jpg exists) — 720 px wide
 * Stamped on the doc:
 *   streamUrl        the DEFAULT stream — the blend when there is one, else the IR render:
 *                    the view the app's own player shows for the same capture (meta.tracks
 *                    .video, blended > ir > visible). Clients that predate the tracks read
 *                    only this field.
 *   streamView       which view streamUrl shows: 'blended' | 'ir' | 'visible'
 *   streamIrUrl / streamMixUrl / streamVisUrl   every track that was baked
 *   videoDurationSec the CONTENT duration (frameCount / 5) — the frame→time basis both
 *                    viewers seek by (app src/lib/panoSeek.ts). The file itself is 8 s
 *                    longer: tail-padded like streamAll.mjs so the last frames of the sweep
 *                    never sit in ExoPlayer's near-EOS zone.
 *   streamFrameCount, bakeVersion, bakedAt
 * Every frame object also gets Cache-Control: the create-only upload rule leaves the app no
 * way to set it, so the data_N.dat the web still reads for temperatures were served
 * uncacheable too.
 *
 * The decisions (bakeDecision, ffmpegStreamArgs, bakeDocPatch, …) are pure and unit tested;
 * bakeStreetView() is the IO around them with its dependencies injected.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Bump when the recipe changes in a way worth re-baking every upload for. */
export const STREET_BAKE_VERSION = 1;

/** The upload's frame clock (app recordingFormat.RECORDING_FPS; web constants FPS). */
export const STREET_STREAM_FPS = 5;

/** Seconds of the last frame cloned onto the tail of every stream (streamAll.mjs PAD_SEC). */
export const STREET_STREAM_PAD_SEC = 8;

/**
 * Uploads are UGC: a takedown moves the objects, but a copy already in a browser or edge
 * cache serves until it expires, so a day — not the seeds' year — is the longest a removed
 * panorama may linger. The app downloads to disk and never depends on this.
 */
export const UGC_CACHE_CONTROL = 'public, max-age=86400';

export type StreetTrack = 'mix' | 'ir' | 'vis';

/** The playback view a track is (app files.ts PlaybackMode). */
export type StreetView = 'blended' | 'ir' | 'visible';

export interface TrackSpec {
  track: StreetTrack;
  view: StreetView;
  /** Storage object name of the source frame N. */
  source: (n: number) => string;
  /** Storage object name of the baked stream. */
  object: string;
  /** Doc field the stream's URL is stamped on. */
  field: 'streamMixUrl' | 'streamIrUrl' | 'streamVisUrl';
  /** Width the stream is scaled to (never upscaled). */
  width: number;
  /** x264 quality. */
  crf: number;
  /** Always present on an upload (the cloud contract) — a missing frame is an error, not a skip. */
  required: boolean;
}

/**
 * In DEFAULT-VIEW order: the first track that bakes becomes `streamUrl`. Mirrors the app's
 * own choice of what a bundle's video.mp4 shows (blended > ir > visible).
 */
export const TRACKS: readonly TrackSpec[] = [
  {
    track: 'mix',
    view: 'blended',
    source: (n) => `mix_${n}.jpg`,
    object: 'stream_mix.mp4',
    field: 'streamMixUrl',
    width: 720,
    crf: 24,
    required: false,
  },
  {
    track: 'ir',
    view: 'ir',
    source: (n) => `data_${n}.png`,
    object: 'stream_ir.mp4',
    field: 'streamIrUrl',
    width: 480,
    crf: 22,
    required: true,
  },
  {
    track: 'vis',
    view: 'visible',
    source: (n) => `vis_${n}.jpg`,
    object: 'stream_vis.mp4',
    field: 'streamVisUrl',
    width: 720,
    crf: 24,
    required: false,
  },
];

export type BakeSkipReason = 'missing' | 'legacy' | 'not-pano' | 'too-few-frames' | 'baked';

export type BakeDecision = { bake: true; frameCount: number } | { bake: false; reason: BakeSkipReason };

/** How many frames the upload claims: shots[] (app upload), else the seed-shaped arrays. */
export function bakeFrameCount(doc: Record<string, unknown> | undefined): number {
  if (!doc) return 0;
  if (Array.isArray(doc.shots) && doc.shots.length > 0) return doc.shots.length;
  if (Array.isArray(doc.azimuthDeg) && doc.azimuthDeg.length > 0) return doc.azimuthDeg.length;
  return typeof doc.frameCount === 'number' && doc.frameCount > 0 ? Math.floor(doc.frameCount) : 0;
}

/**
 * Whether a doc is an upload that needs baking. The seeded panoramas (ownerId 'system',
 * `legacy`, or a `virUrl`) are baked by the offline scripts and never touched here; a doc
 * already at this bake version is skipped unless `redo`.
 */
export function bakeDecision(doc: Record<string, unknown> | undefined, opts: { redo?: boolean } = {}): BakeDecision {
  if (!doc) return { bake: false, reason: 'missing' };
  if (doc.ownerId === 'system' || doc.legacy === true || typeof doc.virUrl === 'string') {
    return { bake: false, reason: 'legacy' };
  }
  if (doc.sourceType !== undefined && doc.sourceType !== 'pano') return { bake: false, reason: 'not-pano' };
  const frameCount = bakeFrameCount(doc);
  if (frameCount < 2) return { bake: false, reason: 'too-few-frames' };
  const version = typeof doc.bakeVersion === 'number' ? doc.bakeVersion : 0;
  if (!opts.redo && typeof doc.streamUrl === 'string' && version >= STREET_BAKE_VERSION) {
    return { bake: false, reason: 'baked' };
  }
  return { bake: true, frameCount };
}

/** Which tracks the objects under the prefix can bake: every frame 1..N of the source present. */
export function completeTracks(objectNames: ReadonlySet<string>, frameCount: number): TrackSpec[] {
  return TRACKS.filter((t) => {
    for (let n = 1; n <= frameCount; n++) {
      if (!objectNames.has(t.source(n))) return false;
    }
    return true;
  });
}

/** Frame numbers of a track's source missing under the prefix (for the error message). */
export function missingFrames(objectNames: ReadonlySet<string>, spec: TrackSpec, frameCount: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= frameCount; n++) {
    if (!objectNames.has(spec.source(n))) out.push(n);
  }
  return out;
}

/**
 * The all-intra recipe (streamAll.mjs, adapted to an image sequence): every frame a keyframe
 * so any seek decodes exactly one picture; 5 fps input clock; the last frame cloned for
 * PAD_SEC; scaled down (never up) to the track's width, even dimensions for yuv420p; moov up
 * front so a browser can seek before the file has fully arrived.
 */
export function ffmpegStreamArgs(
  inputPattern: string,
  outPath: string,
  spec: Pick<TrackSpec, 'width' | 'crf'>,
): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    String(STREET_STREAM_FPS),
    '-start_number',
    '1',
    '-i',
    inputPattern,
    '-an',
    '-vf',
    // The comma inside min() is escaped so the filter graph does not read it as an
    // argument separator; the args go to execFile, so there is no shell layer to please.
    `scale=w=min(${spec.width}\\,iw):h=-2,tpad=stop_mode=clone:stop_duration=${STREET_STREAM_PAD_SEC}`,
    '-c:v',
    'libx264',
    '-g',
    '1',
    '-keyint_min',
    '1',
    '-sc_threshold',
    '0',
    '-crf',
    String(spec.crf),
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outPath,
  ];
}

/** Content duration the viewers map frame→time against (before the tail pad). */
export function contentDurationSec(frameCount: number): number {
  return frameCount / STREET_STREAM_FPS;
}

/** The public download URL the viewers already use for streetviews/** (anonymously readable). */
export function storageMediaUrl(bucketName: string, objectPath: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media`;
}

/** The Firestore update for a finished bake. `baked` is in TRACKS order, so [0] is the default. */
export function bakeDocPatch(args: {
  bucketName: string;
  svId: string;
  baked: readonly TrackSpec[];
  frameCount: number;
  now: Date;
}): Record<string, unknown> {
  if (args.baked.length === 0) throw new Error('bakeDocPatch: no tracks baked');
  const url = (spec: TrackSpec) => storageMediaUrl(args.bucketName, `streetviews/${args.svId}/${spec.object}`);
  const patch: Record<string, unknown> = {
    streamUrl: url(args.baked[0]),
    streamView: args.baked[0].view,
    videoDurationSec: contentDurationSec(args.frameCount),
    streamFrameCount: args.frameCount,
    bakeVersion: STREET_BAKE_VERSION,
    bakedAt: args.now,
  };
  for (const spec of args.baked) patch[spec.field] = url(spec);
  return patch;
}

// ── IO ──────────────────────────────────────────────────────────────────────────

/** The slice of a Storage File the bake uses (so a test can hand in a fake). */
export interface BakeFile {
  name: string;
  download(options: { destination: string }): Promise<unknown>;
  setMetadata(metadata: { cacheControl: string }): Promise<unknown>;
}

export interface BakeBucket {
  name: string;
  getFiles(query: { prefix: string }): Promise<[BakeFile[], ...unknown[]]>;
  upload(
    localPath: string,
    options: { destination: string; metadata: { contentType: string; cacheControl: string } },
  ): Promise<unknown>;
}

export interface BakeDb {
  doc(path: string): {
    get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
    update(patch: Record<string, unknown>): Promise<unknown>;
  };
}

export interface BakeDeps {
  db: BakeDb;
  bucket: BakeBucket;
  /** Absolute path of an ffmpeg binary (ffmpeg-static). */
  ffmpegPath: string;
  /** Runs ffmpeg; injectable so a test needs no binary. Resolves when the output exists. */
  runFfmpeg?: (ffmpegPath: string, args: string[]) => Promise<void>;
  /** Where the frames and streams are staged (default: a fresh dir under os.tmpdir()). */
  workDir?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface BakeOptions {
  /** Re-bake even when the doc is already at STREET_BAKE_VERSION. */
  redo?: boolean;
  /**
   * Encode only: leave the streams in `workDir` and touch neither Storage nor the doc. For
   * looking at the output before the first real run (scripts/bakeStreetViews.mjs --out).
   */
  localOnly?: boolean;
  /** Parallel frame downloads. */
  downloadConcurrency?: number;
  /** Parallel Cache-Control updates on the frame objects. */
  metadataConcurrency?: number;
}

export interface BakedTrack {
  track: StreetTrack;
  view: StreetView;
  bytes: number;
  /** Where the stream is: the Storage object (uploaded) or the local file (localOnly). */
  location: string;
}

export type BakeResult =
  | { svId: string; baked: BakedTrack[]; skipped: StreetTrack[]; frameCount: number; framesRetagged: number }
  | { svId: string; skippedReason: BakeSkipReason };

const defaultRunFfmpeg = (ffmpegPath: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err)
        reject(
          new Error(
            `ffmpeg failed: ${String(stderr || err.message)
              .trim()
              .slice(-2000)}`,
          ),
        );
      else resolve();
    });
  });

/** Run `fn` over `items` with at most `limit` in flight. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = items.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** The frame objects an upload consists of — what gets retagged cacheable. */
export function isFrameObject(name: string): boolean {
  return /^(data_\d+\.(dat|png)|mix_\d+\.jpg|vis_\d+\.jpg)$/.test(name);
}

/**
 * Bake one street view: read the doc, list its frames, encode every complete track, upload
 * the streams, retag the frames cacheable, stamp the doc. Throws on a genuine failure (a
 * missing contract frame, ffmpeg, Storage) so a trigger retry / the sweeper sees it; a doc
 * that needs no bake resolves with `skippedReason`.
 */
export async function bakeStreetView(svId: string, deps: BakeDeps, opts: BakeOptions = {}): Promise<BakeResult> {
  const log = deps.log ?? (() => undefined);
  const runFfmpeg = deps.runFfmpeg ?? defaultRunFfmpeg;
  const now = deps.now ?? (() => new Date());

  const ref = deps.db.doc(`streetviews/${svId}`);
  const snap = await ref.get();
  const decision = bakeDecision(snap.exists ? snap.data() : undefined, { redo: opts.redo });
  if (!decision.bake) {
    log(`${svId}: skip (${decision.reason})`);
    return { svId, skippedReason: decision.reason };
  }
  const { frameCount } = decision;

  const prefix = `streetviews/${svId}/`;
  const [files] = await deps.bucket.getFiles({ prefix });
  const byName = new Map<string, BakeFile>();
  for (const f of files) byName.set(f.name.slice(prefix.length), f);
  const names = new Set(byName.keys());

  const complete = completeTracks(names, frameCount);
  for (const spec of TRACKS) {
    if (spec.required && !complete.includes(spec)) {
      const missing = missingFrames(names, spec, frameCount);
      throw new Error(
        `${svId}: ${spec.source(1).replace('1', 'N')} incomplete — ${missing.length} of ${frameCount} missing (first: ${missing
          .slice(0, 5)
          .join(', ')})`,
      );
    }
  }
  const skipped = TRACKS.filter((t) => !complete.includes(t)).map((t) => t.track);
  log(
    `${svId}: ${frameCount} frames, baking ${complete.map((t) => t.track).join('+')}${
      skipped.length ? `, no ${skipped.join('/')}` : ''
    }`,
  );

  const ownWorkDir = !deps.workDir;
  const workDir = deps.workDir ?? (await mkdtemp(join(tmpdir(), `svbake-${svId}-`)));
  try {
    const baked: BakedTrack[] = [];
    for (const spec of complete) {
      const dir = join(workDir, spec.track);
      await mkdir(dir, { recursive: true });
      const ext = spec.source(1).split('.').pop();
      const frames = Array.from({ length: frameCount }, (_, i) => i + 1);
      await eachLimit(frames, opts.downloadConcurrency ?? 8, async (n) => {
        const file = byName.get(spec.source(n));
        if (!file) throw new Error(`${svId}: ${spec.source(n)} vanished during bake`);
        await file.download({ destination: join(dir, `f_${n}.${ext}`) });
      });
      const out = join(workDir, spec.object);
      await runFfmpeg(deps.ffmpegPath, ffmpegStreamArgs(join(dir, `f_%d.${ext}`), out, spec));
      const bytes = (await stat(out)).size;
      if (bytes <= 0) throw new Error(`${svId}: ffmpeg produced an empty ${spec.object}`);
      // The frames are not needed once encoded; a Cloud Function's /tmp is memory.
      await rm(dir, { recursive: true, force: true });
      let location = out;
      if (!opts.localOnly) {
        location = `${prefix}${spec.object}`;
        await deps.bucket.upload(out, {
          destination: location,
          metadata: { contentType: 'video/mp4', cacheControl: UGC_CACHE_CONTROL },
        });
        await rm(out, { force: true });
      }
      log(`${svId}: ${spec.object} ${(bytes / 1048576).toFixed(1)} MB${opts.localOnly ? ' (local)' : ''}`);
      baked.push({ track: spec.track, view: spec.view, bytes, location });
    }

    let framesRetagged = 0;
    if (!opts.localOnly) {
      // Every frame object, not just the ones a stream was cut from: the web reads data_N.dat
      // for temperatures on each frame it shows, and the app fetches the same for measuring.
      const frameObjects = files.filter((f) => isFrameObject(f.name.slice(prefix.length)));
      await eachLimit(frameObjects, opts.metadataConcurrency ?? 32, async (f) => {
        await f.setMetadata({ cacheControl: UGC_CACHE_CONTROL });
        framesRetagged += 1;
      });
      await ref.update(bakeDocPatch({ bucketName: deps.bucket.name, svId, baked: complete, frameCount, now: now() }));
      log(
        `${svId}: doc stamped (streamView=${complete[0].view}), ${framesRetagged} frames retagged ${UGC_CACHE_CONTROL}`,
      );
    }
    return { svId, baked, skipped, frameCount, framesRetagged };
  } finally {
    if (ownWorkDir && !opts.localOnly) await rm(workDir, { recursive: true, force: true });
  }
}
