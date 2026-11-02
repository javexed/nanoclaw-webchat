/**
 * Join over SSH: only private hosts, a password only after the host key was
 * confirmed, sudo's password on stdin, and no secret anywhere it could stay.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetProbesForTest,
  checkTarget,
  fingerprint,
  isPrivateTarget,
  joinHost,
  probeHost,
  redact,
  type JoinEvent,
  type SshClient,
  type SshStream,
} from './ssh-join.js';

const KEY_A = Buffer.from('host-key-a');
const KEY_B = Buffer.from('host-key-b');

interface Run {
  cmd?: string;
  stdin: string[];
  ended: boolean;
}

/** A fake ssh2 Client: presents `key`, accepts `goodPassword` (or any key), and runs `script` on exec. */
function fakeFactory(opts: {
  key: Buffer;
  goodPassword?: string;
  script?: (s: { out: (t: string) => void; err: (t: string) => void; close: (code: number) => void; run: Run }) => void;
}) {
  const runs: Run[] = [];
  const configs: Array<Record<string, unknown>> = [];
  let clientsEnded = 0;
  const factory = (): SshClient => {
    const h: Record<string, Array<(...a: unknown[]) => void>> = {};
    const fire = (ev: string, ...a: unknown[]): void => (h[ev] ?? []).forEach((f) => f(...a));
    const c: SshClient = {
      on(ev: string, fn: (...a: never[]) => void) {
        (h[ev] ??= []).push(fn as (...a: unknown[]) => void);
        return c;
      },
      connect(cfg: Record<string, unknown>) {
        configs.push(cfg);
        queueMicrotask(() => {
          const ok = (cfg.hostVerifier as (k: Buffer) => boolean)(opts.key);
          if (!ok) return fire('error', new Error('Host denied (verification failed)'));
          if (cfg.password !== undefined && cfg.password !== opts.goodPassword)
            return fire('error', new Error('All configured authentication methods failed'));
          fire('ready');
        });
        return c;
      },
      exec(cmd: string, cb: (err: Error | undefined, stream: SshStream) => void) {
        const run: Run = { cmd, stdin: [], ended: false };
        runs.push(run);
        const sh: Record<string, Array<(...a: unknown[]) => void>> = {};
        const stream = {
          on(ev: string, fn: (...a: unknown[]) => void) {
            (sh[ev] ??= []).push(fn);
            return stream;
          },
          stderr: {
            on(ev: string, fn: (...a: unknown[]) => void) {
              (sh[`err-${ev}`] ??= []).push(fn);
            },
          },
          write(s: string) {
            run.stdin.push(s);
          },
          end() {
            run.ended = true;
            queueMicrotask(() =>
              opts.script?.({
                out: (t) => (sh.data ?? []).forEach((f) => f(Buffer.from(t))),
                err: (t) => (sh['err-data'] ?? []).forEach((f) => f(Buffer.from(t))),
                close: (code) => (sh.close ?? []).forEach((f) => f(code)),
                run,
              }),
            );
          },
        } as unknown as SshStream;
        cb(undefined, stream);
        return c;
      },
      end() {
        clientsEnded++;
        return c;
      },
    };
    return c;
  };
  return { factory, runs, configs, ended: () => clientsEnded };
}

const own = new Set(['10.0.0.1', '127.0.0.1']);
const priv = async () => ['10.0.0.10'];
const mint = async () => ({ host: '10.0.0.1', port: 7443, pin: 'PIN', token: 'TOKEN-1' });

async function probe(key = KEY_A, userId = 'webchat:owner') {
  const f = fakeFactory({ key });
  const r = await probeHost({ userId, host: 'app.internal', port: 22 }, { client: f.factory, resolve: priv, own });
  if (!r.ok) throw new Error(r.error);
  return r;
}

beforeEach(() => __resetProbesForTest());

describe('where Join over SSH may connect', () => {
  it('private ranges only: RFC 1918, the tailnet range, unique-local IPv6', () => {
    for (const a of [
      '10.0.0.5',
      '172.16.0.0',
      '172.17.0.1',
      '10.0.0.10',
      '100.64.0.0',
      '100.96.1.2',
      'fd12::1',
    ])
      expect(isPrivateTarget(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '169.254.169.254', '2001:db8::1', '1.1.1.1'])
      expect(isPrivateTarget(a)).toBe(false);
  });

  it('refuses public addresses, this host, and a name with any public address', async () => {
    expect(await checkTarget('8.8.8.8', priv, own)).toEqual({ ok: false, error: 'Private addresses only' });
    expect(await checkTarget('10.0.0.1', priv, own)).toMatchObject({ ok: false });
    expect(await checkTarget('mixed.example', async () => ['10.0.0.10', '8.8.8.8'], own)).toEqual({
      ok: false,
      error: 'Private addresses only',
    });
    expect(await checkTarget('app.internal', priv, own)).toEqual({ ok: true, address: '10.0.0.10' });
    expect(await checkTarget('bad host;rm', priv, own)).toEqual({ ok: false, error: 'Bad host' });
  });
});

describe('step 1: probe', () => {
  it('reads the host key without signing in, and pins the checked address', async () => {
    const f = fakeFactory({ key: KEY_A });
    const r = await probeHost(
      { userId: 'u', host: 'app.internal', port: 22 },
      { client: f.factory, resolve: priv, own },
    );
    expect(r).toMatchObject({ ok: true, fingerprint: fingerprint(KEY_A), address: '10.0.0.10' });
    expect(f.configs[0]).toMatchObject({ host: '10.0.0.10', port: 22 });
    expect(f.configs[0].password).toBeUndefined();
    expect(f.configs[0].privateKey).toBeUndefined();
  });
});

describe('step 2: join', () => {
  it('runs the installer with sudo reading the password from stdin, never argv', async () => {
    const p = await probe();
    const f = fakeFactory({ key: KEY_A, goodPassword: 's3cret-pw', script: (s) => (s.out('installed\n'), s.close(0)) });
    const events: JoinEvent[] = [];
    const r = await joinHost(
      {
        userId: 'webchat:owner',
        probeId: p.probeId,
        confirmed: p.fingerprint,
        username: 'azureuser',
        secrets: { password: 's3cret-pw' },
      },
      mint,
      (e) => events.push(e),
      { client: f.factory },
    );
    expect(r.ok).toBe(true);
    expect(f.runs[0].cmd).toContain("sudo -S -p ''");
    expect(f.runs[0].cmd).toContain('exec </dev/null');
    expect(f.runs[0].cmd).toContain('TOKEN-1');
    expect(f.runs[0].cmd).not.toContain('s3cret-pw');
    expect(f.runs[0].stdin).toEqual(['s3cret-pw\n']);
    expect(f.runs[0].ended).toBe(true);
    expect(events.at(-1)).toEqual({ t: 'done', ok: true });
    expect(JSON.stringify(events)).not.toContain('s3cret-pw');
  });

  it('refuses a fingerprint that was not confirmed, and a probe used twice or by someone else', async () => {
    const p = await probe();
    const f = fakeFactory({ key: KEY_A, goodPassword: 'pw-pw' });
    const ev: JoinEvent[] = [];
    expect(
      await joinHost(
        {
          userId: 'webchat:owner',
          probeId: p.probeId,
          confirmed: 'SHA256:other',
          username: 'u',
          secrets: { password: 'pw-pw' },
        },
        mint,
        (e) => ev.push(e),
        { client: f.factory },
      ),
    ).toMatchObject({ ok: false, error: 'Fingerprint not confirmed' });
    expect(
      await joinHost(
        {
          userId: 'webchat:owner',
          probeId: p.probeId,
          confirmed: p.fingerprint,
          username: 'u',
          secrets: { password: 'pw-pw' },
        },
        mint,
        (e) => ev.push(e),
        { client: f.factory },
      ),
    ).toMatchObject({ ok: false, error: 'Connect again' });
    const q = await probe(KEY_A, 'webchat:owner');
    expect(
      await joinHost(
        {
          userId: 'webchat:someone-else',
          probeId: q.probeId,
          confirmed: q.fingerprint,
          username: 'u',
          secrets: { password: 'pw-pw' },
        },
        mint,
        (e) => ev.push(e),
        { client: f.factory },
      ),
    ).toMatchObject({ ok: false, error: 'Connect again' });
    expect(f.configs).toHaveLength(0);
  });

  it('refuses when the host key changed between the steps, before any password is checked', async () => {
    const p = await probe(KEY_A);
    const f = fakeFactory({ key: KEY_B, goodPassword: 'pw-pw' });
    let minted = 0;
    const r = await joinHost(
      {
        userId: 'webchat:owner',
        probeId: p.probeId,
        confirmed: p.fingerprint,
        username: 'u',
        secrets: { password: 'pw-pw' },
      },
      async () => (minted++, mint()),
      () => {},
      { client: f.factory },
    );
    expect(r).toMatchObject({ ok: false, error: 'Host key changed' });
    expect(minted).toBe(0);
    expect(f.runs).toHaveLength(0);
  });

  it('with a key and no password uses sudo -n, and says so when sudo wants a password', async () => {
    const p = await probe();
    const f = fakeFactory({ key: KEY_A, script: (s) => (s.err('sudo: a password is required\n'), s.close(1)) });
    const r = await joinHost(
      {
        userId: 'webchat:owner',
        probeId: p.probeId,
        confirmed: p.fingerprint,
        username: 'u',
        secrets: { privateKey: 'KEY-MATERIAL', passphrase: 'phrase-1' },
      },
      mint,
      () => {},
      { client: f.factory },
    );
    expect(f.runs[0].cmd).toContain('sudo -n sh -c');
    expect(f.runs[0].stdin).toEqual([]);
    expect(f.configs[0]).toMatchObject({ privateKey: 'KEY-MATERIAL', passphrase: 'phrase-1' });
    expect(r).toMatchObject({ ok: false, error: 'sudo needs a password' });
  });

  it('masks secrets that show up in the output', async () => {
    expect(redact('pw is hunter22 ok', ['hunter22', undefined])).toBe('pw is *** ok');
    const p = await probe();
    const f = fakeFactory({
      key: KEY_A,
      goodPassword: 'hunter22',
      script: (s) => (s.out('echo hunter22\n'), s.close(0)),
    });
    const ev: JoinEvent[] = [];
    await joinHost(
      {
        userId: 'webchat:owner',
        probeId: p.probeId,
        confirmed: p.fingerprint,
        username: 'u',
        secrets: { password: 'hunter22' },
      },
      mint,
      (e) => ev.push(e),
      { client: f.factory },
    );
    expect(ev[0]).toEqual({ t: 'out', s: 'echo ***\n' });
  });

  it('reports a refused sign-in without the password', async () => {
    const p = await probe();
    const f = fakeFactory({ key: KEY_A, goodPassword: 'right-pw' });
    const ev: JoinEvent[] = [];
    const r = await joinHost(
      {
        userId: 'webchat:owner',
        probeId: p.probeId,
        confirmed: p.fingerprint,
        username: 'u',
        secrets: { password: 'wrong-pw' },
      },
      mint,
      (e) => ev.push(e),
      { client: f.factory },
    );
    expect(r).toMatchObject({ ok: false, error: 'Sign-in refused' });
    expect(JSON.stringify(ev)).not.toContain('wrong-pw');
  });

  it('cancel closes the session; a stuck installer times out', async () => {
    const p = await probe();
    const f = fakeFactory({ key: KEY_A, goodPassword: 'pw-pw', script: () => {} });
    const ac = new AbortController();
    const pending = joinHost(
      {
        userId: 'webchat:owner',
        probeId: p.probeId,
        confirmed: p.fingerprint,
        username: 'u',
        secrets: { password: 'pw-pw' },
      },
      mint,
      () => {},
      { client: f.factory, signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'Cancelled' });
    expect(f.ended()).toBeGreaterThan(0);

    const q = await probe();
    const g = fakeFactory({ key: KEY_A, goodPassword: 'pw-pw', script: () => {} });
    expect(
      await joinHost(
        {
          userId: 'webchat:owner',
          probeId: q.probeId,
          confirmed: q.fingerprint,
          username: 'u',
          secrets: { password: 'pw-pw' },
        },
        mint,
        () => {},
        { client: g.factory, installTimeoutMs: 20 },
      ),
    ).toMatchObject({ ok: false, error: 'Timed out' });
  });
});
