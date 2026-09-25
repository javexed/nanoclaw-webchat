import { describe, expect, it } from 'vitest';

import { editorNote, splitEditorNote } from './editor-note.js';

const rel = (u: { fsPath: string }) => u.fsPath.replace(/^\/ws\//, '');
const ed = (file: string, start: number, end: number, scheme = 'file') => ({
  document: { uri: { scheme, fsPath: `/ws/${file}` } },
  selection: { isEmpty: start === end, active: { line: start }, start: { line: start }, end: { line: end } },
});

describe('editorNote', () => {
  it('names the file and cursor line, or the selected range; nothing for non-file editors or no editor', () => {
    expect(editorNote(ed('src/app.ts', 41, 41), rel)).toBe('(editor: src/app.ts:42)');
    expect(editorNote(ed('src/app.ts', 9, 19), rel)).toBe('(editor: src/app.ts:10-20 selected)');
    expect(editorNote(ed('Untitled-1', 0, 0, 'untitled'), rel)).toBeNull();
    expect(editorNote(undefined, rel)).toBeNull();
  });
});

describe('splitEditorNote', () => {
  it('separates the trailing editor note from the prose, and leaves other text whole', () => {
    expect(splitEditorNote('fix this\n(editor: src/app.ts:42)')).toEqual({ text: 'fix this', note: 'src/app.ts:42' });
    expect(splitEditorNote('see (editor: x) here')).toEqual({ text: 'see (editor: x) here', note: null });
    expect(splitEditorNote('\n(editor: a.ts:1-2 selected)\n')).toEqual({ text: '', note: 'a.ts:1-2 selected' });
  });
});
