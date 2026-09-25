// The engine behind inline review: which lines changed, where they go in the
// file the developer has open, and what Accept / Reject does to that file.
// No vscode import — every rule here is unit-tested; review-controller.ts
// only turns these plans into edits, decorations and CodeLenses.
//
// A review shows each change as a BLOCK in the real buffer: the old lines
// (red, struck through) directly above the new lines (green). Accept deletes
// the red lines, Reject deletes the green ones. Both kinds of line are real
// text in the buffer while the review is open — VS Code offers extensions no
// inline-diff API, and decorations cannot render whole extra lines.

export interface Hunk {
  /** 0-based index of the first old line (for a pure insertion: the line it goes before). */
  oldStart: number;
  /** 0-based index of the first new line, likewise. */
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export interface Block {
  /** First red (old) line in the buffer, 0-based. */
  removedStart: number;
  removedCount: number;
  /** First green (new) line — always removedStart + removedCount. */
  addedStart: number;
  addedCount: number;
}

export interface Insert {
  /** Insert before this 0-based line of the buffer as it is before the review opens. */
  line: number;
  lines: string[];
}

export interface ReviewPlan {
  inserts: Insert[];
  blocks: Block[];
  /** Changes that could not be placed in the current file (it moved on); left to a 3-way apply. */
  conflicts: Hunk[];
}

export function splitLines(text: string): { lines: string[]; eol: '\n' | '\r\n' } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text.endsWith('\n') ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text;
  return { lines: text.length === 0 ? [] : body.split(/\r?\n/), eol };
}

/** Beyond this many cells the middle of a file is treated as one replaced block rather than diffed. */
const MAX_CELLS = 4_000_000;

/** Line-level diff, grouped into hunks of contiguous change. */
export function lineHunks(oldText: string, newText: string): Hunk[] {
  const a = splitLines(oldText).lines;
  const b = splitLines(newText).lines;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length === 0 && bm.length === 0) return [];
  if (am.length * bm.length > MAX_CELLS || am.length === 0 || bm.length === 0) {
    return [{ oldStart: pre, newStart: pre, oldLines: am, newLines: bm }];
  }
  // LCS table over the differing middle only.
  const n = am.length;
  const m = bm.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  const open = () => (cur ??= { oldStart: pre + i, newStart: pre + j, oldLines: [], newLines: [] });
  const close = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i >= n || t[i * w + j + 1] >= t[(i + 1) * w + j])) {
      open().newLines.push(bm[j++]);
    } else {
      open().oldLines.push(am[i++]);
    }
  }
  close();
  return hunks;
}

const CONTEXT = 2;

function matchesAt(hay: string[], at: number, needle: string[]): boolean {
  if (at < 0 || at + needle.length > hay.length) return false;
  for (let k = 0; k < needle.length; k++) if (hay[at + k] !== needle[k]) return false;
  return true;
}

/**
 * Where does each hunk (in base coordinates) begin in `current`? The developer
 * may have edited the file since the agent's copy was made. A hunk is placed
 * where its old lines — and the base lines around them — still read the same,
 * nearest to where the earlier hunks suggest; never overlapping an earlier
 * one. null means it no longer fits.
 */
export function placeHunks(base: string[], current: string[], hunks: Hunk[]): Array<number | null> {
  const same = base.length === current.length && base.every((l, k) => l === current[k]);
  if (same) return hunks.map((h) => h.oldStart);
  const out: Array<number | null> = [];
  let drift = 0;
  let floor = 0;
  for (const h of hunks) {
    const before = base.slice(Math.max(0, h.oldStart - CONTEXT), h.oldStart);
    const after = base.slice(h.oldStart + h.oldLines.length, h.oldStart + h.oldLines.length + CONTEXT);
    // A pure insertion has nothing of its own to match: it needs its surroundings.
    if (h.oldLines.length === 0 && before.length === 0 && after.length === 0) {
      out.push(current.length === 0 ? 0 : null);
      continue;
    }
    const fits = (p: number) =>
      p >= floor &&
      matchesAt(current, p, h.oldLines) &&
      matchesAt(current, p - before.length, before) &&
      matchesAt(current, p + h.oldLines.length, after);
    const expected = h.oldStart + drift;
    let found: number | null = null;
    for (let d = 0; d <= current.length; d++) {
      if (fits(expected - d)) {
        found = expected - d;
        break;
      }
      if (d > 0 && fits(expected + d)) {
        found = expected + d;
        break;
      }
    }
    out.push(found);
    if (found !== null) {
      drift = found - h.oldStart;
      floor = found + h.oldLines.length;
    }
  }
  return out;
}

/**
 * Propose mode: the buffer holds the developer's file; the agent's new lines
 * are inserted under the lines they replace.
 */
export function planPropose(base: string, proposal: string, current: string): ReviewPlan {
  const hunks = lineHunks(base, proposal);
  const places = placeHunks(splitLines(base).lines, splitLines(current).lines, hunks);
  const inserts: Insert[] = [];
  const blocks: Block[] = [];
  const conflicts: Hunk[] = [];
  let offset = 0;
  hunks.forEach((h, k) => {
    const at = places[k];
    if (at === null) {
      conflicts.push(h);
      return;
    }
    if (h.newLines.length) inserts.push({ line: at + h.oldLines.length, lines: h.newLines });
    const removedStart = at + offset;
    blocks.push({
      removedStart,
      removedCount: h.oldLines.length,
      addedStart: removedStart + h.oldLines.length,
      addedCount: h.newLines.length,
    });
    offset += h.newLines.length;
  });
  return { inserts, blocks, conflicts };
}

/**
 * Direct mode: the agent already wrote the file, so the buffer holds its new
 * content; the old lines come back in above the lines that replaced them.
 */
export function planDirect(old: string, current: string): ReviewPlan {
  const hunks = lineHunks(old, current);
  const inserts: Insert[] = [];
  const blocks: Block[] = [];
  let offset = 0;
  for (const h of hunks) {
    if (h.oldLines.length) inserts.push({ line: h.newStart, lines: h.oldLines });
    const removedStart = h.newStart + offset;
    blocks.push({
      removedStart,
      removedCount: h.oldLines.length,
      addedStart: removedStart + h.oldLines.length,
      addedCount: h.newLines.length,
    });
    offset += h.oldLines.length;
  }
  return { inserts, blocks, conflicts: [] };
}

/** Accept keeps the new lines (deletes the red); Reject keeps the old (deletes the green). */
export function resolveBlock(
  blocks: Block[],
  index: number,
  decision: 'accept' | 'reject',
): { deleteStart: number; deleteCount: number; blocks: Block[] } {
  const b = blocks[index];
  const deleteStart = decision === 'accept' ? b.removedStart : b.addedStart;
  const deleteCount = decision === 'accept' ? b.removedCount : b.addedCount;
  const rest = blocks
    .filter((_, k) => k !== index)
    .map((x) =>
      x.removedStart > b.removedStart
        ? { ...x, removedStart: x.removedStart - deleteCount, addedStart: x.addedStart - deleteCount }
        : x,
    );
  return { deleteStart, deleteCount, blocks: rest };
}

/**
 * Keep blocks on their lines while the developer types. An edit spanning old
 * lines [startLine, endLine] that adds `delta` lines shifts every block below
 * it; an edit inside a block grows or shrinks the part it lands in.
 */
export function adjustBlocks(blocks: Block[], startLine: number, endLine: number, delta: number): Block[] {
  if (delta === 0) return blocks;
  return blocks.map((b) => {
    const end = b.addedStart + b.addedCount; // exclusive
    if (endLine < b.removedStart) {
      return { ...b, removedStart: b.removedStart + delta, addedStart: b.addedStart + delta };
    }
    if (startLine >= end && !(b.addedCount === 0 && startLine === end)) return b;
    if (startLine >= b.addedStart) return { ...b, addedCount: Math.max(0, b.addedCount + delta) };
    const removedCount = Math.max(0, b.removedCount + delta);
    return { ...b, removedCount, addedStart: b.removedStart + removedCount };
  });
}

/** The block a cursor on `line` belongs to, or -1. */
export function blockAt(blocks: Block[], line: number): number {
  return blocks.findIndex((b) => line >= b.removedStart && line < b.addedStart + b.addedCount);
}
