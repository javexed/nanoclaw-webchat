/**
 * Tests for the role-gating primitives in roles.ts.
 *
 * These functions are the load-bearing authorization layer for every
 * webchat HTTP endpoint that mutates state. Bugs here trade user
 * isolation for user impersonation, so they get unit coverage on the
 * full matrix of role rows + agent_group_id scoping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureOwnerRoleOnFirstLogin, grantOwnerRole, hasAdminPrivilege, isOwner } from './roles.js';

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  await closeDb();
});

async function insertRole(userId: string, role: 'owner' | 'admin' | 'member', agentGroupId: string | null): Promise<void> {
  const db = getDb();
  // user_roles has an FK to users; satisfy it idempotently.
  await db.run(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`, userId, new Date().toISOString());
  // Scoped roles need a real agent_groups row to satisfy the FK on
  // agent_group_id. Create a stub if the test asks for one.
  if (agentGroupId) {
    await db.run(`INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, NULL, ?)`, agentGroupId, agentGroupId, agentGroupId, new Date().toISOString());
  }
  await db.run(`INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
     VALUES (?, ?, ?, NULL, ?)`, userId, role, agentGroupId, new Date().toISOString());
}

describe('isOwner', () => {
  it('returns true for any user when user_roles table is missing (fail-open)', async () => {
    // No migrations run — user_roles doesn't exist.
    expect(await isOwner('webchat:anyone')).toBe(true);
  });

  it('returns true only for global-owner rows (agent_group_id IS NULL)', async () => {
    await runMigrations(getDb());
    await insertRole('webchat:alice', 'owner', null);
    expect(await isOwner('webchat:alice')).toBe(true);
    expect(await isOwner('webchat:bob')).toBe(false);
  });

  it("does not treat 'admin' rows as owner", async () => {
    await runMigrations(getDb());
    await insertRole('webchat:alice', 'admin', null); // global admin
    expect(await isOwner('webchat:alice')).toBe(false);
  });

  it("does not treat scoped 'owner' rows as owner (agent_group_id != NULL)", async () => {
    await runMigrations(getDb());
    // Anomalous row — not created by webchat itself, but if some other
    // module inserts (alice, owner, ag-1), isOwner shouldn't grant
    // global owner privileges.
    await insertRole('webchat:alice', 'owner', 'ag-1');
    expect(await isOwner('webchat:alice')).toBe(false);
  });

  it("ignores 'member' rows", async () => {
    await runMigrations(getDb());
    await insertRole('webchat:alice', 'member', null);
    expect(await isOwner('webchat:alice')).toBe(false);
  });
});

describe('hasAdminPrivilege', () => {
  it('returns true for any user when user_roles table is missing (fail-open)', async () => {
    expect(await hasAdminPrivilege('webchat:anyone', 'ag-1')).toBe(true);
  });

  it('global owner has admin privilege over every agent group', async () => {
    await runMigrations(getDb());
    await insertRole('webchat:alice', 'owner', null);
    expect(await hasAdminPrivilege('webchat:alice', 'ag-1')).toBe(true);
    expect(await hasAdminPrivilege('webchat:alice', 'ag-2')).toBe(true);
  });

  it('global admin (agent_group_id NULL) has admin privilege over every agent group', async () => {
    await runMigrations(getDb());
    await insertRole('webchat:alice', 'admin', null);
    expect(await hasAdminPrivilege('webchat:alice', 'ag-1')).toBe(true);
    expect(await hasAdminPrivilege('webchat:alice', 'ag-99')).toBe(true);
  });

  it('scoped admin matches only the scoped agent_group_id', async () => {
    await runMigrations(getDb());
    await insertRole('webchat:alice', 'admin', 'ag-1');
    expect(await hasAdminPrivilege('webchat:alice', 'ag-1')).toBe(true);
    expect(await hasAdminPrivilege('webchat:alice', 'ag-2')).toBe(false);
  });

  it("'member' rows do not grant admin privilege", async () => {
    await runMigrations(getDb());
    await insertRole('webchat:alice', 'member', null);
    await insertRole('webchat:alice', 'member', 'ag-1');
    expect(await hasAdminPrivilege('webchat:alice', 'ag-1')).toBe(false);
  });

  it('returns false for users with no roles', async () => {
    await runMigrations(getDb());
    expect(await hasAdminPrivilege('webchat:nobody', 'ag-1')).toBe(false);
  });
});

describe('ensureOwnerRoleOnFirstLogin', () => {
  it('is a no-op when user_roles table is absent', async () => {
    // Permissions module not installed; helper bails out cleanly.
    expect(() => ensureOwnerRoleOnFirstLogin('webchat:alice')).not.toThrow();
  });

  it('creates an owner row on first call', async () => {
    await runMigrations(getDb());
    await ensureOwnerRoleOnFirstLogin('webchat:alice');
    expect(await isOwner('webchat:alice')).toBe(true);
  });

  it('is idempotent — second call does not change ownership', async () => {
    await runMigrations(getDb());
    await ensureOwnerRoleOnFirstLogin('webchat:alice');
    await ensureOwnerRoleOnFirstLogin('webchat:alice');
    const ownerCount = (
      (await getDb().get(`SELECT COUNT(*) AS c FROM user_roles WHERE role='owner'`)) as { c: number }
    ).c;
    expect(ownerCount).toBe(1);
  });

  it('does not promote a second user when an owner already exists', async () => {
    await runMigrations(getDb());
    await ensureOwnerRoleOnFirstLogin('webchat:alice');
    await ensureOwnerRoleOnFirstLogin('webchat:bob');
    expect(await isOwner('webchat:alice')).toBe(true);
    expect(await isOwner('webchat:bob')).toBe(false);
    const ownerCount = (
      (await getDb().get(`SELECT COUNT(*) AS c FROM user_roles WHERE role='owner'`)) as { c: number }
    ).c;
    expect(ownerCount).toBe(1);
  });

  it('atomic guard: simulated concurrent first-login produces exactly one owner', async () => {
    // The check-and-insert is atomic via INSERT ... WHERE NOT EXISTS,
    // so even back-to-back calls intended to race can't double-insert.
    // We simulate the race by calling many times with different userIds
    // in sequence (single-threaded JS, but each call independently does
    // the WHERE-NOT-EXISTS check).
    await runMigrations(getDb());
    for (const u of ['webchat:alice', 'webchat:bob', 'webchat:carol', 'webchat:dave']) {
      await ensureOwnerRoleOnFirstLogin(u);
    }
    const ownerCount = (
      (await getDb().get(`SELECT COUNT(*) AS c FROM user_roles WHERE role='owner'`)) as { c: number }
    ).c;
    expect(ownerCount).toBe(1);
    // First caller wins.
    expect(await isOwner('webchat:alice')).toBe(true);
  });

  it('creates a users row with kind=webchat when users table exists', async () => {
    await runMigrations(getDb());
    await ensureOwnerRoleOnFirstLogin('webchat:alice');
    const row = (await getDb().get(`SELECT kind FROM users WHERE id = ?`, 'webchat:alice')) as
      | { kind: string }
      | undefined;
    expect(row?.kind).toBe('webchat');
  });
});

describe('grantOwnerRole', () => {
  it('grants global owner to a specific identity (co-owner-safe, idempotent)', async () => {
    await runMigrations(getDb());
    await insertRole('webchat:owner', 'owner', null); // bearer bootstrap already owns
    // Promote a second (Tailscale) identity alongside it.
    expect(await grantOwnerRole('webchat:tailscale:me@example.com')).toBe(true);
    expect(await isOwner('webchat:tailscale:me@example.com')).toBe(true);
    expect(await isOwner('webchat:owner')).toBe(true); // original owner preserved
    // Idempotent — a second grant for the same id inserts nothing.
    expect(await grantOwnerRole('webchat:tailscale:me@example.com')).toBe(false);
  });

  it('is a no-op (false) when the permissions module is absent', async () => {
    expect(await grantOwnerRole('webchat:x')).toBe(false); // no migrations → no user_roles
  });
});
