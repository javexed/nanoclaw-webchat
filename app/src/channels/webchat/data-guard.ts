/**
 * Boot guard — side-effect module: refuse to start on a missing data dir.
 *
 * An installed tree (it carries `.webchat-provenance.json`) always has a
 * `data/` — and on some hosts it is a symlink to a data disk. A deploy that
 * deletes or breaks that link would otherwise boot happily: the host creates
 * `data/` and a fresh, empty central database, and every agent, room and
 * member appears gone. Refusing is the safe answer; the operator restores the
 * directory (or the link) and starts again.
 *
 * Runs at import, from `webchat/index.ts` — before `main()` creates `data/`
 * (the circuit breaker's first write) or opens the database. A source
 * checkout without the provenance file is not an install and is left alone.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

/** Why this install must not start, or null when its data dir is in place. */
export function missingDataDir(installRoot: string, dataDir = path.join(installRoot, 'data')): string | null {
  if (!fs.existsSync(path.join(installRoot, '.webchat-provenance.json'))) return null;
  let linked = false;
  try {
    linked = fs.lstatSync(dataDir).isSymbolicLink();
  } catch {
    return `${dataDir} is missing`;
  }
  // existsSync follows the link: false for one whose target is gone.
  if (!fs.existsSync(dataDir)) return `${dataDir} is a symlink to ${fs.readlinkSync(dataDir)}, which does not exist`;
  if (!fs.statSync(dataDir).isDirectory()) return `${dataDir} is not a directory${linked ? ' (symlink)' : ''}`;
  return null;
}

if (!process.env.VITEST) {
  const why = missingDataDir(path.dirname(DATA_DIR), DATA_DIR);
  if (why) {
    const msg =
      `Refusing to start: ${why}. This is an installed tree, so starting would create a fresh, empty ` +
      'database. Restore the data directory (or re-point its symlink at the data disk) and start again.';
    log.error(msg);
    throw new Error(msg);
  }
}
