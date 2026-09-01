/**
 * Validation for the one image a CLIENT is allowed to put in a prompt: the "moment capture" the analyzer
 * sends with a Q&A question — its own player as the student sees it, i.e. the frame plus the probe
 * markers, annotation callouts and transect lines drawn over it.
 *
 * Every other image an AI surface uses is produced server-side (a stored render, or a frame drawn from
 * the raw data). This one arrives as a data URL over a callable, so it gets its own small module: a
 * strict shape check, a hard size ceiling, and no path back to anything but "a picture in a prompt".
 * Rejection is silent and total — the caller then falls back to the stored renders, which is exactly what
 * a moment carried before captures existed.
 */

/** Size ceiling for one capture, in base64 characters (~1 MB decoded). The client caps its own capture
 *  well below this (768 px long edge, and JPEG instead of PNG past ~600 KB); this is the guard against a
 *  crafted request, not the normal path. */
export const CAPTURE_MAX_CHARS = 1_400_000;

/** What a capture may be encoded as. Deliberately just the two the browser's canvas produces: GIF and
 *  WEBP are accepted from Storage (where we wrote the bytes) but never from a client, and SVG — which is
 *  a document, not a bitmap — is refused outright. */
export type CaptureImage = { data: string; mediaType: 'image/png' | 'image/jpeg' };

/** Which view a capture is of — mirrors the client's ViewMode (src/types.ts). A recording can be watched
 *  as the IR render, the visible-light still or the blended MSX; a video only ever as 'ir'. */
export type CaptureView = 'ir' | 'visible' | 'blended';

// One canvas-produced data URL: no charset, no whitespace, no line breaks, padding only at the end.
const CAPTURE_DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Parse a client-supplied capture, or return null if it is anything other than a PNG/JPEG data URL
 * within the size cap. The base64 is not decoded here: it goes to the model provider as-is, so what
 * matters is that the label matches the shape and the payload cannot be smuggled past the cap.
 */
export function parseCaptureImage(value: unknown): CaptureImage | null {
  if (typeof value !== 'string' || value.length > CAPTURE_MAX_CHARS) return null;
  const parsed = CAPTURE_DATA_URL.exec(value);
  if (!parsed) return null;
  return { data: parsed[2], mediaType: parsed[1] === 'png' ? 'image/png' : 'image/jpeg' };
}

/** Normalize the claimed view of a capture. Anything unrecognised reads as 'ir' — the view every medium
 *  has, and the one a capture stands in for when the client says nothing. */
export function parseCaptureView(value: unknown): CaptureView {
  return value === 'visible' || value === 'blended' ? value : 'ir';
}
