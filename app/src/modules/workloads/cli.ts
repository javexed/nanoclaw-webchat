/**
 * `ncl workloads …` — an agent's own Compose stacks. Group-scoped: inside a
 * container the agent group always comes from the caller. `up` (a first
 * deploy, a new shape, or more resources), `delete` (removes data),
 * `restore` (replaces data) and `extend` (keeps it running longer) wait for
 * an owner's card; `redeploy` within the approved size and shape (and an
 * `up` without --publish that changes nothing approved), and everything that
 * only looks or restarts, runs at once.
 *
 * The approval verbs declare a precheck (cli/registry.ts): the stack is
 * checked before any card is made, the card says in words what will run, and
 * the values it showed (Compose hash, digests, Dockerfile and build-arg
 * hashes) are pinned into the approved arguments, so the handler refuses if
 * anything changed before the owner said yes.
 *
 * `up --publish <route>` deploys AND publishes on one card: the card shows
 * what runs and where people open it, and pins both (the deploy's hashes, and
 * the route, rule, app name, address and ticket expose pins). On approve the
 * publish is planned again before anything runs, then the stack is deployed,
 * then published through exposeApp, exactly as `expose` would.
 */
import { randomUUID } from 'crypto';

import { audit } from '../../audit.js';
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
  DEFAULT_DAYS,
  downWorkload,
  execWorkload,
  extendWorkload,
  logsWorkload,
  psWorkload,
  redeployWorkload,
  restoreWorkload,
  startWorkload,
  stopWorkload,
  upWorkload,
  withinApproval,
} from './control.js';
import { diskUsed, gb } from './disk.js';
import { egressOf } from './egress.js';
import { workloadEgressRefusals } from '../../channels/webchat/workload-egress-refusals.js';
import { isLinked } from '../machines/links.js';
import { getMember, isolationStatus, listMembers, setWorkloadsOn } from '../machines/members.js';
import {
  accessCardLines,
  accessPin,
  exposeApp,
  openLine,
  pickRoute,
  planAccess,
  planExpose,
  publishTarget,
  routesOf,
  routeView,
  unexposeApp,
  whoText,
  type ExposeInput,
} from './publish.js';
import { dayText } from './notify.js';
import { isRouteKind, ROUTE_KIND_WORDS } from './gateway/publishing.js';
import { describeShape, decodeApproved } from './shape.js';
import { sleepAfterH } from './sleep.js';
import {
  buildRegistries,
  findWorkload,
  listWorkloads,
  quotaFor,
  setBuildRegistries,
  setPin,
  setQuota,
  updateWorkload,
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
  state: w.state === 'stopped' && w.asleepAt !== null ? 'asleep' : w.state,
  sleeps_after: sleepAfterH(w) > 0 ? `${sleepAfterH(w)} h idle` : 'never',
  // Private to the agent's own network: reachable from its container, never by a person.
  services_private: w.addresses,
  ...(open ? { open } : {}),
  memoryMb: w.memoryMb,
  cpus: w.cpus,
  approved: `${w.approvedMemoryMb} MB / ${w.approvedCpus} CPUs`,
  expires: w.expiresAt ? new Date(w.expiresAt).toISOString().slice(0, 10) : null,
  error: w.lastError,
});

/** A workload's runtime egress, as approved, and its recent refusals (newest first). */
export function egressView(w: Workload): Record<string, unknown> {
  const refused = workloadEgressRefusals(w.agentGroupId, w.id).slice(0, 20);
  return {
    egress: egressOf(w),
    egress_refused: refused.map((r) => ({
      at: new Date(r.at).toISOString().slice(0, 16).replace('T', ' '),
      service: r.service,
      target: `${r.host}:${r.port}`,
      reason: r.reason,
    })),
  };
}

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
    hostname: args.hostname === undefined ? undefined : String(args.hostname),
  };
}

/** The publish half of `up --publish`, from its args; null without --publish. */
function upPublishInput(args: Record<string, unknown>):
  | (Omit<ExposeInput, 'service' | 'port'> & {
      service?: string;
      port?: number;
    })
  | null {
  if (args.publish === undefined) return null;
  const route = str(args.publish, 'publish');
  return {
    name: str(args.name, 'name'),
    route,
    service: args.service === undefined ? undefined : str(args.service, 'service'),
    port: args.port === undefined ? undefined : Number(args.port),
    app: args.app === undefined ? undefined : String(args.app),
    who: args.who === undefined ? undefined : String(args.who),
    emails: args.emails === undefined ? undefined : String(args.emails),
    hostname: args.hostname === undefined ? undefined : String(args.hostname),
  };
}

/** Publish flags without --publish are a mistake, not a deploy-only: say so before any card. */
const PUBLISH_ONLY = ['who', 'emails', 'service', 'port', 'app'] as const;

/** When --publish names a route that is off: the refusal points to the owner's switch and to deploying only. */
const deployOnly = (err: unknown): Error =>
  new Error(
    `${(err as Error).message}. Or deploy without --publish now, and publish later with \`ncl workloads expose\`.`,
  );

/** A published app as a deploy that published it reports it: where, for whom, and whether it is live. */
async function publishedView(r: Awaited<ReturnType<typeof exposeApp>>): Promise<Record<string, unknown>> {
  const v = await routeView(r);
  return { ...v, open_for: whoText({ who: r.who, emails: r.emails }) };
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
          where: r.placement.node === 'local' ? `central (${r.placement.reason})` : r.placement.reason,
          ...(r.translated.length ? { translated: r.translated } : {}),
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
        'Deploy a stack for the first time, or with new images, Dockerfiles or more memory/CPU than approved (needs an owner approval). An unchanged stack without --publish redeploys at once. Run `ncl workloads check` first. With --publish, the same card also publishes it for people (see `expose`): prefer this for an app people will open.',
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
        {
          name: 'publish',
          type: 'string',
          description: `Also publish it for people, on this route: ${ROUTE_KIND_WORDS} (one card for both).`,
        },
        {
          name: 'who',
          type: 'string',
          description:
            'With --publish: who can open it, agent-members (default: everyone who may use this agent), only-me, signed-in, or specific (cloudflare only, with --emails).',
        },
        {
          name: 'emails',
          type: 'string',
          description: 'With --who specific: the email addresses of the people who may open it, comma-separated.',
        },
        {
          name: 'service',
          type: 'string',
          description: 'With --publish: the service people open (default: the one that declares an `expose:` port).',
        },
        {
          name: 'port',
          type: 'number',
          description: 'With --publish: the port it listens on (default: its first `expose:` port).',
        },
        {
          name: 'app',
          type: 'string',
          description: 'With --publish: the app’s name in its address (default: the workload’s name).',
        },
        { name: 'approved', type: 'string', description: 'Set by NanoClaw on the approval card; leave out.' },
        { name: 'hostname', type: 'string', description: 'Set by NanoClaw on the approval card; leave out.' },
        { name: 'ticket', type: 'string', description: 'Set by NanoClaw on the approval card; leave out.' },
      ],
      precheck: async (args, ctx) => {
        const name = str(args.name, 'name');
        str(args.reason, 'reason');
        const pub = upPublishInput(args);
        if (!pub) {
          const stray = PUBLISH_ONLY.filter((k) => args[k] !== undefined);
          if (stray.length)
            throw new Error(`--${stray.join(', --')} go${stray.length === 1 ? 'es' : ''} with --publish`);
        }
        const g = groupOf(args, ctx);
        if (pub && !isRouteKind(pub.route)) throw new Error(`--publish must be ${ROUTE_KIND_WORDS}`);
        // The route first: with it off there is nothing to card, and the agent hears how to deploy only.
        const route = pub ? await pickRoute(pub.route).catch((err: unknown) => Promise.reject(deployOnly(err))) : null;
        const c = await checkWorkload(g, name, str(args.file, 'file'));
        // Nothing here needs an owner: redeploy now and answer with the result,
        // with no card. redeploy runs its own checks again (shape, size, builds),
        // so this does nothing \`ncl workloads redeploy\` would not. --publish
        // always needs its card, so it never takes this path.
        if (!pub && (await withinApproval(g, c)))
          return { done: { ...view(await redeployWorkload(g, name, str(args.file, 'file'))), redeployed: true } };
        const size = (mb: number, cpus: number): string => `${gbText(mb)} memory, ${cpus} CPU`;
        const now = size(c.stack.total.memoryMb, c.stack.total.cpus);
        const was = c.existing ? size(c.existing.approvedMemoryMb, c.existing.approvedCpus) : null;
        const runs = [
          'Runs:',
          ...describeShape(c.shape, decodeApproved(c.existing?.approvedShape ?? null)),
          `Size: ${was && was !== now ? `${was} → ${now}` : now}`,
          ...(c.existing
            ? []
            : [`Where: ${c.placement.node === 'local' ? `central — ${c.placement.reason}` : c.placement.reason}`]),
          ...(c.translated.length ? ['Translated:', ...c.translated.map((n) => `• ${n}`)] : []),
        ];
        const verb = c.existing ? 'update' : 'deploy';
        if (!pub || !route)
          return {
            title: `${c.existing ? 'Update' : 'Deploy'} workload ${name}`,
            summary: `{agent} wants to ${verb} the workload ${quoteForCard(name)}.\nWhy: ${cardReason(args.reason)}`,
            detail: runs.join('\n'),
            pin: { approved: approvalPin(c) },
          };
        const target = publishTarget(c.stack.compose.services, pub.service, pub.port);
        const p = await planAccess(route, name, c.existing?.id ?? null, pub);
        const access = accessPin(p, randomUUID());
        // up names the route --publish; the rest is what expose pins.
        delete access.route;
        return {
          title: `${c.existing ? 'Update' : 'Deploy'} and publish ${p.app}`,
          summary: `{agent} wants to ${verb} the workload ${quoteForCard(name)} and publish it on ${p.route.label} for ${whoText(p)}.\nWhy: ${cardReason(args.reason)}`,
          detail: [...runs, ...accessCardLines(p, `service ${quoteForCard(target.service)}, port ${target.port}`)].join(
            '\n',
          ),
          pin: {
            approved: approvalPin(c),
            publish: p.route.kind,
            service: target.service,
            port: target.port,
            ...access,
          },
        };
      },
      handler: async (args, ctx) => {
        const g = groupOf(args, ctx);
        const name = str(args.name, 'name');
        const agent = ctx.caller === 'agent';
        const pub = upPublishInput(args);
        // An agent's publish only runs from a card, which pins all of it.
        if (pub && agent && (!/^[0-9a-f-]{36}$/.test(String(args.ticket ?? '')) || !pub.hostname || !pub.service))
          throw new Error('up --publish runs from an approval card');
        if (pub) {
          // Planned again BEFORE the deploy: a route switched off, a name taken or a new address since the card
          // refuses the whole of it, and nothing runs.
          const existing = await findWorkload(g, name);
          await planAccess(await pickRoute(pub.route), name, existing?.id ?? null, pub);
        }
        const w = await upWorkload(
          g,
          name,
          str(args.file, 'file'),
          agent ? `agent:${ctx.agentGroupId}` : 'host',
          // An agent's up only runs from a card, which always pins.
          agent ? String(args.approved ?? '') : (args.approved as string | undefined),
        );
        if (!pub || w.state !== 'running') return view(w);
        // The stack is the one the card pinned (upWorkload refused any other), so is its service.
        const input: ExposeInput = { ...pub, ...publishTarget(w.stack.compose.services, pub.service, pub.port) };
        try {
          const r = await exposeApp(g, input, {
            userId: null,
            ticket: agent ? String(args.ticket) : null,
            createdBy: agent ? `agent:${ctx.agentGroupId}` : 'host',
          });
          return { ...view(w), published: await publishedView(r) };
        } catch (err) {
          return { ...view(w), published: { error: String((err as Error).message ?? err) } };
        }
      },
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
    status: {
      access: 'open',
      description:
        'One workload: its state, what each service may call at runtime (x-nanoclaw-egress, as approved) and what it was refused lately.',
      args: [GROUP, NAME],
      handler: async (args, ctx) => {
        const g = groupOf(args, ctx);
        const name = str(args.name, 'name');
        const w = await findWorkload(g, name);
        if (!w) throw new Error(`you have no workload named "${name}"`);
        return { ...view(w, await openLine(w)), ...egressView(w) };
      },
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
    sleep: {
      access: 'open',
      description:
        'After how many idle hours a workload sleeps (stops until its next request wakes it). --after 0: never; for stacks that work in the background (a job worker, a scheduled sync).',
      args: [
        GROUP,
        NAME,
        {
          name: 'after',
          type: 'string',
          description: 'Idle hours before sleeping; 0 = never; "default" = the default.',
          required: true,
        },
      ],
      handler: async (args, ctx) => {
        const group = groupOf(args, ctx);
        const name = str(args.name, 'name');
        const w = await findWorkload(group, name);
        if (!w) throw new Error(`you have no workload named "${name}"`);
        const raw = String(args.after).trim();
        const hours = raw === 'default' ? null : Number(raw);
        if (hours !== null && (!Number.isInteger(hours) || hours < 0 || hours > 24 * 90))
          throw new Error('--after is whole hours from 0 (never) to 2160, or "default"');
        return view(await updateWorkload(w.id, { sleepAfterH: hours }));
      },
    },
    start: {
      access: 'open',
      description: 'Start a stopped workload (its approved images and Dockerfiles only; a sleeping one wakes).',
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
    extend: {
      access: 'approval',
      description: `Keep a workload running for ${DEFAULT_DAYS} days from today, past its expiry (needs an owner approval; an admin can also extend it in Agent → Apps).`,
      args: [GROUP, NAME],
      precheck: async (args, ctx) => {
        const w = await findWorkload(groupOf(args, ctx), str(args.name, 'name'));
        if (!w) throw new Error(`you have no workload named "${String(args.name)}"`);
        if (w.expiresAt === null) throw new Error(`${w.name} does not expire`);
        const to = Math.max(w.expiresAt, Date.now() + DEFAULT_DAYS * 86_400_000);
        // Less than a day to gain is not worth a card.
        if (to - w.expiresAt < 86_400_000) throw new Error(`${w.name} already runs until ${dayText(w.expiresAt)}`);
        return {
          title: `Extend workload ${w.name}`,
          summary: `{agent} wants to keep the workload ${quoteForCard(w.name)} running for ${DEFAULT_DAYS} more days.`,
          detail: `Expires: ${dayText(w.expiresAt)} → ${dayText(to)}. Nothing else changes.`,
        };
      },
      handler: async (args, ctx) =>
        view(
          await extendWorkload(
            groupOf(args, ctx),
            str(args.name, 'name'),
            ctx.caller === 'agent' ? `agent:${ctx.agentGroupId}` : 'host',
          ),
        ),
    },
    expose: {
      access: 'approval',
      description:
        'Publish a service of a workload for people at its own address, on a publishing route an owner turned on (needs an owner approval). --who: agent-members (default: everyone who may use this agent), only-me or signed-in; on cloudflare also specific, with --emails.',
      args: [
        GROUP,
        NAME,
        { ...SERVICE, required: true },
        { name: 'port', type: 'number', description: 'The port the service listens on.', required: true },
        { name: 'app', type: 'string', description: 'The app’s name in its address (default: the workload’s name).' },
        { name: 'route', type: 'string', description: `${ROUTE_KIND_WORDS} (default: the one that is on).` },
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
        { name: 'hostname', type: 'string', description: 'Set by NanoClaw on the approval card; leave out.' },
        { name: 'ticket', type: 'string', description: 'Set by NanoClaw on the approval card; leave out.' },
      ],
      precheck: async (args, ctx) => {
        str(args.reason, 'reason');
        const p = await planExpose(groupOf(args, ctx), exposeInput(args));
        return {
          title: `Publish ${p.app}`,
          summary: `{agent} wants to publish ${quoteForCard(p.app)} on ${p.route.label} for ${whoText(p)}.\nWhy: ${cardReason(args.reason)}`,
          detail: accessCardLines(
            p,
            `${quoteForCard(p.workload.name)} service ${quoteForCard(String(args.service))}, port ${p.target.split(':')[1]}`,
          ).join('\n'),
          // The route, rule and address the card shows, and the ticket that makes the approver its "only me".
          pin: accessPin(p, randomUUID()),
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
    pin: {
      access: 'open',
      hostOnly: true,
      description:
        "Keep an agent's new workloads on one node (a worker machine's id, or `local` for central); `--node none` removes the pin (host only). A pin to a worker counts even with its Run workloads here off, never while its isolation check fails.",
      args: [
        { name: 'group', type: 'string', description: 'Agent group id.', required: true },
        { name: 'node', type: 'string', required: true, description: 'Machine id (m-…), `local`, or `none`.' },
      ],
      handler: async (args) => {
        const group = str(args.group, 'group');
        const node = str(args.node, 'node');
        if (node !== 'none' && node !== 'local' && !/^m-[0-9a-f]{8}$/.test(node))
          throw new Error('node must be a machine id (m-…), local, or none');
        await setPin(group, node === 'none' ? null : node, 'host');
        audit({ type: 'workload.pin', actor: 'host', effect: 'allow', detail: { agentGroupId: group, node } });
        return { ok: true, group, node };
      },
    },
    workers: {
      access: 'open',
      hostOnly: true,
      description:
        'Worker machines and workloads (host only): whether each runs workloads, its isolation check, and the stacks on it.',
      args: [],
      handler: async () => {
        const now = Date.now();
        const all = await listWorkloads();
        return (await listMembers())
          .filter((m) => m.role === 'worker' && m.state !== 'revoked')
          .map((m) => ({
            id: m.id,
            name: m.name,
            runsWorkloads: m.workloadsOn,
            linked: isLinked(m.id),
            isolation: isolationStatus(m, now),
            checkedAt: m.isolationAt ? new Date(m.isolationAt).toISOString() : null,
            stacks: all
              .filter((w) => w.node === m.id)
              .map((w) => `${w.name} (${w.state}${w.lastError ? `: ${w.lastError}` : ''})`),
          }));
      },
      formatHuman: (rows) =>
        (rows as Array<Record<string, unknown>>).length
          ? (rows as Array<Record<string, unknown>>)
              .map(
                (r) =>
                  `${String(r.name)} (${String(r.id)})  workloads ${r.runsWorkloads ? 'on' : 'off'}  ${r.linked ? 'linked' : 'not linked'}  isolation ${String(r.isolation)}${(r.stacks as string[]).length ? `\n  ${(r.stacks as string[]).join('\n  ')}` : ''}`,
              )
              .join('\n')
          : 'No workers.',
    },
    'worker-set': {
      access: 'open',
      hostOnly: true,
      description:
        'Turn "Run workloads here" on or off for a worker machine (host only). New stacks go only to workers with it on, or to the worker an agent is pinned to, and only while its isolation check passes.',
      args: [
        { name: 'id', type: 'string', description: 'Machine id (m-…).', required: true },
        { name: 'workloads', type: 'string', description: 'on | off', required: true },
      ],
      handler: async (args) => {
        const id = str(args.id, 'id');
        const v = str(args.workloads, 'workloads');
        if (v !== 'on' && v !== 'off') throw new Error('--workloads must be on or off');
        const m = await getMember(id);
        if (!m || m.role !== 'worker' || m.state === 'revoked') throw new Error(`no worker ${id}`);
        await setWorkloadsOn(id, v === 'on');
        audit({ type: 'machine.workloads', actor: 'host', effect: 'allow', detail: { machineId: id, on: v === 'on' } });
        return { id, name: m.name, runsWorkloads: v === 'on', isolation: isolationStatus(m) };
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
            'Host patterns as a JSON array, e.g. ["registry-1.docker.io","auth.docker.io","production.cloudflare.docker.com","production.cloudfront.docker.com"].',
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
