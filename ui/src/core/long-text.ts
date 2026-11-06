/**
 * Long text in the chat: when a paste becomes an attachment, and when a code
 * block starts collapsed. Pure, so the thresholds are tested in one place.
 */

/** Pastes past either size become a pasted-text.txt attachment. */
export const LONG_PASTE_LINES = 40;
export const LONG_PASTE_CHARS = 4000;

/** Code blocks longer than this start collapsed, with "Show all". The collapsed
 * height (style.css, 15em) shows about 12 lines, so a clamp always hides a dozen or more. */
export const CODE_CLAMP_LINES = 25;

/** What a paste into the composer becomes: a file, a ```text block, or plain inline text. */
export function pasteKind(text: string): 'attach' | 'block' | 'inline' {
  if (text.length > LONG_PASTE_CHARS || lineCount(text) > LONG_PASTE_LINES) return 'attach';
  return text.includes('\n') ? 'block' : 'inline';
}

/** Lines in a block of text, not counting one trailing newline. */
export function lineCount(text: string): number {
  return text.replace(/\n$/, '').split('\n').length;
}

/** Ctrl/Cmd+Shift+V: paste as plain text, never as a file or a fenced block. */
export function isPlainPasteKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';
}
