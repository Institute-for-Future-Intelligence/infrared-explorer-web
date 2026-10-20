/*
 * What the user changed in the plan, for the model: a line diff with removed
 * lines as "- ", added lines as "+ ", and each run of unchanged lines folded
 * to "…" (the model has the whole current plan beside it). Plans keep no
 * earlier versions, so this is worked out at the moment the user saves.
 */

/** Above this many line pairs the diff is not searched for; both sides are listed whole. */
const MAX_CELLS = 1_000_000;

export function lineDiff(before: string, after: string, maxChars = 6000): string {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const out: string[] = start > 0 ? ['…'] : [];
  if (A.length * B.length > MAX_CELLS) {
    out.push(...A.map(l => `- ${l}`), ...B.map(l => `+ ${l}`));
  } else {
    // longest common subsequence, filled from the end
    const n = A.length;
    const m = B.length;
    const lcs = Array.from({length: n + 1}, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        if (out[out.length - 1] !== '…') {
          out.push('…');
        }
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        out.push(`- ${A[i]}`);
        i++;
      } else {
        out.push(`+ ${B[j]}`);
        j++;
      }
    }
  }
  if (endA < a.length && out[out.length - 1] !== '…') {
    out.push('…');
  }
  const text = out.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (more changes)` : text;
}
