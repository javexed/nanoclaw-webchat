import { describe, expect, it } from 'vitest';

import { clip, messageText } from './server/floor-feed.js';

// The feed's risky parts are the two that decide what LEAVES a room: how text
// is cut down, and how a message envelope is unwrapped. Both run over every
// event on an install-wide view, so they get pinned here.

describe('clip', () => {
  it('redacts before truncating, so a secret cannot survive by being long', () => {
    // Truncate-then-redact would leave a half-key in place. Order matters.
    // The literal below is an all-X placeholder, not a key — it exists so the
    // redactor has a real key SHAPE to match. The marker rides the offending
    // line itself because the scanner filters line-wise, not by block.
    const out = clip('token sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'); // leak-scan-allow
    expect(out).not.toContain('sk-ant-api03-XXXX');
  });

  it('caps length so the floor cannot become a transcript reader', () => {
    const out = clip('x'.repeat(400))!;
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a short line alone', () => {
    expect(clip('reading poll-loop.ts')).toBe('reading poll-loop.ts');
  });

  it('passes null through rather than inventing an empty string', () => {
    expect(clip(null)).toBeNull();
    expect(clip(undefined)).toBeNull();
    expect(clip('')).toBeNull();
  });
});

describe('messageText', () => {
  it('pulls the human part out of a JSON envelope', () => {
    expect(messageText(JSON.stringify({ text: 'deploy finished' }))).toBe('deploy finished');
    expect(messageText(JSON.stringify({ prompt: 'run the sweep' }))).toBe('run the sweep');
  });

  it('handles a bare string payload', () => {
    expect(messageText(JSON.stringify('plain'))).toBe('plain');
  });

  it('falls back to the raw content when it is not JSON at all', () => {
    // Some paths write bare text. Returning null there would silently blank
    // real messages on the floor.
    expect(messageText('not json at all')).toBe('not json at all');
  });

  it('returns null for an envelope with no recognisable text field', () => {
    expect(messageText(JSON.stringify({ attachments: [1, 2] }))).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(messageText(null)).toBeNull();
  });
});
