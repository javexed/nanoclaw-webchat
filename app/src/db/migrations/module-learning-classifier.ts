import type Database from 'better-sqlite3';

import type { Migration } from './index.js';
import { addColumnIfMissing } from '../add-column-if-missing.js';

/**
 * Learning-loop classifier gate. The auto-review trigger's default is a bare
 * "≥N tools = busy turn" heuristic; when an owner picks a small local model
 * here it decides "was this turn actually worth distilling?" instead. We store
 * the roster model id (for the Settings picker) plus the resolved,
 * CONTAINER-REACHABLE call params (url + model) so materializeContainerJson can
 * inject them into container.json without a roster lookup (keeping core free of
 * a webchat dependency). NULL model id = no classifier (heuristic only).
 */
export const moduleLearningClassifier: Migration = {
  // PRAGMA/table_info is sqlite's vocabulary, not the portable driver's.
  sqliteOnly: true,
  version: 206,
  name: 'learning-classifier',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'learning_master', `classifier_model_id TEXT`);
    addColumnIfMissing(db, 'learning_master', `classifier_url TEXT`);
    addColumnIfMissing(db, 'learning_master', `classifier_model TEXT`);
  },
};
