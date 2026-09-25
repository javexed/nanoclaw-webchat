/**
 * Admin → Audit log → Keep: GET/PUT /api/webchat/audit-retention.
 * Owner / global admin only; validated; recorded before it applies; stored so
 * a restart keeps it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseRetention } from './audit-retention.js';
import type { WebchatServer } from './server.js';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

describe('parseRetention', () => {
  it('takes whole days 0 … 3650 and a cap of 10 MB or more', () => {
    expect(parseRetention({ days: 90, maxMb: 200 })).toEqual({ ok: true, value: { days: 90, maxMb: 200 } });
    expect(parseRetention({ days: 0, maxMb: 10 }).ok).toBe(true);
    for (const bad of [
      { days: -1, maxMb: 200 },
      { days: 1.5, maxMb: 200 },
      { days: '90', maxMb: 200 },
      { days: 90, maxMb: 5 },
      { days: 90 },
      null,
    ])
      expect(parseRetention(bad).ok).toBe(false);
  });
});

describe('/api/webchat/audit-retention', () => {
  let server: typeof import('./server.js');
  let conn: typeof import('../../db/connection.js');
  let wc: WebchatServer;
  let port: number;
  let auditFile: string;

  beforeEach(async () => {
    auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ret-')), 'audit.jsonl');
    for (const [k, v] of Object.entries({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
      NANOCLAW_AUDIT_FILE: auditFile,
    }))
      vi.stubEnv(k, v);
    vi.resetModules();
    conn = await import('../../db/connection.js');
    await conn.initTestDb();
    const migrations = await import('../../db/migrations/index.js');
    await migrations.runMigrations(conn.getDb());
    const db = conn.getDb();
    const now = new Date().toISOString();
    for (const id of ['webchat:owner', 'webchat:nobody'])
      await db.run(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`, id, now);
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES ('webchat:owner', 'owner', NULL, NULL, ?)`,
      now,
    );
    server = await import('./server.js');
    wc = await server.startWebchatServer(noopHooks);
    const a = wc.http.address();
    port = typeof a === 'object' && a ? a.port : 0;
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
    (await import('../../audit.js')).setAuditRetention(null);
    await conn.closeDb();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const call = async (method: string, who: string, body?: unknown, csrf = true) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/webchat/audit-retention`, {
      method,
      headers: {
        'x-forwarded-user': who,
        'content-type': 'application/json',
        ...(csrf ? { 'x-webchat-csrf': '1' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };

  it('shows the defaults and usage to the owner; refuses anyone else', async () => {
    const r = await call('GET', 'owner');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ days: 90, maxMb: 200, stored: false, defaults: { days: 90, maxMb: 200 } });
    expect(r.body.usage).toHaveProperty('bytes');
    expect((await call('GET', 'nobody')).status).toBe(403);
    expect((await call('PUT', 'nobody', { days: 30, maxMb: 100 })).status).toBe(403);
  });

  it('stores and applies a change, recorded with from and to', async () => {
    const r = await call('PUT', 'owner', { days: 365, maxMb: 500 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ days: 365, maxMb: 500, stored: true });
    const row = (await conn.getDb().get(`SELECT audit_retention FROM webchat_settings`)) as { audit_retention: string };
    expect(JSON.parse(row.audit_retention)).toEqual({ days: 365, maxMb: 500 });
    const events = fs
      .readFileSync(auditFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === 'audit.retention')).toMatchObject({
      actor: 'human:webchat:owner',
      detail: { from: { days: 90, maxMb: 200 }, to: { days: 365, maxMb: 500 } },
    });
  });

  it('refuses a bad value and a missing CSRF header, changing nothing', async () => {
    expect((await call('PUT', 'owner', { days: 90, maxMb: 1 })).status).toBe(400);
    expect((await call('PUT', 'owner', { days: 30, maxMb: 100 }, false)).status).toBe(403);
    expect((await call('GET', 'owner')).body).toMatchObject({ days: 90, stored: false });
  });
});
