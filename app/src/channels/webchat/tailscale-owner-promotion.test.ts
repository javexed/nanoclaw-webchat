/**
 * Regression tests for the wizard's "first Tailscale login becomes owner"
 * one-shot (auth.ts finalize → roles.ts grantOwnerRole).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM auth.test.ts. That suite calls
 * `initTestDb()` without `runMigrations`, so `user_roles` does not exist and
 * every role helper degrades to a no-op by design — it is testing the
 * "permissions module not installed" posture. The consequence is that the
 * grant itself has never been exercised against a real schema, and the real
 * schema is where it was broken: `user_roles.granted_by` is
 * `REFERENCES users(id)` under `foreign_keys = ON`, while the promotion passes
 * the sentinel 'webchat:first-tailscale-owner' — a reason, not a user. Every
 * grant threw the FK constraint, the catch swallowed it, and the caller
 * disarmed the one-shot regardless. Observed on a live install: the tailnet
 * identity authenticated, the flag read back `armed:false`, and `user_roles`
 * had no row for it.
 *
 * So these run WITH migrations. The point is the FK, and a test that can't
 * violate it proves nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { grantOwnerRole, isOwner } from './roles.js';

const now = '2026-08-14T00:00:00.000Z';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

function addUser(id: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`)
    .run(id, now);
}

function grantorOf(userId: string): string | null {
  const row = getDb().prepare(`SELECT granted_by FROM user_roles WHERE user_id = ? AND role = 'owner'`).get(userId) as
    | { granted_by: string | null }
    | undefined;
  return row?.granted_by ?? null;
}

describe('grantOwnerRole — grantedBy must never cost the grant', () => {
  it('grants when grantedBy is a sentinel that is not a user (the live failure)', () => {
    const ts = 'webchat:tailscale:operator@example.com';
    expect(grantOwnerRole(ts, 'webchat:first-tailscale-owner')).toBe(true);
    expect(isOwner(ts)).toBe(true);
    // The sentinel can't be stored — it would violate the FK — so the row
    // records no grantor. Losing attribution beats losing the role.
    expect(grantorOf(ts)).toBeNull();
  });

  it('grants alongside an existing owner (co-owner, the real install shape)', () => {
    addUser('webchat:local-owner');
    grantOwnerRole('webchat:local-owner');
    const ts = 'webchat:tailscale:operator@example.com';

    expect(grantOwnerRole(ts, 'webchat:first-tailscale-owner')).toBe(true);
    expect(isOwner('webchat:local-owner')).toBe(true);
    expect(isOwner(ts)).toBe(true);
  });

  it('preserves grantedBy when it names a real user', () => {
    addUser('webchat:local-owner');
    const ts = 'webchat:tailscale:operator@example.com';

    expect(grantOwnerRole(ts, 'webchat:local-owner')).toBe(true);
    expect(grantorOf(ts)).toBe('webchat:local-owner');
  });

  it('is idempotent per identity — a second call inserts nothing', () => {
    const ts = 'webchat:tailscale:operator@example.com';
    expect(grantOwnerRole(ts, 'webchat:first-tailscale-owner')).toBe(true);
    expect(grantOwnerRole(ts, 'webchat:first-tailscale-owner')).toBe(false);

    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ? AND role = 'owner'`)
      .get(ts) as { n: number };
    expect(count.n).toBe(1);
  });

  it('creates the users row for the grantee so the role has somewhere to point', () => {
    const ts = 'webchat:tailscale:operator@example.com';
    grantOwnerRole(ts, 'webchat:first-tailscale-owner');
    const row = getDb().prepare(`SELECT id FROM users WHERE id = ?`).get(ts);
    expect(row).toBeDefined();
  });
});
