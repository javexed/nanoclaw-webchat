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
 *
 * Portable (no PRAGMA): the previous column-exists guard duplicated what the
 * migration runner already guarantees — schema_version dedupes by name, so
 * this runs exactly once — and webchat-credentials-config (which creates the
 * table) is ordered before every module-file migration in the composed tree.
 */
export const moduleUserCredentialsGrokFlag: Migration = {
  version: 207,
  name: 'user-credentials-grok-flag',
  async up(db) {
    await db.exec(`ALTER TABLE webchat_settings ADD COLUMN allow_grok_oauth INTEGER NOT NULL DEFAULT 0;`);
  },
};
