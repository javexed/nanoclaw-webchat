/**
 * The control plane: the rules around a machine's life. Callers are the CLI
 * (`ncl machines …`, approval-gated where it costs money or destroys data)
 * and the reconcile loop. Every change is audited.
 *
 * Access for the agent: each machine gets a deploy key (`machine-<name>`),
 * created before the machine so its public half goes into first boot, and
 * pointed at `nanoclaw@<ip>` once the machine reports its address. The
 * deploy-key module then writes the SSH entry, pins the host key, lists it in
 * the agent's memory and tells its running sessions — so `ssh machine-<name>`
 * works with no further step.
 */
import { audit } from '../../audit.js';
import { INSTALL_SLUG } from '../../config.js';
import { log } from '../../log.js';
import { createDeployKey, deleteDeployKey, listDeployKeys } from '../deploy-keys/index.js';
import { driverFor } from './drivers/index.js';
import { findMachine, getSite, insertMachine, listMachines, listSites, updateMachine } from './store.js';
import type { Machine, MachineSpec, Site } from './types.js';

export const MACHINE_NAME_RE = /^[a-z][a-z0-9-]{0,28}[a-z0-9]$/;
const DEFAULT_EXPIRY_DAYS = 30;

export const keyNameFor = (machineName: string): string => `machine-${machineName}`;

const actor = (agentGroupId: string): string => `agent:${agentGroupId}`;

/** First boot, the same on every backend: login user, Docker, earlyoom. */
export function cloudInit(publicKey: string): string {
  return [
    '#cloud-config',
    'users:',
    '  - name: nanoclaw',
    '    groups: [docker]',
    '    shell: /bin/bash',
    '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
    '    ssh_authorized_keys:',
    `      - ${publicKey.trim()}`,
    'ssh_pwauth: false',
    'package_update: true',
    'packages: [docker.io, docker-compose-v2, earlyoom]',
    'runcmd:',
    '  - systemctl enable --now docker earlyoom',
    // A runaway container is killed in seconds instead of thrashing the box.
    '  - touch /var/lib/cloud/instance/nanoclaw-ready',
    '',
  ].join('\n');
}

/** Resolve the site for a request: the named one, else the only enabled one. */
async function pickSite(siteId?: string): Promise<Site> {
  if (siteId) {
    const s = await getSite(siteId);
    if (!s || !s.enabled) throw new Error(`no enabled site "${siteId}"`);
    return s;
  }
  const sites = (await listSites()).filter((s) => s.enabled);
  if (sites.length === 1) return sites[0];
  if (!sites.length) throw new Error('no machine sites are set up on this install');
  throw new Error(`more than one site: pass --site (${sites.map((s) => s.id).join(', ')})`);
}

/** Every rule a create must pass, checked without changing anything. */
export async function checkCreate(
  agentGroupId: string,
  req: { name: string; size: string; site?: string },
): Promise<{ site: Site; spec: Omit<MachineSpec, 'machineId' | 'cloudInit'> }> {
  if (!MACHINE_NAME_RE.test(req.name))
    throw new Error('name must be 2–30 lowercase letters, digits and hyphens, starting with a letter');
  const site = await pickSite(req.site);
  const size = site.sizes[req.size];
  if (!size) throw new Error(`no size "${req.size}" on ${site.id}: ${Object.keys(site.sizes).join(', ')}`);
  if (await findMachine(agentGroupId, req.name)) throw new Error(`you already have a machine named "${req.name}"`);
  const live = (await listMachines()).filter((m) => m.siteId === site.id);
  const mine = live.filter((m) => m.agentGroupId === agentGroupId);
  if (mine.length >= site.perAgentCap)
    throw new Error(`you have ${mine.length} machines on ${site.id}; the limit per agent is ${site.perAgentCap}`);
  if (live.length >= site.installCap) throw new Error(`${site.id} is at its limit of ${site.installCap} machines`);
  const spec = {
    name: req.name,
    sizeName: req.size,
    size,
    agentGroupId,
    tags: { 'nanoclaw-install': INSTALL_SLUG, 'nanoclaw-agent': agentGroupId, 'nanoclaw-machine': req.name },
  };
  const v = await driverFor(site.backend).validate(site, { ...spec, machineId: 'check', cloudInit: '' });
  if (!v.ok) throw new Error(v.reason);
  return { site, spec };
}

export async function createMachine(
  agentGroupId: string,
  req: { name: string; size: string; site?: string; days?: number },
  createdBy: string | null,
): Promise<Machine> {
  const { site, spec } = await checkCreate(agentGroupId, req);
  const days = req.days ?? DEFAULT_EXPIRY_DAYS;
  const m = await insertMachine({
    agentGroupId,
    siteId: site.id,
    name: req.name,
    size: req.size,
    expiresAt: Date.now() + days * 86_400_000,
    createdBy,
  });
  try {
    const keyName = keyNameFor(m.name);
    const existing = (await listDeployKeys(agentGroupId)).find((k) => k.name === keyName);
    const key = existing ?? (await createDeployKey(agentGroupId, keyName));
    const { handle } = await driverFor(site.backend).create(
      site,
      { ...spec, machineId: m.id, cloudInit: cloudInit(key.publicKey) },
      m.opId,
    );
    const out = await updateMachine(m.id, { handle });
    audit({ type: 'machine.create', actor: actor(agentGroupId), effect: 'allow', detail: { machine: m.id, site: site.id, size: req.size } });
    return out;
  } catch (err) {
    const out = await updateMachine(m.id, { state: 'failed', lastError: String(err).slice(0, 500) });
    audit({ type: 'machine.create', actor: actor(agentGroupId), effect: 'failed', detail: { machine: m.id, site: site.id } });
    log.warn('Machine create failed', { machineId: m.id, err: String(err) });
    return out;
  }
}

async function ownMachine(agentGroupId: string, name: string): Promise<{ m: Machine; site: Site }> {
  const m = await findMachine(agentGroupId, name);
  if (!m) throw new Error(`you have no machine named "${name}"`);
  const site = await getSite(m.siteId);
  if (!site) throw new Error(`site ${m.siteId} no longer exists`);
  return { m, site };
}

export async function startMachine(agentGroupId: string, name: string): Promise<Machine> {
  const { m, site } = await ownMachine(agentGroupId, name);
  if (m.state === 'running') return m;
  if (m.state !== 'stopped' || !m.handle) throw new Error(`"${name}" is ${m.state}; only a stopped machine can start`);
  await driverFor(site.backend).start(site, m.handle);
  audit({ type: 'machine.start', actor: actor(agentGroupId), effect: 'allow', detail: { machine: m.id } });
  return updateMachine(m.id, { state: 'running', lastError: null });
}

export async function stopMachine(agentGroupId: string, name: string, reason = 'requested'): Promise<Machine> {
  const { m, site } = await ownMachine(agentGroupId, name);
  if (m.state === 'stopped') return m;
  if (m.state !== 'running' || !m.handle) throw new Error(`"${name}" is ${m.state}; only a running machine can stop`);
  await driverFor(site.backend).stop(site, m.handle);
  audit({
    type: reason === 'requested' ? 'machine.stop' : 'machine.autostop',
    actor: actor(agentGroupId),
    effect: 'allow',
    reason,
    detail: { machine: m.id },
  });
  return updateMachine(m.id, { state: 'stopped' });
}

export async function resizeMachine(agentGroupId: string, name: string, size: string): Promise<Machine> {
  const { m, site } = await ownMachine(agentGroupId, name);
  const def = site.sizes[size];
  if (!def) throw new Error(`no size "${size}" on ${site.id}: ${Object.keys(site.sizes).join(', ')}`);
  if (!m.handle || (m.state !== 'running' && m.state !== 'stopped')) throw new Error(`"${name}" is ${m.state}`);
  await driverFor(site.backend).resize(site, m.handle, def);
  audit({ type: 'machine.resize', actor: actor(agentGroupId), effect: 'allow', detail: { machine: m.id, size } });
  return updateMachine(m.id, { size });
}

export async function deleteMachine(agentGroupId: string, name: string): Promise<Machine> {
  const { m, site } = await ownMachine(agentGroupId, name);
  await updateMachine(m.id, { state: 'deleting' });
  try {
    if (m.handle) await driverFor(site.backend).delete(site, m.handle);
  } catch (err) {
    audit({ type: 'machine.delete', actor: actor(agentGroupId), effect: 'failed', detail: { machine: m.id } });
    return updateMachine(m.id, { state: 'failed', lastError: String(err).slice(0, 500) });
  }
  await deleteDeployKey(agentGroupId, keyNameFor(m.name)).catch(() => false);
  audit({ type: 'machine.delete', actor: actor(agentGroupId), effect: 'allow', detail: { machine: m.id } });
  return updateMachine(m.id, { state: 'deleted', privateIp: null });
}
