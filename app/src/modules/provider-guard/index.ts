/**
 * Boot check: is every provider an agent group asks for actually installed?
 *
 * WHY THIS EXISTS. Providers other than the baked-in default arrive by SKILL —
 * `/add-pi-stack`, `/add-grok`, `/add-codex` each copy a provider file into two
 * trees and append an import to two barrels. The import is what runs
 * registration; without it the file sits on disk, compiles, passes every test,
 * and the provider does not exist at runtime. A group pinned to it then dies at
 * SPAWN with `Unknown provider: pi. Registered: claude, grok` — hours later,
 * in a container whose logs are gone (`--rm`), attributed to whatever the user
 * was doing at the time.
 *
 * That is not hypothetical: pi sat half-installed for five days that way. One
 * of its four install steps had run; nothing failed, and nothing said so.
 *
 * Why a boot check rather than a test. The provider files are skill-installed
 * and untracked, so they are ABSENT from the composed tree — a test asserting
 * "every provider file is imported" passes vacuously in CI, where none exist.
 * The only place the truth is knowable is a running install, comparing what
 * groups ask for against what actually registered.
 *
 * WARN, never fail. A half-installed provider affects the groups pinned to it;
 * refusing to boot would take down every other group with it, which is a worse
 * outcome than a loud line naming the problem.
 */
import { getDb } from '../../db/connection.js';
import { registerModuleSweep } from '../../module-sweep.js';
import { log } from '../../log.js';
import { listProviderContainerConfigNames } from '../../providers/provider-container-registry.js';

/** The provider a group gets when it names none — always present, never checked. */
const BUILT_IN_DEFAULT = 'claude';

interface ProviderRow {
  provider: string | null;
  groups: number;
}

/**
 * Providers named by at least one agent group, with how many name them.
 * Excludes the default: a null/absent provider means "the baked-in one".
 */
export async function providersInUse(): Promise<ProviderRow[]> {
  const rows = (await getDb().all(
    `SELECT provider, COUNT(*) AS groups
       FROM container_configs
      WHERE provider IS NOT NULL AND provider != '' AND provider != ?
      GROUP BY provider`,
    BUILT_IN_DEFAULT,
  )) as ProviderRow[];
  return rows;
}

/**
 * Which of the in-use providers never registered. Pure over its inputs so the
 * comparison is testable without a DB or a live registry.
 */
export function missingRegistrations(inUse: ProviderRow[], registered: string[]): ProviderRow[] {
  const known = new Set(registered);
  return inUse.filter((r) => r.provider && !known.has(r.provider));
}

export async function checkProviderRegistrations(): Promise<ProviderRow[]> {
  let inUse: ProviderRow[];
  try {
    inUse = await providersInUse();
  } catch {
    return []; // pre-migration boot, or no container_configs yet — nothing to check
  }
  const registered = listProviderContainerConfigNames();
  const missing = missingRegistrations(inUse, registered);
  for (const row of missing) {
    log.error('Provider named by an agent group is NOT registered — those groups cannot spawn', {
      provider: row.provider,
      agentGroups: row.groups,
      registered,
      // The remedy, in the message, because the person reading this line at
      // 2am should not have to find the skill that owns the provider.
      fix: `re-run the skill that installs '${row.provider}' (it is idempotent); the missing step is usually the barrel import`,
    });
  }
  return missing;
}

// Registered on the sweep seam and self-gated to one real run: the check wants
// a booted DB, which module import time cannot promise, and repeating it every
// 60s would turn one honest alarm into a log flood.
let checked = false;
registerModuleSweep('provider-registration-guard', async () => {
  if (checked) return;
  checked = true;
  await checkProviderRegistrations();
});

/** Test seam: allow the one-shot gate to run again. */
export function __resetProviderGuardForTest(): void {
  checked = false;
}
