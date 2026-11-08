/**
 * What an agent's container sees of its deploy keys: a read-only directory at
 * /run/nanoclaw-ssh holding an SSH config (`ssh <name>`; a key with several
 * targets also gets `<name>.2`, `<name>.3`…, in target order), the pinned host
 * keys, the public halves (which pick the key out of the agent), and the agent
 * socket (agent.ts). Never a private key.
 *
 * The agent image includes /run/nanoclaw-ssh/config from its system SSH
 * config, so plain `ssh <name>` and `git clone <name>:repo` work.
 */
import fs from 'fs';
import path from 'path';

import { writeNoFollow } from '../../no-follow-fs.js';
import { groupViewDir, listStored, pinnedHosts, readKnownHosts, resolveTargets, type StoredKey } from './store.js';

export const CONTAINER_SSH_DIR = '/run/nanoclaw-ssh';

/**
 * The SSH config for these keys: a Host block per usable target. A target
 * reached through a jump host gets `ProxyJump <the jump's alias>`, so the
 * container's ssh opens both connections and the agent signs each (one
 * destination constraint per hop). Pure: tested on its own.
 */
export function renderConfig(keys: StoredKey[], pinned: Set<string>): string {
  const lines = ['# Managed by NanoClaw: deploy keys for this agent. Read-only.'];
  for (const k of keys) {
    for (const t of resolveTargets(k.name, k.meta, pinned)) {
      if (!t.usable) continue;
      lines.push(
        '',
        `Host ${t.alias}`,
        `  HostName ${t.host}`,
        `  User ${t.user}`,
        `  IdentityAgent ${CONTAINER_SSH_DIR}/agent.sock`,
        `  IdentityFile ${CONTAINER_SSH_DIR}/${k.name}.pub`,
        '  IdentitiesOnly yes',
        '  BatchMode yes',
        `  UserKnownHostsFile ${CONTAINER_SSH_DIR}/known_hosts`,
        '  StrictHostKeyChecking yes',
        t.jump
          ? `  ProxyJump ${t.jump}`
          : // Direct where the container has a route out; through the egress filter where it has none.
            '  ProxyCommand bun /app/src/ssh-proxy.ts %h %p',
      );
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Rewrite a group's view. Returns whether it has any usable key (a target with
 * a pinned host key, and every jump on its way pinned too); the view directory exists either way once a group has a
 * key, so a running container's mount stays valid across changes.
 */
export function syncView(agentGroupId: string): boolean {
  const keys = listStored(agentGroupId);
  const known = readKnownHosts(agentGroupId);
  const pinned = pinnedHosts(known);
  const dir = groupViewDir(agentGroupId);
  const usable = keys.filter((k) => resolveTargets(k.name, k.meta, pinned).some((t) => t.usable));
  writeNoFollow(dir, 'config', renderConfig(usable, pinned), 0o644);
  writeNoFollow(dir, 'known_hosts', known, 0o644);
  const want = new Set(usable.map((k) => `${k.name}.pub`));
  // 0600: ssh reads an IdentityFile as a private key first and warns about a
  // readable one; the container runs as this same user.
  for (const k of usable) writeNoFollow(dir, `${k.name}.pub`, k.publicKey + '\n', 0o600);
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith('.pub') && !want.has(entry)) fs.rmSync(path.join(dir, entry), { force: true });
  }
  return usable.length > 0;
}

/**
 * The view directory for the container mount, when the agent has a key. An
 * agent's first key reaches its next session; later changes reach running
 * ones too, since the view and socket live in the mounted directory.
 */
export function viewDirFor(agentGroupId: string): string | null {
  try {
    if (!listStored(agentGroupId).length) return null;
    return groupViewDir(agentGroupId);
  } catch {
    return null;
  }
}
