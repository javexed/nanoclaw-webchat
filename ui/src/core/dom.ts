// ── DOM leaves ───────────────────────────────────────────────────────────────
// The helpers everything else calls and which call nothing back. Extracting
// these first keeps every later module a one-way dependency on core/, so the
// split never has to reason about import cycles.

/** querySelector, the shorthand the whole UI is written in. */
export const $ = <T extends Element = Element>(sel: string): T | null => document.querySelector<T>(sel);

/** Inline Lucide icon referencing the SVG sprite in index.html. Returns an HTML
 * string (safe — no user data); styling/color come from the .icon CSS class. */
export function lucide(name: string, cls = ''): string {
  return `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/** Same icon as a detached DOM node, for inserting NEXT TO user-controlled text
 * without resorting to innerHTML (keeps the surrounding text XSS-safe). */
export function lucideEl(name: string, cls = ''): ChildNode | null {
  const t = document.createElement('template');
  t.innerHTML = lucide(name, cls);
  return t.content.firstChild;
}

/** HTML-escape for the few places that still build markup as a string. */
export function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
