/*
 * A project's report leaving the website: printed (the browser's print
 * dialog, which saves a PDF) or downloaded as text. Both come from the
 * app's reportExport.ts (a synced copy): the printed page is the app's own
 * white page, with the pictures loaded straight from their URLs instead of
 * from files beside the page.
 */

import { reportFileName, reportHtml, reportPictures, reportText } from './core/reportExport';
import type { ProjectImage } from './core/types';

export interface ReportExportInput {
  title: string;
  /** The line under the title: whose report it is, when it was written, the model that wrote it. */
  meta: string;
  /** The text under the title (splitReportTitle). */
  body: string;
  images: ProjectImage[];
}

/** The body type, 11 pt: a CSS pixel prints as 1/96 in. */
const ROOT_PX = (11 * 96) / 72;

const PRINT_TIMEOUT_MS = 60_000;

/** Wait until every picture on the page has loaded (or failed), so the print has them. */
function picturesSettled(doc: Document): Promise<void> {
  const pending = Array.from(doc.images).filter((img) => !img.complete);
  return Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    ),
  ).then(() => undefined);
}

/**
 * Open the browser's print dialog on the report's page (Save as PDF is the
 * dialog's own). The page is built in a hidden frame of this document, so no
 * popup is involved; the frame goes once printing is over.
 */
export function printReport(input: ReportExportInput): Promise<void> {
  const files: Record<string, string> = {};
  for (const p of reportPictures(input.body, input.images)) {
    files[p.url] = p.url;
  }
  const html = reportHtml({ ...input, files, rootPx: ROOT_PX });
  return new Promise<void>((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      // a moment later: Safari is still reading the frame when afterprint fires
      setTimeout(() => frame.remove(), 500);
      resolve();
    };
    frame.onload = async () => {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) {
        frame.remove();
        reject(new Error('The print page could not be made.'));
        return;
      }
      await picturesSettled(doc);
      win.addEventListener('afterprint', finish, { once: true });
      setTimeout(finish, PRINT_TIMEOUT_MS);
      win.focus();
      win.print();
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/** Download the report as Markdown, named after its title. */
export function downloadReportText(input: ReportExportInput): void {
  const text = reportText(input);
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${reportFileName(input.title)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
