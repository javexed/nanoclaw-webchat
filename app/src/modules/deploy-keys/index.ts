/**
 * Deploy keys — per-agent SSH keypairs for reaching servers and git remotes.
 *
 * WHY NOT THE VAULT: OneCLI injects credentials into outbound HTTPS at the
 * proxy. SSH is not HTTP, so there is nothing for it to inject into — these
 * have to be files. That is fine, and in one respect better: a group folder is
 * mounted only into that group's container, so a deploy key is private to its
 * agent by construction, with no `selective`-mode precondition.
 *
 * WHY THIS EXISTS: the alternative is a human generating a key by hand and then
 * either pasting the private half into chat (which persists it in
 * webchat_messages and every archived transcript) or asking the agent to make
 * one — which agents refuse, correctly, and which would put the private key in
 * the agent's context either way. Here the pair is generated host-side, the
 * PRIVATE half never leaves disk and is never returned by any API, and only the
 * public half is ever shown.
 *
 * Memory holds the PATH and fingerprint, never key material — the same rule the
 * tool-secrets module applies to tokens.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';

/** A deploy key, as the UI may see it. Never carries the private half. */
export interface DeployKeyInfo {
  name: string;
  /** Path INSIDE the container — what the agent actually uses. */
  path: string;
  publicKey: string;
  fingerprint: string;
  /**
   * Where the key is meant to be used, as `user@host`. Carried in the key's
   * comment because a keypair is otherwise just two opaque files: without it an
   * agent knows it HAS a key but not who to log in as, and burns a turn
   * guessing usernames (observed: root/deploy/ubuntu/admin all tried, the right
   * one never reached).
   */
  target?: string;
}

/**
 * Key names become filenames in the group folder, so anything but a plain slug
 * is a path-traversal attempt or an accident. Rejected rather than sanitised —
 * silently rewriting a name would make the file the operator sees differ from
 * the one they asked for.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** `user@host` — host may be a name or an IP. Kept strict; it lands in a comment. */
const TARGET_RE = /^[a-z_][a-z0-9._-]{0,31}@[a-zA-Z0-9.-]+$/;

/** The comment is `user@host` when it looks like a target, else it's decoration. */
function targetFromComment(pub: string): string | undefined {
  const comment = pub.trim().split(/\s+/)[2] ?? '';
  return TARGET_RE.test(comment) ? comment : undefined;
}

async function groupDir(agentGroupId: string): Promise<string | null> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return null;
  const dir = path.join(GROUPS_DIR, group.folder);
  return fs.existsSync(dir) ? dir : null;
}

/** `deploy_key_<name>` — prefixed so keys are obvious among the group's files. */
function keyFile(dir: string, name: string): string {
  return path.join(dir, `deploy_key_${name}`);
}

function fingerprintOf(pubPath: string): string {
  try {
    // `ssh-keygen -lf` → "256 SHA256:… comment (ED25519)"; keep the hash only.
    const out = execFileSync('ssh-keygen', ['-lf', pubPath], { encoding: 'utf-8', timeout: 5000 });
    return out.trim().split(/\s+/)[1] ?? '';
  } catch {
    return '';
  }
}

export function listDeployKeys(agentGroupId: string): DeployKeyInfo[] {
  const dir = groupDir(agentGroupId);
  if (!dir) return [];
  const out: DeployKeyInfo[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith('deploy_key_') || !entry.endsWith('.pub')) continue;
    const name = entry.slice('deploy_key_'.length, -'.pub'.length);
    const pubPath = path.join(dir, entry);
    const publicKey = fs.readFileSync(pubPath, 'utf-8').trim();
    out.push({
      name,
      path: `/workspace/agent/deploy_key_${name}`,
      publicKey,
      fingerprint: fingerprintOf(pubPath),
      target: targetFromComment(publicKey),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generate an ed25519 pair in the group folder. Returns the PUBLIC half only —
 * the private key is written 0600 and has no read path through this module, so
 * it cannot be surfaced by any caller, deliberately or by mistake.
 */
export async function createDeployKey(agentGroupId: string, name: string, target?: string): Promise<DeployKeyInfo> {
  if (!NAME_RE.test(name)) throw new Error('Name must be lowercase letters, numbers and hyphens');
  if (target && !TARGET_RE.test(target)) throw new Error('Target must look like user@host');
  const dir = groupDir(agentGroupId);
  if (!dir) throw new Error('This agent has no workspace folder yet');
  const priv = keyFile(dir, name);
  if (fs.existsSync(priv) || fs.existsSync(`${priv}.pub`)) throw new Error(`A key named "${name}" already exists`);

  const group = await getAgentGroup(agentGroupId)!;
  // The comment carries the target when we know it — that is what tells the
  // agent (via its memory note) who to log in as.
  const comment = target || `${name}@${group.folder}`;
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', priv, '-N', '', '-C', comment, '-q'], { timeout: 15000 });
  fs.chmodSync(priv, 0o600);
  fs.chmodSync(`${priv}.pub`, 0o644);
  log.info('Deploy key created', { agentGroupId, name });

  const info = listDeployKeys(agentGroupId).find((k) => k.name === name);
  if (!info) throw new Error('Key generation reported success but no key was found');
  return info;
}

/**
 * Re-stamp an existing key's target. The comment lives in the .pub file's third
 * field, so this rewrites that rather than regenerating the pair — the key
 * material, and anything already trusting it, stays valid.
 */
export function setDeployKeyTarget(agentGroupId: string, name: string, target: string): DeployKeyInfo {
  if (!NAME_RE.test(name)) throw new Error('Name must be lowercase letters, numbers and hyphens');
  if (!TARGET_RE.test(target)) throw new Error('Target must look like user@host');
  const dir = groupDir(agentGroupId);
  if (!dir) throw new Error('This agent has no workspace folder yet');
  const pubPath = `${keyFile(dir, name)}.pub`;
  if (!fs.existsSync(pubPath)) throw new Error(`No key named "${name}"`);
  const [type, material] = fs.readFileSync(pubPath, 'utf-8').trim().split(/\s+/);
  fs.writeFileSync(pubPath, `${type} ${material} ${target}\n`, { mode: 0o644 });
  log.info('Deploy key target set', { agentGroupId, name, target });
  return listDeployKeys(agentGroupId).find((k) => k.name === name)!;
}

export function deleteDeployKey(agentGroupId: string, name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  const dir = groupDir(agentGroupId);
  if (!dir) return false;
  const priv = keyFile(dir, name);
  if (!fs.existsSync(`${priv}.pub`)) return false;
  fs.rmSync(priv, { force: true });
  fs.rmSync(`${priv}.pub`, { force: true });
  log.info('Deploy key deleted', { agentGroupId, name });
  return true;
}
