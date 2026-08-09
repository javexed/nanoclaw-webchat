/**
 * Fleet credential lockdown — flip every agent group from OneCLI `all` secret
 * mode to `selective`, so that assignment actually scopes credentials.
 *
 * WHY: in `all` mode the gateway injects EVERY vault secret whose host pattern
 * matches, regardless of assignment. A per-agent PAT is therefore offered to
 * every other `all`-mode agent too. Scoping only becomes real once every agent
 * is `selective` — it is all-or-nothing, not incremental.
 *
 * SAFETY: `isolateGroup` pins each agent's model credential BEFORE flipping the
 * mode, so no agent is ever selective-with-nothing-assigned (which is a live
 * 401 on every request). This script additionally snapshots the pre-change mode
 * and assignment of every agent to a timestamped JSON file so the whole run can
 * be reversed, and re-verifies each agent after flipping it.
 *
 *   pnpm exec tsx scripts/isolate-fleet.ts --dry-run     # report only
 *   pnpm exec tsx scripts/isolate-fleet.ts               # run
 *   pnpm exec tsx scripts/isolate-fleet.ts --rollback <snapshot.json>
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';
import { realOnecliAdmin as admin } from '../src/modules/user-credentials/onecli-admin.js';
import { getGroupIsolation, isolateGroup } from '../src/modules/tool-secrets/index.js';

interface Snap {
  groupId: string;
  name: string;
  agentId: string;
  mode: 'all' | 'selective' | null;
  secretIds: string[];
}

async function snapshot(): Promise<Snap[]> {
  const out: Snap[] = [];
  for (const g of getAllAgentGroups()) {
    const agentId = await admin.findAgentId(g.id);
    if (!agentId) continue;
    out.push({
      groupId: g.id,
      name: g.name,
      agentId,
      mode: await admin.getSecretMode(agentId),
      secretIds: await admin.listAgentSecretIds(agentId),
    });
  }
  return out;
}

async function rollback(file: string): Promise<void> {
  const snaps = JSON.parse(fs.readFileSync(file, 'utf-8')) as Snap[];
  let restored = 0;
  for (const s of snaps) {
    // Restore assignment first, then mode — the mirror of the safe ordering.
    await admin.setSecrets(s.agentId, s.secretIds);
    if (s.mode) await admin.setSecretMode(s.agentId, s.mode);
    restored++;
    console.log(`  restored ${s.name} → ${s.mode}`);
  }
  console.log(`\nRolled back ${restored} agents from ${path.basename(file)}`);
}

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  const args = process.argv.slice(2);

  const rbIdx = args.indexOf('--rollback');
  if (rbIdx !== -1) return rollback(args[rbIdx + 1]);

  const dryRun = args.includes('--dry-run');
  const groups = getAllAgentGroups();

  const todo: { id: string; name: string }[] = [];
  const skip: { name: string; why: string }[] = [];
  for (const g of groups) {
    const iso = await getGroupIsolation(admin, g.id);
    if (!iso.available) skip.push({ name: g.name, why: 'no OneCLI agent yet' });
    else if (iso.isolated) skip.push({ name: g.name, why: 'already isolated' });
    else todo.push({ id: g.id, name: g.name });
  }

  console.log(`groups: ${groups.length} | to isolate: ${todo.length} | skipping: ${skip.length}`);
  for (const s of skip) console.log(`  skip ${s.name} — ${s.why}`);
  if (dryRun) {
    console.log('\n--dry-run: nothing changed');
    return;
  }
  if (!todo.length) return;

  const snapDir = path.join(process.cwd(), 'backups');
  fs.mkdirSync(snapDir, { recursive: true });
  const snapFile = path.join(snapDir, `onecli-modes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(snapFile, JSON.stringify(await snapshot(), null, 2));
  console.log(`\nsnapshot → ${snapFile}\n`);

  const failed: { name: string; err: string }[] = [];
  for (const g of todo) {
    try {
      await isolateGroup(admin, g.id);
      // Verify rather than trust: mode flipped AND something is assigned.
      const agentId = (await admin.findAgentId(g.id))!;
      const mode = await admin.getSecretMode(agentId);
      const assigned = await admin.listAgentSecretIds(agentId);
      if (mode !== 'selective' || assigned.length === 0)
        throw new Error(`verify failed (mode=${mode}, ${assigned.length} secrets)`);
      console.log(`  ✓ ${g.name} — selective, ${assigned.length} secret(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ name: g.name, err: msg });
      console.log(`  ✗ ${g.name} — ${msg}`);
    }
  }

  console.log(`\nisolated ${todo.length - failed.length}/${todo.length}`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed) console.log(`  ${f.name}: ${f.err}`);
  }
  console.log(`\nrollback: pnpm exec tsx scripts/isolate-fleet.ts --rollback ${snapFile}`);
}

void main();
