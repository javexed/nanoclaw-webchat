/**
 * `ncl workloads …` — an agent's own Compose stacks. Group-scoped: inside a
 * container the agent group always comes from the caller. `up` (a first
 * deploy, a new shape, or more resources), `delete` (removes data) and
 * `restore` (replaces data) wait for an owner's card; `redeploy` within the
 * approved size and shape, and everything that only looks or restarts, runs
 * at once.
 *
 * The approval verbs declare a precheck (cli/registry.ts): the stack is
 * checked before any card is made, the card says in words what will run, and
 * the values it showed (Compose hash, digests, Dockerfile and build-arg
 * hashes) are pinned into the approved arguments, so the handler refuses if
 * anything changed before the owner said yes.
 */
import { randomUUID } from 'crypto';

import { quoteForCard } from '../../card-text.js';
import { registerResource } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { GROUP_SCOPE_RESOURCES } from '../../cli/registry.js';
import {
  approvalPin,
  backupNow,
  backupsOf,
  checkWorkload,
  deleteWorkload,
  downWorkload,
  execWorkload,
  logsWorkload,
  psWorkload,
  redeployWorkload,
  restoreWorkload,
  startWorkload,
  stopWorkload,
  upWorkload,
} from './control.js';
import { diskUsed, gb } from './disk.js';
import {
  exposeApp,
  openLine,
  planExpose,
  routesOf,
  routeView,
  unexposeApp,
  WHO_WORDS,
  type ExposeInput,
} from './publish.js';
import { describeShape, decodeApproved } from './shape.js';
import {
  buildRegistries,
  findWorkload,
  listWorkloads,
  quotaFor,
  setBuildRegistries,
  setQuota,
  type Workload,
} from './store.js';

// An agent's own stacks are its own business: scoped to its group like tasks.
GROUP_SCOPE_RESOURCES.add('workloads');

function groupOf(args: Record<string, unknown>, ctx: CallerContext): string {
  if (ctx.caller === 'agent') return ctx.agentGroupId;
  const g = String(args.group ?? '').trim();
  if (!g) throw new Error('--group is required from the host');
  return g;
}

const str = (v: unknown, what: string): string => {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`--${what} is required`);
  return s;
};

export const MAX_REASON = 200;

/** The agent's reason on a card: one line, capped, quoted. Pure. */
export function cardReason(v: unknown): string {
  const one = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = one.length > MAX_REASON ? `${one.slice(0, MAX_REASON - 1)}…` : one;
  return quoteForCard(capped);
}

const view = (w: Workload, open?: string) => ({
  name: w.name,
  state: w.state,
  // Private to the agent's own network: reachable from its container, never by a person.
  services_private: w.addresses,
  ...(open ? { open } : {}),
  memoryMb: w.memoryMb,
  cpus: w.cpus,
  approved: `${w.approvedMemoryMb} MB / ${w.approvedCpus} CPUs`,
  expires: w.expiresAt ? new Date(w.expiresAt).toISOString().slice(0, 10) : null,
  error: w.lastError,
});

/** 1536 → "1.5 GB", 512 → "512 MB". */
const gbText = (mb: number): string => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);

function exposeInput(args: Record<string, unknown>): ExposeInput {
  return {
    name: str(args.name, 'name'),
    service: str(args.service, 'service'),
    port: Number(args.port),
    app: args.app === undefined ? undefined : String(args.app),
    route: args.route === undefined ? undefined : String(args.route),
    who: args.who === undefined ? undefined : String(args.who),
    emails: args.emails === undefined ? undefined : String(args.emails),
  };
}

const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;

const GROUP = {
  name: 'group',
  type: 'string' as const,
  description: 'Agent group id (host only; inside a container it is always your own).',
};
const NAME = { name: 'name', type: 'string' as const, description: 'Workload name.', required: true };
const FILE = {
  name: 'file',
  type: 'string' as const,
  description: 'Compose file in your workspace, e.g. compose.yml.',
  required: true,
};
const SERVICE = { name: 'service', type: 'string' as const, description: 'Service name.' };

registerResource({
  name: 'workload',
  plural: 'workloads',
  table: 'workloads',
  description:
    'Your own Compose stacks, run by NanoClaw under you: private network, hard limits, no host access. You reach services at their addresses from your container.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'Your workloads: state, service addresses, size and expiry.',
      args: [GROUP],
      handler: async (args, ctx) =>
        Promise.all(
          (await listWorkloads({ agentGroupId: groupOf(args, ctx) })).map(async (w) => view(w, await openLine(w))),
        ),
    },
    quota: {
      access: 'open',
      description: 'Your memory, CPU and disk quota across all your workloads, and what is left.',
      args: [GROUP],
      handler: async (args, ctx) => {
        const g = groupOf(args, ctx);
        const q = await quotaFor(g);
        const used = (await listWorkloads({ agentGroupId: g })).reduce(
          (a, w) => ({ memoryMb: a.memoryMb + w.approvedMemoryMb, cpus: a.cpus + w.approvedCpus }),
          { memoryMb: 0, cpus: 0 },
        );
        const disk = diskUsed(g);
        return {
          quota: q,
          used: { ...used, diskGb: disk ? gb(disk.bytes) : null },
          left: {
            memoryMb: q.memoryMb - used.memoryMb,
            cpus: q.cpus - used.cpus,
            diskGb: disk ? gb(q.diskGb * 1024 ** 3 - disk.bytes) : null,
          },
          diskMeasured: disk ? new Date(disk.at).toISOString().slice(0, 16).replace('T', ' ') : null,
        };
      },
    },
    check: {
      access: 'open',
      description: 'Check a Compose file against the rules and your quota without running anything.',
      args: [GROUP, NAME, FILE],
      handler: async (args, ctx) => {
        const g = groupOf(args, ctx);
        const name = str(args.name, 'name');
        const existing = await findWorkload(g, name);
        const r = await checkWorkload(g, name, str(args.file, 'file'), decodeApproved(existing?.approvedShape ?? null));
        return {
          ok: true,
          services: Object.keys(r.stack.compose.services),
          limits: r.stack.limits,
          total: r.stack.total,
          replaces: Boolean(r.existing),
          // Whether `redeploy` would run without a card.
          redeploy_needs_card:
            !r.existing ||
            decodeApproved(r.existing.approvedShape)?.hash !== r.shape.hash ||
            r.stack.total.memoryMb > r.existing.approvedMemoryMb ||
            r.stack.total.cpus > r.existing.approvedCpus,
        };
      },
    },
    up: {
      access: 'approval',
      description:
        'Deploy a stack for the first time, or with new images, Dockerfiles or more memory/CPU than approved (needs an owner approval). Run `ncl workloads check` first.',
      args: [
        GROUP,
        NAME,
        FILE,
        {
          name: 'reason',
          type: 'string',
          description: 'What it is for, in one line — shown on the approval card.',
          required: true,
        },
        { name: 'approved', type: 'string', description: 'Set by NanoClaw on the approval card; leave out.' },
      ],
      precheck: async (args, ctx) => {
        const name = str(args.name, 'name');
        str(args.reason, 'reason');
        const c = await checkWorkload(groupOf(args, ctx), name, str(args.file, 'file'));
        const size = (mb: number, cpus: number): string => `${gbText(mb)} memory, ${cpus} CPU`;
        const now = size(c.stack.total.memoryMb, c.stack.total.cpus);
        const was = c.existing ? size(c.existing.approvedMemoryMb, c.existing.approvedCpus) : null;
        return {
          title: `${c.existing ? 'Update' : 'Deploy'} workload ${name}`,
          summary: `{agent} wants to ${c.existing ? 'update' : 'deploy'} the workload ${quoteForCard(name)}.\nWhy: ${cardReason(args.reason)}`,
          detail: [
            'Runs:',
            ...describeShape(c.shape, decodeApproved(c.existing?.approvedShape ?? null)),
            `Size: ${was && was !== now ? `${was} → ${now}` : now}`,
          ].join('\n'),
          pin: { approved: approvalPin(c) },
        };
      },
      handler: async (args, ctx) =>
        view(
          await upWorkload(
            groupOf(args, ctx),
            str(args.name, 'name'),
            str(args.file, 'file'),
            ctx.caller === 'agent' ? `agent:${ctx.agentGroupId}` : 'host',
            // An agent's up only runs from a card, which always pins.
            ctx.caller === 'agent' ? String(args.approved ?? '') : (args.approved as string | undefined),
          ),
        ),
    },
    redeploy: {
      access: 'open',
      description: 'Deploy a changed stack within its approved size and images (no approval needed).',
      args: [GROUP, NAME, FILE],
      handler: async (args, ctx) =>
        view(await redeployWorkload(groupOf(args, ctx), str(args.name, 'name'), str(args.file, 'file'))),
    },
    ps: {
      access: 'open',
      description: 'The services of a workload, their state and address.',
      args: [GROUP, NAME],
      handler: async (args, ctx) => ({
        services_private: await psWorkload(groupOf(args, ctx), str(args.name, 'name')),
      }),
    },
    logs: {
      access: 'open',
      description: 'Recent logs of a workload, or of one service.',
      args: [GROUP, NAME, SERVICE, { name: 'tail', type: 'number', description: 'Lines (default 200, max 2000).' }],
      handler: async (args, ctx) =>
        logsWorkload(
          groupOf(args, ctx),
          str(args.name, 'name'),
          args.service ? String(args.service) : undefined,
          args.tail ? Number(args.tail) : 200,
        ),
    },
    exec: {
      access: 'open',
      description:
        'Run a command in one of your services, e.g. --service db --command \'["psql","-U","app","-c","select 1"]\'.',
      args: [
        GROUP,
        NAME,
        { ...SERVICE, required: true },
        { name: 'command', type: 'json', description: 'The command as a JSON array.', required: true },
      ],
      handler: async (args, ctx) => {
        const cmd = args.command;
        if (!Array.isArray(cmd) || !cmd.every((c) => typeof c === 'string'))
          throw new Error('--command must be a JSON array of strings');
        return execWorkload(groupOf(args, ctx), str(args.name, 'name'), str(args.service, 'service'), cmd as string[]);
      },
    },
    stop: {
      access: 'open',
      description: 'Stop a workload (containers and data kept).',
      args: [GROUP, NAME],
      handler: async (args, ctx) => view(await stopWorkload(groupOf(args, ctx), str(args.name, 'name'))),
    },
    start: {
      access: 'open',
      description: 'Start a stopped workload (its approved images and Dockerfiles only).',
      args: [GROUP, NAME],
      handler: async (args, ctx) => view(await startWorkload(groupOf(args, ctx), str(args.name, 'name'))),
    },
    down: {
      access: 'open',
      description: 'Remove a workload’s containers, keeping its data volumes.',
      args: [GROUP, NAME],
      handler: async (args, ctx) => view(await downWorkload(groupOf(args, ctx), str(args.name, 'name'))),
    },
    delete: {
      access: 'approval',
      description: 'Delete a workload and its data volumes (needs an owner approval). Cannot be undone.',
      args: [GROUP, NAME],
      precheck: async (args, ctx) => {
        const w = await findWorkload(groupOf(args, ctx), str(args.name, 'name'));
        if (!w) throw new Error(`you have no workload named "${String(args.name)}"`);
        const vols = Object.keys(w.stack.compose.volumes ?? {});
        return {
          title: `Delete workload ${w.name}`,
          summary: `{agent} wants to delete the workload ${quoteForCard(w.name)}${vols.length ? ' and its data' : ''}.`,
          detail: `Removes: ${Object.keys(w.stack.compose.services).join(', ')}${vols.length ? `; data: ${vols.join(', ')}` : ''}. This can't be undone.`,
        };
      },
      handler: async (args, ctx) => view(await deleteWorkload(groupOf(args, ctx), str(args.name, 'name'))),
    },
    expose: {
      access: 'approval',
      description:
        'Publish a service of a workload for people at its own address, on a publishing route an owner turned on (needs an owner approval). --who: only-me (default), agent-members or signed-in; on cloudflare also specific, with --emails.',
      args: [
        GROUP,
        NAME,
        { ...SERVICE, required: true },
        { name: 'port', type: 'number', description: 'The port the service listens on.', required: true },
        { name: 'app', type: 'string', description: 'The app’s name in its address (default: the workload’s name).' },
        { name: 'route', type: 'string', description: 'tailnet or cloudflare (default: the one that is on).' },
        {
          name: 'who',
          type: 'string',
          description:
            'Who can open it: only-me, agent-members, signed-in, or specific (cloudflare only, with --emails).',
        },
        {
          name: 'emails',
          type: 'string',
          description: 'For --who specific: the email addresses of the people who may open it, comma-separated.',
        },
        {
          name: 'reason',
          type: 'string',
          description: 'What people will use it for, in one line — shown on the approval card.',
          required: true,
        },
        { name: 'ticket', type: 'string', description: 'Set by NanoClaw on the approval card; leave out.' },
      ],
      precheck: async (args, ctx) => {
        str(args.reason, 'reason');
        const p = await planExpose(groupOf(args, ctx), exposeInput(args));
        const where = p.route.label;
        const whom =
          p.who === 'specific'
            ? `${p.emails.length} named ${p.emails.length === 1 ? 'person' : 'people'}`
            : WHO_WORDS[p.who];
        const was = p.existing
          ? p.existing.who === 'specific'
            ? `${p.existing.emails.length} named`
            : WHO_WORDS[p.existing.who]
          : '';
        return {
          title: `Publish ${p.app}`,
          summary: `{agent} wants to publish ${quoteForCard(p.app)} on ${where} for ${whom}.\nWhy: ${cardReason(args.reason)}`,
          detail: [
            `Address: https://${p.hostname}/`,
            `Serves: ${quoteForCard(p.workload.name)} service ${quoteForCard(String(args.service))}, port ${p.target.split(':')[1]}`,
            `Who can open: ${whom}${p.existing ? ` (was: ${was}${p.existing.kind !== p.route.kind ? `, on ${p.existing.kind}` : ''})` : ''}`,
            ...(p.who === 'specific' ? [`People: ${p.emails.map((e) => quoteForCard(e)).join(', ')}`] : []),
          ].join('\n'),
          // The route and rule the card shows, and the ticket that makes the approver its "only me".
          pin: {
            route: p.route.kind,
            who: p.who,
            app: p.app,
            ...(p.who === 'specific' ? { emails: p.emails.join(',') } : {}),
            ticket: randomUUID(),
          },
        };
      },
      handler: async (args, ctx) => {
        const agent = ctx.caller === 'agent';
        // An agent's expose only runs from a card, which always pins a ticket.
        if (agent && !/^[0-9a-f-]{36}$/.test(String(args.ticket ?? '')))
          throw new Error('expose runs from an approval card');
        const r = await exposeApp(groupOf(args, ctx), exposeInput(args), {
          userId: null,
          ticket: agent ? String(args.ticket) : null,
          createdBy: agent ? `agent:${ctx.agentGroupId}` : 'host',
        });
        return routeView(r);
      },
    },
    unexpose: {
      access: 'open',
      description: 'Stop publishing an app (people can no longer open it; the workload keeps running).',
      args: [
        GROUP,
        { name: 'app', type: 'string', description: 'The app’s name, from `ncl workloads routes`.', required: true },
      ],
      handler: async (args, ctx) => unexposeApp(groupOf(args, ctx), str(args.app, 'app')),
    },
    routes: {
      access: 'open',
      description: 'Your published apps: address, route, who can open them, and whether they are live.',
      args: [GROUP],
      handler: async (args, ctx) => routesOf(groupOf(args, ctx)),
    },
    backups: {
      access: 'open',
      description: 'A workload’s volume backups, newest first (nightly; the newest 3 are kept).',
      args: [GROUP, NAME],
      handler: async (args, ctx) => backupsOf(groupOf(args, ctx), str(args.name, 'name')),
    },
    backup: {
      access: 'open',
      description: 'Back up a workload’s volumes now (it pauses for the copy). Counts toward the 3 kept.',
      args: [GROUP, NAME],
      handler: async (args, ctx) => backupNow(groupOf(args, ctx), str(args.name, 'name')),
    },
    restore: {
      access: 'approval',
      description: 'Replace a workload’s volumes with a backup (needs an owner approval). Current data is lost.',
      args: [
        GROUP,
        NAME,
        {
          name: 'backup',
          type: 'string',
          description: 'The backup stamp, from `ncl workloads backups`.',
          required: true,
        },
      ],
      precheck: async (args, ctx) => {
        const name = str(args.name, 'name');
        const list = await backupsOf(groupOf(args, ctx), name);
        const b = list.find((x) => x.stamp === String(args.backup));
        if (!b) throw new Error(`no backup ${String(args.backup)} of ${name}: see \`ncl workloads backups\``);
        return {
          title: `Restore workload ${name}`,
          summary: `{agent} wants to restore the workload ${quoteForCard(name)} from the backup of ${b.at}.`,
          detail: `Replaces: ${b.volumes.map((v) => v.volume).join(', ')}. The current data is lost.`,
        };
      },
      handler: async (args, ctx) =>
        view(await restoreWorkload(groupOf(args, ctx), str(args.name, 'name'), str(args.backup, 'backup'))),
    },
    'quota-set': {
      access: 'open',
      hostOnly: true,
      description: 'Set an agent’s workload quota (host only).',
      args: [
        { name: 'group', type: 'string', description: 'Agent group id.', required: true },
        { name: 'memory_mb', type: 'number', description: 'Memory across all its workloads.', required: true },
        { name: 'cpus', type: 'number', description: 'CPUs across all its workloads.', required: true },
        { name: 'disk_gb', type: 'number', description: 'Disk across all its volumes.', required: true },
      ],
      handler: async (args) => {
        const q = { memoryMb: Number(args.memory_mb), cpus: Number(args.cpus), diskGb: Number(args.disk_gb) };
        if (![q.memoryMb, q.cpus, q.diskGb].every((n) => Number.isFinite(n) && n >= 0))
          throw new Error('memory_mb, cpus and disk_gb must be numbers ≥ 0');
        await setQuota(String(args.group), q);
        return quotaFor(String(args.group));
      },
    },
    'build-registries': {
      access: 'open',
      hostOnly: true,
      description:
        'Set the registries an agent’s builds may pull base images from, on top of its own egress policy (host only). An empty list removes them.',
      args: [
        { name: 'group', type: 'string', description: 'Agent group id.', required: true },
        {
          name: 'hosts',
          type: 'json',
          description:
            'Host patterns as a JSON array, e.g. ["registry-1.docker.io","auth.docker.io","production.cloudflare.docker.com"].',
          required: true,
        },
      ],
      handler: async (args) => {
        const hosts = args.hosts;
        if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === 'string' && HOST_RE.test(h.toLowerCase())))
          throw new Error('--hosts must be a JSON array of host names (a leading *. is allowed)');
        await setBuildRegistries(String(args.group), [...new Set((hosts as string[]).map((h) => h.toLowerCase()))]);
        return { group: String(args.group), hosts: await buildRegistries(String(args.group)) };
      },
    },
  },
});
