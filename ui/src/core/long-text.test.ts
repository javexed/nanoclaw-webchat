import { describe, expect, it } from 'vitest';

import {
  CODE_CLAMP_LINES,
  LONG_PASTE_CHARS,
  LONG_PASTE_LINES,
  isPlainPasteKey,
  lineCount,
  pasteKind,
} from './long-text.js';

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

  it('knows the plain-paste shortcut', () => {
    const key = (k: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey', boolean>>) => ({
      key: k,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      ...mods,
    });
    expect(isPlainPasteKey(key('V', { shiftKey: true, ctrlKey: true }))).toBe(true);
    expect(isPlainPasteKey(key('v', { shiftKey: true, metaKey: true }))).toBe(true);
    expect(isPlainPasteKey(key('v', { ctrlKey: true }))).toBe(false);
    expect(isPlainPasteKey(key('v', { shiftKey: true }))).toBe(false);
  });
});
