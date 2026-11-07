/**
 * A backend with no cloud behind it: machines are rows in a JSON file under
 * DATA_DIR/machines. It exists so the control plane, the CLI, approvals,
 * caps and reconciliation can be built and tested before any Azure or Proxmox
 * resource does, and so staging can rehearse the whole flow. A new machine is
 * `provisioning` on create and `running` on the next get, like a real boot.
 *
 * Out-of-band changes (someone stops it in a portal, it vanishes) are made by
 * editing the file, which is how the tests exercise reconciliation.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../../config.js';
import type { InboundRules, MachineDriver, Observation, Site } from '../types.js';

interface FakeMachine {
  handle: string;
  opId: string;
  state: Observation['state'];
  privateIp: string;
  sizeName: string;
  tags: Record<string, string>;
  inbound?: InboundRules;
}

const file = (site: Site): string => path.join(DATA_DIR, 'machines', `fake-${site.id}.json`);

function load(site: Site): FakeMachine[] {
  try {
    return JSON.parse(fs.readFileSync(file(site), 'utf8')) as FakeMachine[];
  } catch {
    return [];
  }
}

function save(site: Site, rows: FakeMachine[]): void {
  fs.mkdirSync(path.dirname(file(site)), { recursive: true });
  fs.writeFileSync(file(site), JSON.stringify(rows, null, 2));
}

function find(site: Site, handle: string): { rows: FakeMachine[]; m: FakeMachine | undefined } {
  const rows = load(site);
  return { rows, m: rows.find((r) => r.handle === handle) };
}

export const fakeDriver: MachineDriver = {
  backend: 'fake',
  capabilities: () => ({ nativeAutoShutdown: false, liveResize: false }),

  async validate(site, spec) {
    if (site.config.failValidate) return { ok: false, reason: String(site.config.failValidate) };
    return site.sizes[spec.sizeName] ? { ok: true } : { ok: false, reason: `no size ${spec.sizeName} on ${site.id}` };
  },

  async create(site, spec, opId) {
    const rows = load(site);
    const existing = rows.find((r) => r.opId === opId);
    if (existing) return { handle: existing.handle };
    const n = rows.length + 1;
    const m: FakeMachine = {
      handle: `fake-${spec.machineId}`,
      opId,
      state: 'provisioning',
      privateIp: `10.99.${Math.floor(n / 250)}.${(n % 250) + 2}`,
      sizeName: spec.sizeName,
      tags: spec.tags,
    };
    save(site, [...rows, m]);
    return { handle: m.handle };
  },

  async get(site, handle) {
    const { rows, m } = find(site, handle);
    if (!m) return { handle, state: 'missing', privateIp: null };
    if (m.state === 'provisioning') {
      m.state = 'running';
      save(site, rows);
    }
    return { handle, state: m.state, privateIp: m.privateIp, sizeName: m.sizeName };
  },

  async list(site, installTag) {
    return load(site)
      .filter((m) => m.tags['nanoclaw-install'] === installTag)
      .map((m) => ({ handle: m.handle, state: m.state, privateIp: m.privateIp, sizeName: m.sizeName, tags: m.tags }));
  },

  async start(site, handle) {
    const { rows, m } = find(site, handle);
    if (!m) throw new Error(`no machine ${handle}`);
    m.state = 'running';
    save(site, rows);
  },

  async stop(site, handle) {
    const { rows, m } = find(site, handle);
    if (!m) throw new Error(`no machine ${handle}`);
    m.state = 'stopped';
    save(site, rows);
  },

  async resize(site, handle, size) {
    const { rows, m } = find(site, handle);
    if (!m) throw new Error(`no machine ${handle}`);
    const name = Object.entries(site.sizes).find(([, s]) => s.backendSize === size.backendSize)?.[0];
    m.sizeName = name ?? m.sizeName;
    save(site, rows);
  },

  async delete(site, handle) {
    save(
      site,
      load(site).filter((r) => r.handle !== handle),
    );
  },

  async setInbound(site, handle, rules) {
    const { rows, m } = find(site, handle);
    if (!m) throw new Error(`no machine ${handle}`);
    m.inbound = rules;
    save(site, rows);
  },
};
