/**
 * `ncl machines …` — an agent's own machines. Group-scoped: inside a
 * container the agent group always comes from the caller, never from an
 * argument, so an agent can see and touch only machines it created. Create,
 * resize and delete cost money or destroy data, so they are held for an
 * owner's approval card (and on the never-auto-approve list).
 */
import { registerResource } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { GROUP_SCOPE_RESOURCES } from '../../cli/registry.js';
import { checkCreate, createMachine, deleteMachine, resizeMachine, startMachine, stopMachine } from './control.js';
import { listMachines, listSites, putSite } from './store.js';
import type { Machine } from './types.js';

// An agent's own machines are its own business: scoped to its group like tasks.
GROUP_SCOPE_RESOURCES.add('machines');

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

/** What a machine looks like to its agent: no backend handle, no internal ids. */
const view = (m: Machine) => ({
  name: m.name,
  site: m.siteId,
  size: m.size,
  state: m.state,
  ip: m.privateIp,
  ssh: m.state === 'running' ? `ssh machine-${m.name}` : null,
  expires: m.expiresAt ? new Date(m.expiresAt).toISOString().slice(0, 10) : null,
  error: m.lastError,
});

function table(rows: ReturnType<typeof view>[]): string {
  if (!rows.length) return 'No machines.';
  return rows
    .map((r) => `${r.name}  ${r.state}  ${r.site}/${r.size}  ${r.ip ?? '-'}  expires ${r.expires ?? '-'}${r.ssh ? `  (${r.ssh})` : ''}${r.error ? `  error: ${r.error}` : ''}`)
    .join('\n');
}

const GROUP_ARG = { name: 'group', type: 'string' as const, description: 'Agent group id (host only; inside a container it is always your own).' };
const NAME_ARG = { name: 'name', type: 'string' as const, description: 'Machine name.', required: true };

registerResource({
  name: 'machine',
  plural: 'machines',
  table: 'machines',
  description: 'Your own VMs, built by NanoClaw on an approved site. Connect with `ssh machine-<name>` once running.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'Your machines: state, site and size, address, expiry and the ssh command.',
      args: [GROUP_ARG],
      handler: async (args, ctx) => (await listMachines({ agentGroupId: groupOf(args, ctx) })).map(view),
      formatHuman: (rows) => table(rows as ReturnType<typeof view>[]),
    },
    sites: {
      access: 'open',
      description: 'Where machines can be built, the sizes on offer, and how many you may have.',
      args: [GROUP_ARG],
      handler: async (args, ctx) => {
        const group = groupOf(args, ctx);
        const mine = await listMachines({ agentGroupId: group });
        return (await listSites())
          .filter((s) => s.enabled)
          .map((s) => ({
            site: s.id,
            label: s.label,
            sizes: Object.fromEntries(Object.entries(s.sizes).map(([k, v]) => [k, `${v.vcpu} vCPU / ${v.memoryGb} GB`])),
            yours: mine.filter((m) => m.siteId === s.id).length,
            limit: s.perAgentCap,
            dailyStop: s.autoStopAt,
          }));
      },
    },
    check: {
      access: 'open',
      description: 'Check a create would be accepted (size, site, limits) before asking for approval.',
      args: [GROUP_ARG, NAME_ARG, { name: 'size', type: 'string', description: 'A size from `ncl machines sites`.', required: true }, { name: 'site', type: 'string', description: 'Site id; optional when there is only one.' }],
      handler: async (args, ctx) => {
        const { site, spec } = await checkCreate(groupOf(args, ctx), {
          name: str(args.name, 'name'),
          size: str(args.size, 'size'),
          site: args.site ? String(args.site) : undefined,
        });
        return { ok: true, site: site.id, size: spec.sizeName };
      },
    },
    create: {
      access: 'approval',
      description:
        'Build a machine (needs an owner approval). Run `ncl machines check` first. It boots with Docker, and you reach it with `ssh machine-<name>`.',
      args: [
        GROUP_ARG,
        NAME_ARG,
        { name: 'size', type: 'string', description: 'A size from `ncl machines sites`.', required: true },
        { name: 'site', type: 'string', description: 'Site id; optional when there is only one.' },
        { name: 'days', type: 'number', description: 'Days until it expires and stops (default 30).' },
        { name: 'reason', type: 'string', description: 'What it is for — shown on the approval card.', required: true },
      ],
      handler: async (args, ctx) =>
        view(
          await createMachine(
            groupOf(args, ctx),
            {
              name: str(args.name, 'name'),
              size: str(args.size, 'size'),
              site: args.site ? String(args.site) : undefined,
              days: args.days === undefined ? undefined : Math.min(Math.max(Number(args.days), 1), 90),
            },
            ctx.caller === 'agent' ? `agent:${ctx.agentGroupId}` : 'host',
          ),
        ),
    },
    start: {
      access: 'open',
      description: 'Start one of your stopped machines.',
      args: [GROUP_ARG, NAME_ARG],
      handler: async (args, ctx) => view(await startMachine(groupOf(args, ctx), str(args.name, 'name'))),
    },
    stop: {
      access: 'open',
      description: 'Stop one of your machines (its disk is kept; start it again later).',
      args: [GROUP_ARG, NAME_ARG],
      handler: async (args, ctx) => view(await stopMachine(groupOf(args, ctx), str(args.name, 'name'))),
    },
    resize: {
      access: 'approval',
      description: 'Move a machine to another size (needs an owner approval).',
      args: [GROUP_ARG, NAME_ARG, { name: 'size', type: 'string', description: 'A size from `ncl machines sites`.', required: true }],
      handler: async (args, ctx) =>
        view(await resizeMachine(groupOf(args, ctx), str(args.name, 'name'), str(args.size, 'size'))),
    },
    delete: {
      access: 'approval',
      description: 'Delete a machine and its disk (needs an owner approval). Cannot be undone.',
      args: [GROUP_ARG, NAME_ARG],
      handler: async (args, ctx) => view(await deleteMachine(groupOf(args, ctx), str(args.name, 'name'))),
    },
    'site-set': {
      access: 'open',
      hostOnly: true,
      description: 'Create or replace a site (host only).',
      args: [
        { name: 'id', type: 'string', description: 'Site id.', required: true },
        { name: 'backend', type: 'string', description: 'fake | azure | proxmox', required: true },
        { name: 'label', type: 'string', description: 'Shown to agents.', required: true },
        { name: 'sizes', type: 'json', description: '{"small":{"vcpu":2,"memoryGb":8,"backendSize":"…"}}', required: true },
        { name: 'config', type: 'json', description: 'Backend settings (never a credential).' },
        { name: 'per_agent_cap', type: 'number', description: 'Default 2.' },
        { name: 'install_cap', type: 'number', description: 'Default 6.' },
        { name: 'auto_stop_at', type: 'string', description: 'HH:MM daily stop, host local time.' },
        { name: 'enabled', type: 'boolean', description: 'Default true.' },
      ],
      handler: async (args) =>
        putSite({
          id: str(args.id, 'id'),
          backend: str(args.backend, 'backend'),
          label: str(args.label, 'label'),
          sizes: (args.sizes ?? {}) as never,
          config: (args.config ?? {}) as Record<string, unknown>,
          perAgentCap: args.per_agent_cap === undefined ? 2 : Number(args.per_agent_cap),
          installCap: args.install_cap === undefined ? 6 : Number(args.install_cap),
          autoStopAt: args.auto_stop_at ? String(args.auto_stop_at) : null,
          enabled: args.enabled !== false,
        }),
    },
  },
});
