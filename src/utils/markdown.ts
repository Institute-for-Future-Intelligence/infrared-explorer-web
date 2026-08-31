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

// Markdown links [text](url). Only safe schemes become anchors (guards against `javascript:` etc. in
// model output); anything else is left as the literal text. Applied after the other inline marks so link
// text can still be bold/italic/code. External http(s) links open in a new tab; in-app (#/… , /…) stay.
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const safeLinkHref = (url: string): string | null =>
  /^(#|\/|https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : null;

/** Escape, then apply inline marks: **bold**, *italic*, `code`, and [links](url). */
const inline = (s: string): string =>
  escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
    .replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(LINK_RE, (m, text, url) => {
      const href = safeLinkHref(url);
      if (!href) return m;
      const external = /^https?:\/\//i.test(href);
      return `<a href="${href}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
    });

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
  let para: string[] = [];

  // Open list levels, outermost first, each with the source indent that opened it and whether its most
  // recent <li> is still awaiting its </li> (left open so a deeper list nests INSIDE it).
  const stack: { tag: 'ul' | 'ol'; indent: number; liOpen: boolean }[] = [];

  const popList = () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (top.liOpen) out.push('</li>');
    out.push(`</${top.tag}>`);
    stack.pop();
  };
  const closeLists = () => {
    while (stack.length) popList();
  };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };

  /**
   * Emit one list item at source indent `indent`. Deeper indent nests a new list inside the currently
   * open <li>; shallower indent pops back out; same indent with a different marker swaps list type.
   * `start` is the literal number an ordered item was written with, so a list beginning at "3." keeps
   * its numbering instead of silently restarting at 1.
   */
  const pushItem = (tag: 'ul' | 'ol', indent: number, content: string, start?: number) => {
    while (stack.length && indent < stack[stack.length - 1].indent) popList();
    const top = stack[stack.length - 1];
    if (top && indent === top.indent && top.tag === tag) {
      if (top.liOpen) {
        out.push('</li>');
        top.liOpen = false;
      }
    } else {
      if (top && indent === top.indent) popList(); // same level, different marker
      const attr = tag === 'ol' && start !== undefined && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${attr}>`);
      stack.push({ tag, indent, liOpen: false });
    }
    out.push(`<li>${inline(content)}`);
    stack[stack.length - 1].liOpen = true;
  };

  // Indent width in spaces (a tab counts as four), used to decide list nesting depth.
  const indentWidth = (s: string) => s.replace(/\t/g, '    ').length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    // A blank line ends a paragraph but NOT a list: a "loose" list (blank lines between items) is what
    // these models emit by default, and closing here restarted every <ol> at 1 and split every <ul>.
    // Any following non-list block closes the list through its own branch below.
    if (line.trim() === '') {
      flushPara();
      continue;
    }

    // GFM table: a row with pipes immediately followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      flushPara();
      closeLists();
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
    // Leading whitespace is captured (the line is only trimEnd'ed) so an indented item nests instead of
    // falling through to the paragraph branch, which used to print it as literal "- text" at the margin.
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);

    if (heading) {
      flushPara();
      closeLists();
      // Three levels, not two: reports routinely use #/##/### and the old `<=2 ? h4 : h5` mapping
      // collapsed the first two together, flattening the section hierarchy. Every consumer of this
      // renderer styles h4/h5/h6 (aiReport, qaPanel, AiChatWidget) — add a rule there before adding a
      // level here, or the extra level falls back to the browser's tiny default.
      const tag = heading[1].length <= 1 ? 'h4' : heading[1].length === 2 ? 'h5' : 'h6';
      out.push(`<${tag}>${inline(heading[2])}</${tag}>`);
    } else if (bullet) {
      flushPara();
      pushItem('ul', indentWidth(bullet[1]), bullet[2]);
    } else if (ordered) {
      flushPara();
      pushItem('ol', indentWidth(ordered[1]), ordered[3], Number(ordered[2]));
    } else {
      closeLists();
      para.push(inline(line));
    }
  }
  flushPara();
  closeLists();
  const html = out.join('');
  // Swap the KaTeX HTML back in for the placeholders. A function replacement keeps `$` sequences in the
  // KaTeX markup from being interpreted as replacement patterns.
  return mathHtml.length ? html.replace(MATH_TOKEN_RE, (_m, i) => mathHtml[Number(i)]) : html;
};
