/*
 * The plan editor's way back: the edited page turned into Markdown. The
 * app's lib/labProjects/planEditor.ts (synced into core/) builds the page
 * from the plan (markdownToEditorHtml) and carries this half inside its
 * WebView as a script string (EDITOR_SCRIPT), which a browser page cannot
 * import; this is that script as TypeScript over the same DOM, rule for
 * rule, writing the forms the reader (core/markdown.ts) takes: "#"
 * headings, "-" and "1." lists indented two spaces a level, pipe tables,
 * ![caption](image:ID) pictures. Change the two together.
 */

const BLOCK = /^(P|DIV|H[1-6]|UL|OL|TABLE|FIGURE|PRE|BLOCKQUOTE|HR)$/;
const TICK = '`';

/** A no-break space a browser puts in for a typed space at the edge of a text node reads as a space. */
const NBSP = new RegExp(String.fromCharCode(160), 'g');
const nb = (s: string): string => s.replace(NBSP, ' ');
const line = (s: string): string => s.replace(/\s+/g, ' ').trim();

function wrap(s: string, m: string): string {
  const t = s.trim();
  if (!t) {
    return s;
  }
  return (s.match(/^\s*/)?.[0] ?? '') + m + t + m + (s.match(/\s*$/)?.[0] ?? '');
}

function node(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) {
    return nb(n.nodeValue ?? '');
  }
  if (n.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  const el = n as Element;
  const t = el.tagName;
  if (t === 'BR') {
    return ' ';
  }
  if (t === 'CODE') {
    return TICK + nb(el.textContent ?? '') + TICK;
  }
  const s = inl(el);
  if (t === 'STRONG' || t === 'B') {
    return wrap(s, '**');
  }
  if (t === 'EM' || t === 'I') {
    return wrap(s, '*');
  }
  if (t === 'A') {
    const h = el.getAttribute('href') ?? '';
    return h ? `[${s}](${h})` : s;
  }
  return s;
}

function inl(el: Node): string {
  let s = '';
  el.childNodes.forEach((c) => {
    s += node(c);
  });
  return s;
}

function list(el: Element, d: number): string[] {
  const out: string[] = [];
  let k = 0;
  const ordered = el.tagName === 'OL';
  el.childNodes.forEach((li) => {
    if (li.nodeType !== Node.ELEMENT_NODE) {
      const loose = li.nodeType === Node.TEXT_NODE ? line(nb(li.nodeValue ?? '')) : '';
      if (loose) {
        out.push('  '.repeat(d) + '- ' + loose);
      }
      return;
    }
    const item = li as Element;
    if (item.tagName === 'UL' || item.tagName === 'OL') {
      out.push(...list(item, d + 1));
      return;
    }
    let text = '';
    const sub: string[] = [];
    item.childNodes.forEach((c) => {
      if (c.nodeType === Node.ELEMENT_NODE && ((c as Element).tagName === 'UL' || (c as Element).tagName === 'OL')) {
        sub.push(...list(c as Element, d + 1));
      } else {
        text += node(c);
      }
    });
    text = line(text);
    const task = text.match(/^([☐☑])\s*(.*)$/);
    if (task) {
      text = `[${task[1] === '☑' ? 'x' : ' '}] ${task[2]}`;
    }
    if (!text && sub.length === 0) {
      return;
    }
    k += 1;
    out.push('  '.repeat(d) + (ordered ? `${k}.` : '-') + ' ' + text);
    out.push(...sub);
  });
  return out;
}

function table(t: HTMLTableElement): string {
  const rows = Array.from(t.rows).map((r) => Array.from(r.cells).map((c) => line(inl(c))));
  if (rows.length === 0) {
    return '';
  }
  const row = (r: string[]) => `| ${r.join(' | ')} |`;
  const sep = `| ${rows[0].map(() => '---').join(' | ')} |`;
  return [row(rows[0]), sep, ...rows.slice(1).map(row)].join('\n');
}

function blocks(el: Element): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    const s = line(run);
    if (s) {
      out.push(s);
    }
    run = '';
  };
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && !BLOCK.test((n as Element).tagName))) {
      run += node(n);
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    flush();
    const e = n as Element;
    const t = e.tagName;
    let s: string;
    if (/^H[1-6]$/.test(t)) {
      s = line(inl(e));
      if (s) {
        out.push('#'.repeat(Number(t.charAt(1))) + ' ' + s);
      }
    } else if (t === 'P' || t === 'DIV') {
      if (Array.from(e.children).some((c) => BLOCK.test(c.tagName))) {
        out.push(...blocks(e));
      } else {
        s = line(inl(e));
        if (s) {
          out.push(s);
        }
      }
    } else if (t === 'UL' || t === 'OL') {
      const l = list(e, 0);
      if (l.length > 0) {
        out.push(l.join('\n'));
      }
    } else if (t === 'TABLE') {
      s = table(e as HTMLTableElement);
      if (s) {
        out.push(s);
      }
    } else if (t === 'FIGURE') {
      out.push(`![${e.getAttribute('data-caption') ?? ''}](${e.getAttribute('data-src') ?? ''})`);
    } else if (t === 'PRE') {
      out.push(`${TICK}${TICK}${TICK}\n${nb(e.textContent ?? '').replace(/\n+$/, '')}\n${TICK}${TICK}${TICK}`);
    } else if (t === 'BLOCKQUOTE') {
      s = line(inl(e));
      if (s) {
        out.push('> ' + s);
      }
    } else if (t === 'HR') {
      out.push('---');
    }
  });
  flush();
  return out;
}

/** The editor's content as the plan's Markdown. */
export function editorMarkdown(editor: Element): string {
  return blocks(editor).join('\n\n');
}
