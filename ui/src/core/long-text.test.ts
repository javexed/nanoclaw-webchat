import { describe, expect, it } from 'vitest';

import { CODE_CLAMP_LINES, LONG_PASTE_CHARS, LONG_PASTE_LINES, lineCount, pasteKind } from './long-text.js';

describe('long text', () => {
  it('turns a long paste into an attachment, by lines or by size', () => {
    expect(pasteKind('a\n'.repeat(LONG_PASTE_LINES + 1))).toBe('attach');
    expect(pasteKind('x'.repeat(LONG_PASTE_CHARS + 1))).toBe('attach');
  });

  it('keeps short pastes as a block, or inline when on one line', () => {
    expect(pasteKind('a\nb')).toBe('block');
    expect(pasteKind('a\n'.repeat(LONG_PASTE_LINES - 1))).toBe('block');
    expect(pasteKind('one line')).toBe('inline');
  });

  it('counts lines without the trailing newline', () => {
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('x\n'.repeat(CODE_CLAMP_LINES + 1))).toBe(CODE_CLAMP_LINES + 1);
  });
});
