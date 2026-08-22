/**
 * Authorization + validation for PUT /api/agents/:id/config-model, and the
 * GET /api/models/known suggestions that feed its datalist.
 *
 * `container_configs.model` is the id the agent-runner hands the Claude Agent
 * SDK as its `model` option — the authoritative model for the built-in harness.
 * Before this route webchat had no path to it at all: the only model control in
 * the PWA was the webchat-model roster (for BYO Ollama / OpenAI-compatible
 * endpoints), so an operator could not move an agent between Anthropic models
 * without `ncl`, and an agent already pinned by `ncl` still rendered as
 * "Default / Built-in Anthropic".
 *
 * The interesting cases are the refusals:
 *
 *   - An implausible id is rejected on shape. The value is handed to the SDK, so
 *     a pasted URL or shell fragment must not reach container_configs.model.
 *     WHICH model is deliberately NOT gated (see KNOWN_ANTHROPIC_MODELS) — an
 *     install outlives any baked-in list, and refusing a model Anthropic has
 *     already shipped is the worse failure.
 *   - Pinning is refused while an `anthropic`-kind webchat model is assigned.
 *     That assignment writes ANTHROPIC_MODEL into the group's settings.json env,
 *     and the SDK's explicit `model` option overrides the env var — so allowing
 *     both would silently ignore the assignment.
 *
 * Same boot/teardown pattern as agent-egress.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WebchatServer } from './server.js';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

beforeEach(async () => {
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    await conn.closeDb();
  } catch {
    // ignore
  }
  vi.resetModules();
});

async function loadServerWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v ?? '');
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  await migrations.runMigrations(conn.getDb());
  return { server: await import('./server.js'), conn };
}

async function httpRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const portOf = (wc: { http: { address: () => unknown } }): number => {
  const a = wc.http.address();
  return typeof a === 'object' && a ? (a as { port: number }).port : 0;
};

const now = '2026-07-31T00:00:00.000Z';
function seed(db: import('../../db/driver.js').DbDriver): void {
  const user = async (id: string) =>
    await db.run(
      `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
      id,
      now,
    );
  const group = async (id: string) =>
    await db.run(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
      id,
      id,
      id,
      now,
    );
  const role = async (uid: string, r: 'owner' | 'admin', g: string | null) => {
    await user(uid);
    if (g) await group(g);
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)`,
      uid,
      r,
      g,
      now,
    );
  };
  group('ag-mdl-a');
  group('ag-mdl-b');
  role('webchat:owner', 'owner', null);
  role('webchat:admina', 'admin', 'ag-mdl-a');
  user('webchat:nobody');
}

describe('PUT /api/agents/:id/config-model', () => {
  let server: Awaited<ReturnType<typeof loadServerWithEnv>>['server'];
  let wc: WebchatServer;
  let port: number;
  let conn: Awaited<ReturnType<typeof loadServerWithEnv>>['conn'];

  beforeEach(async () => {
    const loaded = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
    });
    server = loaded.server;
    conn = loaded.conn;
    seed(conn.getDb());
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (n: string) => ({ 'x-forwarded-user': n, 'content-type': 'application/json', 'x-webchat-csrf': '1' });
  const put = (agent: string, who: string, model: unknown) =>
    httpRequest(port, 'PUT', `/api/agents/${agent}/config-model`, as(who), JSON.stringify({ model }));
  const stored = async (id: string) =>
    (
      (await conn.getDb().get(`SELECT model FROM container_configs WHERE agent_group_id = ?`, id)) as
        | { model: string | null }
        | undefined
    )?.model ?? null;

  it('a scoped admin may pin a model on an agent they administer', async () => {
    const r = await put('ag-mdl-a', 'admina', 'claude-opus-5');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-a')).toBe('claude-opus-5');
  });

  it('accepts a model id newer than the curated suggestion list', async () => {
    // The whole point of the free-text field: the list is suggestions, not a gate.
    const r = await put('ag-mdl-a', 'admina', 'claude-something-not-shipped-yet-9');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-a')).toBe('claude-something-not-shipped-yet-9');
  });

  it('accepts the bracketed long-context variant form', async () => {
    const r = await put('ag-mdl-a', 'admina', 'claude-opus-4-7[1m]');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-a')).toBe('claude-opus-4-7[1m]');
  });

  it('blank clears the pin back to the SDK default', async () => {
    await put('ag-mdl-a', 'admina', 'claude-opus-5');
    const r = await put('ag-mdl-a', 'admina', '');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-a')).toBeNull();
  });

  it('rejects a value that is not model-id shaped, leaving the pin untouched', async () => {
    await put('ag-mdl-a', 'admina', 'claude-opus-5');
    for (const bad of ['https://evil.example/v1', 'opus; rm -rf /', 'a b', '../../etc/passwd']) {
      const r = await put('ag-mdl-a', 'admina', bad);
      expect(r.status, `${bad} must be refused`).toBe(400);
    }
    expect(await stored('ag-mdl-a')).toBe('claude-opus-5');
  });

  it('refuses while an anthropic-kind webchat model is assigned, rather than silently losing to it', async () => {
    // ANTHROPIC_MODEL (from the assignment) is env; container_configs.model is the
    // SDK's explicit `model` option, which wins. Two levers, one silent loser.
    const db = conn.getDb();
    await db.run(`INSERT INTO webchat_models (id, name, kind, endpoint, model_id, credential_ref, created_at)
       VALUES ('m-anth', 'Anthropic pin', 'anthropic', NULL, 'claude-sonnet-5', NULL, 0)`);
    await db.run(
      `INSERT INTO webchat_agent_models (agent_group_id, model_id, assigned_at) VALUES ('ag-mdl-a','m-anth',0)`,
    );

    const r = await put('ag-mdl-a', 'admina', 'claude-opus-5');
    expect(r.status).toBe(409);
    expect(r.body).toContain('Anthropic pin');
    expect(await stored('ag-mdl-a')).toBeNull();
  });

  // ── the inherited case (#112 follow-up) ────────────────────────────────────
  // The refusal above read the ASSIGNED model only. An UNASSIGNED agent runs on
  // the workspace default, which sets the same env var and wins the same way —
  // so a pin was accepted and then quietly ignored. Harder to notice than the
  // assigned case, because nothing on the agent names the model it inherited.

  const setWorkspaceDefault = async (kind: 'anthropic' | 'ollama') => {
    const db = conn.getDb();
    await db.run(
      `INSERT INTO webchat_models (id, name, kind, endpoint, model_id, credential_ref, created_at)
       VALUES ('m-def', 'Workspace default', ?, ?, 'claude-sonnet-5', NULL, 0)`,
      kind,
      kind === 'anthropic' ? null : 'http://127.0.0.1:11434',
    );
    await db.run(`UPDATE webchat_settings SET default_model_id = 'm-def'`);
  };

  it('refuses when an anthropic-kind WORKSPACE DEFAULT is inherited, not just an assignment', async () => {
    await setWorkspaceDefault('anthropic'); // agent has no assignment of its own
    const r = await put('ag-mdl-a', 'admina', 'claude-opus-5');
    expect(r.status).toBe(409);
    // Different wording from the assigned case on purpose: the fix differs —
    // you change the default (or assign this agent its own model), you do not
    // "unassign" something the agent never had.
    expect(r.body).toContain('workspace default');
    expect(r.body).toContain('Workspace default');
    expect(await stored('ag-mdl-a')).toBeNull();
  });

  it('still allows clearing the pin while inheriting such a default', async () => {
    await setWorkspaceDefault('anthropic');
    const r = await put('ag-mdl-a', 'admina', '');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-a')).toBeNull();
  });

  it('does NOT refuse when the inherited default is a non-anthropic kind', async () => {
    // Only anthropic-kind models write ANTHROPIC_MODEL, so only they conflict.
    // Refusing on an ollama default would block a legitimate pin.
    await setWorkspaceDefault('ollama');
    const r = await put('ag-mdl-a', 'admina', 'claude-opus-5');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-a')).toBe('claude-opus-5');
  });

  it('an ASSIGNED non-anthropic model still shadows an anthropic default', async () => {
    // Assignment wins over the default, so the effective model is the ollama
    // one and there is no conflict to refuse — the check must not look past
    // the assignment to the default underneath it.
    await setWorkspaceDefault('anthropic');
    const db = conn.getDb();
    await db.run(`INSERT INTO webchat_models (id, name, kind, endpoint, model_id, credential_ref, created_at)
       VALUES ('m-oll', 'Local', 'ollama', 'http://127.0.0.1:11434', 'qwen3:8b', NULL, 0)`);
    await db.run(
      `INSERT INTO webchat_agent_models (agent_group_id, model_id, assigned_at) VALUES ('ag-mdl-a','m-oll',0)`,
    );

    const r = await put('ag-mdl-a', 'admina', 'claude-opus-5');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-a')).toBe('claude-opus-5');
  });

  it('still allows CLEARING the pin while such a model is assigned', async () => {
    // The refusal exists to stop a NEW silent conflict; unpinning removes one.
    const db = conn.getDb();
    await db.run(`INSERT INTO webchat_models (id, name, kind, endpoint, model_id, credential_ref, created_at)
       VALUES ('m-anth', 'Anthropic pin', 'anthropic', NULL, 'claude-sonnet-5', NULL, 0)`);
    await db.run(
      `INSERT INTO webchat_agent_models (agent_group_id, model_id, assigned_at) VALUES ('ag-mdl-a','m-anth',0)`,
    );

    const r = await put('ag-mdl-a', 'admina', '');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-a')).toBeNull();
  });

  it('a scoped admin is refused on an agent they do NOT administer', async () => {
    const r = await put('ag-mdl-b', 'admina', 'claude-opus-5');
    expect(r.status).toBe(403);
    expect(await stored('ag-mdl-b')).toBeNull();
  });

  it('a user with no role anywhere is refused', async () => {
    const r = await put('ag-mdl-a', 'nobody', 'claude-opus-5');
    expect(r.status).toBe(403);
    expect(await stored('ag-mdl-a')).toBeNull();
  });

  it('requires the CSRF header', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      '/api/agents/ag-mdl-a/config-model',
      { 'x-forwarded-user': 'admina', 'content-type': 'application/json' },
      JSON.stringify({ model: 'claude-opus-5' }),
    );
    expect(r.status).toBe(403);
    expect(await stored('ag-mdl-a')).toBeNull();
  });

  it('owner reaches any agent', async () => {
    const r = await put('ag-mdl-b', 'owner', 'claude-opus-5');
    expect(r.status).toBe(200);
    expect(await stored('ag-mdl-b')).toBe('claude-opus-5');
  });
});

describe('GET /api/models/known', () => {
  let server: Awaited<ReturnType<typeof loadServerWithEnv>>['server'];
  let wc: WebchatServer;
  let port: number;
  let conn: Awaited<ReturnType<typeof loadServerWithEnv>>['conn'];

  beforeEach(async () => {
    const loaded = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
    });
    server = loaded.server;
    conn = loaded.conn;
    seed(conn.getDb());
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  it('serves the suggestions to a scoped admin, not just the owner', async () => {
    // The /api/models/discover POST is owner-only, so a scoped admin editing
    // their own agent could not have read the list through it.
    const r = await httpRequest(port, 'GET', '/api/models/known', { 'x-forwarded-user': 'admina' });
    expect(r.status).toBe(200);
    const models = JSON.parse(r.body).models as string[];
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  it('every suggestion passes the field its own validation', async () => {
    // A suggestion the field would then refuse to save would be a trap.
    const { isPlausibleAnthropicModelId } = await import('./models.js');
    const r = await httpRequest(port, 'GET', '/api/models/known', { 'x-forwarded-user': 'owner' });
    for (const id of JSON.parse(r.body).models as string[]) {
      expect(isPlausibleAnthropicModelId(id), `${id} must be settable`).toBe(true);
    }
  });
});
