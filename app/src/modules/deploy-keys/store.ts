/**
 * The host-only deploy-key store.
 *
 * Private halves live under `data/deploy-keys/<agent group id>/`, a directory
 * no container mounts. An agent never sees a key file: the host loads each key
 * into a per-agent ssh-agent (agent.ts) restricted to the key's target, and
 * the container gets only that agent's socket plus a read-only view
 * (`data/v2-sessions/<agent group id>/ssh-view/`: SSH config, pinned host
 * keys, public halves). The view sits under the group's session root because
 * that is where a group-state mount may come from.
 *
 * Per key: `<name>.key` (0600), `<name>.pub`, and `<name>.json` with the target
 * and state. Per agent: `known_hosts`, the host keys pinned for its targets.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { isPlainFile, readNoFollow, removeNoFollow, writeNoFollow } from '../../no-follow-fs.js';

/** Who set a key's target. Only an install admin's target may resolve to a private address. */
export type TargetSetBy = 'install' | 'agent';

export interface KeyMeta {
  /** `user@host` */
  target?: string;
  targetSetBy?: TargetSetBy;
  /** The private half was readable by the agent at some point: rotate it. */
  exposed?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface StoredKey {
  name: string;
  publicKey: string;
  meta: KeyMeta;
}

/** Key names become filenames, so anything but a plain slug is refused. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
/** `user@host`; host is a name or an IPv4 address. */
export const TARGET_RE = /^[a-z_][a-z0-9._-]{0,31}@[a-zA-Z0-9.-]+$/;
const GROUP_RE = /^[A-Za-z0-9_-]{1,80}$/;

export const storeRoot = (): string => path.join(DATA_DIR, 'deploy-keys');
/** Under the group's session root, beside its sessions: where group-state mounts may come from. */
const VIEW_DIR = 'ssh-view';

function checkGroup(agentGroupId: string): void {
  if (!GROUP_RE.test(agentGroupId)) throw new Error('Unknown agent group');
}

/** A 0700 directory, created if missing; refused if something else sits there. */
function privateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Not a directory: ${dir}`);
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function groupStoreDir(agentGroupId: string): string {
  checkGroup(agentGroupId);
  privateDir(storeRoot());
  return privateDir(path.join(storeRoot(), agentGroupId));
}

export function groupViewDir(agentGroupId: string): string {
  checkGroup(agentGroupId);
  const parent = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
  fs.mkdirSync(parent, { recursive: true });
  return privateDir(path.join(parent, VIEW_DIR));
}

/** The groups that have a store directory (whether or not it holds keys). */
export function storedGroups(): string[] {
  try {
    return fs.readdirSync(storeRoot()).filter((g) => GROUP_RE.test(g));
  } catch {
    return [];
  }
}

export const keyFile = (agentGroupId: string, name: string): string =>
  path.join(groupStoreDir(agentGroupId), `${name}.key`);

export function readMeta(dir: string, name: string): KeyMeta {
  try {
    return JSON.parse(readNoFollow(dir, `${name}.json`) ?? '{}') as KeyMeta;
  } catch {
    return {};
  }
}

export function writeMeta(dir: string, name: string, meta: KeyMeta): void {
  writeNoFollow(dir, `${name}.json`, JSON.stringify(meta, null, 2) + '\n', 0o600);
}

export function listStored(agentGroupId: string): StoredKey[] {
  checkGroup(agentGroupId);
  const dir = path.join(storeRoot(), agentGroupId);
  if (!fs.existsSync(dir)) return [];
  const out: StoredKey[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.pub')) continue;
    const name = entry.slice(0, -'.pub'.length);
    if (!NAME_RE.test(name) || !isPlainFile(dir, entry) || !isPlainFile(dir, `${name}.key`)) continue;
    out.push({ name, publicKey: (readNoFollow(dir, entry) ?? '').trim(), meta: readMeta(dir, name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Store a private/public pair. Refuses to replace an existing key. */
export function putKey(agentGroupId: string, name: string, priv: Buffer, pub: string, meta: KeyMeta): void {
  if (!NAME_RE.test(name)) throw new Error('Name must be lowercase letters, numbers and hyphens');
  const dir = groupStoreDir(agentGroupId);
  if (fs.existsSync(path.join(dir, `${name}.key`)) || fs.existsSync(path.join(dir, `${name}.pub`)))
    throw new Error(`A key named "${name}" already exists`);
  writeNoFollow(dir, `${name}.key`, priv, 0o600);
  writeNoFollow(dir, `${name}.pub`, pub.trim() + '\n', 0o600);
  writeMeta(dir, name, meta);
}

/** Replace a key's pair in place (rotation): same name, target and state file. */
export function replaceKey(agentGroupId: string, name: string, priv: Buffer, pub: string): void {
  const dir = groupStoreDir(agentGroupId);
  writeNoFollow(dir, `${name}.key`, priv, 0o600);
  writeNoFollow(dir, `${name}.pub`, pub.trim() + '\n', 0o600);
}

export function removeKey(agentGroupId: string, name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  const dir = path.join(storeRoot(), agentGroupId);
  if (!fs.existsSync(path.join(dir, `${name}.pub`))) return false;
  for (const ext of ['key', 'pub', 'json']) removeNoFollow(dir, `${name}.${ext}`);
  return true;
}

/** A fresh ed25519 pair, made in a private temp directory. */
export function generatePair(comment: string): { priv: Buffer; pub: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-deploy-key-'));
  try {
    const priv = path.join(tmp, 'key');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', priv, '-N', '', '-C', comment, '-q'], { timeout: 15000 });
    return { priv: fs.readFileSync(priv), pub: fs.readFileSync(`${priv}.pub`, 'utf-8').trim() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The public half of a private key, or null when it is not one ssh-keygen can read without a passphrase. */
export function publicOf(priv: Buffer): string | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-deploy-key-'));
  try {
    const f = path.join(tmp, 'key');
    fs.writeFileSync(f, priv, { mode: 0o600 });
    const out = execFileSync('ssh-keygen', ['-y', '-P', '', '-f', f], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function fingerprintOf(publicKey: string): string {
  try {
    const out = execFileSync('ssh-keygen', ['-lf', '-'], { input: publicKey, encoding: 'utf-8', timeout: 5000 });
    return out.trim().split(/\s+/)[1] ?? '';
  } catch {
    return '';
  }
}

export function splitTarget(target: string): { user: string; host: string } {
  const at = target.lastIndexOf('@');
  return { user: target.slice(0, at), host: target.slice(at + 1) };
}

// ── pinned host keys ──────────────────────────────────────────────────────────

export function readKnownHosts(agentGroupId: string): string {
  return readNoFollow(groupStoreDir(agentGroupId), 'known_hosts') ?? '';
}

/** Hosts with a pinned key. */
export function pinnedHosts(knownHosts: string): Set<string> {
  const out = new Set<string>();
  for (const line of knownHosts.split('\n')) {
    const first = line.trim().split(/\s+/)[0];
    if (!first || first.startsWith('#') || first.startsWith('|')) continue;
    for (const h of first.split(',')) out.add(h.replace(/^\[(.+)\]:22$/, '$1'));
  }
  return out;
}

/** Replace what is pinned for `host` with `lines` (ssh-keyscan output). */
export function pinHost(agentGroupId: string, host: string, lines: string[]): void {
  const dir = groupStoreDir(agentGroupId);
  const kept = readKnownHosts(agentGroupId)
    .split('\n')
    .filter((l) => l.trim() && l.trim().split(/\s+/)[0] !== host);
  writeNoFollow(dir, 'known_hosts', [...kept, ...lines].join('\n') + '\n', 0o600);
}

/** Pinned host keys as `{host, blob}`, for naming the host a signature was bound to. */
export function pinnedKeyBlobs(knownHosts: string): Array<{ host: string; blob: Buffer }> {
  const out: Array<{ host: string; blob: Buffer }> = [];
  for (const line of knownHosts.split('\n')) {
    const [hosts, , b64] = line.trim().split(/\s+/);
    if (!hosts || !b64 || hosts.startsWith('#') || hosts.startsWith('|')) continue;
    const blob = Buffer.from(b64, 'base64');
    for (const h of hosts.split(',')) out.push({ host: h.replace(/^\[(.+)\]:22$/, '$1'), blob });
  }
  return out;
}
