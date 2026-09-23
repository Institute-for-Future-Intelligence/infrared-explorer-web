/**
 * What a twin's AI model is writing, made readable as it streams (docs/digital-twin-plan.md §28.5). The
 * answer is JSON — a scene program's record, a fixed-camera scene, a revision — arriving a few tokens at
 * a time, so what there is at any moment is a PREFIX of a JSON document. This renders such a prefix as
 * lines a person can follow ("subject: A two-storey house…", the parts one per line, then the program
 * itself as it is written) and never fails on the cut-off end: an unterminated string shows what there
 * is of it, a half-written key shows nothing yet. Run over the whole text on each update — it is linear,
 * and the text is at most a few hundred KB.
 *
 * Top-level keys become `key: value` lines; `code` (the program) is written out as it is, on its own
 * lines; an array becomes a list, one item per line, with an object item's fields joined by " · ";
 * anything nested deeper is written inline the same way, in parentheses. An answer that is not JSON
 * (the plain-text rung of the response ladder, a fenced block) is shown as it is.
 */

interface Cursor {
  s: string;
  i: number;
}

interface Piece {
  text: string;
  /** Whether the value was written to its end (its closing quote, bracket or a delimiter after it). */
  closed: boolean;
}

const WS = /\s/;
const SCALAR = /[-+0-9.eEa-zA-Z_]/;

const ws = (p: Cursor) => {
  while (p.i < p.s.length && WS.test(p.s[p.i])) p.i++;
};

/** A JSON string starting at the opening quote, decoded; stops at the closing quote or the end of the
 *  text. An escape cut off by the end is dropped rather than shown as a backslash. */
function readString(p: Cursor): Piece {
  let out = '';
  p.i++; // the opening quote
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === '"') {
      p.i++;
      return { text: out, closed: true };
    }
    if (c === '\\') {
      if (p.i + 1 >= p.s.length) break;
      const e = p.s[p.i + 1];
      if (e === 'u') {
        if (p.i + 6 > p.s.length) break;
        const code = parseInt(p.s.slice(p.i + 2, p.i + 6), 16);
        out += Number.isNaN(code) ? '' : String.fromCharCode(code);
        p.i += 6;
        continue;
      }
      out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '' : e === 'b' || e === 'f' ? '' : e;
      p.i += 2;
      continue;
    }
    out += c;
    p.i++;
  }
  p.i = p.s.length;
  return { text: out, closed: false };
}

/** A number, boolean or null: the run of scalar characters at the cursor. */
function readScalar(p: Cursor): Piece {
  const start = p.i;
  while (p.i < p.s.length && SCALAR.test(p.s[p.i])) p.i++;
  return { text: p.s.slice(start, p.i), closed: p.i < p.s.length };
}

/** Any value at the cursor, written on one line: an object as `k: v` fields joined by " · " (in
 *  parentheses when `nested`), an array as a bracketed list, a string decoded, a scalar as it is. */
function readInline(p: Cursor, nested: boolean): Piece {
  const c = p.s[p.i];
  if (c === '"') return readString(p);
  if (c === '{') {
    p.i++;
    const fields: string[] = [];
    let closed = false;
    for (;;) {
      ws(p);
      if (p.i >= p.s.length) break;
      const d = p.s[p.i];
      if (d === '}') {
        p.i++;
        closed = true;
        break;
      }
      if (d === ',') {
        p.i++;
        continue;
      }
      if (d !== '"') {
        p.i++;
        continue;
      }
      const key = readString(p);
      if (!key.closed) break;
      ws(p);
      if (p.i >= p.s.length) break;
      if (p.s[p.i] === ':') p.i++;
      ws(p);
      if (p.i >= p.s.length) {
        // The value has not started: the key alone, spelled so that what follows only appends to it.
        fields.push(`${key.text}:`);
        break;
      }
      const value = readInline(p, true);
      fields.push(`${key.text}: ${value.text}`);
      if (!value.closed) break;
    }
    const text = fields.join(' · ');
    return { text: nested ? `(${text}${closed ? ')' : ''}` : text, closed };
  }
  if (c === '[') {
    p.i++;
    const items: string[] = [];
    let closed = false;
    for (;;) {
      ws(p);
      if (p.i >= p.s.length) break;
      const d = p.s[p.i];
      if (d === ']') {
        p.i++;
        closed = true;
        break;
      }
      if (d === ',') {
        p.i++;
        continue;
      }
      const item = readInline(p, true);
      items.push(item.text);
      if (!item.closed) break;
    }
    return { text: `[${items.join(', ')}${closed ? ']' : ''}`, closed };
  }
  const scalar = readScalar(p);
  if (!scalar.text) {
    // Something that is not a value (a stray character): step over it so the walk always advances.
    p.i++;
    return { text: '', closed: true };
  }
  return scalar;
}

/** The key the program is stored under, in every twin answer that has one (twinBuilding.ts). */
const CODE_KEY = 'code';

export function renderTwinLive(raw: string): string {
  // The plain-text rung of the ladder may fence its JSON; the block's opening line says nothing.
  const s = raw.replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n?/, '');
  const p: Cursor = { s, i: 0 };
  ws(p);
  if (p.s[p.i] !== '{') return raw.trimStart();
  p.i++;
  let out = '';
  for (;;) {
    ws(p);
    if (p.i >= p.s.length) break;
    const c = p.s[p.i];
    if (c === '}') break;
    if (c === ',') {
      p.i++;
      continue;
    }
    if (c !== '"') {
      p.i++;
      continue;
    }
    const key = readString(p);
    if (!key.closed) break;
    ws(p);
    if (p.s[p.i] === ':') p.i++;
    ws(p);
    if (p.i >= p.s.length) {
      // The value has not started: the key alone, spelled so that what follows — a list's newline, a
      // string's space — only appends to it. The program's key is not written at all (its lines are).
      if (key.text !== CODE_KEY) out += `${key.text}:`;
      break;
    }
    const v = p.s[p.i];
    if (v === '"') {
      const value = readString(p);
      // The program on its own lines, set off from the fields around it.
      if (key.text === CODE_KEY) out += `\n${value.text}${value.closed ? '\n\n' : ''}`;
      else out += `${key.text}: ${value.text}${value.closed ? '\n' : ''}`;
      if (!value.closed) break;
    } else if (v === '[') {
      p.i++;
      out += `${key.text}:\n`;
      let closed = false;
      for (;;) {
        ws(p);
        if (p.i >= p.s.length) break;
        const d = p.s[p.i];
        if (d === ']') {
          p.i++;
          closed = true;
          break;
        }
        if (d === ',') {
          p.i++;
          continue;
        }
        const item = readInline(p, false);
        out += `  - ${item.text}${item.closed ? '\n' : ''}`;
        if (!item.closed) break;
      }
      if (!closed) break;
    } else {
      const value = readInline(p, false);
      out += `${key.text}: ${value.text}${value.closed ? '\n' : ''}`;
      if (!value.closed) break;
    }
  }
  return out;
}
