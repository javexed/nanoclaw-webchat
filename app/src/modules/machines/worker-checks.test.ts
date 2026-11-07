/**
 * What a worker checks itself, whatever central sends (M1 of the scaling
 * review): the Compose files, the shape of a network it creates, and the
 * names an image archive would load under.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildOverride } from '../workloads/override.js';
import { refuseArchive, refuseComposeFiles, refuseNetworkCreate, LOADABLE } from './worker-main.js';

const project = 'nc-2e60-abc-demo';

function files(stack: unknown, override?: unknown): Record<string, string> {
  const o =
    override ??
    buildOverride(Object.keys((stack as { services: object }).services), {
      project,
      network: 'nc-wl-2e60-3',
      slice: 'nanoclaw-wl-2e60.slice',
      labels: { 'nanoclaw.install': '2e60', 'nanoclaw.agent': 'abc', 'nanoclaw.workload': 'w1' },
      addresses: { web: '198.18.3.10', db: '198.18.3.11' },
    });
  return { 'stack.yml': JSON.stringify(stack), 'override.yml': JSON.stringify(o) };
}

const good = {
  services: {
    web: {
      image: `${project}-web:built`,
      environment: { A: '1' },
      volumes: ['data:/var/lib/app', { type: 'tmpfs', target: '/tmp' }],
      cap_add: ['CHOWN', 'SETUID'],
      labels: { 'org.example.app': 'x' },
      deploy: { resources: { limits: { memory: '256m' } } },
    },
    db: { image: `${project}-db:pulled`, volumes: [{ type: 'volume', source: 'pg', target: '/pg' }] },
  },
  volumes: { data: null, pg: { driver: 'local' } },
};

const svc = (patch: Record<string, unknown>) => ({
  ...good,
  services: { ...good.services, web: { ...good.services.web, ...patch } },
});

describe('the Compose files a worker runs', () => {
  it("accepts what central writes: a checked stack and NanoClaw's override", () => {
    expect(refuseComposeFiles(files(good), project)).toBeNull();
  });

  it('refuses anything that reaches past the container', () => {
    const cases: Array<[string, unknown]> = [
      ['privileged', svc({ privileged: true })],
      ['host mount', svc({ volumes: ['/:/host'] })],
      ['relative mount', svc({ volumes: ['./x:/x'] })],
      ['bind mount', svc({ volumes: [{ type: 'bind', source: '/etc', target: '/x' }] })],
      ['unknown volume', svc({ volumes: ['other:/x'] })],
      ['host network', svc({ network_mode: 'host' })],
      ['host pid', svc({ pid: 'host' })],
      ['devices', svc({ devices: ['/dev/sda:/dev/sda'] })],
      ['gpu devices', svc({ deploy: { resources: { reservations: { devices: [{ capabilities: ['gpu'] }] } } } })],
      ['cap_add', svc({ cap_add: ['SYS_ADMIN'] })],
      ['cap_add prefixed', svc({ cap_add: ['CAP_NET_ADMIN'] })],
      ['security_opt', svc({ security_opt: ['seccomp=unconfined'] })],
      ['cgroup_parent', svc({ cgroup_parent: '/' })],
      ['reserved label', svc({ labels: { 'nanoclaw.workload': 'other' } })],
      ['compose label', svc({ labels: ['com.docker.compose.project=x'] })],
      ['build', svc({ build: '.' })],
      ['foreign image', svc({ image: 'alpine:3' })],
      ['another stack image', svc({ image: 'nc-2e60-abc-other-web:built' })],
      ['volume driver_opts', { ...good, volumes: { data: { driver: 'local', driver_opts: { o: 'bind' } } } }],
      ['external volume', { ...good, volumes: { data: { external: true } } }],
      ['top-level key', { ...good, networks: { x: {} } }],
    ];
    for (const [why, stack] of cases) expect(refuseComposeFiles(files(stack), project), why).not.toBeNull();
  });

  it("refuses an override that is not NanoClaw's", () => {
    const base = JSON.parse(files(good)['override.yml']) as {
      name: string;
      networks: { nanoclaw: Record<string, unknown> };
      services: Record<string, Record<string, unknown>>;
    };
    const tweak = (f: (o: typeof base) => void) => {
      const o = structuredClone(base);
      f(o);
      return files(good, o);
    };
    const cases: Array<[string, Record<string, string>]> = [
      ['caps kept', tweak((o) => (o.services.web.cap_drop = []))],
      ['no no-new-privileges', tweak((o) => (o.services.web.security_opt = []))],
      ['other cgroup', tweak((o) => (o.services.web.cgroup_parent = 'system.slice'))],
      ['gateway address', tweak((o) => (o.services.web.networks = { nanoclaw: { ipv4_address: '198.18.3.1' } }))],
      ['outside the range', tweak((o) => (o.services.web.networks = { nanoclaw: { ipv4_address: '10.0.0.5' } }))],
      ['not external', tweak((o) => (o.networks.nanoclaw = { name: 'nc-wl-2e60-3' }))],
      ['host network', tweak((o) => (o.networks.nanoclaw = { external: true, name: 'host' }))],
      ['extra key', tweak((o) => (o.services.web.privileged = true))],
      ['other project', tweak((o) => (o.name = 'nc-2e60-abc-other'))],
      ['missing service', tweak((o) => delete o.services.db)],
      ['foreign label', tweak((o) => (o.services.web.labels = { 'com.docker.compose.project': 'x' }))],
    ];
    for (const [why, f] of cases) expect(refuseComposeFiles(f, project), why).not.toBeNull();
  });

  it('needs both files, as JSON, for a NanoClaw project', () => {
    const f = files(good);
    expect(refuseComposeFiles({ 'stack.yml': f['stack.yml'] }, project)).toMatch(/override.yml is missing/);
    expect(refuseComposeFiles({ ...f, 'stack.yml': 'services:\n  web: {}\n' }, project)).toMatch(/JSON/);
    expect(refuseComposeFiles(f, 'evil')).not.toBeNull();
  });
});

describe('the networks a worker creates', () => {
  const args = (over: Partial<Record<number, string>> = {}) => {
    const a = [
      'network',
      'create',
      '--internal',
      '--subnet',
      '198.19.4.0/24',
      '--gateway',
      '198.19.4.1',
      '--ip-range',
      '198.19.4.128/25',
      '-o',
      'com.docker.network.bridge.name=ncw1a2b3c4',
      '--label',
      'nanoclaw-workloads=2e60',
      'nc-wl-2e60-260',
    ];
    for (const [i, v] of Object.entries(over)) a[Number(i)] = v as string;
    return a;
  };
  it('only an internal workload network, in its exact shape', () => {
    expect(refuseNetworkCreate(args())).toBeNull();
    for (const over of [
      { 2: '--attachable' },
      { 4: '10.0.0.0/24' },
      { 4: '198.18.4.0/16' },
      { 6: '198.19.4.2' },
      { 8: '198.19.4.0/24' },
      { 10: 'parent=eth0' },
      { 10: 'com.docker.network.bridge.name=docker0' },
      { 12: 'other=1' },
      { 13: 'bridge' },
    ])
      expect(refuseNetworkCreate(args(over)), JSON.stringify(over)).not.toBeNull();
    expect(refuseNetworkCreate([...args(), '-d', 'macvlan'])).not.toBeNull();
  });
});

describe('the images a worker loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-archive-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A docker-save-shaped tar with these metadata files. */
  function archive(name: string, meta: Record<string, unknown>): string {
    const root = path.join(dir, `${name}-src`);
    fs.mkdirSync(path.join(root, 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'blobs', 'layer'), 'x'.repeat(1500));
    for (const [f, v] of Object.entries(meta)) fs.writeFileSync(path.join(root, f), JSON.stringify(v));
    const file = path.join(dir, `${name}.tar`);
    execFileSync('tar', ['-cf', file, '-C', root, 'blobs', ...Object.keys(meta)]);
    return file;
  }

  it('takes only names NanoClaw owns', () => {
    for (const ok of [
      'nc-2e60-abc-demo-web:built',
      'nc-2e60-abc-demo-db:pulled',
      'nanoclaw-workload-helper:2e0b81d60597f449',
    ])
      expect(LOADABLE.test(ok)).toBe(true);
    for (const bad of ['nginx:latest', 'postgres:16', 'nc-x:latest', 'registry.example.com/nc-x:built'])
      expect(LOADABLE.test(bad)).toBe(false);
  });

  it('loads an archive only when every name in it is the one asked for', () => {
    const image = 'nc-2e60-abc-demo-web:built';
    const ok = archive('ok', {
      'manifest.json': [{ RepoTags: [image] }],
      'index.json': { manifests: [{ annotations: { 'io.containerd.image.name': `docker.io/library/${image}` } }] },
    });
    expect(refuseArchive(ok, image)).toBeNull();
    const extra = archive('extra', { 'manifest.json': [{ RepoTags: [image] }, { RepoTags: ['nginx:latest'] }] });
    expect(refuseArchive(extra, image)).toMatch(/nginx:latest/);
    const legacy = archive('legacy', {
      'manifest.json': [{ RepoTags: [image] }],
      repositories: { postgres: { '16': 'x' } },
    });
    expect(refuseArchive(legacy, image)).toMatch(/postgres:16/);
    const idx = archive('idx', {
      'manifest.json': [{ RepoTags: [image] }],
      'index.json': { manifests: [{ annotations: { 'io.containerd.image.name': 'docker.io/library/redis:7' } }] },
    });
    expect(refuseArchive(idx, image)).toMatch(/redis:7/);
    expect(
      refuseArchive(archive('other', { 'manifest.json': [{ RepoTags: ['nc-2e60-abc-demo-db:pulled'] }] }), image),
    ).not.toBeNull();
    expect(refuseArchive(archive('none', { 'index.json': { manifests: [] } }), image)).toMatch(/manifest/);
    const junk = path.join(dir, 'junk.tar');
    fs.writeFileSync(junk, 'not a tar at all'.repeat(100));
    expect(refuseArchive(junk, image)).not.toBeNull();
  });
});
