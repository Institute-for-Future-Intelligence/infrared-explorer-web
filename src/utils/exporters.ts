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

/**
 * Rasterize a DOM element (image + thermometer/annotation/isotherm overlays, or a chart) to a PNG
 * and download it. Elements marked `data-html2canvas-ignore` (e.g. the chart menu button) are
 * excluded. Throws if the element's content is cross-origin tainted (e.g. a CORS-blocked <video>).
 */
export async function exportElementToPNG(element: HTMLElement, filename: string): Promise<void> {
  const canvas = await html2canvas(element, { backgroundColor: null, useCORS: true, logging: false });
  triggerDownload(canvas.toDataURL('image/png'), filename);
}

/**
 * Like exportElementToPNG, but for a container whose <video> is cross-origin tainted (a direct capture
 * throws). In html2canvas's CLONE only — the live DOM is never touched, so there's no flicker — the <video>
 * is swapped for `replacementDataURL` (a false-colour render of the same frame), so the export keeps the
 * frame plus every untainted overlay (thermometers / annotations / isotherms). The replacement fills the
 * video's box (the media box is already sized to the frame aspect, so no letterboxing to correct).
 */
export async function exportElementReplacingVideoToPNG(
  element: HTMLElement,
  filename: string,
  replacementDataURL: string,
): Promise<void> {
  const canvas = await html2canvas(element, {
    backgroundColor: null,
    useCORS: true,
    logging: false,
    onclone: (_doc, clonedElement) => {
      const video = clonedElement.querySelector('video');
      if (!video) return;
      const img = clonedElement.ownerDocument.createElement('img');
      img.src = replacementDataURL;
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;';
      video.replaceWith(img);
    },
  });
  triggerDownload(canvas.toDataURL('image/png'), filename);
}
