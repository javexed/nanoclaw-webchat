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
 * Per key: `<name>.key` (0600), `<name>.pub`, and `<name>.json` with the
 * targets and state. Per agent: `known_hosts`, the host keys pinned for its targets.
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
  /** `user@host`, or `user@host via jumpuser@jumphost` (see normalizeTargets). */
  targets?: string[];
  /** The single target of keys stored before a key could have several. Read, never written. */
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
/** `user@host via jumpuser@jumphost`: reach the first through the second, itself a target of the key. */
const VIA_RE = /^(\S+)\s+via\s+(\S+)$/;
export const MAX_TARGETS = 16;

/** The `user@host` an entry logs in to. */
export const hopOf = (entry: string): string => VIA_RE.exec(entry)?.[1] ?? entry;
/** The `user@host` an entry is reached through, if any. */
export const viaOf = (entry: string): string | undefined => VIA_RE.exec(entry)?.[2];

/** An entry of the right shape: it becomes SSH config lines, so nothing else passes. */
function wellFormed(entry: unknown): entry is string {
  if (typeof entry !== 'string' || /[\r\n]/.test(entry)) return false;
  const via = viaOf(entry);
  return TARGET_RE.test(hopOf(entry)) && (via === undefined || TARGET_RE.test(via));
}

/** A key's targets, whichever shape its state file has. Malformed entries are dropped. */
export function targetsOf(meta: KeyMeta): string[] {
  if (Array.isArray(meta.targets)) return meta.targets.filter(wellFormed);
  return wellFormed(meta.target) ? [meta.target] : [];
}

/**
 * Validate a target list: an array, or one string separated by commas or new
 * lines. Each entry is `user@host`, or `user@host via jumpuser@jumphost` when
 * the server is reached through another one; the jump must be listed earlier
 * in the same key. Duplicates go; order is kept (it names the SSH aliases).
 */
export function normalizeTargets(input: string | string[] | undefined): string[] {
  const raw = Array.isArray(input) ? input : (input ?? '').split(/[,\n]/);
  const out: string[] = [];
  for (const item of raw) {
    const entry = String(item).trim().replace(/\s+/g, ' ');
    if (!entry) continue;
    const hop = hopOf(entry);
    const via = viaOf(entry);
    if (!TARGET_RE.test(hop) || (via !== undefined && !TARGET_RE.test(via)))
      throw new Error('Target must look like user@host');
    if (via !== undefined && !out.some((e) => hopOf(e) === via))
      throw new Error(`Target "${entry}": list ${via} before it`);
    if (via === hop) throw new Error(`Target "${entry}" goes through itself`);
    if (!out.includes(entry)) out.push(entry);
  }
  if (!out.length) throw new Error('Target must look like user@host');
  if (out.length > MAX_TARGETS) throw new Error(`Targets: at most ${MAX_TARGETS} per key`);
  return out;
}

/** The SSH alias for a key's i-th target: the key's name, then `<name>.2`, `<name>.3`… (names hold no dot). */
export const aliasFor = (name: string, i: number): string => (i === 0 ? name : `${name}.${i + 1}`);

export interface ResolvedTarget {
  target: string;
  alias: string;
  user: string;
  host: string;
  /** The alias of the target this one is reached through. */
  jump?: string;
  /** Its host key is pinned, and so is every hop's on the way. */
  usable: boolean;
}

/** A key's targets with their aliases and whether each can be used. Pure. */
export function resolveTargets(name: string, meta: KeyMeta, pinned: Set<string>): ResolvedTarget[] {
  const out: ResolvedTarget[] = [];
  targetsOf(meta).forEach((target, i) => {
    const { user, host } = splitTarget(hopOf(target));
    const via = viaOf(target);
    const jumpIdx = via === undefined ? -1 : out.findIndex((r) => hopOf(r.target) === via);
    const jump = jumpIdx >= 0 ? out[jumpIdx] : undefined;
    const usable = pinned.has(host) && (via === undefined || (jump?.usable ?? false));
    out.push({ target, alias: aliasFor(name, i), user, host, ...(jump ? { jump: jump.alias } : {}), usable });
  });
  return out;
}

/** Every `user@host` a key signs for, once each: the destination constraints. */
export const hopsOf = (meta: KeyMeta): string[] => [...new Set(targetsOf(meta).map(hopOf))];

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

/** `meta` with a new target list, in the current shape (the single `target` field goes). */
export function withTargets(meta: KeyMeta, targets: string[], setBy: TargetSetBy): KeyMeta {
  const { target: _single, ...rest } = meta;
  return { ...rest, targets, targetSetBy: setBy };
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

/** Replace a key's pair in place (rotation): same name, targets and state file. */
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

/**
 * Pin host keys an operator supplies (known_hosts text) for `hosts`, for a
 * server this host cannot scan, such as one reached only through a jump host.
 * Lines for other hosts, hashed lines and malformed lines are ignored.
 * Returns the hosts pinned.
 */
export function pinFromKnownHosts(agentGroupId: string, hosts: string[], text: string): string[] {
  const wanted = new Set(hosts);
  const byHost = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const [names, type, b64, ...rest] = line.trim().split(/\s+/);
    if (!names || !type || !b64 || rest.length > 1 || names.startsWith('#') || names.startsWith('|')) continue;
    if (!/^(ssh-|ecdsa-|sk-)[a-z0-9@.-]+$/.test(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
    for (const h of names.split(',').map((n) => n.replace(/^\[(.+)\]:22$/, '$1')))
      if (wanted.has(h)) byHost.set(h, [...(byHost.get(h) ?? []), `${h} ${type} ${b64}`]);
  }
  for (const [h, lines] of byHost) pinHost(agentGroupId, h, lines);
  return [...byHost.keys()];
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
