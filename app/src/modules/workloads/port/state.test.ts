import { describe, expect, it } from 'vitest';

import { pickPort } from './state.js';

describe('handing out ports', () => {
  it('keeps an app on its port while that port is usable', () => {
    const s = { apps: { notes: { port: 9003, at: 0 } } };
    expect(pickPort(s, 'notes', [9001, 9002, 9003])).toBe(9003);
  });

  it('gives the lowest usable port nobody else holds', () => {
    const s = { apps: { notes: { port: 9001, at: 0 } } };
    expect(pickPort(s, 'wiki', [9001, 9002])).toBe(9002);
    // Its port stopped being usable: it moves.
    expect(pickPort({ apps: { wiki: { port: 9005, at: 0 } } }, 'wiki', [9001])).toBe(9001);
  });

  it('none when every usable port is held', () => {
    expect(pickPort({ apps: { notes: { port: 9001, at: 0 } } }, 'wiki', [9001])).toBeNull();
  });
});
