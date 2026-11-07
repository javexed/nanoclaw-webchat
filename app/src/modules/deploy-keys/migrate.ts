/**
 * Move private keys out of agent folders into the host store.
 *
 * Agents could read anything in their group folder, so every private key found
 * there is treated as exposed: it is imported (marked "exposed — rotate"), the
 * original is backed up to a 0600 tarball in the store, and removed from the
 * folder. A key's target comes from the agent's own `.ssh/config`, or from the
 * `.pub` comment of a key NanoClaw generated; otherwise Admin asks for it.
 *
 * Run by the operator: `ncl deploy-keys migrate --dry-run`, then without.
 * Scripts that used `ssh -i /workspace/agent/<file>` stop working; the memory
 * note and the deploy-keys skill point agents to `ssh <name>`.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import {
  NAME_RE,
  TARGET_RE,
  fingerprintOf,
  groupStoreDir,
  listStored,
  publicOf,
  putKey,
  storeRoot,
  type TargetSetBy,
} from './store.js';

/** Folders never searched: dependency trees and test fixtures carry sample keys. */
const SKIP_DIRS = new Set(['node_modules', '.pnpm-store', '.cache', 'fixtures', '.git', '.npm', '.bun']);
const MAX_DEPTH = 6;
const MAX_KEY_BYTES = 16 * 1024;
const KEY_HEAD = /^-----BEGIN (OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/;

export interface FoundKey {
  /** Relative to the group folder. */
  file: string;
  name: string;
  fingerprint: string;
  target?: string;
  /** Why it is not imported, when it is not. */
  skip?: string;
}

export interface GroupPlan {
  agentGroupId: string;
  folder: string;
  keys: FoundKey[];
}

/** Files in a group folder that are private keys (by content), without following links. */
export function findKeyFiles(groupDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(groupDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH) walk(r, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(path.join(groupDir, r));
        if (st.size > MAX_KEY_BYTES) continue;
        const text = fs.readFileSync(path.join(groupDir, r), 'latin1').trimStart();
        if (KEY_HEAD.test(text) && /-----END [A-Z ]*PRIVATE KEY-----/.test(text)) out.push(r);
      } catch {
        /* unreadable: not ours to judge */
      }
    }
  };
  walk('', 0);
  return out.sort();
}

/** A store name for a key file: `deploy_key_<name>` keeps its name, others become a slug. */
export function nameFor(file: string, taken: Set<string>): string {
  const base = path.basename(file);
  let n = base.startsWith('deploy_key_') ? base.slice('deploy_key_'.length) : base;
  n = n
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  if (!n || !/^[a-z0-9]/.test(n)) n = `key-${n}`.replace(/-+$/, '');
  if (n.length < 2) n = `${n}-key`;
  let out = n;
  for (let i = 2; taken.has(out) || !NAME_RE.test(out); i++) out = `${n.slice(0, 33)}-${i}`;
  taken.add(out);
  return out;
}

/** `Host` blocks of an SSH config that use this identity file, as user@host. */
export function targetFromConfig(config: string, file: string): string | undefined {
  const wanted = new Set([`/workspace/agent/${file}`, `~/${file}`, file]);
  let host: string | undefined;
  let user: string | undefined;
  let identity: string | undefined;
  let hit: string | undefined;
  const flush = (): void => {
    if (!hit && identity && wanted.has(identity) && user && host) hit = `${user}@${host}`;
  };
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"|"$/g, '');
    if (key === 'host' || key === 'match') {
      flush();
      host = key === 'host' ? value.split(/\s+/).find((h) => !/[*?!]/.test(h)) : undefined;
      user = identity = undefined;
    } else if (key === 'hostname') host = value;
    else if (key === 'user') user = value;
    else if (key === 'identityfile') identity = value;
  }
  flush();
  return hit && TARGET_RE.test(hit) ? hit : undefined;
}

/** What a migration would do. Reads only; never returns key material. */
export async function planMigration(): Promise<GroupPlan[]> {
  const plans: GroupPlan[] = [];
  for (const g of await getAllAgentGroups()) {
    const dir = path.join(GROUPS_DIR, g.folder);
    if (!fs.existsSync(dir)) continue;
    const files = findKeyFiles(dir);
    if (!files.length) continue;
    const taken = new Set(listStored(g.id).map((k) => k.name));
    const seen = new Set(listStored(g.id).map((k) => fingerprintOf(k.publicKey)));
    let config = '';
    try {
      const p = path.join(dir, '.ssh', 'config');
      if (!fs.lstatSync(p).isSymbolicLink()) config = fs.readFileSync(p, 'utf-8');
    } catch {
      /* none */
    }
    const keys: FoundKey[] = [];
    for (const file of files) {
      const pub = publicOf(fs.readFileSync(path.join(dir, file)));
      const name = nameFor(file, taken);
      if (!pub) {
        keys.push({ file, name, fingerprint: '', skip: 'passphrase-protected or unreadable' });
        continue;
      }
      const fingerprint = fingerprintOf(pub);
      if (seen.has(fingerprint)) {
        keys.push({ file, name, fingerprint, skip: 'same key already stored' });
        continue;
      }
      seen.add(fingerprint);
      // A comment is the target only on a key NanoClaw generated (it wrote the
      // target there); elsewhere `user@machine` is just who made the key.
      let comment = '';
      if (path.basename(file).startsWith('deploy_key_'))
        try {
          comment =
            fs
              .readFileSync(path.join(dir, `${file}.pub`), 'utf-8')
              .trim()
              .split(/\s+/)[2] ?? '';
        } catch {
          /* no .pub beside it */
        }
      const target = targetFromConfig(config, file) ?? (TARGET_RE.test(comment) ? comment : undefined);
      keys.push({ file, name, fingerprint, ...(target ? { target } : {}) });
    }
    plans.push({ agentGroupId: g.id, folder: g.folder, keys });
  }
  return plans;
}

export interface MigrationResult {
  plans: GroupPlan[];
  imported: number;
  backup?: string;
}

/**
 * Import every key the plan finds, back the originals up, and remove them from
 * the agent folders. `trustTargets` records the found targets as an install
 * admin's (they may then resolve to a private address); otherwise an owner
 * confirms each one in Admin.
 */
export async function migrateKeys(opts: { dryRun: boolean; trustTargets?: boolean }): Promise<MigrationResult> {
  const plans = await planMigration();
  if (opts.dryRun) return { plans, imported: 0 };
  const toBackUp: string[] = [];
  let imported = 0;
  for (const plan of plans) {
    const dir = path.join(GROUPS_DIR, plan.folder);
    for (const k of plan.keys) {
      if (k.skip) continue;
      const priv = fs.readFileSync(path.join(dir, k.file));
      const pub = publicOf(priv);
      if (!pub) continue;
      const setBy: TargetSetBy = opts.trustTargets ? 'install' : 'agent';
      putKey(plan.agentGroupId, k.name, priv, pub, {
        ...(k.target ? { target: k.target, targetSetBy: setBy } : {}),
        exposed: true,
        createdAt: new Date().toISOString(),
      });
      imported++;
      toBackUp.push(path.join(plan.folder, k.file));
      if (fs.existsSync(path.join(dir, `${k.file}.pub`))) toBackUp.push(path.join(plan.folder, `${k.file}.pub`));
    }
    groupStoreDir(plan.agentGroupId);
  }
  if (!toBackUp.length) return { plans, imported };
  const backups = path.join(storeRoot(), 'backups');
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const backup = path.join(backups, `group-folder-keys-${new Date().toISOString().replace(/[:.]/g, '-')}.tgz`);
  const fd = fs.openSync(backup, 'wx', 0o600);
  fs.closeSync(fd);
  execFileSync('tar', ['czf', backup, '-C', GROUPS_DIR, '--', ...toBackUp], { timeout: 60_000 });
  fs.chmodSync(backup, 0o600);
  for (const rel of toBackUp) fs.rmSync(path.join(GROUPS_DIR, rel), { force: true });
  log.info('Deploy keys: moved keys out of agent folders', { imported, backup });
  return { plans, imported, backup };
}

/** Human summary: names, files and targets only. */
export function formatPlan(r: MigrationResult, dryRun: boolean): string {
  const lines: string[] = [];
  let n = 0;
  for (const p of r.plans) {
    lines.push(`${p.folder} (${p.agentGroupId})`);
    for (const k of p.keys) {
      if (!k.skip) n++;
      lines.push(
        `  ${k.file} → ${k.name}` +
          (k.skip ? `  [skipped: ${k.skip}]` : k.target ? `  ${k.target}` : '  [target needed in Admin]'),
      );
    }
  }
  lines.push(
    dryRun
      ? `${n} key${n === 1 ? '' : 's'} would move into the host store. Nothing changed.`
      : `${r.imported} key${r.imported === 1 ? '' : 's'} moved. Originals backed up to ${r.backup ?? '(none)'}.`,
  );
  return lines.join('\n');
}
