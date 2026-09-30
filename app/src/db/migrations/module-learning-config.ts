import type Database from 'better-sqlite3';
import type { Migration } from './index.js';
import { addColumnIfMissing } from '../add-column-if-missing.js';

/**
 * Per-agent learning-loop settings (design §1: "per-agent opt-in").
 *
 * JSON blob: { autoTrigger?: boolean; autoKeep?: boolean; cooldownMinutes?: number }
 *
 * Absent keys mean defaults: autoTrigger ON (a busy turn stages a draft — the
 * human gate survives at Keep), autoKeep OFF (accepting self-written agent
 * context without review is the one autonomy step that needs an explicit,
 * owner-level opt-in).
 */
export const moduleLearningConfig: Migration = {
  // PRAGMA/table_info is sqlite's vocabulary, not the portable driver's.
  sqliteOnly: true,
  version: 201,
  name: 'learning-config',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'container_configs', `learning TEXT NOT NULL DEFAULT '{}'`);
  },
};
