import { describe, expect, it } from 'vitest';

import { canConnect, canJoin, initialSsh, OUTPUT_MAX, parseSse, reduceSsh } from './ssh-join-view.js';

describe('Join over SSH dialog', () => {
  it('goes form → confirm → running → done, and reset starts over', () => {
    let s = { ...initialSsh(), host: 'app.internal', username: 'azureuser' };
    expect(canConnect(s)).toBe(true);
    s = reduceSsh(s, { type: 'probed', probeId: 'p1', fingerprint: 'SHA256:x', address: '10.0.0.10' });
    expect(s).toMatchObject({ phase: 'confirm', probeId: 'p1', fingerprint: 'SHA256:x', address: '10.0.0.10' });
    s = reduceSsh(s, { type: 'start' });
    expect(s.phase).toBe('running');
    s = reduceSsh(s, { type: 'event', event: { t: 'out', s: 'a\n' } });
    s = reduceSsh(s, { type: 'event', event: { t: 'out', s: 'b\n' } });
    expect(s.output).toBe('a\nb\n');
    s = reduceSsh(s, { type: 'event', event: { t: 'done', ok: false, error: 'sudo needs a password' } });
    expect(s).toMatchObject({ phase: 'done', ok: false, error: 'sudo needs a password', probeId: undefined });
    expect(reduceSsh(s, { type: 'reset' })).toEqual(initialSsh());
  });

  it('Connect needs host, port and user; Join needs a password or a key, only once confirming', () => {
    expect(canConnect({ ...initialSsh(), host: 'h', username: '' })).toBe(false);
    expect(canConnect({ ...initialSsh(), host: 'h', username: 'u', port: '70000' })).toBe(false);
    const c = { ...initialSsh(), phase: 'confirm' as const };
    expect(canJoin(c, { password: '', privateKey: '' })).toBe(false);
    expect(canJoin(c, { password: 'pw', privateKey: '' })).toBe(true);
    expect(canJoin({ ...c, auth: 'key' }, { password: 'pw', privateKey: '' })).toBe(false);
    expect(canJoin({ ...c, auth: 'key' }, { password: '', privateKey: '-----BEGIN' })).toBe(true);
    expect(canJoin(initialSsh(), { password: 'pw', privateKey: '' })).toBe(false);
  });

  it('keeps only the tail of very long output', () => {
    let s = reduceSsh(initialSsh(), { type: 'start' });
    s = reduceSsh(s, { type: 'event', event: { t: 'out', s: 'x'.repeat(OUTPUT_MAX + 10) } });
    expect(s.output.length).toBe(OUTPUT_MAX);
  });

  it('parses server-sent events across chunk boundaries', () => {
    const a = parseSse('data: {"t":"out","s":"one"}\n\ndata: {"t":"o');
    expect(a.events).toEqual([{ t: 'out', s: 'one' }]);
    const b = parseSse(`${a.rest}ut","s":"two"}\n\ndata: {"t":"done","ok":true}\n\n`);
    expect(b.events).toEqual([
      { t: 'out', s: 'two' },
      { t: 'done', ok: true },
    ]);
    expect(b.rest).toBe('');
    expect(parseSse('data: not json\n\n').events).toEqual([]);
  });
});
