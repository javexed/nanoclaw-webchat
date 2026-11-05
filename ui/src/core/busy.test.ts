import { afterEach, describe, expect, it, vi } from 'vitest';

import { buttonBusy } from './busy.js';

/** Just enough of an element for buttonBusy (the UI tests run without a DOM). */
function fakeButton() {
  const attrs = new Map<string, string>();
  let children: unknown[] = ['Save'];
  return {
    disabled: false,
    attrs,
    get childNodes() {
      return children;
    },
    set textContent(_v: string) {
      children = [];
    },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    appendChild: (n: unknown) => void children.push(n),
    replaceChildren: (...n: unknown[]) => void (children = n),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('buttonBusy', () => {
  it('marks the control busy for assistive tech, and clears it on restore', () => {
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute() {}, className: '' }),
      createTextNode: (t: string) => t,
    });
    const btn = fakeButton();
    const restore = buttonBusy(btn as unknown as HTMLElement & { disabled?: boolean }, 'Saving…');
    expect(btn.disabled).toBe(true);
    expect(btn.attrs.get('aria-busy')).toBe('true');
    restore();
    expect(btn.disabled).toBe(false);
    expect(btn.attrs.has('aria-busy')).toBe(false);
    expect(btn.childNodes).toEqual(['Save']);
  });
});
