/**
 * The backend is the source of truth for what exists; this loop keeps the
 * records honest. Every minute it checks machines still provisioning (so a
 * booted one becomes usable quickly); every five, all of them, plus orphans,
 * expiry and the daily stop.
 */
import { audit } from '../../audit.js';
import { INSTALL_SLUG } from '../../config.js';
import { log } from '../../log.js';
import { deleteDeployKey, setDeployKeyTarget } from '../deploy-keys/index.js';
import { keyAddedText, keyRemovedText, notifyKeyChange } from '../deploy-keys/notify.js';
import { refreshCredentialNote } from '../tool-secrets/index.js';
import { realOnecliAdmin } from '../user-credentials/onecli-admin.js';
import { keyNameFor, stopMachine } from './control.js';
import { driverFor } from './drivers/index.js';
import { listMachines, listSites, updateMachine } from './store.js';
import type { Machine, Site } from './types.js';

const FULL_EVERY_MS = 5 * 60_000;
let lastFull = 0;
const reportedOrphans = new Set<string>();
const autoStoppedOn = new Map<string, string>();

/** The machine is up: point its key at it, so `ssh machine-<name>` works and the agent hears about it. */
async function becameReady(m: Machine, ip: string): Promise<void> {
  const key = keyNameFor(m.name);
  const target = `nanoclaw@${ip}`;
  try {
    await setDeployKeyTarget(m.agentGroupId, key, target);
    await refreshCredentialNote(realOnecliAdmin, m.agentGroupId);
    await notifyKeyChange(
      m.agentGroupId,
      `${keyAddedText(key, target)} It is your machine "${m.name}" (${m.size}); it shuts down when not in use and expires ${new Date(m.expiresAt ?? 0).toISOString().slice(0, 10)}.`,
    );
  } catch (err) {
    log.warn('Machine ready: key setup failed', { machineId: m.id, err: String(err) });
  }
  audit({ type: 'machine.ready', actor: `agent:${m.agentGroupId}`, effect: 'allow', detail: { machine: m.id } });
}

async function gone(m: Machine): Promise<void> {
  await updateMachine(m.id, { state: 'deleted', privateIp: null, lastError: 'no longer exists on the backend' });
  await deleteDeployKey(m.agentGroupId, keyNameFor(m.name)).catch(() => false);
  await refreshCredentialNote(realOnecliAdmin, m.agentGroupId).catch(() => undefined);
  await notifyKeyChange(m.agentGroupId, keyRemovedText(keyNameFor(m.name)));
  audit({ type: 'machine.gone', actor: `agent:${m.agentGroupId}`, effect: 'failed', detail: { machine: m.id } });
}

export async function reconcileMachine(m: Machine, site: Site): Promise<void> {
  if (!m.handle || m.state === 'deleting') return;
  const obs = await driverFor(site.backend).get(site, m.handle);
  if (obs.state === 'missing') {
    await gone(m);
    return;
  }
  if (obs.state === 'error') {
    if (m.state !== 'failed')
      await updateMachine(m.id, { state: 'failed', lastError: obs.detail ?? 'backend reports an error' });
    return;
  }
  if (m.state === 'provisioning') {
    if (obs.state === 'running' && obs.privateIp) {
      const up = await updateMachine(m.id, { state: 'running', privateIp: obs.privateIp, lastError: null });
      await becameReady(up, obs.privateIp);
    }
    return;
  }
  // Drift: stopped or started outside NanoClaw (a portal, a schedule).
  if ((obs.state === 'running' || obs.state === 'stopped') && obs.state !== m.state && m.state !== 'failed') {
    await updateMachine(m.id, { state: obs.state, privateIp: obs.privateIp ?? m.privateIp });
  } else if (obs.privateIp && obs.privateIp !== m.privateIp) {
    await updateMachine(m.id, { privateIp: obs.privateIp });
  }
}

/** "HH:MM" today in local time has passed, and today's stop has not run yet. */
function dueAutoStop(site: Site, now: Date): boolean {
  if (!site.autoStopAt || !/^\d{2}:\d{2}$/.test(site.autoStopAt)) return false;
  const [h, min] = site.autoStopAt.split(':').map(Number);
  const today = now.toDateString();
  if (autoStoppedOn.get(site.id) === today) return false;
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= min);
}

export async function reconcileAll(now = Date.now()): Promise<void> {
  const full = now - lastFull >= FULL_EVERY_MS;
  if (full) lastFull = now;
  const sites = new Map((await listSites()).map((s) => [s.id, s]));
  const machines = await listMachines();
  for (const m of machines) {
    const site = sites.get(m.siteId);
    if (!site || (!full && m.state !== 'provisioning')) continue;
    try {
      await reconcileMachine(m, site);
    } catch (err) {
      log.warn('Machine reconcile failed', { machineId: m.id, err: String(err) });
    }
  }
  if (!full) return;
  for (const site of sites.values()) {
    if (!site.enabled) continue;
    // Orphans: tagged with this install but unknown here. Reported, never adopted silently.
    try {
      const known = new Set(machines.filter((m) => m.siteId === site.id).map((m) => m.handle));
      for (const o of await driverFor(site.backend).list(site, INSTALL_SLUG)) {
        if (known.has(o.handle) || reportedOrphans.has(o.handle)) continue;
        reportedOrphans.add(o.handle);
        log.warn('Machine on the backend that NanoClaw has no record of', { site: site.id, handle: o.handle });
        audit({ type: 'machine.orphan', effect: 'failed', detail: { site: site.id, handle: o.handle } });
      }
    } catch (err) {
      log.warn('Machine orphan check failed', { site: site.id, err: String(err) });
    }
    const stopAll = dueAutoStop(site, new Date(now));
    if (stopAll) autoStoppedOn.set(site.id, new Date(now).toDateString());
    for (const m of machines.filter((x) => x.siteId === site.id && x.state === 'running')) {
      const expired = m.expiresAt !== null && m.expiresAt <= now;
      if (!expired && !stopAll) continue;
      try {
        await stopMachine(m.agentGroupId, m.name, expired ? 'expired' : 'daily stop');
        if (expired)
          await notifyKeyChange(
            m.agentGroupId,
            `[System] Your machine "${m.name}" passed its expiry date and was stopped. Ask an admin to extend it, or delete it with \`ncl machines delete --name ${m.name}\`.`,
          );
      } catch (err) {
        log.warn('Machine auto-stop failed', { machineId: m.id, err: String(err) });
      }
    }
  }
}

export function __resetReconcileForTest(): void {
  lastFull = 0;
  reportedOrphans.clear();
  autoStoppedOn.clear();
}
