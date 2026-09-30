// ── DOM leaves ───────────────────────────────────────────────────────────────
// The helpers everything else calls and which call nothing back, so every
// module's dependency on core/ stays one-way.

/** querySelector, the shorthand the whole UI is written in. */
// Defaults to HTMLElement, not Element: callers reach for .hidden / .dataset /
// .value / .style. Pass a type argument for SVG or generic Element cases.
export const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);

/** Inline Lucide icon referencing the SVG sprite in index.html. Returns an HTML
 * string (safe — no user data); styling/color come from the .icon CSS class. */
export function lucide(name: string, cls = ''): string {
  return `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/** Same icon as a detached DOM node, for inserting NEXT TO user-controlled text
 * without resorting to innerHTML (keeps the surrounding text XSS-safe). */
export function lucideEl(name: string, cls = ''): ChildNode {
  const t = document.createElement('template');
  t.innerHTML = lucide(name, cls);
  // Never null: an unknown icon name yields an empty text node, so it renders
  // nothing instead of throwing in the caller's appendChild().
  return t.content.firstChild ?? document.createTextNode('');
}

/** HTML-escape for the few places that still build markup as a string.
 * `'` is escaped too, so a single-quoted attribute built with esc() cannot break out. */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// CSS.escape with a fallback.
export function cssEscape(s: string): string {
  if (window.CSS && CSS.escape) return CSS.escape(String(s));
  return String(s).replace(/["\\\]]/g, '\\$&');
}
