/**
 * Deploy keys — per-agent SSH keys for reaching servers and git remotes. The
 * operations; index.ts registers the spawn, env, egress and sweep hooks.
 *
 * WHY NOT THE VAULT: OneCLI injects credentials into outbound HTTPS at the
 * proxy. SSH is not HTTP, so there is nothing to inject into. For a git host,
 * an HTTPS token in the vault is the alternative, and both are allowed.
 *
 * WHERE THE KEY LIVES: on the host only (store.ts), never in a folder a
 * container mounts. The agent uses a key through a per-agent ssh-agent on the
 * host (agent.ts) that signs only for the key's own targets (OpenSSH
 * destination constraints, checked against the pinned host keys). A
 * compromised agent can log in to those targets while its session runs; it
 * cannot take the key away or use it anywhere else. The container sees a
 * read-only view (view.ts): `ssh <name>`, the pinned host keys, the agent
 * socket.
 *
 * Earlier versions wrote both halves into the agent's group folder, where the
 * agent could read them. migrate.ts moves those into the store and marks them
 * exposed, and Admin offers Rotate.
 *
 * The private half is never returned by any function here.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { ensureAgent, reloadAgent, stopAgent } from './agent.js';
import { notifyKeyChange } from './notify.js';
import {
  NAME_RE,
  fingerprintOf,
  generatePair,
  groupStoreDir,
  hopOf,
  listStored,
  normalizeTargets,
  pinFromKnownHosts,
  pinHost,
  pinnedHosts,
  putKey,
  readKnownHosts,
  readMeta,
  removeKey,
  replaceKey,
  resolveTargets,
  splitTarget,
  targetsOf,
  withTargets,
  writeMeta,
  type TargetSetBy,
} from './store.js';
import { syncView } from './view.js';

const run = promisify(execFile);

/** One target of a key, as the UI and the memory note see it. */
export interface DeployKeyTarget {
  /** `user@host`, or `user@host via jumpuser@jumphost`. */
  target: string;
  /** The command the agent runs for this target. Present when it is usable. */
  command?: string;
  /** Its host key (or a jump's) could not be fetched yet, so it is not usable. */
  hostKeyMissing?: boolean;
}

/** A deploy key, as the UI and the memory note see it. Never carries the private half. */
export interface DeployKeyInfo {
  name: string;
  publicKey: string;
  fingerprint: string;
  /** The first target: who the agent logs in as, for callers that know one. */
  target?: string;
  /** Every target, in order. */
  targets: DeployKeyTarget[];
  /** The first usable target's command. Present when the key is usable. */
  command?: string;
  /** Some target's host key could not be fetched yet. */
  hostKeyMissing?: boolean;
  /** The private half was readable by the agent once: rotate it. */
  exposed?: boolean;
  lastUsedAt?: string;
}

export async function listDeployKeys(agentGroupId: string): Promise<DeployKeyInfo[]> {
  if (!(await getAgentGroup(agentGroupId))) return [];
  const pinned = pinnedHosts(readKnownHosts(agentGroupId));
  return listStored(agentGroupId).map((k) => {
    const targets: DeployKeyTarget[] = resolveTargets(k.name, k.meta, pinned).map((t) => ({
      target: t.target,
      ...(t.usable ? { command: `ssh ${t.alias}` } : { hostKeyMissing: true }),
    }));
    const command = targets.find((t) => t.command)?.command;
    return {
      name: k.name,
      publicKey: k.publicKey,
      fingerprint: fingerprintOf(k.publicKey),
      ...(targets.length ? { target: targets[0].target } : {}),
      targets,
      ...(command ? { command } : {}),
      ...(targets.some((t) => t.hostKeyMissing) ? { hostKeyMissing: true } : {}),
      ...(k.meta.exposed ? { exposed: true } : {}),
      ...(k.meta.lastUsedAt ? { lastUsedAt: k.meta.lastUsedAt } : {}),
    };
  });
}

/** The target's host keys as known_hosts lines, scanned from this host. Empty on failure. */
async function keyscan(host: string): Promise<string[]> {
  try {
    const { stdout } = await run('ssh-keyscan', ['-T', '5', '-t', 'ed25519,ecdsa,rsa', host], { timeout: 15_000 });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.split(/\s+/)[0] === host);
  } catch (err) {
    log.warn('Deploy key: host key scan failed', { host, err: String(err).slice(0, 200) });
    return [];
  }
}

let scanHostKeys = keyscan;
/** Tests replace the scan: it reaches the network. */
export function _setHostKeyScanForTest(fn: ((host: string) => Promise<string[]>) | null): void {
  scanHostKeys = fn ?? keyscan;
}

/** Pin (or re-pin) a target's host key. True when one is pinned afterwards. */
export async function pinTarget(agentGroupId: string, target: string, rescan: boolean): Promise<boolean> {
  const { host } = splitTarget(hopOf(target));
  if (!rescan && pinnedHosts(readKnownHosts(agentGroupId)).has(host)) return true;
  const lines = await scanHostKeys(host);
  if (lines.length) pinHost(agentGroupId, host, lines);
  return pinnedHosts(readKnownHosts(agentGroupId)).has(host);
}

/** After any change: the container's view, a running agent, the memory note, live sessions. */
async function applied(agentGroupId: string, notice: string): Promise<void> {
  try {
    syncView(agentGroupId);
    if (await groupIsLive(agentGroupId)) {
      await reloadAgent(agentGroupId);
      await ensureAgent(agentGroupId);
    } else stopAgent(agentGroupId);
  } catch (err) {
    log.warn('Deploy key: could not apply the change', { agentGroupId, err: String(err) });
  }
  // Imported here: tool-secrets imports this module.
  const { refreshCredentialNote } = await import('../tool-secrets/index.js');
  const { realOnecliAdmin } = await import('../user-credentials/onecli-admin.js');
  await refreshCredentialNote(realOnecliAdmin, agentGroupId).catch((err: unknown) =>
    log.warn('Deploy key: memory note refresh failed', { agentGroupId, err: String(err) }),
  );
  await notifyKeyChange(agentGroupId, notice);
}

/**
 * Generate an ed25519 pair in the host store. Returns the PUBLIC half only.
 * `setBy` records whether an install admin (owner or global admin) set the
 * target: only then may it resolve to a private address (egress below).
 */
export async function createDeployKey(
  agentGroupId: string,
  name: string,
  target?: string | string[],
  setBy: TargetSetBy = 'agent',
): Promise<DeployKeyInfo> {
  if (!NAME_RE.test(name)) throw new Error('Name must be lowercase letters, numbers and hyphens');
  const blank = Array.isArray(target) ? !target.some((t) => String(t).trim()) : !target?.trim();
  const targets = blank ? [] : normalizeTargets(target);
  const group = await getAgentGroup(agentGroupId);
  if (!group) throw new Error('This agent has no workspace folder yet');
  const first = listStored(agentGroupId).length === 0;
  const { priv, pub } = generatePair(targets.length ? hopOf(targets[0]) : `${name}@${group.folder}`);
  putKey(agentGroupId, name, priv, pub, {
    ...(targets.length ? { targets, targetSetBy: setBy } : {}),
    createdAt: new Date().toISOString(),
  });
  for (const t of targets) await pinTarget(agentGroupId, t, true);
  log.info('Deploy key created', { agentGroupId, name });
  // A first key is mounted at the next spawn; a running session cannot see it.
  await applied(
    agentGroupId,
    first
      ? `[SSH keys changed] A deploy key "${name}" was added. It works from your next session: \`ssh ${name}\`.`
      : `[SSH keys changed] A deploy key "${name}" was added. Run \`ssh ${name}\`.`,
  );
  return (await listDeployKeys(agentGroupId)).find((k) => k.name === name)!;
}

export interface SetTargetOptions {
  /**
   * known_hosts text an operator supplies: host keys for these targets are
   * pinned from it instead of scanned (a server this host cannot reach).
   */
  knownHosts?: string;
}

/**
 * Re-point a key at new targets (one `user@host`, a comma-separated list, or
 * an array; see normalizeTargets). The key material stays the same.
 */
export async function setDeployKeyTarget(
  agentGroupId: string,
  name: string,
  target: string | string[],
  setBy: TargetSetBy = 'agent',
  opts: SetTargetOptions = {},
): Promise<DeployKeyInfo> {
  if (!NAME_RE.test(name)) throw new Error('Name must be lowercase letters, numbers and hyphens');
  const targets = normalizeTargets(target);
  if (!listStored(agentGroupId).some((k) => k.name === name)) throw new Error(`No key named "${name}"`);
  const dir = groupStoreDir(agentGroupId);
  writeMeta(dir, name, withTargets(readMeta(dir, name), targets, setBy));
  const hosts = [...new Set(targets.map((t) => splitTarget(hopOf(t)).host))];
  const supplied = opts.knownHosts ? pinFromKnownHosts(agentGroupId, hosts, opts.knownHosts) : [];
  for (const t of targets) if (!supplied.includes(splitTarget(hopOf(t)).host)) await pinTarget(agentGroupId, t, true);
  log.info('Deploy key target set', { agentGroupId, name, targets });
  await applied(agentGroupId, `[SSH keys changed] Deploy key "${name}" now logs in as ${targets.join(', ')}.`);
  return (await listDeployKeys(agentGroupId)).find((k) => k.name === name)!;
}

/**
 * Replace a key's pair: same name and targets, new key material, no longer
 * marked exposed. The new public half must be installed on the target.
 */
export async function rotateDeployKey(agentGroupId: string, name: string): Promise<DeployKeyInfo> {
  if (!NAME_RE.test(name)) throw new Error('Name must be lowercase letters, numbers and hyphens');
  const key = listStored(agentGroupId).find((k) => k.name === name);
  if (!key) throw new Error(`No key named "${name}"`);
  const group = await getAgentGroup(agentGroupId);
  const first = targetsOf(key.meta)[0];
  const { priv, pub } = generatePair(first ? hopOf(first) : `${name}@${group?.folder ?? agentGroupId}`);
  replaceKey(agentGroupId, name, priv, pub);
  const dir = groupStoreDir(agentGroupId);
  const { exposed: _old, ...rest } = readMeta(dir, name);
  writeMeta(dir, name, { ...rest, createdAt: new Date().toISOString() });
  log.info('Deploy key rotated', { agentGroupId, name });
  await applied(agentGroupId, `[SSH keys changed] Deploy key "${name}" was replaced with a new key.`);
  return (await listDeployKeys(agentGroupId)).find((k) => k.name === name)!;
}

export async function deleteDeployKey(agentGroupId: string, name: string): Promise<boolean> {
  if (!NAME_RE.test(name) || !(await getAgentGroup(agentGroupId))) return false;
  if (!removeKey(agentGroupId, name)) return false;
  log.info('Deploy key deleted', { agentGroupId, name });
  await applied(agentGroupId, `[SSH keys changed] Deploy key "${name}" was removed.`);
  return true;
}

export async function groupIsLive(agentGroupId: string): Promise<boolean> {
  const { isContainerRunning } = await import('../../container-runner.js');
  return (await getSessionsByAgentGroup(agentGroupId)).some((s) => isContainerRunning(s.id));
}

/** After a migration: the group's view, agent and memory note. */
export async function refreshAfterMigration(agentGroupId: string): Promise<void> {
  await applied(
    agentGroupId,
    '[SSH keys changed] Your SSH keys moved to the host. Use `ssh <name>`; there are no key files.',
  );
}
