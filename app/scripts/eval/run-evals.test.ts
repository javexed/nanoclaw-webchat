import { describe, expect, it } from 'vitest';

import { effectiveTimeoutMs, httpBaseFromWsUrl } from './run-evals.js';

// The runner's only pure piece worth pinning. Everything else in that file
// needs a live install; this does not, and getting it wrong fails SILENTLY in
// the direction that matters — a `wss://` install called over plain http means
// the between-case reset never lands, and the suite carries on scoring
// contaminated turns without saying so.
describe('httpBaseFromWsUrl', () => {
  it('maps ws to http and wss to https', async () => {
    expect(httpBaseFromWsUrl('ws://127.0.0.1:3100/ws')).toBe('http://127.0.0.1:3100');
    expect(httpBaseFromWsUrl('wss://nanoclaw.example.ts.net/ws')).toBe('https://nanoclaw.example.ts.net');
  });

  it('keeps a non-default port', async () => {
    // The bare-IP form this is normally driven with carries one. (Address from
    // the TEST-NET-3 documentation range, never a real host.)
    expect(httpBaseFromWsUrl('ws://203.0.113.10:3100/ws')).toBe('http://203.0.113.10:3100');
  });

  it('drops path, query and fragment so a route can be appended', async () => {
    expect(httpBaseFromWsUrl('ws://host:3100/ws?token=x#frag')).toBe('http://host:3100');
  });

  it('leaves no trailing slash for a bare origin', async () => {
    // `${base}/api/...` would otherwise produce a double slash.
    expect(httpBaseFromWsUrl('ws://host:3100')).toBe('http://host:3100');
  });
});

describe('effectiveTimeoutMs', () => {
  it('widens a case budget to the model budget when the model is slower', () => {
    // The bug this fixes: ornith-1.5:9b answering correctly in 122s against a
    // 120s case reported "turn did not finish" — a capability failure the
    // model never committed.
    expect(effectiveTimeoutMs(120_000, 335_000)).toBe(335_000);
  });

  it('leaves a generous case budget alone', () => {
    // A case that already allows more than the model needs keeps its own
    // number; this only ever widens.
    expect(effectiveTimeoutMs(300_000, 220_000)).toBe(300_000);
  });

  it('falls back to the case budget when the model could not be resolved', () => {
    expect(effectiveTimeoutMs(120_000, null)).toBe(120_000);
    expect(effectiveTimeoutMs(120_000, undefined)).toBe(120_000);
  });

  it('uses the default when the case names no budget', () => {
    expect(effectiveTimeoutMs(undefined, null)).toBe(600_000);
  });

  it('ignores a nonsense model budget rather than shrinking the case', () => {
    // A zero or negative derived value must never tighten a case's own bound.
    expect(effectiveTimeoutMs(120_000, 0)).toBe(120_000);
    expect(effectiveTimeoutMs(120_000, -5)).toBe(120_000);
  });
});
