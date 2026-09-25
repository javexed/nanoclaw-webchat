// The file (and selection) the developer is looking at, as a trailing note on
// every message so "this file" means something to the agent. Pure: no vscode
// import, so it is unit-testable; the view passes the editor's shape in.
export interface EditorLike {
  document: { uri: { scheme: string; fsPath: string } };
  selection: { isEmpty: boolean; active: { line: number }; start: { line: number }; end: { line: number } };
}

export function editorNote(
  editor: EditorLike | undefined,
  rel: (uri: { scheme: string; fsPath: string }) => string,
): string | null {
  if (!editor || editor.document.uri.scheme !== 'file') return null;
  const p = rel(editor.document.uri);
  const sel = editor.selection;
  if (sel.isEmpty) return `(editor: ${p}:${sel.active.line + 1})`;
  return `(editor: ${p}:${sel.start.line + 1}-${sel.end.line + 1} selected)`;
}

/** A message's text and the editor note trailing it, split so the note can be shown apart from the prose. */
export function splitEditorNote(content: string): { text: string; note: string | null } {
  const m = /\n\(editor: ([^)]+)\)\s*$/.exec(content);
  return m ? { text: content.slice(0, m.index), note: m[1] } : { text: content, note: null };
}
