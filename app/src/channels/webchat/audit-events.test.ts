/**
 * The audit trail, end to end: boot the real server, make real requests, read
 * the real file. Unit tests on audit() prove lines get written; these prove
 * the SEAMS emit — which is where the value lives, and which nothing else
 * exercises (the decision used to be computed and thrown away).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

let auditFile: string;
const SCRATCH: string[] = [];

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-e2e-'));
  SCRATCH.push(dir);
  auditFile = path.join(dir, 'audit.jsonl');
  vi.stubEnv('NANOCLAW_AUDIT_FILE', auditFile);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    conn.closeDb();
  } catch {
    /* ignore */
  }
  vi.resetModules();
  for (const d of SCRATCH.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const events = () =>
  fs.existsSync(auditFile)
    ? fs
        .readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>)
    : [];

async function bootLocalhost(env: Record<string, string> = {}) {
  // Defaults first, caller overrides second — the refusal test sets
  // WEBCHAT_TOKEN, and the first version of this helper stubbed it back to ''
  // AFTER the test had set it, which made the server auto-pass loopback and
  // the test fail with 200-instead-of-401.
  const merged = {
    WEBCHAT_HOST: '127.0.0.1',
    WEBCHAT_PORT: '0',
    WEBCHAT_TOKEN: '',
    WEBCHAT_TAILSCALE: '',
    WEBCHAT_TRUSTED_PROXY_IPS: '',
    ...env,
  };
  for (const [k, v] of Object.entries(merged)) vi.stubEnv(k, v);
  const conn = await import('../../db/connection.js');
  conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  migrations.runMigrations(conn.getDb());
  const server = await import('./server.js');
  const wc = await server.startWebchatServer(noopHooks);
  const addr = wc.http.address() as { port: number };
  return { server, wc, port: addr.port };
}

describe('audit events at the seams', () => {
  it('records the first-login owner grant and the session, once', async () => {
    const { server, wc, port } = await bootLocalhost();
    try {
      // Three requests; the transition events must appear ONCE.
      for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${port}/api/webchat/onboarding`);

      const grants = events().filter((e) => e.type === 'role.grant');
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        effect: 'granted',
        detail: { role: 'owner', via: 'first-login' },
      });

      const sessions = events().filter((e) => e.type === 'auth.session');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].detail).toMatchObject({ source: 'localhost', ip: '127.0.0.1' });
      // The incident question: the grant and the session name the same identity.
      expect(grants[0].actor).toBe(sessions[0].actor);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('records a refusal when explicit auth is configured and the caller has none', async () => {
    const { server, wc, port } = await bootLocalhost({ WEBCHAT_TOKEN: 'a'.repeat(32) }); // bearer on → loopback auto-pass off
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/rooms`);
      expect(r.status).toBe(401);

      const denied = events().filter((e) => e.type === 'auth.denied');
      expect(denied).toHaveLength(1);
      expect(denied[0].detail).toMatchObject({ ip: '127.0.0.1' });
      // …and throttled: a second refused request inside the window adds nothing.
      await fetch(`http://127.0.0.1:${port}/api/rooms`);
      expect(events().filter((e) => e.type === 'auth.denied')).toHaveLength(1);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('guard consults leave a decision record', async () => {
    // Straight to the seam — a registered action, both verdict shapes.
    const { guard } = await import('../../guard/index.js');
    const { defineGuardedAction } = await import('../../guard/guard-actions.js');
    const { ALLOW, DENY } = await import('../../guard/types.js');

    const allowAction = defineGuardedAction({ action: 'audit-test.allow', decide: () => ALLOW('fine') });
    const denyAction = defineGuardedAction({ action: 'audit-test.deny', decide: () => DENY('nope') });
    guard(allowAction, { actor: { kind: 'human', userId: 'webchat:probe' }, payload: { secret: 'MUST-NOT-APPEAR' } });
    guard(denyAction, { actor: { kind: 'agent', agentGroupId: 'g1' }, payload: {} });

    const decisions = events().filter((e) => e.type === 'guard.decision');
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ actor: 'human:webchat:probe', action: 'audit-test.allow', effect: 'allow' });
    expect(decisions[1]).toMatchObject({
      actor: 'agent:g1',
      action: 'audit-test.deny',
      effect: 'deny',
      reason: 'nope',
    });
    // The payload-exclusion contract, asserted where it matters: on disk.
    expect(fs.readFileSync(auditFile, 'utf8')).not.toContain('MUST-NOT-APPEAR');
  });
});

describe('audit syslog config route', () => {
  it('rejects a malformed target with 400 and changes nothing', async () => {
    const { server, wc, port } = await bootLocalhost();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/webchat/audit-syslog`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
        body: JSON.stringify({ target: 'udp://nowhere' }), // no port
      });
      expect(r.status).toBe(400);
      const g = (await (await fetch(`http://127.0.0.1:${port}/api/webchat/audit-syslog`)).json()) as { target: string };
      expect(g.target).toBe('');
      expect(events().filter((e) => e.type === 'audit.config')).toHaveLength(0);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('audits its own change twice and delivers the after-switch event to the NEW sink', async () => {
    const dgram = await import('dgram');
    const sock = dgram.createSocket('udp4');
    const got: string[] = [];
    sock.on('message', (m) => got.push(m.toString('utf8')));
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
    const udpPort = (sock.address() as { port: number }).port;

    const { server, wc, port } = await bootLocalhost();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/webchat/audit-syslog`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
        body: JSON.stringify({ target: `udp://127.0.0.1:${udpPort}` }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { target: string };
      expect(body.target).toBe(`udp://127.0.0.1:${udpPort}`);

      // The file (the floor) carries BOTH emissions — before and after.
      const cfg = events().filter((e) => e.type === 'audit.config');
      expect(cfg).toHaveLength(2);
      expect(cfg[0]).toMatchObject({ effect: 'changed', detail: { phase: 'before-switch' } });
      expect(cfg[1]).toMatchObject({ effect: 'applied', detail: { phase: 'after-switch' } });

      // The NEW collector's record starts with its own provenance: the
      // after-switch event is the first thing it receives.
      await vi.waitFor(() => expect(got.length).toBeGreaterThan(0));
      expect(got[0]).toContain('"phase":"after-switch"');
    } finally {
      await server.stopWebchatServer(wc);
      sock.close();
    }
  });
});

describe('audited routes', () => {
  it('records a privileged route with its real outcome, and only identifiers', async () => {
    const { server, wc, port } = await bootLocalhost();
    try {
      // Export is the highest-value one to cover: it reads the entire
      // workspace out of the box, and nothing else would record that it
      // happened. Loopback boot makes this caller the owner.
      const ok = await fetch(`http://127.0.0.1:${port}/api/system/export`);
      expect(ok.status).toBe(200);

      const exp = events().filter((e) => e.type === 'system.export');
      expect(exp).toHaveLength(1);
      expect(exp[0]).toMatchObject({ effect: 'ok', action: 'GET /api/system/export' });
      expect(exp[0].actor).toMatch(/^human:/);
      expect(exp[0].detail).toMatchObject({ status: 200 });

      // A failure is recorded AS a failure, not skipped and not as a success:
      // deleting a room that does not exist is the shape of "someone tried
      // something that did not take", which is exactly what an incident asks.
      const bad = await fetch(`http://127.0.0.1:${port}/api/rooms/no-such-room`, {
        method: 'DELETE',
        headers: { 'X-Webchat-CSRF': '1' },
      });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      const del = events().filter((e) => e.type === 'room.delete');
      expect(del).toHaveLength(1);
      expect(del[0]).toMatchObject({ effect: 'failed', detail: { id: 'no-such-room' } });

      // The payload-exclusion contract holds on this path too.
      const raw = fs.readFileSync(auditFile, 'utf8');
      expect(raw).not.toContain('"body"');
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('leaves unaudited privileged routes alone', async () => {
    const { server, wc, port } = await bootLocalhost();
    try {
      // A probe is privileged but says nothing after the fact. If everything
      // privileged were recorded, the twelve lines that matter would be buried.
      await fetch(`http://127.0.0.1:${port}/api/models/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
        body: JSON.stringify({}),
      });
      const kinds = new Set(events().map((e) => e.type));
      expect(kinds.has('model.discover')).toBe(false);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});
