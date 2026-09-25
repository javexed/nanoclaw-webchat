import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { moduleEgressExistingOpen } from './module-egress-existing-open.js';

// The migration is portable (exec only); a raw handle wrapped as the driver
// is enough to run it against a hand-built schema — the states it meets in
// the wild (rows with NULL, rows already set, groups with no row) cannot be
// reproduced by running the repo's own migrations on a fresh database.
function seed(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
    CREATE TABLE container_configs (
      agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
      egress TEXT,
      skills TEXT NOT NULL DEFAULT '"all"',
      updated_at TEXT NOT NULL
    );
    INSERT INTO agent_groups (id) VALUES ('unset'), ('chosen-none'), ('chosen-open'), ('no-row');
    INSERT INTO container_configs VALUES ('unset', NULL, '"all"', 't0');
    INSERT INTO container_configs VALUES ('chosen-none', 'none', '"all"', 't0');
    INSERT INTO container_configs VALUES ('chosen-open', 'open', '"all"', 't0');
  `);
  return db;
}

async function run(db: Database.Database): Promise<void> {
  await moduleEgressExistingOpen.up({ exec: async (sql: string) => void db.exec(sql) } as never);
}

describe('webchat-egress-existing-open', () => {
  it('stamps open on unset rows, leaves chosen modes, and gives row-less groups an open row', async () => {
    const db = seed();
    await run(db);
    const rows = db.prepare('SELECT agent_group_id AS id, egress FROM container_configs ORDER BY id').all() as Array<{
      id: string;
      egress: string;
    }>;
    expect(rows).toEqual([
      { id: 'chosen-none', egress: 'none' },
      { id: 'chosen-open', egress: 'open' },
      { id: 'no-row', egress: 'open' },
      { id: 'unset', egress: 'open' },
    ]);
    expect(
      (
        db.prepare("SELECT updated_at FROM container_configs WHERE agent_group_id = 'no-row'").get() as {
          updated_at: string;
        }
      ).updated_at,
    ).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const db = seed();
    await run(db);
    const before = db.prepare('SELECT * FROM container_configs ORDER BY agent_group_id').all();
    await run(db);
    expect(db.prepare('SELECT * FROM container_configs ORDER BY agent_group_id').all()).toEqual(before);
  });
});
