/**
 * Models on another machine for agents behind the egress filter: which
 * endpoints get a relay, on which port, and which agents dial it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createHash } from 'crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  lockdown: false,
  egress: {} as Record<string, string | null>,
  models: [] as Array<{ kind: string; endpoint: string | null }>,
}));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get EGRESS_LOCKDOWN() {
    return state.lockdown;
  },
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: async (id: string) => (id in state.egress ? { egress: state.egress[id] } : undefined),
}));
vi.mock('./db.js', () => ({ listWebchatModels: async () => state.models }));

import {
  _resetRelayPortsForTest,
  agentModelUrl,
  isLoopbackHost,
  modelRelaysFor,
  remoteModelTarget,
} from './model-relay.js';

const LAN = { kind: 'ollama', endpoint: 'http://192.0.2.9:11434' };
const LAN2 = { kind: 'ollama', endpoint: 'http://192.0.2.10:11434' };
const LOCAL = { kind: 'ollama', endpoint: 'http://127.0.0.1:11434' };

beforeEach(() => {
  state.lockdown = false;
  state.egress = {};
  state.models = [LAN, LAN2, LOCAL];
  _resetRelayPortsForTest();
});

describe('which models are relayed', () => {
  it('a plain-HTTP model on another machine, not a host-local one nor one over TLS', () => {
    expect(remoteModelTarget('http://192.0.2.9:11434/v1')).toEqual({ host: '192.0.2.9', port: 11434 });
    expect(remoteModelTarget('http://gpubox')).toEqual({ host: 'gpubox', port: 80 });
    for (const local of ['http://127.0.0.1:11434', 'http://localhost:4000/v1', 'http://host.docker.internal:11434'])
      expect(remoteModelTarget(local)).toBeNull();
    expect(remoteModelTarget('https://llm.example.org/v1')).toBeNull();
    expect(remoteModelTarget(null)).toBeNull();
  });

  it('loopback in any spelling is host-local, never relayed', () => {
    for (const local of [
      'http://[::1]:11434',
      'http://127.0.0.2:11434',
      'http://127.255.255.254:4000/v1',
      'http://[::ffff:127.0.0.1]:11434',
      'http://[0:0:0:0:0:0:0:1]:11434',
      'http://0.0.0.0:11434',
      'http://LOCALHOST:11434',
      'http://ollama.localhost:11434',
    ])
      expect(remoteModelTarget(local)).toBeNull();
    for (const h of ['::1', '[::1]', '127.0.0.1', '127.9.9.9', '::ffff:127.0.0.3', 'localhost', 'host.docker.internal'])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of [
      '128.0.0.1',
      '192.0.2.9',
      '::2',
      '[fe80::1]',
      'gpubox',
      '::ffff:192.0.2.9',
      'localhost.example.com',
    ])
      expect(isLoopbackHost(h)).toBe(false);
  });

  it('a host-local model on [::1] keeps its port from the relays', () => {
    _resetRelayPortsForTest();
    const [alone] = modelRelaysFor([LAN]);
    _resetRelayPortsForTest();
    const [beside] = modelRelaysFor([{ kind: 'ollama', endpoint: `http://[::1]:${alone.port}` }, LAN]);
    expect(beside.port).not.toBe(alone.port);
  });

  it('one port per model host, stable whatever the registry order, never a host-local model port', () => {
    const relays = modelRelaysFor([LAN, LOCAL, LAN2, { ...LAN, endpoint: 'http://192.0.2.9:11434/v1' }]);
    expect(relays.map((r) => r.target)).toEqual([
      { host: '192.0.2.10', port: 11434 },
      { host: '192.0.2.9', port: 11434 },
    ]);
    expect(new Set(relays.map((r) => r.port)).size).toBe(2);
    for (const r of relays) expect(r.port).not.toBe(11434);
    expect(modelRelaysFor([LAN2, LAN])).toEqual(relays);
    // Anthropic-kind models have no endpoint to relay.
    expect(modelRelaysFor([{ kind: 'anthropic', endpoint: null }])).toEqual([]);
  });
});

describe('relay ports stay put', () => {
  const slot = (key: string): number => createHash('sha256').update(key).digest().readUInt32BE(0) % 800;
  /** Two model hosts whose ports collide, the second sorting before the first. */
  function collidingHosts(): [string, string] {
    const first = '192.0.2.200';
    for (let a = 0; a < 256; a++)
      for (let b = 0; b < 256; b++) {
        const h = `10.0.${a}.${b}`;
        if (h < first && slot(`${h}:11434`) === slot(`${first}:11434`)) return [first, h];
      }
    throw new Error('no colliding host found');
  }
  const model = (host: string, created_at: number) => ({
    kind: 'ollama',
    endpoint: `http://${host}:11434`,
    created_at,
  });
  const portOf = (relays: Array<{ port: number; target: { host: string } }>, host: string): number | undefined =>
    relays.find((r) => r.target.host === host)?.port;

  it('a host added later never takes the port of one already registered', () => {
    const [old, added] = collidingHosts();
    const before = portOf(modelRelaysFor([model(old, 1)]), old);
    _resetRelayPortsForTest(); // as after a restart: only the registry decides
    const after = modelRelaysFor([model(old, 1), model(added, 2)]);
    expect(portOf(after, old)).toBe(before);
    expect(portOf(after, added)).not.toBe(before);
  });

  it('a host keeps its port when the one it collided with is removed', () => {
    const [old, added] = collidingHosts();
    const port = portOf(modelRelaysFor([model(old, 1), model(added, 2)]), added);
    expect(portOf(modelRelaysFor([model(added, 2)]), added)).toBe(port);
  });

  it('…and keeps it across a restart, from the recorded ports', () => {
    const [old, added] = collidingHosts();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ports-'));
    const file = path.join(dir, 'relay-ports.json');
    try {
      _resetRelayPortsForTest(file);
      const port = portOf(modelRelaysFor([model(old, 1), model(added, 2)]), added);
      modelRelaysFor([model(added, 2)]); // the host it collided with is removed
      _resetRelayPortsForTest(file); // central restarts: memory gone, the record stays
      expect(portOf(modelRelaysFor([model(added, 2)]), added)).toBe(port);
      // Without the record, the hash alone would have moved it back.
      _resetRelayPortsForTest();
      expect(portOf(modelRelaysFor([model(added, 2)]), added)).not.toBe(port);
      // A removed host is forgotten, so its port is free again.
      _resetRelayPortsForTest(file);
      modelRelaysFor([]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a damaged record falls back to the hash, never to a port outside the relay range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ports-'));
    const file = path.join(dir, 'relay-ports.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ '192.0.2.9:11434': 22 }));
      _resetRelayPortsForTest(file);
      const port = portOf(modelRelaysFor([LAN]), '192.0.2.9')!;
      expect(port).toBeGreaterThanOrEqual(47100);
      fs.writeFileSync(file, '{not json');
      _resetRelayPortsForTest(file);
      expect(portOf(modelRelaysFor([LAN]), '192.0.2.9')).toBe(port);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the model URL an agent dials', () => {
  it('behind the egress filter (the unset default), a model on another machine goes through its relay', async () => {
    const port = modelRelaysFor(state.models).find((r) => r.target.host === '192.0.2.9')!.port;
    expect(await agentModelUrl('ag-new', 'http://192.0.2.9:11434/v1')).toBe(`http://host.docker.internal:${port}/v1`);
    state.egress['ag-model-only'] = 'none';
    expect(await agentModelUrl('ag-model-only', 'http://192.0.2.9:11434')).toBe(`http://host.docker.internal:${port}`);
  });

  it('an Open agent dials it directly — unless the install-wide lockdown puts it behind the filter too', async () => {
    state.egress['ag-open'] = 'open';
    expect(await agentModelUrl('ag-open', 'http://192.0.2.9:11434/v1')).toBe('http://192.0.2.9:11434/v1');
    state.lockdown = true;
    expect(await agentModelUrl('ag-open', 'http://192.0.2.9:11434/v1')).toMatch(/^http:\/\/host\.docker\.internal:/);
  });

  it('a host-local model, and a model the registry does not know, keep their URL', async () => {
    expect(await agentModelUrl('ag-new', 'http://host.docker.internal:11434/v1')).toBe(
      'http://host.docker.internal:11434/v1',
    );
    expect(await agentModelUrl('ag-new', 'http://10.0.0.5:8000/v1')).toBe('http://10.0.0.5:8000/v1');
  });
});
