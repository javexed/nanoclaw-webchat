import { describe, expect, it } from 'vitest';

import { clip, deskEligible, messageText } from './server/floor-feed.js';

// The feed's risky parts are the two that decide what LEAVES a room: how text
// is cut down, and how a message envelope is unwrapped. Both run over every
// event on an install-wide view, so they get pinned here.

describe('clip', () => {
  it('redacts before truncating, so a secret cannot survive by being long', async () => {
    // Truncate-then-redact would leave a half-key in place. Order matters.
    // The literal below is an all-X placeholder, not a key — it exists so the
    // redactor has a real key SHAPE to match. The marker rides the offending
    // line itself because the scanner filters line-wise, not by block.
    const out = clip('token sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'); // leak-scan-allow
    expect(out).not.toContain('sk-ant-api03-XXXX');
  });

  it('caps length so the floor cannot become a transcript reader', async () => {
    const out = clip('x'.repeat(400))!;
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a short line alone', async () => {
    expect(clip('reading poll-loop.ts')).toBe('reading poll-loop.ts');
  });

  it('passes null through rather than inventing an empty string', async () => {
    expect(clip(null)).toBeNull();
    expect(clip(undefined)).toBeNull();
    expect(clip('')).toBeNull();
  });
});

describe('messageText', () => {
  it('pulls the human part out of a JSON envelope', async () => {
    expect(messageText(JSON.stringify({ text: 'deploy finished' }))).toBe('deploy finished');
    expect(messageText(JSON.stringify({ prompt: 'run the sweep' }))).toBe('run the sweep');
  });

  it('handles a bare string payload', async () => {
    expect(messageText(JSON.stringify('plain'))).toBe('plain');
  });

  it('falls back to the raw content when it is not JSON at all', async () => {
    // Some paths write bare text. Returning null there would silently blank
    // real messages on the floor.
    expect(messageText('not json at all')).toBe('not json at all');
  });

  it('returns null for an envelope with no recognisable text field', async () => {
    expect(messageText(JSON.stringify({ attachments: [1, 2] }))).toBeNull();
  });

  it('returns null for empty input', async () => {
    expect(messageText(null)).toBeNull();
  });
});

describe('deskEligible', () => {
  const NOW = Date.parse('2026-08-21T05:20:40.000Z');

  it('always reads a running session', async () => {
    expect(deskEligible(true, null, NOW)).toBe(true);
  });

  it('reads a cold session that was active moments ago — the cold-spawn window', async () => {
    // The shipped miss: the waking message lands in inbound.db BEFORE the
    // container exists. Skip the session while it spawns and the cursor
    // advances past the arrival, so it never shows at all.
    expect(deskEligible(false, '2026-08-21T05:20:34.712Z', NOW)).toBe(true);
  });

  it('skips a session cold for longer than the grace window', async () => {
    expect(deskEligible(false, '2026-08-21T04:20:00.000Z', NOW)).toBe(false);
  });

  it('never guesses when last_active is missing or unparseable', async () => {
    expect(deskEligible(false, null, NOW)).toBe(false);
    expect(deskEligible(false, 'not-a-date', NOW)).toBe(false);
  });
});
