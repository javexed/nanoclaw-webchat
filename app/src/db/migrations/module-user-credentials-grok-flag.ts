import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `allow_grok_oauth` on the webchat settings singleton.
 *
 * Members can connect their own Grok subscription only when the workspace says
 * so — the same gate the Claude and Codex flags provide. There is deliberately
 * no key counterpart: xAI's CLI authenticates with a subscription and offers no
 * API-key path, so a second flag could never be true.
 *
 * Defaults to 0, so an existing install does not silently start accepting
 * member credentials for a provider its operator never enabled.
 */
export const moduleUserCredentialsGrokFlag: Migration = {
  version: 207,
  name: 'user-credentials-grok-flag',
  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(webchat_settings)`).all() as { name: string }[];
    // The settings table is created by its own migration; if it has not run yet
    // there is no column set to extend, and this is a no-op rather than a crash.
    if (!cols.length) return;
    if (cols.some((c) => c.name === 'allow_grok_oauth')) return;
    db.exec(`ALTER TABLE webchat_settings ADD COLUMN allow_grok_oauth INTEGER NOT NULL DEFAULT 0`);
  },
};
