/**
 * Signed releases through central's real routes: who may attach a signature
 * (an owner or global admin, with the CSRF header), what is refused, and that
 * the package listing and the download serve it.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { WebchatServer } from './server.js';

let tmp = '';
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get DATA_DIR() {
    return tmp;
  },
}));

const SERVER = 'https://chat.example.com';

function operator(seedByte: number, releaseMessage: (f: never) => Buffer | null) {
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seedByte)]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const key = `ed25519:${Buffer.from(spki.subarray(12)).toString('base64')}`;
  return {
    key,
    sign: (f: { kind: 'vsix'; subject: string; sha256: string }) => {
      const facts = { ...f, server: SERVER };
      return {
        format: 'nanoclaw-runner-release-signature/1',
        ...facts,
        key,
        signature: sign(null, releaseMessage(facts as never)!, priv).toString('base64'),
      };
    },
  };
}

describe('release signature routes', () => {
  let server: typeof import('./server.js');
  let conn: typeof import('../../db/connection.js');
  let ext: typeof import('./runner-extension.js');
  let wc: WebchatServer;
  let base = '';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sig-routes-'));
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
    const now = new Date().toISOString();
    for (const id of ['webchat:owner@example.org', 'webchat:dev@example.org'])
      await db.run(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`, id, now);
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
      'webchat:owner@example.org',
      now,
    );
    ext = await import('./runner-extension.js');
    await import('./runner-register.js');
    server = await import('./server.js');
    wc = await server.startWebchatServer({ onInbound: vi.fn(), onAction: vi.fn() });
    const a = wc.http.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  afterAll(async () => {
    await server.stopWebchatServer(wc);
    await conn.closeDb();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const call = (
    route: string,
    who: string,
    init: { method?: string; body?: unknown; csrf?: boolean; headers?: Record<string, string> } = {},
  ) =>
    fetch(`${base}${route}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-forwarded-user': who,
        ...(init.csrf === false ? {} : { 'X-Webchat-CSRF': '1' }),
        ...(init.body !== undefined && !Buffer.isBuffer(init.body) ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: Buffer.isBuffer(init.body) ? init.body : JSON.stringify(init.body) }),
    });

  it('serves no agent image and takes no signature for one: the laptop container is retired', async () => {
    for (const route of ['/api/runners/image/manifest', '/api/runners/image/download'])
      expect((await call(route, 'owner@example.org')).status, route).toBe(404);
    const put = await call('/api/runners/image/signature', 'owner@example.org', { method: 'PUT', body: {} });
    expect(put.status).toBe(404);
  });

  it('publishes a package with its signature; the listing and the download carry it', async () => {
    const op = operator(2, ext.releaseMessage as never);
    const bytes = Buffer.from('PK signed package');
    const sig = op.sign({ kind: 'vsix', subject: '0.20.0', sha256: createHash('sha256').update(bytes).digest('hex') });
    const header = Buffer.from(JSON.stringify(sig)).toString('base64');
    const post = (who: string, headers: Record<string, string>) =>
      call('/api/runners/extension', who, {
        method: 'POST',
        body: bytes,
        headers: {
          'X-NanoClaw-Filename': 'nanoclaw-0.20.0.vsix',
          'Content-Type': 'application/octet-stream',
          ...headers,
        },
      });
    expect((await post('dev@example.org', { 'X-NanoClaw-Signature': header })).status).toBe(403);
    // A signature for another version is refused, and nothing is published.
    const other = Buffer.from(JSON.stringify({ ...sig, subject: '0.19.0' })).toString('base64');
    expect((await post('owner@example.org', { 'X-NanoClaw-Signature': other })).status).toBe(409);
    expect((await call('/api/runners/extension', 'dev@example.org')).status).toBe(404);

    const res = await post('owner@example.org', { 'X-NanoClaw-Signature': header });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: '0.20.0', signed: true });
    const listing = (await (await call('/api/runners/extension', 'dev@example.org')).json()) as Record<string, unknown>;
    expect(listing.signature).toMatchObject({ signature: sig.signature });
    const dl = await call('/api/runners/extension/download', 'dev@example.org');
    expect(JSON.parse(Buffer.from(dl.headers.get('x-nanoclaw-signature') ?? '', 'base64').toString())).toEqual(
      listing.signature,
    );
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("offers the install's release key and refuses signatures by any other key once it is set", async () => {
    const op = operator(3, ext.releaseMessage as never);
    const stranger = operator(4, ext.releaseMessage as never);
    const cfg = '/api/runners/client-config';
    expect((await call(cfg, 'dev@example.org', { method: 'PUT', body: { releaseKey: op.key } })).status).toBe(403);
    expect((await call(cfg, 'owner@example.org', { method: 'PUT', body: { releaseKey: op.key } })).status).toBe(200);
    expect(await (await call(cfg, 'dev@example.org')).json()).toMatchObject({ releaseKey: op.key });
    // The sign-in page's save leaves it alone.
    await call(cfg, 'owner@example.org', { method: 'PUT', body: { appIdUri: '', clientId: '' } });
    expect(await (await call(cfg, 'dev@example.org')).json()).toMatchObject({ releaseKey: op.key });

    const m = ext.readExtensionManifest()!;
    const route = '/api/runners/extension/signature';
    const bad = stranger.sign({ kind: 'vsix', subject: m.version, sha256: m.sha256 });
    const res = await call(route, 'owner@example.org', { method: 'PUT', body: bad });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('release key') });
    const good = op.sign({ kind: 'vsix', subject: m.version, sha256: m.sha256 });
    expect((await call(route, 'dev@example.org', { method: 'PUT', body: good })).status).toBe(403);
    expect((await call(route, 'owner@example.org', { method: 'PUT', body: good })).status).toBe(200);
    expect(ext.readExtensionManifest()?.signature?.key).toBe(op.key);
  });
});
