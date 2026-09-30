import type Database from 'better-sqlite3';
import type { Migration } from './index.js';
import { addColumnIfMissing } from '../add-column-if-missing.js';

/**
 * Per-agent-group network egress mode: 'open' | 'host-only' | 'none'. Meanings
 * and the unset default (the allowlist) live in modules/container-egress.
 */
export const moduleContainerEgress: Migration = {
  // PRAGMA/table_info is sqlite's vocabulary, not the portable driver's.
  sqliteOnly: true,
  version: 204,
  name: 'container-egress',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'container_configs', `egress TEXT`);
  },
};
