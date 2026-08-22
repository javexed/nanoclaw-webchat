import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * User credentials — the consolidated migration.
 *
 * Squashes the five historical migrations that built this schema in steps
 * (recorded on old installs as `byok-credentials`, `byok-oauth-credentials`,
 * `byok-provider`, `byok-user-credentials`, `rename-user-credentials` — names
 * from the era the feature was called BYOK). The squash exists so those frozen
 * names no longer appear anywhere in the repo; installs that already ran the
 * chain keep them as inert rows in their own schema_version, which nothing
 * reads back.
 *
 * Written to converge EVERY starting state onto the final schema, so no
 * version fence is needed:
 *   - fresh install            → creates the final tables directly
 *   - legacy byok tables       → renames, then patches any missing columns
 *     (covers an install that crashed mid-chain and never ran the rename)
 *   - fully migrated install   → verifies and no-ops
 *
 * Final schema:
 *   user_credentials          — per-user connect-time source of truth, one row
 *                               per (user, provider), OneCLI `secret_id` only —
 *                               the host never holds the credential itself.
 *   user_credential_members   — lazy per-(user, agent-group) enrollment; the
 *                               onecli_agent_id index lets approval routing
 *                               recover the owning group from a per-member
 *                               container's identity.
 *
 * The backfill (member rows → user-level rows, most-recently-updated
 * credential wins) is INSERT OR IGNORE, so it is exact on a legacy upgrade and
 * a no-op everywhere else.
 */
export const moduleUserCredentials: Migration = {
  // PRAGMA/sqlite_master introspection is sqlite's vocabulary, not the
  // portable driver's — same standing as the chain this replaces.
  sqliteOnly: true,
  version: 24,
  name: 'user-credentials',
  up(db: Database.Database) {
    const hasTable = (t: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t) != null;
    const hasIndex = (i: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(i) != null;
    const hasColumn = (t: string, c: string) =>
      db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(t, c) != null;

    // 1. Legacy renames first, so every later step addresses one set of names.
    if (hasTable('byok_user_credentials') && !hasTable('user_credentials')) {
      db.exec('ALTER TABLE byok_user_credentials RENAME TO user_credentials;');
    }
    if (hasTable('byok_credentials') && !hasTable('user_credential_members')) {
      db.exec('ALTER TABLE byok_credentials RENAME TO user_credential_members;');
    }

    // 2. Final tables, complete column set.
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_credential_members (
        user_id         TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL,
        onecli_agent_id TEXT NOT NULL,
        secret_id       TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        cred_type       TEXT NOT NULL DEFAULT 'api_key',
        provider        TEXT NOT NULL DEFAULT 'claude',
        PRIMARY KEY (user_id, agent_group_id)
      );
      CREATE TABLE IF NOT EXISTS user_credentials (
        user_id    TEXT NOT NULL,
        provider   TEXT NOT NULL DEFAULT 'claude',
        secret_id  TEXT,
        cred_type  TEXT NOT NULL DEFAULT 'api_key',
        status     TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, provider)
      );
    `);

    // 3. Column patches for a renamed legacy table that missed later steps.
    if (!hasColumn('user_credential_members', 'cred_type')) {
      db.exec(`ALTER TABLE user_credential_members ADD COLUMN cred_type TEXT NOT NULL DEFAULT 'api_key';`);
    }
    if (!hasColumn('user_credential_members', 'provider')) {
      db.exec(`ALTER TABLE user_credential_members ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';`);
    }

    // 4. The index, under its final name only.
    if (hasIndex('idx_byok_onecli_agent')) {
      db.exec('DROP INDEX idx_byok_onecli_agent;');
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_user_credential_members_onecli_agent ON user_credential_members(onecli_agent_id);',
    );

    // 5. Backfill user-level rows from member enrollments (legacy upgrades
    // only, in practice) — most recently updated credential wins per
    // (user, provider), so the seeded cred_type matches the live credential.
    db.exec(`
      INSERT OR IGNORE INTO user_credentials (user_id, provider, secret_id, cred_type, status, created_at, updated_at)
        SELECT user_id, provider, secret_id, cred_type, 'active',
               strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
          FROM user_credential_members m
         WHERE status = 'active' AND secret_id IS NOT NULL
           AND updated_at = (
             SELECT MAX(m2.updated_at) FROM user_credential_members m2
              WHERE m2.user_id = m.user_id AND m2.provider = m.provider
                AND m2.status = 'active' AND m2.secret_id IS NOT NULL
           )
         GROUP BY user_id, provider;
    `);
  },
};
