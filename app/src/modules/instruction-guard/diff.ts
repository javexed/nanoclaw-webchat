/**
 * A compact line diff for an approval card. Cards have a hard length limit
 * (MAX_CARD_QUESTION_LENGTH), so this renders changed lines with one line of
 * context and stops at a character budget, saying how much it left out — an
 * approver must never mistake a truncated diff for the whole change.
 */

/** Above this many line pairs the LCS table costs more than the card is worth. */
const MAX_CELLS = 2_000_000;
const CONTEXT = 1;
/** One long line must not eat the whole card. */
const MAX_LINE = 200;

type Op = { kind: ' ' | '-' | '+'; line: string };

function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineOps(a: string[], b: string[]): Op[] | null {
  // Trim the common head and tail first: an edit usually touches a few lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if ((am.length + 1) * (bm.length + 1) > MAX_CELLS) return null;

  // lcs[i][j] = LCS length of am[i..] and bm[j..]
  const lcs: Uint32Array[] = Array.from({ length: am.length + 1 }, () => new Uint32Array(bm.length + 1));
  for (let i = am.length - 1; i >= 0; i--) {
    for (let j = bm.length - 1; j >= 0; j--) {
      lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = a.slice(0, head).map((line) => ({ kind: ' ', line }));
  let i = 0;
  let j = 0;
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) {
      ops.push({ kind: ' ', line: am[i] });
      i++;
      j++;
    } else if (i < am.length && (j === bm.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ kind: '-', line: am[i++] });
    } else {
      ops.push({ kind: '+', line: bm[j++] });
    }
  }
  for (const line of a.slice(a.length - tail)) ops.push({ kind: ' ', line });
  return ops;
}

/**
 * Changed lines (prefixed `-`/`+`) with CONTEXT lines around them, at most
 * `budget` characters. A file too large to diff is shown as a replacement.
 */
export function compactDiff(before: string | null, after: string | null, budget: number): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = lineOps(a, b) ?? [
    ...a.map((line): Op => ({ kind: '-', line })),
    ...b.map((line): Op => ({ kind: '+', line })),
  ];

  const keep = ops.map(() => false);
  ops.forEach((op, idx) => {
    if (op.kind === ' ') return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) keep[k] = true;
  });

  const out: string[] = [];
  let used = 0;
  let shownChanges = 0;
  // Characters cut from changed lines that ARE shown: a long line's hidden
  // tail can carry the whole change, so it is counted like a hidden line.
  let hiddenChars = 0;
  const totalChanges = ops.filter((op) => op.kind !== ' ').length;
  let gap = false;
  // Room for the truncation line, so the whole result stays within budget.
  const room = budget - 128;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep[idx]) {
      gap = true;
      continue;
    }
    const { kind, line } = ops[idx];
    const shown = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
    const rendered = [...(gap && out.length > 0 ? ['…'] : []), `${kind} ${shown}`];
    const cost = rendered.reduce((n, s) => n + s.length + 1, 0);
    if (used + cost > room) break;
    out.push(...rendered);
    used += cost;
    gap = false;
    if (kind !== ' ') {
      shownChanges++;
      hiddenChars += Math.max(0, line.length - MAX_LINE);
    }
  }
  if (totalChanges === 0) return '(whitespace-only change)';
  const missing = totalChanges - shownChanges;
  const notes: string[] = [];
  if (missing > 0) notes.push(`${missing} more changed line${missing === 1 ? '' : 's'} not shown`);
  if (hiddenChars > 0) notes.push(`${hiddenChars} character${hiddenChars === 1 ? '' : 's'} of long lines not shown`);
  if (notes.length > 0) out.push(`(diff truncated: ${notes.join('; ')})`);
  return out.join('\n');
}
