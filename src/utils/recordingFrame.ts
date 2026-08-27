import { getBlob, getBytes, ref } from 'firebase/storage';
import { firebaseStorage } from '../services/firebase';
import { ViewMode } from '../types';

// Storage file for each ViewMode render. MUST mirror VIEW_MODE_FILE in ImagePlayer (which builds the
// same paths for playback): data_N.png is the palette render every recording has; app-captured
// recordings additionally upload vis_N.jpg (visible-light still) and mix_N.jpg (the MSX blend), and a
// legacy/telelab recording has neither — so a vis/mix fetch can 404 even mid-clip.
const VIEW_MODE_FILE: Record<ViewMode, (n: number) => string> = {
  ir: (n) => `data_${n}.png`,
  visible: (n) => `vis_${n}.jpg`,
  blended: (n) => `mix_${n}.jpg`,
};

/**
 * Fetch one render of a recording's frame (N in recording-frame space) as a data URL. Used to rebuild a
 * key-moment thumbnail after reload, where only the frame index is persisted (never the full-frame data
 * URL), and to switch the Q&A lightbox between the frame's IR / visible / blended renders. Defaults to
 * IR because that is the one render every recording is guaranteed to have; asking for visible/blended
 * rejects on a recording (or a frame) that never uploaded one. Videos have no CORS-safe frame image, so
 * this is recording-only.
 */
export async function fetchRecordingFrameDataUrl(
  recordingId: string,
  recordingIndex: number,
  mode: ViewMode = 'ir',
): Promise<string> {
  const blob = await getBlob(ref(firebaseStorage, `recordings/${recordingId}/${VIEW_MODE_FILE[mode](recordingIndex)}`));
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
