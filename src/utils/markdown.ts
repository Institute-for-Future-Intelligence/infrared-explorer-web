/**
 * Minimal Markdown -> HTML for AI-drafted experiment descriptions / reports.
 *
 * It escapes HTML FIRST (so nothing in the model output can inject raw markup/script), then
 * renders a known, safe subset — headings, bold/italic/inline-code, ordered/unordered lists,
 * GFM tables, LaTeX math (via KaTeX), and paragraphs — into a fixed tag set. Output is inserted via
 * innerHTML in the AI report panel (and the gallery card strips tags via its own extractText()), so
 * both surfaces stay correct. Output contains no literal newlines so a `white-space: pre-wrap`
 * container doesn't introduce stray blank lines.
 */

import katex from 'katex';

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Render one LaTeX span to HTML via KaTeX. Malformed TeX renders in place as red text
 *  (throwOnError:false) rather than throwing; a hard failure falls back to the escaped source. */
const renderMath = (tex: string, displayMode: boolean): string => {
  try {
    return katex.renderToString(tex.trim(), { displayMode, throwOnError: false });
  } catch {
    const d = displayMode ? '$$' : '$';
    return escapeHtml(d + tex + d);
  }
};

// Math delimiters, highest precedence first: $$…$$ / \[…\] are display (block), $…$ / \(…\) are inline.
// $$ is matched before $ so a display block isn't split by the inline rule. [\s\S] lets display math
// span lines (they're extracted from the raw source before it is split into lines).
const MATH_PATTERNS: { re: RegExp; display: boolean }[] = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /\$([^$\n]+?)\$/g, display: false },
];

// Placeholder swapped in for each extracted math span; printable + markdown-inert + whitespace-free so
// it survives escaping and trimEnd, and double-@ makes a collision with real text effectively impossible.
const mathToken = (i: number): string => `@@KATEX${i}@@`;
const MATH_TOKEN_RE = /@@KATEX(\d+)@@/g;

/** Escape, then apply inline marks: **bold**, *italic*, `code`. */
const inline = (s: string): string =>
  escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
    .replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');

/** Split a Markdown table row into trimmed cells (tolerant of optional leading/trailing pipes). */
const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
};

/** A GFM table separator row, e.g. `|---|:--:|---|` (cells of dashes, optional colons). */
const isSeparatorRow = (line: string): boolean => {
  if (!line.includes('-') || !line.includes('|')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
};

export const markdownToHtml = (md: string): string => {
  // Pull math spans out BEFORE escaping / markdown so KaTeX's HTML isn't escaped or mangled, then
  // reinsert at the very end (the placeholder passes through the pipeline untouched).
  const mathHtml: string[] = [];
  let src = md;
  for (const { re, display } of MATH_PATTERNS) {
    src = src.replace(re, (_m, tex: string) => {
      const idx = mathHtml.length;
      mathHtml.push(renderMath(tex, display));
      return mathToken(idx);
    });
  }

  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    if (line.trim() === '') {
      flushPara();
      closeList();
      continue;
    }

    // GFM table: a row with pipes immediately followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      flushPara();
      closeList();
      const header = splitRow(line);
      i += 2; // consume header + separator
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        body.push(splitRow(lines[i]));
        i++;
      }
      i--; // for-loop will ++ past the last consumed line
      const head = header.map((h) => `<th>${inline(h)}</th>`).join('');
      const rows = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const ordered = line.match(/^\d+\.\s+(.*)$/);

    if (heading) {
      flushPara();
      closeList();
      const tag = heading[1].length <= 2 ? 'h4' : 'h5';
      out.push(`<${tag}>${inline(heading[2])}</${tag}>`);
    } else if (bullet) {
      flushPara();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
    } else if (ordered) {
      flushPara();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(ordered[1])}</li>`);
    } else {
      closeList();
      para.push(inline(line));
    }
  }
  flushPara();
  closeList();
  const html = out.join('');
  // Swap the KaTeX HTML back in for the placeholders. A function replacement keeps `$` sequences in the
  // KaTeX markup from being interpreted as replacement patterns.
  return mathHtml.length ? html.replace(MATH_TOKEN_RE, (_m, i) => mathHtml[Number(i)]) : html;
};
