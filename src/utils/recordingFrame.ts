import { getBlob, ref } from 'firebase/storage';
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
