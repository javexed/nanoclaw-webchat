/**
 * Re-assign the CURRENT workspace-default model credential to every agent.
 *
 * Why this is needed: re-minting the workspace default (wizard → Connect to
 * Claude) DELETES the old vault secret and creates a new one with a new id.
 * Agents left in OneCLI `all` mode pick that up automatically, but an ISOLATED
 * (`selective`) agent only receives what is explicitly assigned — so after a
 * re-mint every isolated agent holds a dangling id and 401s with "credentials
 * exist in OneCLI but this agent does not have access".
 *
 * The host now fans the new secret out automatically on re-mint
 * (fanOutWorkspaceCredential in user-credentials/onboard.ts); this script
 * covers the case NanoClaw cannot intercept — a credential rotated directly in
 * the OneCLI UI, where no host code runs to fan out.
 *
 * Members who have connected their OWN model credential are left alone; theirs
 * is not ours to replace.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';
import { getContainerConfig } from '../src/db/container-configs.js';
import { getUserCredential, listGroupMemberEnrollments } from '../src/modules/user-credentials/db.js';
import { userCredsAgentIdentifier, WORKSPACE_DEFAULT_USER_ID } from '../src/modules/user-credentials/identity.js';
import { realOnecliAdmin as admin } from '../src/modules/user-credentials/onecli-admin.js';

async function ensureAssigned(identifier: string, secretId: string, label: string): Promise<string> {
  const agentId = await admin.findAgentId(identifier);
  if (!agentId) return `skip  ${label} (no OneCLI agent)`;
  const assigned = await admin.listAgentSecretIds(agentId);
  if (assigned.includes(secretId)) return `ok    ${label}`;
  // Drop ids the vault no longer knows — those are the deleted credential.
  const live = new Set((await admin.listAllSecrets()).map((s) => s.id));
  const kept = assigned.filter((id) => live.has(id));
  await admin.setSecrets(agentId, [...kept, secretId]);
  return `FIXED ${label} (${assigned.length - kept.length} dangling removed)`;
}

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  const wsClaude = getUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude');
  const wsCodex = getUserCredential(WORKSPACE_DEFAULT_USER_ID, 'codex');
  if (!wsClaude?.secret_id && !wsCodex?.secret_id) {
    console.log('No workspace-default credential is connected — nothing to assign.');
    return;
  }
  let fixed = 0;
  for (const group of getAllAgentGroups()) {
    const isCodex = getContainerConfig(group.id)?.provider === 'codex';
    const ws = isCodex ? wsCodex : wsClaude;
    if (!ws?.secret_id) continue;
    const line = await ensureAssigned(group.id, ws.secret_id, group.name);
    if (line.startsWith('FIXED')) fixed++;
    console.log(line);
    for (const row of listGroupMemberEnrollments(group.id)) {
      // A member with their own credential keeps it.
      const own = getUserCredential(row.user_id, isCodex ? 'codex' : 'claude');
      if (own?.status === 'active' && own.secret_id) continue;
      const ml = await ensureAssigned(
        userCredsAgentIdentifier(group.id, row.user_id),
        ws.secret_id,
        `${group.name} / ${row.user_id}`,
      );
      if (ml.startsWith('FIXED')) fixed++;
      console.log('  ' + ml);
    }
  }
  console.log(`\nrepaired ${fixed} agent(s)`);
}

void main();
