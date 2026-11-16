import { describe, expect, it } from 'vitest';
import { COMPOSE_MAX, cleanComposeText, composeTextFrom, newComposeNonce } from './attachment-compose.js';

// Stand-ins for window objects: only identity matters.
const frame = { name: 'drawer frame' };
const other = { name: 'some other window' };
const NONCE = 'a1b2c3';
const msg = (text: unknown) => ({ type: 'nanoclaw:compose', text, nonce: NONCE });

describe('composeTextFrom — who may speak', () => {
  it('accepts the fixed shape from the drawer frame', () => {
    expect(composeTextFrom({ source: frame, data: msg('hello') }, frame, NONCE)).toBe('hello');
  });

  it('ignores the same message from any other window', () => {
    expect(composeTextFrom({ source: other, data: msg('hello') }, frame, NONCE)).toBeNull();
    expect(composeTextFrom({ source: null, data: msg('hello') }, frame, NONCE)).toBeNull();
    expect(composeTextFrom({ source: undefined, data: msg('hello') }, frame, NONCE)).toBeNull();
  });

  it('ignores everything when there is no frame to compare with', () => {
    // A closed or not-yet-loaded drawer: contentWindow is null, and a message
    // whose source is also null must not slip through on null === null.
    expect(composeTextFrom({ source: null, data: msg('hello') }, null, NONCE)).toBeNull();
    expect(composeTextFrom({ source: undefined, data: msg('hello') }, undefined, NONCE)).toBeNull();
  });

  it("ignores the frame without this open's nonce (a page it navigated to)", () => {
    const send = (data: unknown, nonce = NONCE) => composeTextFrom({ source: frame, data }, frame, nonce);
    expect(send({ type: 'nanoclaw:compose', text: 'x' })).toBeNull();
    expect(send({ type: 'nanoclaw:compose', text: 'x', nonce: 'other' })).toBeNull();
    expect(send({ type: 'nanoclaw:compose', text: 'x', nonce: '' }, '')).toBeNull();
    expect(send(msg('x'), 'other')).toBeNull();
  });

  it('makes a fresh 128-bit nonce each time', () => {
    const a = newComposeNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newComposeNonce()).not.toBe(a);
  });
});

describe('composeTextFrom — what it may say', () => {
  const from = (data: unknown) => composeTextFrom({ source: frame, data }, frame, NONCE);

  it('ignores other types, missing or non-string text', () => {
    expect(from({ type: 'nanoclaw:send', text: 'x' })).toBeNull();
    expect(from({ type: 'nanoclaw:compose' })).toBeNull();
    expect(from(msg(42))).toBeNull();
    expect(from(msg({ toString: () => 'x' }))).toBeNull();
  });

  it('ignores anything but exactly { type, text, nonce }', () => {
    expect(from({ ...msg('x'), send: true })).toBeNull();
    expect(from({ ...msg('x'), autoSend: true })).toBeNull();
    expect(from(['nanoclaw:compose', 'x'])).toBeNull();
    expect(from('nanoclaw:compose')).toBeNull();
    expect(from(null)).toBeNull();
  });

  it('ignores text that is empty once cleaned', () => {
    expect(from(msg(''))).toBeNull();
    expect(from(msg('   \n\t'))).toBeNull();
    expect(from(msg('\u0000\u0007‮'))).toBeNull();
  });

  it(`caps the text at ${COMPOSE_MAX} characters`, () => {
    const out = from(msg('a'.repeat(COMPOSE_MAX + 500)));
    expect(out).toHaveLength(COMPOSE_MAX);
    expect(from(msg('b'.repeat(COMPOSE_MAX)))).toHaveLength(COMPOSE_MAX);
  });

  it('caps after cleaning, so stripped characters cannot pad past the cap', () => {
    const out = from(msg('\u0000'.repeat(10) + 'c'.repeat(COMPOSE_MAX)));
    expect(out).toBe('c'.repeat(COMPOSE_MAX));
  });
});

describe('cleanComposeText', () => {
  it('keeps newlines and tabs, normalises CR', () => {
    expect(cleanComposeText('a\r\nb\rc\td')).toBe('a\nb\nc\td');
  });

  it('strips C0/C1 controls and DEL', () => {
    expect(cleanComposeText('a\u0000b\u001bc\u007fd\u0085e')).toBe('abcde');
  });

  it('strips bidi overrides and isolates', () => {
    expect(cleanComposeText('ok‮gnirts‬ ⁦x⁩')).toBe('okgnirts x');
  });
});
