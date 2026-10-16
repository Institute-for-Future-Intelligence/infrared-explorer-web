/*
 * A capture's number in its project (Capture 1, 2, … in the order added), the
 * one its tile shows everywhere and the AI is told. The server gives it out
 * when a capture is filed and never reuses a removed one's
 * (functions/src/store.ts numberTakes); a take that arrives without one (a
 * server from before numbers) is numbered here the same way, after the
 * numbered ones, in the order added.
 */

import type {Take} from './types';

export function captureNumbers(takes: Take[]): Map<string, number> {
  const out = new Map<string, number>();
  let next = 0;
  for (const t of takes) {
    if (t.n != null) {
      out.set(t.takeId, t.n);
      next = Math.max(next, t.n);
    }
  }
  for (const t of [...takes].sort((a, b) => a.at - b.at)) {
    if (t.n == null) {
      out.set(t.takeId, ++next);
    }
  }
  return out;
}
