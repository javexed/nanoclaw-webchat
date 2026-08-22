import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { moduleUserCredentials } from './module-user-credentials.js';

// The Migration union can't narrow a direct .up() call; this migration is
// sqliteOnly, so its up() takes the raw better-sqlite3 handle.
const up = moduleUserCredentials.up as (db: Database.Database) => void;

// The squash replaced a five-step chain whose tracking names live forever in
// old installs' schema_version. Its whole safety argument is "converges every
// starting state" — so every state gets a test, because the states the squash
// meets in the wild (fresh, legacy, migrated) can never be reproduced by
// running the repo's own migrations again.

const finalTables = (db: Database.Database) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%credential%' ORDER BY name")
    .all()
    .map((r: any) => r.name);

const columns = (db: Database.Database, t: string) =>
  db
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(t)
    .map((r: any) => r.name);

describe('moduleUserCredentials (squashed)', () => {
  it('fresh install: creates the final schema directly', async () => {
    const db = new Database(':memory:');
    up(db);
    expect(finalTables(db)).toEqual(['user_credential_members', 'user_credentials']);
    expect(columns(db, 'user_credential_members')).toContain('cred_type');
    expect(columns(db, 'user_credential_members')).toContain('provider');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%onecli%'").all();
    expect(idx.map((r: any) => r.name)).toEqual(['idx_user_credential_members_onecli_agent']);
  });

  it('legacy byok tables: renames, patches columns, backfills, drops the old index', async () => {
    const db = new Database(':memory:');
    // The state migration 020 alone left behind: members table without
    // cred_type/provider, byok index, no user-level table. (An install that
    // crashed mid-chain — the state the old rename migration could NOT fix.)
    db.exec(`
      CREATE TABLE byok_credentials (
        user_id TEXT NOT NULL, agent_group_id TEXT NOT NULL, onecli_agent_id TEXT NOT NULL,
        secret_id TEXT, status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_group_id)
      );
      CREATE INDEX idx_byok_onecli_agent ON byok_credentials(onecli_agent_id);
      INSERT INTO byok_credentials VALUES ('u1','g1','a1','s1','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    `);
    up(db);
    expect(finalTables(db)).toEqual(['user_credential_members', 'user_credentials']);
    expect(columns(db, 'user_credential_members')).toContain('provider');
    const seeded = db.prepare('SELECT user_id, provider, secret_id FROM user_credentials').all();
    expect(seeded).toEqual([{ user_id: 'u1', provider: 'claude', secret_id: 's1' }]);
    const oldIdx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_byok_onecli_agent'").get();
    expect(oldIdx).toBeUndefined();
  });

  it('fully migrated install: a re-run changes nothing', async () => {
    const db = new Database(':memory:');
    up(db);
    db.exec(`
      INSERT INTO user_credentials VALUES ('u1','claude','s-live','oauth_token','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      INSERT INTO user_credential_members VALUES ('u1','g1','a1','s-live','active','2026-01-01T00:00:00Z','2026-02-02T00:00:00Z','api_key','claude');
    `);
    up(db);
    // The existing user-level row wins over the backfill (INSERT OR IGNORE):
    // a re-run must never overwrite a live credential's cred_type.
    const row = db.prepare("SELECT secret_id, cred_type FROM user_credentials WHERE user_id='u1'").get() as any;
    expect(row).toEqual({ secret_id: 's-live', cred_type: 'oauth_token' });
  });
});
