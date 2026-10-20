/*
 * The value of one string field in a JSON object that is still being
 * streamed — so a plan or a report the model is writing as a tool argument
 * can be shown to the user as it grows, instead of appearing all at once when
 * the call ends.
 *
 * Only top-level `"key": "…"` is looked for; escapes are decoded; an escape
 * cut off at the end of the buffer is left for the next call. Returns null
 * while the key's string has not started.
 */

export function partialJsonString(buffer: string, key: string): string | null {
  const needle = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`);
  const m = needle.exec(buffer);
  if (!m) {
    return null;
  }
  let i = m.index + m[0].length;
  let out = '';
  while (i < buffer.length) {
    const c = buffer[i];
    if (c === '"') {
      return out;
    }
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    if (i + 1 >= buffer.length) {
      return out; // a backslash at the very end: wait for the rest
    }
    const e = buffer[i + 1];
    switch (e) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '"':
      case '\\':
      case '/':
        out += e;
        break;
      case 'u': {
        const hex = buffer.slice(i + 2, i + 6);
        if (hex.length < 4) {
          return out;
        }
        const code = Number.parseInt(hex, 16);
        if (Number.isFinite(code)) {
          out += String.fromCharCode(code);
        }
        i += 6;
        continue;
      }
      default:
        out += e;
    }
    i += 2;
  }
  return out;
}
