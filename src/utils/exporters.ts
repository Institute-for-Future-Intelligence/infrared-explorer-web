/** Client-side exporters (CSV is dependency-free; PNG uses html2canvas). */

import html2canvas from 'html2canvas';
import dayjs from 'dayjs';

/** A filesystem-safe timestamped filename, e.g. "lineplot-06-23-2026-14-08-31.png". */
export function timestampedName(prefix: string, ext: string): string {
  return `${prefix}-${dayjs().format('MM-DD-YYYY-HH-mm-ss')}.${ext}`;
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const escapeCSV = (value: unknown): string => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Download an array of row objects as a CSV file (columns taken from the first row, or `headers`). */
export function downloadCSV(filename: string, rows: Record<string, unknown>[], headers?: string[]) {
  if (!rows.length) return;
  const cols = headers ?? Object.keys(rows[0]);
  const lines = [cols.map(escapeCSV).join(',')];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCSV(row[c])).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

/** Download a data-URL (e.g. the current thermal frame) as a file. */
export function downloadDataURL(filename: string, dataURL: string) {
  triggerDownload(dataURL, filename);
}

/** How a capture is produced: shared by the PNG downloads and the data-URL capture below. */
interface CaptureOptions {
  /** Longest edge of the produced bitmap, in CSS pixels. Omitted = html2canvas's own default, which
   *  rasterizes at devicePixelRatio (what a downloaded screenshot wants on a HiDPI screen). */
  maxEdge?: number;
  /** Data URL swapped in for a cross-origin <video> inside the element (see captureElementImage). */
  replaceVideoWith?: string;
  /** Canvas background painted under the element. null = transparent (the PNG download's behaviour). */
  background?: string | null;
}

/**
 * Rasterize a DOM element (image + thermometer / annotation / isotherm overlays, or a chart) to a canvas.
 * Elements marked `data-html2canvas-ignore` (e.g. the chart menu button) are excluded. Throws if the
 * element's content is cross-origin tainted (e.g. a CORS-blocked <video>) — `replaceVideoWith` is the way
 * out of that: in html2canvas's CLONE only (the live DOM is never touched, so there's no flicker) the
 * <video> is swapped for that data URL — a false-colour render of the same frame — so the capture keeps
 * the frame plus every untainted overlay. The replacement fills the video's box (the media box is already
 * sized to the frame aspect, so there is no letterboxing to correct).
 */
async function renderElementToCanvas(element: HTMLElement, options: CaptureOptions = {}): Promise<HTMLCanvasElement> {
  const { maxEdge, replaceVideoWith, background = null } = options;
  const longEdge = Math.max(element.clientWidth || element.offsetWidth, element.clientHeight || element.offsetHeight);
  // Pin the raster scale only when a cap was asked for, and never above 1 — upscaling is bytes without
  // information. With no cap the key is left OUT entirely, which is what keeps html2canvas's
  // devicePixelRatio default (its options are assigned over the defaults, so an explicit
  // `scale: undefined` would blank it and give a NaN-sized canvas) — a download wants those retina pixels.
  const scaled = maxEdge === undefined ? {} : { scale: Math.min(1, maxEdge / longEdge) };
  return html2canvas(element, {
    backgroundColor: background,
    useCORS: true,
    logging: false,
    ...scaled,
    onclone: replaceVideoWith
      ? (_doc, clonedElement) => {
          const video = clonedElement.querySelector('video');
          if (!video) return;
          const img = clonedElement.ownerDocument.createElement('img');
          img.src = replaceVideoWith;
          img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;';
          video.replaceWith(img);
        }
      : undefined,
  });
}

/**
 * Rasterize a DOM element (image + thermometer/annotation/isotherm overlays, or a chart) to a PNG
 * and download it. Elements marked `data-html2canvas-ignore` (e.g. the chart menu button) are
 * excluded. Throws if the element's content is cross-origin tainted (e.g. a CORS-blocked <video>).
 */
export async function exportElementToPNG(element: HTMLElement, filename: string): Promise<void> {
  const canvas = await renderElementToCanvas(element);
  triggerDownload(canvas.toDataURL('image/png'), filename);
}

/**
 * Like exportElementToPNG, but for a container whose <video> is cross-origin tainted (a direct capture
 * throws): in html2canvas's clone the <video> is swapped for `replacementDataURL` (a false-colour render
 * of the same frame), so the export keeps the frame plus every untainted overlay (thermometers /
 * annotations / isotherms).
 */
export async function exportElementReplacingVideoToPNG(
  element: HTMLElement,
  filename: string,
  replacementDataURL: string,
): Promise<void> {
  const canvas = await renderElementToCanvas(element, { replaceVideoWith: replacementDataURL });
  triggerDownload(canvas.toDataURL('image/png'), filename);
}

/** Long edge of a capture headed for an AI model. The thermal grid behind it is 120x160, so the pixels
 *  above this carry overlay text and nothing else — and every one of them is upload size and prompt cost. */
const AI_CAPTURE_MAX_EDGE = 768;
/** Above this many data-URL characters (~600 KB) a PNG capture is re-encoded as JPEG: up to three of these
 *  ride on one Q&A request, and a false-colour frame is photographic enough that PNG barely compresses it. */
const AI_CAPTURE_MAX_PNG_CHARS = 800_000;

/**
 * Capture an element to a data URL, sized for upload rather than for download — used to hand the AI the
 * player exactly as the user sees it (the frame WITH its probe markers, annotation callouts and transect
 * lines) instead of the bare stored frame the server would otherwise load on its own.
 *
 * PNG keeps the overlay text crisp; an oversized one falls back to JPEG rather than pushing a multi-megabyte
 * string through a callable. Throws like the exporters above when the content is cross-origin tainted —
 * pass `replaceVideoWith` (a rendered frame) for a container holding a tainted <video>.
 */
export async function captureElementImage(
  element: HTMLElement,
  options: { replaceVideoWith?: string } = {},
): Promise<string> {
  const canvas = await renderElementToCanvas(element, {
    maxEdge: AI_CAPTURE_MAX_EDGE,
    replaceVideoWith: options.replaceVideoWith,
    // Opaque, unlike the download: a transparent PNG goes black wherever the JPEG fallback flattens it,
    // and the model should see the same backdrop the player shows.
    background: '#000',
  });
  const png = canvas.toDataURL('image/png');
  return png.length <= AI_CAPTURE_MAX_PNG_CHARS ? png : canvas.toDataURL('image/jpeg', 0.9);
}
