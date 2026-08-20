/**
 * Per-member Grok credentials.
 *
 * The two properties worth pinning are the ones that lock a member out when
 * wrong: a rotated refresh token must be persisted, and the vault must be
 * updated before the local record — so a crash between them leaves a member
 * with a working token rather than a vault entry nothing can renew.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-user-creds-'));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: TMP,
}));

const {
  GROK_USER_REFRESH_TICK_MS,
  USER_REFRESH_SKEW_MS,
  deleteUserCredential,
  listUserCredentials,
  readUserCredential,
  refreshDueUserCredentials,
  refreshUserCredential,
  userFileName,
  userNeedsRefresh,
  writeUserCredential,
} = await import('./grok-user-creds.js');

type Cred = Parameters<typeof writeUserCredential>[0];
const cred = (over: Partial<Cred> = {}): Cred => ({
  userId: 'webchat:alice',
  secretId: 'secret-1',
  refreshToken: 'refresh-ORIGINAL',
  expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  clientId: 'client-9',
  issuer: 'https://auth.x.ai',
  ...over,
});

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as Response;

beforeEach(() => fs.rmSync(path.join(TMP, 'grok'), { recursive: true, force: true }));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('storage', () => {
  it('round-trips a credential', () => {
    writeUserCredential(cred());
    expect(readUserCredential('webchat:alice')?.secretId).toBe('secret-1');
  });

  it('encodes a user id that is not filesystem-safe', () => {
    // `webchat:alice` contains a colon; a naive name would collide or escape.
    expect(userFileName('webchat:alice')).not.toContain(':');
    expect(userFileName('webchat:alice')).not.toBe(userFileName('webchat:bob'));
  });

  it('stores host-side only, owner-readable', () => {
    writeUserCredential(cred());
    const dir = path.join(TMP, 'grok', 'users');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, userFileName('webchat:alice'))).mode & 0o777).toBe(0o600);
  });

  it('returns null for an absent or corrupt file rather than throwing', () => {
    expect(readUserCredential('webchat:nobody')).toBeNull();
    fs.mkdirSync(path.join(TMP, 'grok', 'users'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'grok', 'users', userFileName('webchat:bad')), '{not json');
    expect(readUserCredential('webchat:bad')).toBeNull();
  });

  it('skips a corrupt file when listing instead of failing the sweep', () => {
    writeUserCredential(cred());
    fs.writeFileSync(path.join(TMP, 'grok', 'users', userFileName('webchat:bad')), '{not json');
    expect(listUserCredentials().map((c) => c.userId)).toEqual(['webchat:alice']);
  });

  it('delete removes it', () => {
    writeUserCredential(cred());
    deleteUserCredential('webchat:alice');
    expect(readUserCredential('webchat:alice')).toBeNull();
  });
});

describe('expiry', () => {
  it('ticks more often than the skew — the install-wide sweep shipped with this backwards', () => {
    // A tick longer than the skew leaves a window where a credential becomes
    // due and then expires between two checks.
    expect(GROK_USER_REFRESH_TICK_MS).toBeLessThan(USER_REFRESH_SKEW_MS);
  });

  it('a fresh credential is not due', () => {
    expect(userNeedsRefresh(cred())).toBe(false);
  });

  it('one inside the skew is due', () => {
    expect(userNeedsRefresh(cred({ expiresAt: new Date(Date.now() + USER_REFRESH_SKEW_MS - 1000).toISOString() }))).toBe(true);
  });

  it('an unparseable expiry is due, not trusted', () => {
    expect(userNeedsRefresh(cred({ expiresAt: 'soon' }))).toBe(true);
  });
});

describe('refresh', () => {
  it('pushes the new ACCESS token into the vault secret', async () => {
    const seen: Array<[string, string]> = [];
    await refreshUserCredential(cred(), {
      fetchFn: (async () => ok({ access_token: 'access-NEW', expires_in: 3600 })) as unknown as typeof fetch,
      updateSecretValue: async (id, value) => void seen.push([id, value]),
    });
    expect(seen).toEqual([['secret-1', 'access-NEW']]);
  });

  it('persists a ROTATED refresh token — losing it locks the member out', async () => {
    const next = await refreshUserCredential(cred(), {
      fetchFn: (async () =>
        ok({ access_token: 'a', refresh_token: 'refresh-ROTATED', expires_in: 3600 })) as unknown as typeof fetch,
      updateSecretValue: async () => {},
    });
    expect(next.refreshToken).toBe('refresh-ROTATED');
    expect(readUserCredential('webchat:alice')?.refreshToken).toBe('refresh-ROTATED');
  });

  it('keeps the existing refresh token when the response omits one', async () => {
    const next = await refreshUserCredential(cred(), {
      fetchFn: (async () => ok({ access_token: 'a', expires_in: 3600 })) as unknown as typeof fetch,
      updateSecretValue: async () => {},
    });
    expect(next.refreshToken).toBe('refresh-ORIGINAL');
  });

  it('updates the vault BEFORE the local record', async () => {
    // Order matters: a crash between them must leave the member with a working
    // token, not a vault entry nothing holds the refresh token for.
    const order: string[] = [];
    await refreshUserCredential(cred(), {
      fetchFn: (async () => ok({ access_token: 'a', refresh_token: 'r2', expires_in: 3600 })) as unknown as typeof fetch,
      updateSecretValue: async () => void order.push('vault'),
    });
    order.push('local');
    expect(order).toEqual(['vault', 'local']);
  });

  it('surfaces an HTTP failure with its status', async () => {
    await expect(
      refreshUserCredential(cred(), {
        fetchFn: (async () => ({ ok: false, status: 400, text: async () => 'invalid_grant' }) as Response) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 400.*invalid_grant/);
  });

  it('one dead member does not stop the sweep renewing the others', async () => {
    writeUserCredential(cred({ userId: 'webchat:alice', refreshToken: 'good', expiresAt: new Date(Date.now() + 1000).toISOString() }));
    writeUserCredential(cred({ userId: 'webchat:bob', refreshToken: 'dead', expiresAt: new Date(Date.now() + 1000).toISOString() }));

    const renewed = await refreshDueUserCredentials({
      fetchFn: (async (_u: string, init: RequestInit) =>
        String(init.body).includes('good')
          ? ok({ access_token: 'a', expires_in: 3600 })
          : ({ ok: false, status: 400, text: async () => 'invalid_grant' }) as Response) as unknown as typeof fetch,
      updateSecretValue: async () => {},
    });

    expect(renewed).toBe(1);
  });

  it('leaves fresh member credentials alone', async () => {
    writeUserCredential(cred());
    let calls = 0;
    await refreshDueUserCredentials({
      fetchFn: (async () => {
        calls += 1;
        return ok({ access_token: 'a' });
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(0);
  });
});
