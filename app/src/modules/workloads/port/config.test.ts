import { describe, expect, it } from 'vitest';

import { MAX_PORTS, parsePorts, portSettings } from './config.js';

describe('tailnet ports settings', () => {
  it('is off until a range is named', () => {
    expect(portSettings(() => undefined)).toEqual({ on: false });
    expect(portSettings(() => '')).toEqual({ on: false });
  });

  it('reads one port or a range', () => {
    expect(portSettings(() => '9001-9003')).toEqual({
      on: true,
      ok: true,
      ports: [9001, 9002, 9003],
      range: '9001-9003',
    });
    expect(portSettings(() => '9001')).toEqual({ on: true, ok: true, ports: [9001], range: '9001' });
    expect(parsePorts(' 9001 - 9002 ')).toEqual([9001, 9002]);
  });

  it('refuses privileged ports, reversed or oversized ranges, and anything else', () => {
    for (const bad of ['443', '80-9000', '9010-9001', '9001-70000', `9001-${9001 + MAX_PORTS}`, 'all', '9001,9002'])
      expect(
        portSettings(() => bad),
        bad,
      ).toMatchObject({ on: true, ok: false });
    expect(parsePorts(`9001-${9000 + MAX_PORTS}`)).toHaveLength(MAX_PORTS);
  });
});
