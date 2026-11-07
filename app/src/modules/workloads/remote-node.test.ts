/**
 * Workloads on a worker: every docker step goes to the workload's node over
 * its link, with the Compose files it needs; images reach it only from
 * central's own Docker (shipImage).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-remote-wl-'));
const calls: Array<{ node: string; op: string; payload: Record<string, unknown> }> = [];
let reply: (op: string, payload: Record<string, unknown>) => unknown = () => ({ code: 0, stdout: '', stderr: '' });
const local: string[][] = [];

// Central's own Docker: only `image inspect` is asked here.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (e: null, r: { stdout: string; stderr: string }) => void,
  ) => {
    local.push(args);
    cb(null, { stdout: 'sha256:aaaa\n', stderr: '' });
  },
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: tmp,
  INSTALL_SLUG: 'test',
}));
vi.mock('../machines/links.js', () => ({
  callWorker: async (node: string, op: string, payload: Record<string, unknown>) => {
    calls.push({ node, op, payload });
    return reply(op, payload);
  },
  openWorkerStream: () => {
    throw new Error('nothing should be sent');
  },
}));

const {
  compose,
  dockerOn,
  ensureNetwork,
  foreignIndexes,
  projectName,
  removeWorkloadFiles,
  shipImage,
  sizeWorkerSlice,
  workDir,
} = await import('./docker.js');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  calls.length = 0;
  local.length = 0;
  reply = () => ({ code: 0, stdout: '', stderr: '' });
});

const w = { id: 'w-1', agentGroupId: 'ag-12345678', name: 'demo', node: 'm-abcdef01' } as never;

describe('docker on a worker', () => {
  it('runs Compose there with the files, by their plain names, in the workload folder', async () => {
    fs.mkdirSync(workDir('w-1'), { recursive: true });
    fs.writeFileSync(path.join(workDir('w-1'), 'stack.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(workDir('w-1'), 'override.yml'), 'x: 1\n');
    reply = () => ({ code: 0, stdout: 'up', stderr: '' });
    expect(await compose(w, ['up', '-d'])).toBe('up');
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.node).toBe('m-abcdef01');
    expect(c.op).toBe('docker');
    expect(c.payload.args).toEqual([
      'compose',
      '-p',
      projectName(w),
      '-f',
      'stack.yml',
      '-f',
      'override.yml',
      'up',
      '-d',
    ]);
    expect(local).toEqual([]);
    expect(c.payload.dir).toBe('w-1');
    // Sent as JSON, which Compose reads as YAML and the worker checks with built-ins.
    expect(c.payload.files).toEqual({
      'stack.yml': JSON.stringify({ services: {} }, null, 2),
      'override.yml': JSON.stringify({ x: 1 }, null, 2),
    });
  });

  it('turns a failed command into an error carrying its output', async () => {
    reply = () => ({ code: 1, stdout: '', stderr: 'no such image' });
    await expect(dockerOn('m-abcdef01', ['image', 'inspect', 'x'])).rejects.toThrow(/no such image/);
  });

  it('creates the workload network on the worker, after checking its subnets there', async () => {
    reply = (_op, p) => {
      const a = p.args as string[];
      if (a[0] === 'network' && a[1] === 'ls') return { code: 0, stdout: 'bridge\nnc-wl-test-0\n', stderr: '' };
      if (a[0] === 'network' && a[1] === 'inspect' && a.includes('bridge'))
        return { code: 0, stdout: '198.18.0.0/24 ', stderr: '' };
      if (a[0] === 'network' && a[1] === 'inspect') return { code: 1, stdout: '', stderr: 'not found' };
      return { code: 0, stdout: '', stderr: '' };
    };
    expect([...(await foreignIndexes('m-abcdef01'))]).toEqual([0]);
    calls.length = 0;
    await ensureNetwork(1, 'm-abcdef01');
    expect(calls.map((c) => (c.payload.args as string[]).slice(0, 2).join(' '))).toEqual([
      'network inspect',
      'network create',
    ]);
    expect(calls[1].payload.args).toContain('198.18.1.0/24');
  });

  it("sizes the worker's slice to NanoClaw's share, and removes the workload's folder there", async () => {
    await sizeWorkerSlice('m-abcdef01', { memMb: 3200, cpus: 0.4 });
    expect(calls[0]).toMatchObject({
      op: 'slice',
      payload: { name: 'nanoclaw-wl-test.slice', memoryMb: 3200, cpus: 0.4 },
    });
    await removeWorkloadFiles({ id: 'w-1', node: 'm-abcdef01' });
    expect(calls[1]).toMatchObject({ op: 'rmdir', payload: { dir: 'w-1' } });
    expect(fs.existsSync(workDir('w-1'))).toBe(false);
  });

  it('sends nothing when the tag there already holds the same image', async () => {
    reply = (op) => (op === 'hasImage' ? 'sha256:aaaa' : null);
    await shipImage('m-abcdef01', 'nc-test-12345678-demo-web:pulled');
    expect(calls.map((c) => c.op)).toEqual(['hasImage']);
    expect(local).toEqual([['image', 'inspect', '--format', '{{.Id}}', 'nc-test-12345678-demo-web:pulled']]);
  });

  it('sends the image when the tag there holds another one', async () => {
    reply = (op) => (op === 'hasImage' ? 'sha256:bbbb' : null);
    await expect(shipImage('m-abcdef01', 'nc-test-12345678-demo-web:pulled')).rejects.toThrow(/nothing should be sent/);
  });
});
