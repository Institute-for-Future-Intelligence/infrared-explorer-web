/*
 * A small Markdown reader for what the AI writes in a project — the plan, the
 * report and its replies. The model decides the structure, so this takes the
 * common forms rather than one template: headings, paragraphs, bullet and
 * numbered lists (nested by indentation), pipe tables, fenced code, quotes,
 * rules, links, bold / italic / inline code, pictures from the project
 * written as ![caption](image:ID) (or a plain https URL), and mathematics in
 * LaTeX — inline between $…$ or \(…\), displayed between $$…$$ or \[…\] (the
 * same four delimiters the website renders).
 *
 * Pure; the components in src/components/labProjects/MarkdownView.tsx draw
 * the blocks (math through math.ts). Tested in
 * __tests__/labProjectsMarkdown.test.ts.
 */

export type MdSpan =
  | {k: 'text' | 'b' | 'i' | 'bi' | 'code'; s: string}
  | {k: 'link'; s: string; href: string}
  /** LaTeX, inline: `s` is the source between its delimiters. */
  | {k: 'math'; s: string};

export interface MdListItem {
  depth: number;
  marker: string;
  spans: MdSpan[];
}

export type MdBlock =
  | {kind: 'heading'; level: number; spans: MdSpan[]}
  | {kind: 'para'; spans: MdSpan[]}
  | {kind: 'list'; items: MdListItem[]}
  | {kind: 'table'; header: MdSpan[][]; rows: MdSpan[][][]}
  | {kind: 'image'; imageId: string | null; url: string | null; caption: string}
  | {kind: 'code'; text: string}
  | {kind: 'quote'; spans: MdSpan[]}
  | {kind: 'rule'}
  /** LaTeX on lines of its own. */
  | {kind: 'math'; tex: string};

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

// Inline math, longest delimiters first. A dollar formula opens and closes on
// a non-space and is not followed by a digit, so "$5 and $7" stays money.
const INLINE_MATH = [/^\$\$([\s\S]+?)\$\$/, /^\\\(([\s\S]+?)\\\)/, /^\\\[([\s\S]+?)\\\]/, /^\$([^$\s](?:[^$\n]*?[^$\s])?)\$(?!\d)/];

/** Inline marks. Unclosed markers stay literal text. */
export function parseInline(src: string): MdSpan[] {
  const out: MdSpan[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({k: 'text', s: buf});
      buf = '';
    }
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null = null;
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push({k: 'code', s: m[1]});
      i += m[0].length;
      continue;
    }
    let math: RegExpMatchArray | null = null;
    if (rest[0] === '$' || rest[0] === '\\') {
      for (const re of INLINE_MATH) {
        math = rest.match(re);
        if (math) {
          break;
        }
      }
    }
    if (math) {
      const tex = math[1].trim();
      flush();
      if (tex) {
        out.push({k: 'math', s: tex});
      }
      i += math[0].length;
      continue;
    }
    if ((m = rest.match(/^\*\*\*([^*]+?)\*\*\*/))) {
      flush();
      out.push({k: 'bi', s: m[1]});
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\*\*(.+?)\*\*/)) || (m = rest.match(/^__(.+?)__/))) {
      flush();
      out.push({k: 'b', s: m[1]});
      i += m[0].length;
      continue;
    }
    if (
      (m = rest.match(/^\*([^*\s][^*]*?)\*(?!\*)/)) ||
      ((i === 0 || /[\s(]/.test(src[i - 1])) && (m = rest.match(/^_([^_\s][^_]*?)_(?![A-Za-z0-9])/)))
    ) {
      flush();
      out.push({k: 'i', s: m[1]});
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush();
      if (SAFE_HREF.test(m[2])) {
        out.push({k: 'link', s: m[1], href: m[2]});
      } else {
        out.push({k: 'text', s: m[1]});
      }
      i += m[0].length;
      continue;
    }
    buf += src[i];
    i += 1;
  }
  flush();
  return out;
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
// pictures and displayed maths inside a paragraph, each lifted out as a block
const LIFTED_RE = /!\[([^\]]*)\]\(([^)\s]+)\)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;

function imageBlock(caption: string, target: string): MdBlock {
  if (target.startsWith('image:')) {
    return {kind: 'image', imageId: target.slice(6), url: null, caption};
  }
  if (/^https:\/\//i.test(target)) {
    return {kind: 'image', imageId: null, url: target, caption};
  }
  return {kind: 'para', spans: [{k: 'text', s: caption}]};
}

/** A paragraph's text, with any pictures or displayed maths in it lifted out as their own blocks. */
function paraBlocks(text: string): MdBlock[] {
  const out: MdBlock[] = [];
  let last = 0;
  LIFTED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIFTED_RE.exec(text))) {
    const before = text.slice(last, m.index).trim();
    if (before) {
      out.push({kind: 'para', spans: parseInline(before)});
    }
    if (m[2] != null) {
      out.push(imageBlock(m[1], m[2]));
    } else {
      const tex = (m[3] ?? m[4] ?? '').trim();
      if (tex) {
        out.push({kind: 'math', tex});
      }
    }
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) {
    out.push({kind: 'para', spans: parseInline(tail)});
  }
  return out;
}

const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith('|')) {
    s = s.slice(1);
  }
  if (s.endsWith('|')) {
    s = s.slice(0, -1);
  }
  return s.split('|').map(c => c.trim());
};

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * Displayed maths opening at line `i` ($$ or \[): the lines up to its close,
 * or null when it never closes (the text is then read as prose).
 */
function mathLines(lines: string[], i: number): {tex: string; next: number} | null {
  const first = lines[i].trim();
  const open = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null;
  if (!open) {
    return null;
  }
  const close = open === '$$' ? '$$' : '\\]';
  const parts: string[] = [];
  let text = first.slice(open.length);
  for (let j = i; j < lines.length; j++) {
    if (j > i) {
      text = lines[j];
    }
    const at = text.indexOf(close);
    if (at >= 0) {
      // nothing but the close may follow it on the line, else it is prose
      if (text.slice(at + close.length).trim()) {
        return null;
      }
      parts.push(text.slice(0, at));
      return {tex: parts.join('\n').trim(), next: j + 1};
    }
    parts.push(text);
  }
  return null;
}

export function parseMarkdown(md: string): MdBlock[] {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push(...paraBlocks(para.join(' ')));
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      i += 1;
      continue;
    }
    // fenced code
    if (/^```/.test(trimmed)) {
      flushPara();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({kind: 'code', text: body.join('\n')});
      continue;
    }
    // displayed maths, on one line or across several
    const math = mathLines(lines, i);
    if (math) {
      flushPara();
      if (math.tex) {
        blocks.push({kind: 'math', tex: math.tex});
      }
      i = math.next;
      continue;
    }
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      blocks.push({kind: 'heading', level: h[1].length, spans: parseInline(h[2].replace(/\s+#+\s*$/, ''))});
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push({kind: 'rule'});
      i += 1;
      continue;
    }
    // table: a header row followed by a separator row
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const header = splitRow(trimmed).map(parseInline);
      const rows: MdSpan[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i += 1;
      }
      blocks.push({kind: 'table', header, rows});
      continue;
    }
    // lists
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const items: MdListItem[] = [];
      const counters: number[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const mm = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!mm) {
          // a wrapped continuation line belongs to the previous item
          if (l.trim() && /^\s{2,}/.test(l) && items.length > 0) {
            const prev = items[items.length - 1];
            prev.spans = [...prev.spans, {k: 'text', s: ' '}, ...parseInline(l.trim())];
            i += 1;
            continue;
          }
          break;
        }
        const depth = Math.min(4, Math.floor(mm[1].replace(/\t/g, '    ').length / 2));
        const ordered = /\d/.test(mm[2]);
        counters.length = depth + 1;
        if (ordered) {
          const n = Number.parseInt(mm[2], 10);
          counters[depth] = Number.isFinite(n) ? n : (counters[depth] ?? 0) + 1;
        }
        const text = mm[3];
        // a checklist item reads as its own marker
        const task = text.match(/^\[([ xX])\]\s+(.*)$/);
        items.push({
          depth,
          marker: task ? (task[1].trim() ? '☑' : '☐') : ordered ? `${counters[depth]}.` : '•',
          spans: parseInline(task ? task[2] : text),
        });
        i += 1;
      }
      blocks.push({kind: 'list', items});
      continue;
    }
    if (trimmed.startsWith('>')) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        body.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({kind: 'quote', spans: parseInline(body.join(' '))});
      continue;
    }
    para.push(trimmed);
    i += 1;
  }
  flushPara();
  return blocks;
}

/** The project pictures a Markdown text shows (![caption](image:ID)), in order. */
export function markdownImageIds(md: string): string[] {
  const ids: string[] = [];
  const re = new RegExp(IMAGE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(md ?? ''))) {
    if (m[2].startsWith('image:')) {
      ids.push(m[2].slice(6));
    }
  }
  return ids;
}

/** Plain text of a Markdown string, for one-line previews. */
export function markdownPreview(md: string, max = 160): string {
  const text = (md ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A report's title and the text under it. A report that opens with its own
 * title — a top-level heading, or any heading that says the title — has that
 * heading lifted out, so the page can put the time it was written right under
 * the title.
 */
export function splitReportTitle(title: string, md: string): {title: string; body: string} {
  const m = md.match(/^\s*(#{1,6})[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
  if (m) {
    const heading = m[2].replace(/[*_`]+/g, '').trim();
    if (heading && (m[1].length === 1 || heading.toLowerCase() === title.trim().toLowerCase())) {
      return {title: heading, body: md.slice(m[0].length)};
    }
  }
  return {title, body: md};
}
