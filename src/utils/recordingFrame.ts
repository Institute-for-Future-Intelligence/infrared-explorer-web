import { getBlob, getBytes, ref } from 'firebase/storage';
import { firebaseStorage } from '../services/firebase';
import { ViewMode } from '../types';
import { synthesizeBlended } from './msxSynth';

// Storage file for each ViewMode render. MUST mirror VIEW_MODE_FILE in ImagePlayer (which builds the
// same paths for playback): data_N.png is the palette render every recording has; app-captured
// recordings additionally upload vis_N.jpg (visible-light still) and, before 2026-10-08, mix_N.jpg (FLIR's
// MSX blend), and a legacy/telelab recording has neither — so a vis/mix fetch can 404 even mid-clip.
const VIEW_MODE_FILE: Record<ViewMode, (n: number) => string> = {
  ir: (n) => `data_${n}.png`,
  visible: (n) => `vis_${n}.jpg`,
  blended: (n) => `mix_${n}.jpg`,
};

/**
 * Fetch one render of a recording's frame (N in recording-frame space) as a data URL. Used to rebuild a
 * key-moment thumbnail after reload, where only the frame index is persisted (never the full-frame data
 * URL), and to switch the Q&A lightbox between the frame's IR / visible / blended renders. Defaults to
 * IR because that is the one render every recording is guaranteed to have. Blended is the uploaded
 * mix_N.jpg where there is one, else synthesized from the infrared render and vis_N.jpg with the app's
 * recipe (msxSynth) — so asking for visible or blended rejects only on a recording (or a frame) that never
 * uploaded a visible-light still. Videos have no CORS-safe frame image, so this is recording-only.
 */
export async function fetchRecordingFrameDataUrl(
  recordingId: string,
  recordingIndex: number,
  mode: ViewMode = 'ir',
): Promise<string> {
  const at = (file: string) => getBlob(ref(firebaseStorage, `recordings/${recordingId}/${file}`));
  let blob: Blob;
  if (mode !== 'blended') {
    blob = await at(VIEW_MODE_FILE[mode](recordingIndex));
  } else {
    blob = await at(VIEW_MODE_FILE.blended(recordingIndex)).catch(async () => {
      const [ir, vis] = await Promise.all([
        at(VIEW_MODE_FILE.ir(recordingIndex)),
        at(VIEW_MODE_FILE.visible(recordingIndex)),
      ]);
      return synthesizeBlended(ir, vis);
    });
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => (reader.result ? resolve(reader.result as string) : reject(new Error('empty frame read')));
    reader.onerror = () => reject(reader.error ?? new Error('frame read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Fetch a recording's raw thermal frame (data_N.dat, N in recording-frame space) — the pako-deflated
 * 120×160 buffer the player reads temperatures from. Used to recompute a key moment's thermometer
 * readings from its frame (readings are never persisted, and recomputing keeps them true to where the
 * probes sit now). A video keeps its whole clip's frames in the showcase thermal cache instead, so
 * this is recording-only.
 */
export async function fetchRecordingFrameBuffer(recordingId: string, recordingIndex: number): Promise<ArrayBuffer> {
  return getBytes(ref(firebaseStorage, `recordings/${recordingId}/data_${recordingIndex}.dat`));
}

/**
 * A small shared cache in front of fetchRecordingFrameBuffer for consumers that walk many frames of
 * one recording — the digital twin following the playhead, its camera-motion gate. The player keeps its own
 * per-instance cache keyed by player index; this one is keyed by recording index and survives tab
 * switches, so a frame the twin already painted is not fetched again when the user scrubs back.
 * In-flight requests are shared (the promise is cached), and a failed fetch is dropped so it can be
 * retried. Bounded to keep a long recording from pinning hundreds of buffers.
 */
// 1500 frames × ~29 KB deflated ≈ 43 MB: five minutes of a recording the twin's heat map follows
// (plan §43.3) stay in, so a scrub back is painted from memory.
const FRAME_BUFFER_CACHE_MAX = 1500;
const frameBufferCache = new Map<string, Promise<ArrayBuffer>>();

export function fetchRecordingFrameBufferCached(recordingId: string, recordingIndex: number): Promise<ArrayBuffer> {
  const key = `${recordingId}/${recordingIndex}`;
  const hit = frameBufferCache.get(key);
  if (hit) {
    // Refresh recency (Map keeps insertion order; the oldest entry is the first).
    frameBufferCache.delete(key);
    frameBufferCache.set(key, hit);
    return hit;
  }
  const p = fetchRecordingFrameBuffer(recordingId, recordingIndex).catch((e) => {
    frameBufferCache.delete(key);
    throw e;
  });
  frameBufferCache.set(key, p);
  while (frameBufferCache.size > FRAME_BUFFER_CACHE_MAX) {
    const oldest = frameBufferCache.keys().next().value;
    if (oldest === undefined) break;
    frameBufferCache.delete(oldest);
  }
  return p;
}
