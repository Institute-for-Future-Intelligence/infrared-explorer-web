/*
 * A project's report as something that leaves the app: a page to print (the
 * native PdfExport module turns it into a PDF) and a plain-text copy. Both
 * carry the title, the line under it (whose it is, when it was written, the
 * model that wrote it) and the text; the page also shows the pictures, which
 * sit beside it as files.
 *
 * The page is the Report tab on paper: the same Markdown reader
 * (markdown.ts), dark ink on white. Every size in it hangs off the root type
 * size, because a CSS pixel does not print the same on the two platforms
 * (reportPdf.ts picks it).
 *
 * Pure; src/lib/labProjects/reportPdf.ts fetches the pictures and writes the
 * files. Tested in __tests__/labProjectsReportExport.test.ts.
 */

import {parseMarkdown, type MdBlock, type MdSpan} from './markdown';
import {texToSvg} from './math';
import type {ProjectImage} from './types';

type ImageBlock = Extract<MdBlock, {kind: 'image'}>;

const pictureOf = (block: ImageBlock, images: ProjectImage[]): {image?: ProjectImage; url: string | null} => {
  const image = block.imageId ? images.find(i => i.id === block.imageId) : undefined;
  return {image, url: image?.url ?? block.url};
};

/** The pictures a report's text shows, each once, in its order: where to fetch them. */
export function reportPictures(markdown: string, images: ProjectImage[]): {url: string; mime: string | null}[] {
  const out: {url: string; mime: string | null}[] = [];
  for (const block of parseMarkdown(markdown)) {
    if (block.kind !== 'image') {
      continue;
    }
    const {image, url} = pictureOf(block, images);
    if (url && !out.some(p => p.url === url)) {
      out.push({url, mime: image?.mime ?? null});
    }
  }
  return out;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function spansHtml(spans: MdSpan[]): string {
  return spans
    .map(s => {
      const text = escapeHtml(s.s);
      switch (s.k) {
        case 'b':
          return `<strong>${text}</strong>`;
        case 'i':
          return `<em>${text}</em>`;
        case 'bi':
          return `<strong><em>${text}</em></strong>`;
        case 'code':
          return `<code>${text}</code>`;
        case 'link':
          return `<a href="${escapeHtml(s.href)}">${text}</a>`;
        case 'math': {
          // the formula as the phone draws it: an svg of paths, sized in ex, in the text's colour
          const m = texToSvg(s.s, false);
          return m ? `<span class="math">${m.svg}</span>` : `<code>${text}</code>`;
        }
        default:
          return text;
      }
    })
    .join('');
}

function blockHtml(block: MdBlock, images: ProjectImage[], files: Record<string, string>): string {
  switch (block.kind) {
    case 'heading': {
      // the report's title is the page's h1
      const tag = block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
      return `<${tag}>${spansHtml(block.spans)}</${tag}>`;
    }
    case 'para':
      return `<p>${spansHtml(block.spans)}</p>`;
    case 'list':
      return `<div class="list">${block.items
        .map(
          it =>
            `<div class="item" style="margin-left:${it.depth * 1.4}em"><span class="marker">${escapeHtml(
              it.marker,
            )}</span>${spansHtml(it.spans)}</div>`,
        )
        .join('')}</div>`;
    case 'table': {
      const head = block.header.map(c => `<th>${spansHtml(c)}</th>`).join('');
      const rows = block.rows
        .map(r => `<tr>${block.header.map((_h, j) => `<td>${spansHtml(r[j] ?? [])}</td>`).join('')}</tr>`)
        .join('');
      return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    case 'image': {
      const {image, url} = pictureOf(block, images);
      const caption = block.caption || image?.caption || '';
      const file = url ? files[url] : undefined;
      if (!file) {
        return `<p class="missing">[picture not available: ${escapeHtml(caption)}]</p>`;
      }
      const under = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
      return `<figure><img src="${escapeHtml(file)}" alt="">${under}</figure>`;
    }
    case 'code':
      return `<pre>${escapeHtml(block.text)}</pre>`;
    case 'math': {
      const m = texToSvg(block.tex, true);
      return m ? `<div class="math-block">${m.svg}</div>` : `<pre>${escapeHtml(block.tex)}</pre>`;
    }
    case 'quote':
      return `<blockquote>${spansHtml(block.spans)}</blockquote>`;
    case 'rule':
      return '<hr>';
    default:
      return '';
  }
}

const MONO = "Menlo, 'Roboto Mono', monospace";

const pageCss = (rootPx: number): string => `
html { font-size: ${rootPx}px; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; color: #1f1f1f; background: #fff; font-family: -apple-system, 'Helvetica Neue', Roboto, 'Noto Sans', sans-serif; font-size: 1rem; line-height: 1.5; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 0.3em; }
h2 { font-size: 1.4rem; line-height: 1.3; margin: 1.3em 0 0.45em; }
h3 { font-size: 1.15rem; line-height: 1.3; margin: 1.1em 0 0.4em; }
h4 { font-size: 1rem; margin: 1em 0 0.3em; }
h1, h2, h3, h4 { page-break-after: avoid; break-after: avoid; }
p { margin: 0 0 0.7em; orphans: 3; widows: 3; }
.meta { color: #666; font-size: 0.85rem; margin-bottom: 1.6em; }
.missing { color: #666; font-size: 0.85rem; }
a { color: #1a5fb4; }
.list { margin: 0 0 0.7em; }
.item { position: relative; padding-left: 1.9em; margin-bottom: 0.25em; }
.marker { position: absolute; left: 0; }
table { width: 100%; border-collapse: collapse; margin: 0 0 1em; word-break: break-word; }
th, td { border: 1px solid #bbb; padding: 0.35em 0.6em; text-align: left; vertical-align: top; }
th { background: #f0f0f0; }
tr, figure, pre, blockquote { page-break-inside: avoid; break-inside: avoid; }
figure { margin: 1em 0; text-align: center; }
img { max-width: 100%; max-height: 28rem; }
figcaption { color: #666; font-size: 0.85rem; margin-top: 0.4em; }
code { font-family: ${MONO}; font-size: 0.9em; background: #f0f0f0; }
pre { font-family: ${MONO}; font-size: 0.85rem; background: #f4f4f4; border: 1px solid #ddd; padding: 0.7em; margin: 0 0 0.7em; white-space: pre-wrap; word-wrap: break-word; }
blockquote { margin: 0 0 0.7em; padding-left: 0.9em; border-left: 0.25em solid #ccc; color: #444; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.2em 0; }
.math svg { vertical-align: middle; }
.math-block { margin: 0.6em 0 0.9em; text-align: center; overflow-x: auto; page-break-inside: avoid; break-inside: avoid; }
.math-block svg { max-width: 100%; }
`;

/**
 * The report as a page to print. `body` is the text under the title
 * (splitReportTitle); `files` names the file beside the page that holds each
 * picture, by the picture's URL — a picture without one prints as the line
 * the app shows for a picture it does not have.
 */
export function reportHtml({
  title,
  meta,
  body,
  images,
  files,
  rootPx,
}: {
  title: string;
  meta: string;
  body: string;
  images: ProjectImage[];
  files: Record<string, string>;
  /** The size of 1rem in CSS pixels: the body type. */
  rootPx: number;
}): string {
  const blocks = parseMarkdown(body)
    .map(b => blockHtml(b, images, files))
    .join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${pageCss(rootPx)}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(meta)}</p>
${blocks}
</body>
</html>
`;
}

/** The report as plain text: its Markdown, with a line where each picture was. */
export function reportText({
  title,
  meta,
  body,
  images,
}: {
  title: string;
  meta: string;
  body: string;
  images: ProjectImage[];
}): string {
  const text = body.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, caption: string, target: string) => {
    const image = target.startsWith('image:') ? images.find(i => i.id === target.slice(6)) : undefined;
    const label = caption || image?.caption || '';
    return label ? `[Picture: ${label}]` : '[Picture]';
  });
  return `# ${title}\n${meta}\n\n${text.trim()}\n`;
}

const FILE_NAME_MAX = 60;

/**
 * A file name (no extension) from the report's title. ASCII punctuation goes —
 * a path separator, or a character a file:// URL reads as something else —
 * and every other script stays as written.
 */
export function reportFileName(title: string): string {
  const clean = title
    .replace(/[^A-Za-z0-9 ._\-\u0080-￿]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+/, '');
  // by code point: a cut through a surrogate pair is not a name a file system takes
  const cut = Array.from(clean).slice(0, FILE_NAME_MAX).join('').replace(/[ .]+$/, '');
  return cut || 'Report';
}
