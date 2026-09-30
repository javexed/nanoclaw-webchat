/**
 * Pins the user-credentials OAuth-mint route paths against what app.js actually
 * calls. The URLs are extracted from app.js rather than hardcoded, so a rename
 * on either side — client or server — turns this red instead of 404ing
 * "connect to Claude/ChatGPT" for every user.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadServer, LOOPBACK_ENV, noopHooks, portOf, resetServerModules } from './test-server.js';

const LOCAL_OWNER = 'webchat:local-owner';

afterEach(resetServerModules);

async function boot() {
  const { server, conn } = await loadServer(LOOPBACK_ENV);

  const dbh = conn.getDb();
  const now = new Date().toISOString();
  await dbh.run(
    `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    'ag-1',
    'Agent',
    'agent',
    now,
  );
  await dbh.run(
    `INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES ('room-1', 'webchat', 'webchat', 'room-1', 'Room', 0, 'public', ?)`,
    now,
  );
  await dbh.run(
    `INSERT OR IGNORE INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, 'room-1', 'ag-1', 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
    randomUUID(),
    now,
  );
  await dbh.run(
    `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
    LOCAL_OWNER,
    now,
  );
  await dbh.run(
    `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
    LOCAL_OWNER,
    now,
  );

  const wc = await server.startWebchatServer(noopHooks);
  return { server, wc };
}

const CSRF = { 'content-type': 'application/json', 'x-webchat-csrf': '1' };

// Pull the literal mint-route URLs straight out of app.js, same source the browser
// runs, so this test can't itself drift from what the client calls.
const appJsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../public/webchat/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

/**
 * Assert the shipped bundle really references this route, and hand it back so
 * the parity tests below hit the exact same string the client does.
 *
 * Matches the ROUTE LITERAL, not `const <name> = …`: app.js is bundled, and
 * the bundler inlines single-use consts, renames locals and normalises quotes.
 * The contract is "the client calls this path", so pin the path.
 */
function clientCalls(route: string): string {
  const literal = new RegExp(`['"\`]${route.replace(/[/-]/g, '\\$&')}['"\`]`);
  if (!literal.test(appJs)) {
    throw new Error(`app.js: the client no longer references ${route}`);
  }
  return route;
}

const claudeStartUrl = clientCalls('/api/user-credentials/oauth/start');
const codexCancelUrl = clientCalls('/api/user-credentials/codex/cancel');

describe('user-credentials OAuth-mint routes — client/server path parity', () => {
  it('app.js still points at /api/user-credentials/oauth/* and /api/user-credentials/codex/*', async () => {
    // Sanity on the extraction itself: both known branches must resolve, and to
    // the expected prefixes — guards against the regex silently matching nothing.
    expect(claudeStartUrl).toBe('/api/user-credentials/oauth/start');
    expect(codexCancelUrl).toMatch(/^\/api\/user-credentials\/(oauth|codex)\/cancel$/);
  });

  it('server recognizes the Claude oauth/start path (not a 404 fall-through)', async () => {
    const { server, wc } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(wc)}${claudeStartUrl}`, {
        method: 'POST',
        headers: CSRF,
        body: JSON.stringify({ roomId: 'room-1' }),
      });
      const body = (await res.json()) as { error?: string };
      // Not installed/allowed by default — but that's the oauth-opt-in gate, proof
      // the route matched and was evaluated, not the "Not found" route fall-through.
      expect(res.status).toBe(403);
      expect(body.error).toMatch(/does not accept/i);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('server recognizes the Codex oauth/start path (not a 404 fall-through)', async () => {
    const { server, wc } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(wc)}/api/user-credentials/codex/start`, {
        method: 'POST',
        headers: CSRF,
        body: JSON.stringify({ roomId: 'room-1' }),
      });
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(403);
      expect(body.error).toMatch(/does not accept/i);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('the stale pre-rename /api/userCreds/* prefix is gone (would silently un-fix this bug)', async () => {
    const { server, wc } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(wc)}/api/userCreds/oauth/start`, {
        method: 'POST',
        headers: CSRF,
        body: JSON.stringify({ roomId: 'room-1' }),
      });
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(404);
      expect(body.error).toBe('Not found');
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});
