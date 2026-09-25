import fs from 'fs';
import os from 'os';
import path from 'path';
import { gunzipSync } from 'zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUNDLE_CHUNK_BYTES,
  RELAY_SENTINEL,
  chunkBundle,
  packTree,
  toRemoteSpec,
  type BundleDoc,
  type TransitRoots,
} from './remote-spec.js';
import { fixtureSpec } from './spec-fixture.js';
import type { ContainerSpec, MountSpec, SessionSpec } from './types.js';

let tmp: string;
let roots: TransitRoots;

function write(rel: string, content: string, mode = 0o644): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
  return p;
}
const mount = (m: Partial<MountSpec> & Pick<MountSpec, 'class' | 'hostPath' | 'containerPath'>): MountSpec => ({
  mode: 'ro',
  groupScope: 'g1',
  ...m,
});
function specWith(
  mounts: MountSpec[],
  env: Record<string, string> = {},
  contributedEnv?: Record<string, string>,
): { spec: SessionSpec; agent: ContainerSpec } {
  const agent: ContainerSpec = {
    role: 'agent',
    image: 'nanoclaw-agent-v2-abc:latest',
    env: { TZ: 'UTC', ...env },
    ...(contributedEnv ? { contributedEnv } : {}),
    command: ['bash', '-c'],
    args: ['exec bun run /app/src/index.ts'],
    labels: { 'session-channel': 'c1' },
    mounts,
  };
  return { spec: fixtureSpec({ containers: [agent] }), agent };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-transit-'));
  roots = {
    dataRoot: path.join(tmp, 'data'),
    groupsRoot: path.join(tmp, 'groups'),
    buildContext: path.join(tmp, 'container'),
  };
  write('container/Dockerfile', 'FROM node:22-slim\n');
  write('container/entrypoint.sh', '#!/bin/sh\n', 0o755);
  write('container/agent-runner/src/index.ts', 'console.log(1)\n');
  write('container/skills/x/SKILL.md', '# x\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('packTree', () => {
  it('bundles a directory as a content-addressed gzip document, skipping symlinks and node_modules', () => {
    write('tree/a.txt', 'A');
    write('tree/sub/b.sh', 'B', 0o755);
    write('tree/node_modules/dep/index.js', 'x');
    fs.symlinkSync(path.join(tmp, 'tree/a.txt'), path.join(tmp, 'tree/link'));
    const b = packTree(path.join(tmp, 'tree'));
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/);
    const doc = JSON.parse(gunzipSync(b.bytes).toString()) as BundleDoc;
    expect(doc.dirs).toEqual(['sub']);
    expect(doc.files.map((f) => [f.p, f.m, Buffer.from(f.d, 'base64').toString()])).toEqual([
      ['a.txt', 0o644, 'A'],
      ['sub/b.sh', 0o755, 'B'],
    ]);
    expect(doc.skipped).toEqual(['link']);
    expect(packTree(path.join(tmp, 'tree')).hash).toBe(b.hash); // deterministic
  });
  it('bundles a single file under its basename', () => {
    const p = write('one.pem', 'CERT');
    const doc = JSON.parse(gunzipSync(packTree(p).bytes).toString()) as BundleDoc;
    expect(doc.files).toEqual([{ p: 'one.pem', m: 0o644, d: Buffer.from('CERT').toString('base64') }]);
  });
  it('chunks under the socket frame cap and reassembles', () => {
    write('big/blob.bin', 'z'.repeat(600 * 1024));
    const b = packTree(path.join(tmp, 'big'));
    const chunks = chunkBundle(b);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) expect(c.data.length).toBeLessThanOrEqual(BUNDLE_CHUNK_BYTES);
    expect(Buffer.from(chunks.map((c) => c.data).join(''), 'base64').equals(b.bytes)).toBe(true);
  });
});

describe('toRemoteSpec', () => {
  it('rewrites every mount class per the transit table and never names a central path', () => {
    const sess = path.join(roots.dataRoot, 'v2-sessions/g1/s1');
    write('data/v2-sessions/g1/s1/inbound.db', 'sqlite');
    const group = path.join(roots.groupsRoot, 'agent-one');
    write('groups/agent-one/CLAUDE.md', '# memory');
    const cfg = write('groups/agent-one/container.json', '{}');
    const src = write('container/agent-runner/src/index.ts', 'console.log(1)\n');
    const ca = write('tmp/onecli-proxy-ca.pem', 'CA');
    const { spec, agent } = specWith([
      mount({ class: 'group-state', hostPath: sess, containerPath: '/workspace', mode: 'rw' }),
      mount({ class: 'group-state', hostPath: group, containerPath: '/workspace/agent', mode: 'rw' }),
      mount({ class: 'group-state', hostPath: cfg, containerPath: '/workspace/agent/container.json' }),
      mount({ class: 'install-surface', hostPath: path.dirname(src), containerPath: '/app/src' }),
      mount({ class: 'allowlisted-extra', hostPath: ca, containerPath: '/tmp/onecli-gateway-ca.pem' }),
      mount({
        class: 'allowlisted-extra',
        hostPath: '/opt/nanoclaw/v2-groups/x',
        containerPath: '/workspace/extra/agent',
        mode: 'rw',
      }),
    ]);
    const out = toRemoteSpec(spec, agent, 'ncl-spike-s1', roots);
    const byPath = Object.fromEntries(out.spec.mounts.map((m) => [m.containerPath, m]));
    expect(byPath['/workspace']).toMatchObject({ kind: 'state', stateId: 'data/v2-sessions/g1/s1' });
    expect((byPath['/workspace'] as { seed?: string }).seed).toMatch(/^[0-9a-f]{64}$/);
    expect(byPath['/workspace/agent']).toMatchObject({ kind: 'state', stateId: 'groups/agent-one' });
    expect(byPath['/workspace/agent/container.json']).toMatchObject({
      kind: 'content',
      class: 'group-state',
      file: true,
    });
    expect(byPath['/app/src']).toMatchObject({ kind: 'content', class: 'install-surface', file: false });
    expect(byPath['/tmp/onecli-gateway-ca.pem']).toMatchObject({
      kind: 'content',
      class: 'allowlisted-extra',
      file: true,
    });
    expect(byPath['/workspace/extra/agent']).toEqual({
      kind: 'slot',
      class: 'allowlisted-extra',
      containerPath: '/workspace/extra/agent',
      mode: 'rw',
    });
    const serialized = JSON.stringify(out.spec);
    expect(serialized).not.toContain(tmp);
    expect(serialized).not.toContain('/opt/nanoclaw');
    // every referenced bundle exists, plus the build context
    for (const m of out.spec.mounts) {
      if (m.kind === 'content') expect(out.bundles.has(m.bundle)).toBe(true);
      if (m.kind === 'state' && m.seed) expect(out.bundles.has(m.seed)).toBe(true);
    }
    expect(out.spec.build?.bundle).toBeDefined();
    expect(out.bundles.has(out.spec.build!.bundle)).toBe(true);
    expect(out.spec.name).toBe('ncl-spike-s1');
    expect(out.spec.network).toBe('default');
  });

  it("central's own read-only directories ship as content; a path it merely points at stays a slot", () => {
    write('data/user-skills/mine/SKILL.md', '# mine');
    write('elsewhere/project/file.txt', 'x');
    const outside = path.join(tmp, 'elsewhere/project');
    const { spec, agent } = specWith([
      // classed 'extra' only because it sits outside the install-surface roots
      mount({
        class: 'allowlisted-extra',
        hostPath: path.join(roots.dataRoot, 'user-skills'),
        containerPath: '/app/user-skills',
      }),
      mount({ class: 'allowlisted-extra', hostPath: outside, containerPath: '/workspace/extra/agent', mode: 'rw' }),
      mount({ class: 'allowlisted-extra', hostPath: outside, containerPath: '/workspace/extra/ro' }),
    ]);
    const out = toRemoteSpec(spec, agent, 'n', roots);
    const byPath = Object.fromEntries(out.spec.mounts.map((m) => [m.containerPath, m]));
    expect(byPath['/app/user-skills']).toMatchObject({ kind: 'content', file: false });
    expect(byPath['/workspace/extra/agent']).toMatchObject({ kind: 'slot', mode: 'rw' });
    // read-only is not enough on its own: central does not own this one
    expect(byPath['/workspace/extra/ro']).toMatchObject({ kind: 'slot', mode: 'ro' });
  });

  it('strips the proxy credential from every proxy variable and keeps it aside for the relay', () => {
    const { spec, agent } = specWith(
      [],
      { HTTPS_PROXY: 'http://x:s3cret-token@host.docker.internal:10255', NODE_USE_ENV_PROXY: '1' },
      {
        HTTP_PROXY: 'http://x:s3cret-token@host.docker.internal:10255',
        https_proxy: 'http://x:s3cret-token@host.docker.internal:10255',
      },
    );
    const out = toRemoteSpec(spec, agent, 'n', roots);
    expect(out.spec.env.HTTPS_PROXY).toBe(RELAY_SENTINEL);
    expect(out.spec.contributedEnv.HTTP_PROXY).toBe(RELAY_SENTINEL);
    expect(out.spec.contributedEnv.https_proxy).toBe(RELAY_SENTINEL);
    expect(out.spec.env.NODE_USE_ENV_PROXY).toBe('1');
    expect(JSON.stringify(out.spec)).not.toContain('s3cret');
    expect(out.proxyTarget).toEqual({
      host: 'host.docker.internal',
      port: 10255,
      username: 'x',
      password: 's3cret-token',
    });
  });

  it('refuses identity material and writable state outside the roots', () => {
    const { spec, agent } = specWith([
      mount({ class: 'identity-material', hostPath: write('k.pem', 'K'), containerPath: '/run/k.pem' }),
    ]);
    expect(() => toRemoteSpec(spec, agent, 'n', roots)).toThrow(/denied-by-policy.*identity material/);
    const outside = specWith([
      mount({
        class: 'group-state',
        hostPath: write('elsewhere/dir/f', 'x') && path.join(tmp, 'elsewhere/dir'),
        containerPath: '/w',
        mode: 'rw',
      }),
    ]);
    expect(() => toRemoteSpec(outside.spec, outside.agent, 'n', roots)).toThrow(/denied-by-policy/);
    const missing = specWith([
      mount({ class: 'install-surface', hostPath: path.join(tmp, 'nope'), containerPath: '/app/src' }),
    ]);
    expect(() => toRemoteSpec(missing.spec, missing.agent, 'n', roots)).toThrow(/spec-invalid.*mount source missing/);
  });

  it('excludes the runtime source and skills from the build context (they travel as install-surface bundles)', () => {
    const { spec, agent } = specWith([]);
    const out = toRemoteSpec(spec, agent, 'n', roots);
    const doc = JSON.parse(gunzipSync(out.bundles.get(out.spec.build!.bundle)!.bytes).toString()) as BundleDoc;
    const paths = doc.files.map((f) => f.p);
    expect(paths).toContain('Dockerfile');
    expect(paths).toContain('entrypoint.sh');
    expect(paths.some((p) => p.startsWith('agent-runner/src/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('skills/'))).toBe(false);
    expect(out.spec.build!.args).toEqual({ IMAGE_SOURCE: 'runner' });
  });
});
