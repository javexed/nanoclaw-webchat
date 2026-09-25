import { describe, expect, it } from 'vitest';

import {
  adjustBlocks,
  blockAt,
  lineHunks,
  planDirect,
  planPropose,
  resolveBlock,
  splitLines,
  type Block,
  type Insert,
} from './inline-review.js';

/**
 * Apply a plan's inserts to text — exactly what the controller's edits do. A
 * review never changes whether the file ends with a newline (a line diff cannot
 * see it); an empty file counts as ending with one, because inserting lines
 * into it writes each with its line ending.
 */
function applyInserts(text: string, inserts: Insert[]): string {
  const { lines, eol } = splitLines(text);
  const out = [...lines];
  for (const ins of [...inserts].sort((x, y) => y.line - x.line)) out.splice(ins.line, 0, ...ins.lines);
  const trailing = text.endsWith('\n') || (text === '' && out.length > 0);
  return out.join(eol) + (trailing ? eol : '');
}

/** Delete lines [start, start+count) from text — what the controller's delete does. */
function deleteLines(text: string, start: number, count: number): string {
  const { lines, eol } = splitLines(text);
  const trailing = text.endsWith('\n');
  lines.splice(start, count);
  return lines.length ? lines.join(eol) + (trailing ? eol : '') : '';
}

/** Open a review on `doc`, then decide every block in order; returns the final text. */
function review(
  doc: string,
  plan: { inserts: Insert[]; blocks: Block[] },
  decide: (k: number) => 'accept' | 'reject',
): string {
  let text = applyInserts(doc, plan.inserts);
  let blocks = plan.blocks;
  for (let k = 0; blocks.length; k++) {
    const r = resolveBlock(blocks, 0, decide(k));
    text = deleteLines(text, r.deleteStart, r.deleteCount);
    blocks = r.blocks;
  }
  return text;
}

const BASE = [
  'import a',
  'import b',
  '',
  'function f() {',
  '  return 1;',
  '}',
  '',
  'function g() {',
  '  return 2;',
  '}',
  '',
].join('\n');
const PROPOSAL = [
  'import a',
  'import b',
  'import c',
  '',
  'function f() {',
  '  return 42;',
  '}',
  '',
  'function g() {',
  '  return 2;',
  '}',
  '',
].join('\n');

describe('lineHunks', () => {
  it('finds insertions, replacements and deletions as separate hunks', () => {
    expect(lineHunks(BASE, PROPOSAL)).toEqual([
      { oldStart: 2, newStart: 2, oldLines: [], newLines: ['import c'] },
      { oldStart: 4, newStart: 5, oldLines: ['  return 1;'], newLines: ['  return 42;'] },
    ]);
    expect(lineHunks('a\nb\nc\n', 'a\nc\n')).toEqual([{ oldStart: 1, newStart: 1, oldLines: ['b'], newLines: [] }]);
    expect(lineHunks('same\n', 'same\n')).toEqual([]);
    expect(lineHunks('', 'new file\n')).toEqual([{ oldStart: 0, newStart: 0, oldLines: [], newLines: ['new file'] }]);
  });
});

describe('propose mode', () => {
  it("lays the agent's lines under the lines they replace, red above green", () => {
    const plan = planPropose(BASE, PROPOSAL, BASE);
    const shown = applyInserts(BASE, plan.inserts).split('\n');
    expect(plan.blocks).toEqual([
      { removedStart: 2, removedCount: 0, addedStart: 2, addedCount: 1 },
      { removedStart: 5, removedCount: 1, addedStart: 6, addedCount: 1 },
    ]);
    expect(shown[2]).toBe('import c');
    expect(shown.slice(5, 7)).toEqual(['  return 1;', '  return 42;']);
  });

  it("accept all gives the proposal, reject all gives the developer's file, a mix gives exactly the chosen hunks", () => {
    const plan = planPropose(BASE, PROPOSAL, BASE);
    expect(review(BASE, plan, () => 'accept')).toBe(PROPOSAL);
    expect(review(BASE, plan, () => 'reject')).toBe(BASE);
    expect(review(BASE, plan, (k) => (k === 0 ? 'accept' : 'reject'))).toBe(
      BASE.replace('import b\n', 'import b\nimport c\n'),
    );
    expect(review(BASE, plan, (k) => (k === 0 ? 'reject' : 'accept'))).toBe(BASE.replace('return 1;', 'return 42;'));
  });

  it("places hunks in a file the developer has edited since, and keeps the developer's edits", () => {
    // The developer added a header and changed g() — lines the agent did not touch.
    const current = '// header\n// more\n' + BASE.replace('return 2;', 'return 3;');
    const plan = planPropose(BASE, PROPOSAL, current);
    expect(plan.conflicts).toEqual([]);
    expect(review(current, plan, () => 'accept')).toBe(
      '// header\n// more\n' + PROPOSAL.replace('return 2;', 'return 3;'),
    );
    expect(review(current, plan, () => 'reject')).toBe(current);
  });

  it('a hunk whose lines the developer changed is set aside, not forced in', () => {
    const current = BASE.replace('return 1;', 'return 7;');
    const plan = planPropose(BASE, PROPOSAL, current);
    expect(plan.conflicts.map((h) => h.oldLines)).toEqual([['  return 1;']]);
    expect(plan.blocks).toHaveLength(1); // the import still reviews inline
    expect(review(current, plan, () => 'accept')).toBe(current.replace('import b\n', 'import b\nimport c\n'));
  });

  it('keeps CRLF files CRLF', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    const plan = planPropose(crlf(BASE), crlf(PROPOSAL), crlf(BASE));
    expect(review(crlf(BASE), plan, () => 'accept')).toBe(crlf(PROPOSAL));
  });
});

describe('direct mode', () => {
  it("brings the old lines back above the agent's; accept keeps what is on disk, reject restores the old", () => {
    const plan = planDirect(BASE, PROPOSAL);
    const shown = applyInserts(PROPOSAL, plan.inserts).split('\n');
    expect(shown.slice(5, 7)).toEqual(['  return 1;', '  return 42;']);
    expect(review(PROPOSAL, plan, () => 'accept')).toBe(PROPOSAL);
    expect(review(PROPOSAL, plan, () => 'reject')).toBe(BASE);
    expect(review(PROPOSAL, plan, (k) => (k === 0 ? 'reject' : 'accept'))).toBe(
      BASE.replace('return 1;', 'return 42;'),
    );
  });
});

describe('while the developer types', () => {
  const blocks: Block[] = [
    { removedStart: 5, removedCount: 1, addedStart: 6, addedCount: 2 },
    { removedStart: 20, removedCount: 0, addedStart: 20, addedCount: 3 },
  ];
  it('shifts blocks below an edit and leaves blocks above it', () => {
    expect(adjustBlocks(blocks, 1, 1, 2)).toEqual([
      { removedStart: 7, removedCount: 1, addedStart: 8, addedCount: 2 },
      { removedStart: 22, removedCount: 0, addedStart: 22, addedCount: 3 },
    ]);
    expect(adjustBlocks(blocks, 30, 30, 5)).toEqual(blocks);
  });
  it('grows the part of a block an edit lands in', () => {
    const [b0, b1] = adjustBlocks(blocks, 7, 7, 1); // a new line typed inside the green part of block 0
    expect(b0).toEqual({ removedStart: 5, removedCount: 1, addedStart: 6, addedCount: 3 });
    expect(b1.removedStart).toBe(21);
  });
  it('finds the block under the cursor', () => {
    expect(blockAt(blocks, 5)).toBe(0);
    expect(blockAt(blocks, 7)).toBe(0);
    expect(blockAt(blocks, 8)).toBe(-1);
    expect(blockAt(blocks, 21)).toBe(1);
  });
});

describe('randomized', () => {
  // A tiny deterministic PRNG so failures reproduce.
  let seed = 12345;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const vocab = ['a', 'b', 'c', 'd', '', '}', '  x();', 'return;'];
  const randomFile = () =>
    Array.from({ length: rnd(30) }, () => vocab[rnd(vocab.length)]).join('\n') + (rnd(2) ? '\n' : '');
  const mutate = (text: string) => {
    const lines = text.split('\n');
    for (let k = rnd(5); k >= 0; k--) {
      const at = rnd(lines.length + 1);
      const op = rnd(3);
      if (op === 0) lines.splice(at, 0, `new${rnd(100)}`);
      else if (op === 1 && lines.length > 1) lines.splice(at % lines.length, 1);
      else if (lines.length) lines[at % lines.length] = `changed${rnd(100)}`;
    }
    return lines.join('\n');
  };
  // The review keeps the buffer's final-newline state; compare with the proposal adjusted to it.
  const withEnding = (text: string, like: string) => {
    if (text === '') return '';
    const want = like === '' || like.endsWith('\n');
    if (want) return text.endsWith('\n') ? text : `${text}\n`;
    return text.endsWith('\n') && text !== '\n' ? text.slice(0, -1) : text;
  };
  it('accept all and reject all are exact in both modes, over 500 random edits', () => {
    for (let n = 0; n < 500; n++) {
      const base = randomFile();
      const proposal = withEnding(mutate(base), base);
      const p = planPropose(base, proposal, base);
      expect(review(base, p, () => 'accept')).toBe(proposal);
      expect(review(base, p, () => 'reject')).toBe(base);
      const d = planDirect(base, proposal);
      expect(review(proposal, d, () => 'accept')).toBe(proposal);
      expect(review(proposal, d, () => 'reject')).toBe(base);
    }
  });
});
