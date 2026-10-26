import { describe, expect, it } from 'vitest';

import { servedModelShown } from './served-model.js';

describe("a reply's served model", () => {
  const reply = { isAgent: true, servedModel: 'qwen3.5:4b' };

  it('shows only for a viewer who turned it on', () => {
    expect(servedModelShown(reply, { showModel: true })).toBe('qwen3.5:4b');
    expect(servedModelShown(reply, { showModel: false })).toBeNull();
    expect(servedModelShown(reply, {})).toBeNull();
    expect(servedModelShown(reply, null)).toBeNull();
  });

  it('shows nothing when unknown, or on a message that is not a reply', () => {
    expect(servedModelShown({ isAgent: true, servedModel: null }, { showModel: true })).toBeNull();
    expect(servedModelShown({ isAgent: true }, { showModel: true })).toBeNull();
    expect(servedModelShown({ isAgent: false, servedModel: 'm' }, { showModel: true })).toBeNull();
  });
});
