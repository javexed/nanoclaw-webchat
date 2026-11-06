/**
 * What an agent's container sees of its deploy keys: a read-only directory at
 * /run/nanoclaw-ssh holding an SSH config (`ssh <name>`), the pinned host
 * keys, the public halves (which pick the key out of the agent), and the agent
 * socket (agent.ts). Never a private key.
 *
 * The agent image includes /run/nanoclaw-ssh/config from its system SSH
 * config, so plain `ssh <name>` and `git clone <name>:repo` work.
 */
import fs from 'fs';
import path from 'path';

import { writeNoFollow } from '../../no-follow-fs.js';
import { groupViewDir, listStored, pinnedHosts, readKnownHosts, splitTarget, type StoredKey } from './store.js';

export const CONTAINER_SSH_DIR = '/run/nanoclaw-ssh';

/** The SSH config for these keys. Pure: tested on its own. */
export function renderConfig(keys: StoredKey[], pinned: Set<string>): string {
  const lines = ['# Managed by NanoClaw: deploy keys for this agent. Read-only.'];
  for (const k of keys) {
    if (!k.meta.target) continue;
    const { user, host } = splitTarget(k.meta.target);
    if (!pinned.has(host)) continue;
    lines.push(
      '',
      `Host ${k.name}`,
      `  HostName ${host}`,
      `  User ${user}`,
      `  IdentityAgent ${CONTAINER_SSH_DIR}/agent.sock`,
      `  IdentityFile ${CONTAINER_SSH_DIR}/${k.name}.pub`,
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      `  UserKnownHostsFile ${CONTAINER_SSH_DIR}/known_hosts`,
      '  StrictHostKeyChecking yes',
      // Direct where the container has a route out; through the egress filter where it has none.
      '  ProxyCommand bun /app/src/ssh-proxy.ts %h %p',
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Rewrite a group's view. Returns whether it has any usable key (a target with
 * a pinned host key); the view directory exists either way once a group has a
 * key, so a running container's mount stays valid across changes.
 */
export function syncView(agentGroupId: string): boolean {
  const keys = listStored(agentGroupId);
  const known = readKnownHosts(agentGroupId);
  const pinned = pinnedHosts(known);
  const dir = groupViewDir(agentGroupId);
  const usable = keys.filter((k) => k.meta.target && pinned.has(splitTarget(k.meta.target).host));
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
 * The view directory, created if missing, for the container mount. Every agent
 * gets one, empty until it has a key, so a key added while a session runs works
 * without a restart.
 */
export function viewDirFor(agentGroupId: string): string | null {
  try {
    return groupViewDir(agentGroupId);
  } catch {
    return null;
  }
}
