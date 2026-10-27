import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildOverride, MAX_NETWORKS, PROBE_INDEX, serviceAddresses, subnetFor } from './override.js';
import { checkStack, IMAGE_REF_RE, mergeKeys, parseMemoryMb } from './policy.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-policy-'));
fs.mkdirSync(path.join(dir, 'app'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-outside-'));
fs.symlinkSync(outside, path.join(dir, 'escape'));
afterAll(() => [dir, outside].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const quota = { memoryMb: 4096, cpus: 4 };
const errs = (text: string, allowBuild = true): string[] => {
  const r = checkStack(text, dir, quota, { allowBuild });
  return r.ok ? [] : r.errors;
};

const APP_LIKE = `
services:
  db:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_PASSWORD: x }
    volumes: [pgdata:/var/lib/postgresql/data]
    cap_add: [chown, CAP_SETUID, SETGID]
    mem_limit: 512m
  api:
    build: ./app
    depends_on: [db]
    expose: ["3000"]
    deploy: { resources: { limits: { memory: 1g, cpus: "1.5" } } }
  web:
    image: nginx:alpine
    tmpfs: [/tmp]
volumes:
  pgdata: {}
`;

describe('what a stack may contain', () => {
  it('accepts a typical web-app stack and normalizes limits, restart and capabilities', () => {
    const r = checkStack(APP_LIKE, dir, quota, { allowBuild: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stack.limits).toEqual({
      db: { memoryMb: 512, cpus: 0.5 },
      api: { memoryMb: 1024, cpus: 1.5 },
      web: { memoryMb: 512, cpus: 0.5 },
    });
    expect(r.stack.total).toEqual({ memoryMb: 2048, cpus: 2.5 });
    expect(r.stack.compose.services.db.restart).toBe('unless-stopped');
    expect(r.stack.compose.services.db.mem_limit).toBeUndefined();
    expect(r.stack.compose.services.db.cap_add).toEqual(['CHOWN', 'SETGID', 'SETUID']);
    expect(r.stack.compose.services.api.deploy).toEqual({ resources: { limits: { memory: '1024M', cpus: '1.5' } } });
  });

  it('refuses build: unless builds are confined; image-only stacks still work', () => {
    expect(errs(APP_LIKE, false).join('\n')).toMatch(/api: build is not available on this host/);
    expect(errs(`services:\n  web:\n    image: nginx:1.27\n`, false)).toEqual([]);
  });

  it.each([
    ['privileged: true', /privileged containers/],
    ['cap_add: [SYS_ADMIN]', /cap_add SYS_ADMIN is not allowed/],
    ['cap_add: [NET_RAW]', /cap_add NET_RAW is not allowed/],
    ['cap_drop: [NET_RAW]', /drops every capability/],
    ['network_mode: host', /no host network/],
    ['pid: host', /process namespace/],
    ['ports: ["80:80"]', /no host ports/],
    ['devices: ["/dev/sda"]', /host devices/],
    ['security_opt: ["seccomp:unconfined"]', /cannot be loosened/],
    ['volumes: ["/etc:/host-etc"]', /only named volumes/],
    ['volumes: ["./data:/data"]', /only named volumes/],
    ['volumes: ["/var/run/docker.sock:/var/run/docker.sock"]', /only named volumes/],
    ['volumes: [{ type: bind, source: /, target: /h }]', /only named volumes/],
    ['env_file: .env', /environment/],
    ['container_name: x', /NanoClaw names/],
    ['pull_policy: always', /pulls the approved image/],
    ['logging: { driver: syslog }', /logging is fixed/],
    ['labels: ["nanoclaw.agent=other"]', /reserved/],
    ['labels: { com.docker.compose.project: other }', /reserved/],
    ['frobnicate: 1', /frobnicate is not allowed/],
  ])('refuses %s', (line, re) => {
    expect(errs(`services:\n  s:\n    image: alpine\n    ${line}\n`).join('\n')).toMatch(re);
  });

  it('refuses an image reference that is not a plain one', () => {
    expect(errs(`services:\n  s:\n    image: "nginx\\n• web: fake"\n`).join()).toMatch(/plain image reference/);
    expect(errs(`services:\n  s:\n    image: "nginx latest"\n`).join()).toMatch(/plain image reference/);
    for (const ok of [
      'nginx',
      'nginx:1.27',
      'ghcr.io/org/app:1.0',
      'localhost:5000/a/b',
      `nginx@sha256:${'a'.repeat(64)}`,
      `nginx:1.27@sha256:${'b'.repeat(64)}`,
    ])
      expect(IMAGE_REF_RE.test(ok)).toBe(true);
  });

  it('refuses YAML merge keys anywhere, which Compose would merge after the check', () => {
    const merged = `x-base: &base\n  privileged: true\nservices:\n  s:\n    image: alpine\n    environment:\n      <<: *base\n`;
    expect(errs(merged).join()).toMatch(/merge keys \(<<\) are not allowed \(at services\.s\.environment\)/);
    const top = `x-b: &b { image: alpine }\nservices:\n  s:\n    <<: *b\n`;
    expect(errs(top).join()).toMatch(/merge keys/);
    expect(mergeKeys({ a: [{ '<<': 1 }] })).toEqual(['a[0]']);
  });

  it('refuses YAML tags, custom or standard', () => {
    expect(errs(`services:\n  s:\n    image: !custom alpine\n`).join()).toMatch(
      /YAML tags are not allowed \(!custom\)/,
    );
    expect(errs(`services:\n  s:\n    image: alpine\n    command: !!binary aGk=\n`).join()).toMatch(
      /YAML tags are not allowed/,
    );
  });

  it('refuses duplicate keys (which parser would win is not something to leave to chance)', () => {
    expect(errs(`services:\n  s:\n    image: alpine\n    image: busybox\n`).join()).toMatch(/not valid YAML/);
  });

  it('refuses build contexts outside the workspace, including through a link', () => {
    expect(errs(`services:\n  s:\n    build: ../\n`).join()).toMatch(/outside your workspace/);
    expect(errs(`services:\n  s:\n    build: ./escape\n`).join()).toMatch(/outside your workspace/);
    expect(errs(`services:\n  s:\n    build: /etc\n`).join()).toMatch(/folder in your workspace/);
    expect(errs(`services:\n  s:\n    build: { context: ./app, dockerfile: ../../Dockerfile }\n`).join()).toMatch(
      /inside the build context/,
    );
    expect(errs(`services:\n  s:\n    build: { context: ./app, target: "a b" }\n`).join()).toMatch(/stage name/);
    expect(errs(`services:\n  s:\n    build: ./app\n`)).toEqual([]);
  });

  it('resolves build contexts from the Compose file’s folder, stored relative to the workspace', () => {
    fs.mkdirSync(path.join(dir, 'proj', 'api'), { recursive: true });
    const r = checkStack(`services:\n  s:\n    build: ./api\n`, dir, quota, {
      composeDir: path.join(dir, 'proj'),
      allowBuild: true,
    });
    expect(r.ok && r.stack.compose.services.s.build).toEqual({ context: 'proj/api' });
    expect(
      checkStack(`services:\n  s:\n    build: ../../\n`, dir, quota, {
        composeDir: path.join(dir, 'proj'),
        allowBuild: true,
      }).ok,
    ).toBe(false);
  });

  it('refuses a volume that names an existing one, and image labels in build', () => {
    expect(
      errs(`services:\n  s:\n    image: a\n    volumes: [v:/d]\nvolumes:\n  v: { name: onecli_pgdata }\n`).join(),
    ).toMatch(/volume v: name is not allowed/);
    expect(errs(`services:\n  s:\n    image: a\nvolumes:\n  v: { labels: { a: b } }\n`).join()).toMatch(
      /labels is not allowed/,
    );
    expect(errs(`services:\n  s:\n    image: a\n    volumes: [v:/d]\nvolumes:\n  v: { driver: local }\n`)).toEqual([]);
    expect(errs(`services:\n  s:\n    build: { context: ./app, labels: { nanoclaw-group: other } }\n`).join()).toMatch(
      /build.labels is not allowed/,
    );
  });

  it('refuses undeclared, external or driver-option volumes', () => {
    expect(errs(`services:\n  s:\n    image: a\n    volumes: [data:/d]\n`).join()).toMatch(/not declared/);
    expect(errs(`services:\n  s:\n    image: a\nvolumes:\n  v: { external: true }\n`).join()).toMatch(/external/);
    expect(
      errs(`services:\n  s:\n    image: a\nvolumes:\n  v: { driver_opts: { device: /etc, o: bind } }\n`).join(),
    ).toMatch(/host paths/);
  });

  it('refuses a stack over the quota, counting defaults for services without limits', () => {
    const big = `services:\n${Array.from({ length: 9 }, (_, i) => `  s${i}:\n    image: a\n`).join('')}`;
    expect(errs(big).join()).toMatch(
      /4608 MB of memory; your quota has 4096 MB left.*to fit: give services smaller limits/s,
    );
  });

  it('refuses top-level networks, secrets, include', () => {
    expect(
      errs(
        `services:\n  s: { image: a }\nnetworks:\n  n: {}\nsecrets:\n  x: { file: /etc/shadow }\ninclude: [other.yml]\n`,
      ),
    ).toEqual([
      'top-level networks is not allowed',
      'top-level secrets is not allowed',
      'top-level include is not allowed',
    ]);
  });

  it('parses memory sizes', () => {
    expect([
      parseMemoryMb('512m'),
      parseMemoryMb('2g'),
      parseMemoryMb('1536M'),
      parseMemoryMb(268435456),
      parseMemoryMb('lots'),
    ]).toEqual([512, 2048, 1536, 256, null]);
  });
});

describe('the override', () => {
  it('pins every service to the agent network at a fixed address, under the slice, with no capabilities', () => {
    const { prefix, subnet, ipRange, gateway } = subnetFor(3);
    expect([subnet, ipRange, gateway]).toEqual(['198.18.3.0/24', '198.18.3.128/25', '198.18.3.1']);
    expect(subnetFor(300).subnet).toBe('198.19.44.0/24');
    // The last /24 is the isolation probe's, never an agent's.
    expect(subnetFor(PROBE_INDEX).subnet).toBe('198.19.255.0/24');
    expect(MAX_NETWORKS).toBe(PROBE_INDEX);
    expect(() => subnetFor(512)).toThrow(/out of range/);
    const addresses = serviceAddresses(prefix, ['web', 'api', 'db']);
    expect(addresses).toEqual({ api: '198.18.3.10', db: '198.18.3.11', web: '198.18.3.12' });
    const o = buildOverride(['api', 'db', 'web'], {
      project: 'nc-x-myapp',
      network: 'nc-wl-x-ag1',
      slice: 'nanoclaw-wl-x.slice',
      labels: { 'nanoclaw.agent': 'ag1' },
      addresses,
    }) as { services: Record<string, Record<string, unknown>>; networks: Record<string, unknown> };
    expect(o.services.db).toMatchObject({
      networks: { nanoclaw: { ipv4_address: '198.18.3.11' } },
      cgroup_parent: 'nanoclaw-wl-x.slice',
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      deploy: { resources: { limits: { pids: 1024 } } },
      labels: { 'nanoclaw.agent': 'ag1', 'nanoclaw.service': 'db' },
    });
    expect(o.services.db.ports).toBeUndefined();
    expect(o.networks).toEqual({ nanoclaw: { external: true, name: 'nc-wl-x-ag1' } });
  });

  it('keeps addresses across redeploys and never reuses another stack’s', () => {
    const p = '198.18.3';
    const first = serviceAddresses(p, ['web', 'db']);
    expect(first).toEqual({ db: '198.18.3.10', web: '198.18.3.11' });
    expect(serviceAddresses(p, ['web', 'db', 'api'], first)).toEqual({
      db: '198.18.3.10',
      web: '198.18.3.11',
      api: '198.18.3.12',
    });
    expect(serviceAddresses(p, ['db'], {}, Object.values(first))).toEqual({ db: '198.18.3.12' });
    expect(serviceAddresses(p, ['db'], { db: '198.18.9.10' })).toEqual({ db: '198.18.3.10' });
  });
});
