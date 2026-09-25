/** GET /api/runners/mine: a signed-in user's own machines, and nobody else's. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WebchatServer } from './server.js';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

describe('GET /api/runners/mine', () => {
  let server: typeof import('./server.js');
  let conn: typeof import('../../db/connection.js');
  let wc: WebchatServer | undefined;

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
    await conn?.closeDb();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('lists only the caller’s machines, newest first, and not revoked ones', async () => {
    for (const [k, v] of Object.entries({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TAILSCALE: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
    }))
      vi.stubEnv(k, v);
    vi.resetModules();
    conn = await import('../../db/connection.js');
    await conn.initTestDb();
    await (await import('../../db/migrations/index.js')).runMigrations(conn.getDb());
    const db = conn.getDb();
    const row = async (fp: string, user: string, host: string, status: string, seen: number) =>
      db.run(
        `INSERT INTO webchat_runner_machines (fingerprint, user_id, hostname, os, arch, runner_version, status, first_seen, last_seen)
         VALUES (?, ?, ?, 'linux', 'x64', '0.13.1', ?, ?, ?)`,
        fp,
        user,
        host,
        status,
        seen,
        seen,
      );
    await row('fp1', 'webchat:sam@example.org', 'old-laptop', 'approved', 1);
    await row('fp2', 'webchat:sam@example.org', 'laptop', 'pending', 2);
    await row('fp3', 'webchat:sam@example.org', 'gone', 'revoked', 3);
    await row('fp4', 'webchat:kim@example.org', 'kims-box', 'pending', 4);
    server = await import('./server.js');
    wc = await server.startWebchatServer(noopHooks);
    const a = wc.http.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/runners/mine`, {
      headers: { 'x-forwarded-user': 'sam@example.org' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      machines: [
        { hostname: 'laptop', status: 'pending', connected: false },
        { hostname: 'old-laptop', status: 'approved', connected: false },
      ],
    });
  });
});
