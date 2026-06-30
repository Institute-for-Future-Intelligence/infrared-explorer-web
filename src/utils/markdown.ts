/**
 * Minimal, dependency-free Markdown -> HTML for AI-drafted experiment descriptions / reports.
 *
 * It escapes HTML FIRST (so nothing in the model output can inject raw markup/script), then
 * renders a known, safe subset — headings, bold/italic/inline-code, ordered/unordered lists,
 * GFM tables, and paragraphs — into a fixed tag set. Output is inserted via innerHTML in the
 * AI report panel (and the gallery card strips tags via its own extractText()), so both surfaces
 * stay correct. Output contains no literal newlines so a `white-space: pre-wrap` container doesn't
 * introduce stray blank lines.
 */

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
  const lines = md.replace(/\r\n/g, '\n').split('\n');
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
  return out.join('');
};
