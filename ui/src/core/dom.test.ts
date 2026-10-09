import { describe, expect, it } from 'vitest';

import { esc } from './dom.js';

describe('esc — the escape for markup built as a string', () => {
  it('escapes every character that can open a tag, an entity or an attribute', () => {
    expect(esc(`<img src=x onerror="a()">&'`)).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  });

  it('cannot break out of a single- or double-quoted attribute', () => {
    for (const q of [`'`, `"`]) {
      const html = `<a title=${q}${esc(`${q} onclick=${q}x()`)}${q}>`;
      expect(html.split(q)).toHaveLength(3); // the attribute's own two quotes, nothing more
    }
  });

  it('escapes & first, so an existing entity is shown, not decoded', () => {
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  it('turns anything into text', () => {
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('null');
    expect(esc(undefined)).toBe('undefined');
  });
});
