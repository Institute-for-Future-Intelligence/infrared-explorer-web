import { getBlob, getBytes, ref } from 'firebase/storage';
import { firebaseStorage } from '../services/firebase';

/**
 * Fetch a recording's IR frame (data_N.png, N in recording-frame space) as a data URL. Used to rebuild a
 * key-moment thumbnail after reload, where only the frame index is persisted (never the full-frame data
 * URL). IR only — every recording has data_N.png (the vis/mix renders are optional per frame). Videos
 * have no CORS-safe frame image, so this is recording-only.
 */
export async function fetchRecordingFrameDataUrl(recordingId: string, recordingIndex: number): Promise<string> {
  const blob = await getBlob(ref(firebaseStorage, `recordings/${recordingId}/data_${recordingIndex}.png`));
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
