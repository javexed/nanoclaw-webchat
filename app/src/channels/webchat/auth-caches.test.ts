/**
 * Per-request cost of tailnet sign-in: `tailscale whois` and the users-row
 * write are remembered briefly instead of repeated on every request, and the
 * memory is short enough that a revoked peer is re-asked within seconds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';

const calls = vi.hoisted(() => ({ whois: 0, upserts: 0, login: 'alice@example.com' as string | null }));

vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return {
    ...real,
    execFile: (bin: string, args: string[], opts: unknown, cb: (e: Error | null, out: string) => void) => {
      if (bin !== 'tailscale') return (real.execFile as unknown as (...a: unknown[]) => unknown)(bin, args, opts, cb);
      if (args[0] === 'whois') {
        calls.whois += 1;
        const login = calls.login;
        setImmediate(() =>
          login ? cb(null, JSON.stringify({ UserProfile: { LoginName: login } })) : cb(new Error('no peer'), ''),
        );
      } else setImmediate(() => cb(new Error('not in tests'), ''));
      return undefined;
    },
  };
});

vi.mock('../../modules/permissions/db/users.js', async (orig) => {
  const real = await orig<typeof import('../../modules/permissions/db/users.js')>();
  return {
    ...real,
    upsertUser: async (...a: Parameters<typeof real.upsertUser>) => {
      calls.upserts += 1;
      return real.upsertUser(...a);
    },
  };
});

const peer = (ip: string) => ({ socket: { remoteAddress: ip }, headers: {} }) as unknown as IncomingMessage;

async function loadAuth() {
  vi.stubEnv('WEBCHAT_TAILSCALE', 'true');
  vi.stubEnv('WEBCHAT_TOKEN', '');
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  await migrations.runMigrations(conn.getDb());
  return import('./auth.js');
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  calls.whois = 0;
  calls.upserts = 0;
  calls.login = 'alice@example.com';
  const conn = await import('../../db/connection.js');
  await conn.closeDb();
  vi.resetModules();
});

describe('tailnet sign-in caches', () => {
  it('asks whois and writes the user once for a burst of requests', async () => {
    const auth = await loadAuth();
    const results = await Promise.all(Array.from({ length: 5 }, () => auth.authenticateRequest(peer('100.96.0.7'))));
    for (const r of results) expect(r.ok && r.userId).toBe('webchat:tailscale:alice@example.com');
    for (let i = 0; i < 5; i++) await auth.authenticateRequest(peer('100.96.0.7'));
    expect(calls.whois).toBe(1);
    expect(calls.upserts).toBe(1);
  });

  it('asks again once the answer is older than the TTL, so a revoked peer is refused', async () => {
    const auth = await loadAuth();
    vi.useFakeTimers({ toFake: ['Date'] });
    expect((await auth.authenticateRequest(peer('100.96.0.8'))).ok).toBe(true);
    calls.login = null; // removed from the tailnet
    vi.setSystemTime(Date.now() + 31_000);
    expect((await auth.authenticateRequest(peer('100.96.0.8'))).ok).toBe(false);
    expect(calls.whois).toBe(2);
  });

  it('remembers a miss briefly, so a scanner cannot spawn a process per request', async () => {
    const auth = await loadAuth();
    calls.login = null;
    for (let i = 0; i < 4; i++) expect((await auth.authenticateRequest(peer('203.0.113.9'))).ok).toBe(false);
    expect(calls.whois).toBe(1);
  });

  it('writes the user again when the name changes', async () => {
    const auth = await loadAuth();
    await auth.authenticateRequest(peer('100.96.0.9'));
    auth.forgetAuthCaches();
    calls.login = 'Alice@Example.com'; // same id, new display name
    await auth.authenticateRequest(peer('100.96.0.9'));
    expect(calls.upserts).toBe(2);
  });
});
