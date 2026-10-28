import { describe, expect, it } from 'vitest';

import { approvalCardText, approvalRawPayload } from './approval-card-text.js';

describe("an approval card's text", () => {
  it('leads with the question and keeps the payload for Details', () => {
    const a = { question: 'Install curl?', payload: { packages: ['curl'] } };
    expect(approvalCardText(a)).toBe('Install curl?');
    expect(approvalRawPayload(a)).toEqual({ packages: ['curl'] });
  });

  it('falls back to a string payload, without repeating it under Details', () => {
    const a = { payload: 'Install curl?' };
    expect(approvalCardText(a)).toBe('Install curl?');
    expect(approvalRawPayload(a)).toBeNull();
  });

  it('shows the payload alone when there is no text', () => {
    expect(approvalCardText({ payload: { a: 1 } })).toBe('');
    expect(approvalRawPayload({ payload: { a: 1 } })).toEqual({ a: 1 });
    expect(approvalRawPayload({ question: 'q' })).toBeNull();
    expect(approvalRawPayload({ question: 'q', payload: '' })).toBeNull();
  });
});
