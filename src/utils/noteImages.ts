/**
 * Pictures the owner attaches to a revision note on a scene twin (docs/digital-twin-plan.md §28) — a
 * marked-up view of the model, a photo of the real thing, a sketch — sized for a model call rather than
 * for keeping: the longer edge at most NOTE_IMAGE_MAX_EDGE px, JPEG, so three of them stay far under the
 * callable's request limit and the server's cap on each (TWIN_NOTE_IMAGE_MAX_BYTES in
 * functions/src/twinBuilding.ts). The record keeps only how many went with the note.
 */
export interface TwinNoteImage {
  /** Base64 JPEG bytes, without the data-URL prefix — what the callable sends. */
  data: string;
  mediaType: 'image/jpeg';
  /** A data URL of the same picture, for the thumbnail. */
  preview: string;
  /** The file's name, or what the picture is ('this view'). */
  name: string;
}

/** At most this many pictures with one note (TWIN_NOTE_IMAGES_MAX server-side). */
export const NOTE_IMAGES_MAX = 3;
export const NOTE_IMAGE_MAX_EDGE = 1280;
const JPEG_QUALITY = 0.85;

/** The picture decoded: a bitmap (upright — a phone photo carries its rotation in EXIF, which
 *  createImageBitmap applies), else an image element for a data URL or a browser without bitmaps. */
async function decode(source: File | Blob | string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof source !== 'string' && typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(source, { imageOrientation: 'from-image' });
    } catch {
      // Not a picture createImageBitmap reads: the element may still.
    }
  }
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The picture could not be decoded.'));
      img.src = url;
    });
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

/** A file, blob or data URL as a note picture: decoded, scaled to the edge cap, flattened onto white (a
 *  transparent PNG must not go black), re-encoded as JPEG. Throws when the picture cannot be read. */
export async function readNoteImage(source: File | Blob | string, name = ''): Promise<TwinNoteImage> {
  const picture = await decode(source);
  const w = 'naturalWidth' in picture ? picture.naturalWidth : picture.width;
  const h = 'naturalHeight' in picture ? picture.naturalHeight : picture.height;
  if (!w || !h) throw new Error('The picture is empty.');
  const scale = Math.min(1, NOTE_IMAGE_MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The picture could not be drawn.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
  if ('close' in picture) picture.close();
  const preview = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return { data: preview.slice(preview.indexOf(',') + 1), mediaType: 'image/jpeg', preview, name };
}
