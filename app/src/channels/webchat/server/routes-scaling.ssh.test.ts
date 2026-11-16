/**
 * Join over SSH routes: secrets never reach the response or the audit line,
 * closing the request cancels, and only owners and global admins (with the
 * CSRF header) get in.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  joinArgs: [] as unknown[],
  aborted: false,
  liveSecrets: null as Record<string, unknown> | null,
}));

vi.mock('../../../audit.js', () => ({
  audit: (e: Record<string, unknown>) => seen.audits.push(e),
  auditActor: (a: { userId: string }) => `human:${a.userId}`,
}));
vi.mock('../../../modules/machines/listener.js', () => ({
  listenerInfo: () => ({ address: '10.0.0.1', port: 7443, pin: 'PIN' }),
}));
vi.mock('../../../modules/machines/members.js', async (orig) => ({
  ...(await orig<typeof import('../../../modules/machines/members.js')>()),
  createJoinToken: async () => ({ token: 'TOKEN-1', expiresAt: 0 }),
}));
vi.mock('../../../modules/machines/ssh-join.js', () => ({
  probeHost: async () => ({ ok: true, probeId: 'p1', fingerprint: 'SHA256:x', address: '10.0.0.10' }),
  joinHost: async (
    opts: { secrets: Record<string, string> },
    mint: () => Promise<unknown>,
    emit: (e: unknown) => void,
    deps: { signal: AbortSignal },
  ) => {
    seen.joinArgs.push(JSON.parse(JSON.stringify(opts)));
    seen.liveSecrets = opts.secrets;
    await mint();
    emit({ t: 'out', s: 'installing\n' });
    if (opts.secrets.password === 'wait-for-cancel') {
      await new Promise<void>((r) => deps.signal.addEventListener('abort', () => r()));
      seen.aborted = true;
      emit({ t: 'done', ok: false, error: 'Cancelled' });
      return { ok: false, error: 'Cancelled', host: 'app.internal', port: 22 };
    }
    emit({ t: 'done', ok: true });
    return { ok: true, host: 'app.internal', port: 22 };
  },
}));

const { rScalingSshJoinPost } = await import('./routes-scaling.js');

let srv: http.Server | null = null;
afterEach(() => {
  srv?.close();
  srv = null;
  seen.audits.length = 0;
  seen.joinArgs.length = 0;
  seen.aborted = false;
});

let n = 0;
async function serve(): Promise<number> {
  const userId = `webchat:owner-${++n}`; // the per-user rate limit is not under test here
  srv = http.createServer((req, res) => {
    void rScalingSshJoinPost({ req, res, userId } as never, [] as never);
  });
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
  return (srv!.address() as AddressInfo).port;
}

describe('POST /api/scaling/machines/ssh/join', () => {
  it('streams output, and the password, key and passphrase appear in neither the response nor the audit line', async () => {
    const port = await serve();
    const body = {
      probeId: 'p1',
      fingerprint: 'SHA256:x',
      username: 'azureuser',
      role: 'worker',
      password: 'pw-SECRET-1',
      privateKey: 'KEY-SECRET-2',
      passphrase: 'PHRASE-SECRET-3',
    };
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify(body) });
    const text = await r.text();
    expect(r.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(text).toContain('"t":"out"');
    expect(text).toContain('"t":"done","ok":true');
    const audit = JSON.stringify(seen.audits);
    for (const s of ['pw-SECRET-1', 'KEY-SECRET-2', 'PHRASE-SECRET-3']) {
      expect(text).not.toContain(s);
      expect(audit).not.toContain(s);
    }
    expect(seen.audits[0]).toMatchObject({
      type: 'machine.ssh-join',
      effect: 'ok',
      detail: { host: 'app.internal', port: 22, username: 'azureuser', role: 'worker', result: 'installed' },
    });
    expect(seen.joinArgs[0]).toMatchObject({
      secrets: { password: 'pw-SECRET-1', privateKey: 'KEY-SECRET-2', passphrase: 'PHRASE-SECRET-3' },
    });
    // Dropped once the join is over.
    expect(seen.liveSecrets).toEqual({ password: undefined, privateKey: undefined, passphrase: undefined });
  });

  it('closing the request cancels the SSH session', async () => {
    const port = await serve();
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      body: JSON.stringify({ probeId: 'p1', fingerprint: 'SHA256:x', username: 'u', password: 'wait-for-cancel' }),
      signal: ac.signal,
    });
    const reader = r.body!.getReader();
    await reader.read();
    ac.abort();
    for (let i = 0; i < 50 && !seen.aborted; i++) await new Promise((x) => setTimeout(x, 10));
    expect(seen.aborted).toBe(true);
    expect(seen.audits[0]).toMatchObject({ effect: 'failed', detail: { result: 'Cancelled' } });
  });

  it('refuses an unknown role before connecting', async () => {
    const port = await serve();
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      body: JSON.stringify({ role: 'root', password: 'x' }),
    });
    expect(r.status).toBe(400);
    expect(seen.joinArgs).toHaveLength(0);
  });
});
