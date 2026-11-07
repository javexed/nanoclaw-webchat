/**
 * `ncl deploy-keys`: list keys and their targets, set a key's targets, and
 * move private keys out of agent folders into the host store (migrate.ts).
 * Host only: an agent never runs these, whatever its CLI scope. Targets set
 * here are an install admin's (the operator holds the host).
 */
import fs from 'fs';
import path from 'path';

import { registerResource } from '../../cli/crud.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { checkGivenTargets, formatPlan, migrateKeys, type MigrationResult } from './migrate.js';
import { storedGroups } from './store.js';

let dryRunShown = true;
const MAX_KNOWN_HOSTS_BYTES = 64 * 1024;

/** A key as `list` and `set-target` show it: names, targets and a fingerprint, never key material. */
export interface KeyListing {
  name: string;
  fingerprint: string;
  targets: Array<{ target: string; command?: string; hostKeyMissing?: boolean }>;
  exposed?: boolean;
  lastUsedAt?: string;
}

export interface GroupListing {
  agentGroupId: string;
  folder: string;
  keys: KeyListing[];
}

async function listingFor(agentGroupId: string): Promise<KeyListing[]> {
  const { listDeployKeys } = await import('./keys.js');
  return (await listDeployKeys(agentGroupId)).map((k) => ({
    name: k.name,
    fingerprint: k.fingerprint,
    targets: k.targets,
    ...(k.exposed ? { exposed: true } : {}),
    ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}),
  }));
}

function formatKey(k: KeyListing): string[] {
  const head = `  ${k.name}  ${k.fingerprint}${k.exposed ? '  [exposed: rotate]' : ''}`;
  if (!k.targets.length) return [head, '    [no target]'];
  return [
    head,
    ...k.targets.map(
      (t) => `    ${t.target}  ${t.command ? `(${t.command})` : '[host key not pinned: --known-hosts, or retry]'}`,
    ),
  ];
}

export function formatListing(groups: GroupListing[]): string {
  if (!groups.length) return 'No deploy keys.';
  return groups.flatMap((g) => [`${g.folder} (${g.agentGroupId})`, ...g.keys.flatMap(formatKey)]).join('\n');
}

/** Read an operator's known_hosts file: an absolute path, a plain file, bounded. */
export function readKnownHostsFile(file: string): string {
  if (!path.isAbsolute(file)) throw new Error('--known-hosts must be an absolute path');
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error('--known-hosts must be a plain file');
  if (st.size > MAX_KNOWN_HOSTS_BYTES) throw new Error('--known-hosts file is too large');
  return fs.readFileSync(file, 'utf-8');
}

async function requireGroup(id: unknown): Promise<{ id: string; folder: string }> {
  const g = typeof id === 'string' ? await getAgentGroup(id) : undefined;
  if (!g) throw new Error(`No agent group "${String(id)}"`);
  return g;
}

registerResource({
  name: 'deploy-key',
  plural: 'deploy-keys',
  table: 'agent_groups',
  description: 'SSH deploy keys held on the host for agents.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      hostOnly: true,
      description:
        'List deploy keys and their targets.\n\n' +
        'Shows each key’s name, fingerprint and targets, with the command an agent runs for each usable ' +
        'target. Never shows key material.',
      args: [{ name: 'group', type: 'string', description: 'Only this agent group (id).' }],
      examples: ['ncl deploy-keys list', 'ncl deploy-keys list --group <agent group id>'],
      handler: async (args) => {
        const ids = args.group !== undefined ? [(await requireGroup(args.group)).id] : storedGroups();
        const groups = new Map((await getAllAgentGroups()).map((g) => [g.id, g]));
        const out: GroupListing[] = [];
        for (const id of ids) {
          const g = groups.get(id);
          if (!g) continue;
          const keys = await listingFor(id);
          if (keys.length) out.push({ agentGroupId: id, folder: g.folder, keys });
        }
        return out;
      },
      formatHuman: (data) => formatListing(data as GroupListing[]),
    },
    'set-target': {
      access: 'open',
      hostOnly: true,
      description:
        'Set a key’s targets, as an install admin.\n\n' +
        'Replaces the key’s targets with --targets: user@host entries separated by commas. A server reached ' +
        'through a jump host is written "user@host via jumpuser@jumphost", with the jump listed earlier. ' +
        'The agent runs `ssh <key>` for the first target, `ssh <key>.2` for the second, and so on. ' +
        'Host keys are scanned from this host; for a server it cannot reach, --known-hosts names an ' +
        'absolute path to known_hosts lines to pin instead. Targets set here may resolve to private addresses.',
      args: [
        { name: 'group', type: 'string', required: true, description: 'Agent group id.' },
        { name: 'key', type: 'string', required: true, description: 'Key name.' },
        { name: 'targets', type: 'string', required: true, description: 'user@host[,user@host…]' },
        { name: 'known_hosts', type: 'string', description: 'Absolute path to known_hosts lines to pin.' },
      ],
      examples: [
        'ncl deploy-keys set-target --group <id> --key app --targets deploy@192.0.2.10,deploy@192.0.2.11',
        'ncl deploy-keys set-target --group <id> --key ops --targets "root@192.0.2.1,ops@198.51.100.7 via root@192.0.2.1" --known-hosts /root/ops-known-hosts',
      ],
      handler: async (args) => {
        const g = await requireGroup(args.group);
        const knownHosts = args.known_hosts !== undefined ? readKnownHostsFile(String(args.known_hosts)) : undefined;
        const { setDeployKeyTarget } = await import('./keys.js');
        await setDeployKeyTarget(g.id, String(args.key), String(args.targets), 'install', { knownHosts });
        const key = (await listingFor(g.id)).find((k) => k.name === String(args.key))!;
        return { agentGroupId: g.id, folder: g.folder, keys: [key] } satisfies GroupListing;
      },
      formatHuman: (data) => formatListing([data as GroupListing]),
    },
    migrate: {
      access: 'open',
      hostOnly: true,
      description:
        'Move private keys out of agent folders into the host store.\n\n' +
        'Finds private keys in agent folders (skipping dependency trees and fixtures), imports each ' +
        'with its target when the agent’s .ssh/config names one (or, for a key NanoClaw made, its comment), marks every ' +
        'one exposed (rotate it in Admin), backs the originals up to a 0600 tarball in the store, and ' +
        'removes them from the folder. --dry-run lists what would move. --group moves one agent’s keys. ' +
        '--trust-targets records the targets found as an install admin’s, so a name that resolves to a ' +
        'private address stays reachable. --targets (with --group) gives targets per key, by the name the ' +
        'dry run shows, as a JSON object; they are recorded as an install admin’s.',
      args: [
        { name: 'dry_run', type: 'boolean', description: 'List what would move; change nothing.', default: false },
        { name: 'group', type: 'string', description: 'Only this agent group (id).' },
        {
          name: 'trust_targets',
          type: 'boolean',
          description: 'Record found targets as set by an install admin.',
          default: false,
        },
        {
          name: 'targets',
          type: 'json',
          description: 'Targets per key: {"<key name>": "user@host,user@host"}.',
        },
      ],
      examples: [
        'ncl deploy-keys migrate --dry-run',
        'ncl deploy-keys migrate --group <id> --dry-run',
        'ncl deploy-keys migrate --group <id> --targets \'{"app":"deploy@192.0.2.10,deploy@192.0.2.11"}\'',
        'ncl deploy-keys migrate --trust-targets',
      ],
      handler: async (args) => {
        const dryRun = args.dry_run === true;
        const group = args.group !== undefined ? (await requireGroup(args.group)).id : undefined;
        const targets = checkGivenTargets(args.targets);
        dryRunShown = dryRun;
        const r = await migrateKeys({ dryRun, trustTargets: args.trust_targets === true, group, targets });
        if (!dryRun) {
          const { refreshAfterMigration } = await import('./keys.js');
          for (const p of r.plans) await refreshAfterMigration(p.agentGroupId);
        }
        return r;
      },
      formatHuman: (data) => formatPlan(data as MigrationResult, dryRunShown),
    },
  },
});
