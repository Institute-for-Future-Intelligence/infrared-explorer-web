/*
 * The editor's page for the plan and for the report: the text laid out as it
 * reads (headings, lists, tables, pictures), editable in place in a WebView,
 * and turned back into Markdown when the user saves — the user never sees
 * Markdown. (Named after the plan, which it edited first; the report goes
 * through it unchanged, its title as a top heading — markdown.ts
 * reportEditorText.)
 *
 * markdownToEditorHtml is pure (tested in __tests__/labProjectsPlanEditor.test.ts);
 * the way back runs inside the page (EDITOR_SCRIPT) and writes the forms the
 * reader (markdown.ts) takes: "#" headings, "-" and "1." lists indented two
 * spaces a level, pipe tables, ![caption](image:ID) pictures.
 */

import {parseMarkdown, type MdBlock, type MdListItem, type MdSpan} from './markdown';
import {withNewestPictures} from './pictures';
import type {ProjectImage} from './types';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function spansHtml(spans: MdSpan[]): string {
  return spans
    .map(sp => {
      switch (sp.k) {
        case 'b':
          return `<strong>${esc(sp.s)}</strong>`;
        case 'i':
          return `<em>${esc(sp.s)}</em>`;
        case 'bi':
          return `<strong><em>${esc(sp.s)}</em></strong>`;
        case 'code':
          return `<code>${esc(sp.s)}</code>`;
        case 'link':
          return `<a href="${esc(sp.href)}">${esc(sp.s)}</a>`;
        case 'math':
          // the editor shows a formula as its source, which the way back keeps
          return esc(`$${sp.s}$`);
        default:
          return esc(sp.s);
      }
    })
    .join('');
}

/** Flat list items (depth + marker) as nested lists; a deeper item opens a list inside the previous one. */
function listHtml(items: MdListItem[]): string {
  let html = '';
  const open: {tag: 'ul' | 'ol'; depth: number}[] = [];
  for (const it of items) {
    const tag = /^\d/.test(it.marker) ? 'ol' : 'ul';
    while (open.length > 0 && open[open.length - 1].depth > it.depth) {
      html += `</li></${open.pop()!.tag}>`;
    }
    const top = open[open.length - 1];
    if (!top || top.depth < it.depth) {
      html += `<${tag}>`;
      open.push({tag, depth: it.depth});
    } else {
      html += '</li>';
      if (top.tag !== tag) {
        html += `</${top.tag}><${tag}>`;
        top.tag = tag;
      }
    }
    const task = it.marker === '☐' || it.marker === '☑' ? `${it.marker} ` : '';
    html += `<li>${task}${spansHtml(it.spans)}`;
  }
  while (open.length > 0) {
    html += `</li></${open.pop()!.tag}>`;
  }
  return html;
}

function blockHtml(b: MdBlock, byId: Map<string, ProjectImage>, original: Map<string, string>): string {
  switch (b.kind) {
    case 'heading': {
      const n = Math.min(6, Math.max(1, b.level));
      return `<h${n}>${spansHtml(b.spans)}</h${n}>`;
    }
    case 'para':
      return `<p>${spansHtml(b.spans)}</p>`;
    case 'list':
      return listHtml(b.items);
    case 'table':
      return `<table><thead><tr>${b.header.map(c => `<th>${spansHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows
        .map(r => `<tr>${r.map(c => `<td>${spansHtml(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
    case 'image': {
      const shown = b.imageId ? byId.get(b.imageId)?.url : b.url;
      // keep the reference as the plan wrote it; the picture shown is its newest version
      const src = b.imageId ? `image:${original.get(b.imageId) ?? b.imageId}` : b.url ?? '';
      return `<figure contenteditable="false" data-src="${esc(src)}" data-caption="${esc(b.caption)}">${
        shown ? `<img src="${esc(shown)}" alt="">` : ''
      }<figcaption>${esc(b.caption)}</figcaption><button class="rm" type="button" aria-label="Remove">×</button></figure>`;
    }
    case 'code':
      return `<pre>${esc(b.text)}</pre>`;
    case 'math':
      return `<p>${esc(`$$${b.tex}$$`)}</p>`;
    case 'quote':
      return `<blockquote>${spansHtml(b.spans)}</blockquote>`;
    case 'rule':
      return '<hr>';
  }
}

/** The plan as editable HTML; its pictures show their newest version. */
export function markdownToEditorHtml(markdown: string, images: ProjectImage[]): string {
  // Parse the plan with each picture swapped for its newest version (to show
  // it), remembering which id the plan itself wrote (to write it back).
  const original = new Map<string, string>();
  const newest = withNewestPictures(markdown, images);
  const before = markdown.match(/!\[[^\]]*\]\(image:[^)\s]+\)/g) ?? [];
  const after = newest.match(/!\[[^\]]*\]\(image:[^)\s]+\)/g) ?? [];
  before.forEach((ref, i) => {
    const was = ref.match(/image:([^)\s]+)\)/)?.[1];
    const now = after[i]?.match(/image:([^)\s]+)\)/)?.[1];
    if (was && now) {
      original.set(now, was);
    }
  });
  const byId = new Map(images.map(i => [i.id, i]));
  return parseMarkdown(newest)
    .map(b => blockHtml(b, byId, original))
    .join('');
}

const EDITOR_CSS = `
html,body{margin:0;background:#000;color:#fff;font:16px/1.5 -apple-system,Roboto,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
#ed{padding:16px 16px 45vh;outline:none;min-height:60vh;word-wrap:break-word}
#ed:empty::before{content:attr(data-placeholder);color:#808080}
h1{font-size:23px;line-height:1.3;margin:18px 0 8px}h2{font-size:20px;line-height:1.3;margin:16px 0 6px}
h3,h4,h5,h6{font-size:17px;margin:14px 0 6px}
p{margin:0 0 10px}ul,ol{margin:0 0 10px;padding-left:24px}li{margin:2px 0}
table{border-collapse:collapse;margin:0 0 12px;width:100%}th,td{border:1px solid #444;padding:6px;text-align:left;vertical-align:top}th{background:#1a1a1a}
figure{margin:8px 0 14px;position:relative}figure img{display:block;max-width:100%;border-radius:8px}
figcaption{color:#808080;font-size:13px;margin-top:4px}
figure .rm{position:absolute;top:6px;right:6px;width:34px;height:34px;border:0;border-radius:17px;background:rgba(0,0,0,.65);color:#fff;font-size:22px;line-height:34px;padding:0}
pre{background:#1a1a1a;padding:10px;border-radius:6px;white-space:pre-wrap;font:13px/1.4 monospace}
blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid #444;color:#d3d3d3}
code{background:#1a1a1a;border-radius:4px;padding:0 4px;font-family:monospace}
a{color:#D81B60}hr{border:0;border-top:1px solid #444;margin:14px 0}
`;

// String.raw keeps the regular expressions' backslashes; a backtick is written \x60.
const EDITOR_SCRIPT = String.raw`
(function () {
  var ed = document.getElementById('ed'), dirty = false;
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}
  function post(o) { if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } }
  function touch() { if (!dirty) { dirty = true; post({type: 'dirty'}); } }
  ed.addEventListener('input', touch);
  ed.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.rm') : null;
    if (b) { e.preventDefault(); b.closest('figure').remove(); touch(); }
  });
  var BLOCK = /^(P|DIV|H[1-6]|UL|OL|TABLE|FIGURE|PRE|BLOCKQUOTE|HR)$/;
  var TICK = '\x60';
  function nb(s) { return s.replace(/ /g, ' '); }
  function line(s) { return s.replace(/\s+/g, ' ').trim(); }
  function wrap(s, m) {
    var t = s.trim();
    if (!t) { return s; }
    return s.match(/^\s*/)[0] + m + t + m + s.match(/\s*$/)[0];
  }
  function node(n) {
    if (n.nodeType === 3) { return nb(n.nodeValue); }
    if (n.nodeType !== 1) { return ''; }
    var t = n.tagName;
    if (t === 'BR') { return ' '; }
    if (t === 'CODE') { return TICK + nb(n.textContent) + TICK; }
    var s = inl(n);
    if (t === 'STRONG' || t === 'B') { return wrap(s, '**'); }
    if (t === 'EM' || t === 'I') { return wrap(s, '*'); }
    if (t === 'A') { var h = n.getAttribute('href') || ''; return h ? '[' + s + '](' + h + ')' : s; }
    return s;
  }
  function inl(el) { var s = ''; el.childNodes.forEach(function (c) { s += node(c); }); return s; }
  function list(el, d) {
    var out = [], k = 0, ordered = el.tagName === 'OL';
    el.childNodes.forEach(function (li) {
      if (li.nodeType !== 1) {
        var loose = li.nodeType === 3 ? line(nb(li.nodeValue)) : '';
        if (loose) { out.push('  '.repeat(d) + '- ' + loose); }
        return;
      }
      if (li.tagName === 'UL' || li.tagName === 'OL') { out.push.apply(out, list(li, d + 1)); return; }
      var text = '', sub = [];
      li.childNodes.forEach(function (c) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) { sub.push.apply(sub, list(c, d + 1)); }
        else { text += node(c); }
      });
      text = line(text);
      var task = text.match(/^([☐☑])\s*(.*)$/);
      if (task) { text = '[' + (task[1] === '☑' ? 'x' : ' ') + '] ' + task[2]; }
      if (!text && sub.length === 0) { return; }
      k += 1;
      out.push('  '.repeat(d) + (ordered ? k + '.' : '-') + ' ' + text);
      out.push.apply(out, sub);
    });
    return out;
  }
  function table(t) {
    var rows = [].slice.call(t.rows).map(function (r) {
      return [].slice.call(r.cells).map(function (c) { return line(inl(c)); });
    });
    if (!rows.length) { return ''; }
    function row(r) { return '| ' + r.join(' | ') + ' |'; }
    var sep = '| ' + rows[0].map(function () { return '---'; }).join(' | ') + ' |';
    return [row(rows[0]), sep].concat(rows.slice(1).map(row)).join('\n');
  }
  function blocks(el) {
    var out = [], run = '';
    function flush() { var s = line(run); if (s) { out.push(s); } run = ''; }
    el.childNodes.forEach(function (n) {
      if (n.nodeType === 3 || (n.nodeType === 1 && !BLOCK.test(n.tagName))) { run += node(n); return; }
      if (n.nodeType !== 1) { return; }
      flush();
      var t = n.tagName, s;
      if (/^H[1-6]$/.test(t)) { s = line(inl(n)); if (s) { out.push('#'.repeat(+t.charAt(1)) + ' ' + s); } }
      else if (t === 'P' || t === 'DIV') {
        if ([].some.call(n.children, function (c) { return BLOCK.test(c.tagName); })) { out.push.apply(out, blocks(n)); }
        else { s = line(inl(n)); if (s) { out.push(s); } }
      }
      else if (t === 'UL' || t === 'OL') { var l = list(n, 0); if (l.length) { out.push(l.join('\n')); } }
      else if (t === 'TABLE') { s = table(n); if (s) { out.push(s); } }
      else if (t === 'FIGURE') { out.push('![' + (n.getAttribute('data-caption') || '') + '](' + (n.getAttribute('data-src') || '') + ')'); }
      else if (t === 'PRE') { out.push(TICK + TICK + TICK + '\n' + nb(n.textContent).replace(/\n+$/, '') + '\n' + TICK + TICK + TICK); }
      else if (t === 'BLOCKQUOTE') { s = line(inl(n)); if (s) { out.push('> ' + s); } }
      else if (t === 'HR') { out.push('---'); }
    });
    flush();
    return out;
  }
  window.__savePlan = function () { post({type: 'save', markdown: blocks(ed).join('\n\n')}); };
})();
`;

/** The editor page around the plan's HTML. */
export function planEditorPage(bodyHtml: string, placeholder: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>${EDITOR_CSS}</style></head><body><div id="ed" contenteditable="true" data-placeholder="${esc(
    placeholder,
  )}">${bodyHtml}</div><script>${EDITOR_SCRIPT}</script></body></html>`;
}
