import { describe, expect, it } from 'vitest';

import { replyPreviewApplies } from './reply-preview.js';

describe('the live reply preview', () => {
  it('shows in its own thread while the turn is open', () => {
    expect(replyPreviewApplies({ thread_id: 't1', text: 'Half' }, 't1', true)).toBe(true);
  });

  it("never shows in a thread it isn't being written in", () => {
    expect(replyPreviewApplies({ thread_id: 't1', text: 'Half' }, 'main', true)).toBe(false);
  });

  it('never reopens a bubble once the turn has ended', () => {
    expect(replyPreviewApplies({ thread_id: 'main', text: 'Late' }, 'main', false)).toBe(false);
  });

  it('always lets a clear through', () => {
    expect(replyPreviewApplies({ thread_id: 't1', text: null }, 'main', false)).toBe(true);
  });
});
