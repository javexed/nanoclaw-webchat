/**
 * The view as a container sees it: mounted read-only, the socket usable, no
 * key readable. Needs Docker and a Debian bookworm image with openssh-client
 * (the agent image's base release); skipped without them, never pulled.
 */
import { execFile, execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const IMAGE = process.env.DEPLOY_KEYS_TEST_IMAGE ?? 'node:22-bookworm';
const ROOT = fs.mkdtempSync(path.join('/tmp', 'dkd-'));
vi.mock('../../config.js', () => ({ GROUPS_DIR: path.join(ROOT, 'g'), DATA_DIR: path.join(ROOT, 'd') }));

const store = await import('./store.js');
const { ensureAgent, stopAgent } = await import('./agent.js');
const { syncView, CONTAINER_SSH_DIR } = await import('./view.js');

const ok = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const ready = ok('ssh-agent', ['-h']) || spawnSync('ssh-agent', ['-h']).error === undefined;
const canRun = ready && ok('docker', ['image', 'inspect', IMAGE]);
const G = 'ag-1';

/** docker run, asynchronously: the socket is served by this process. */
async function inContainer(script: string): Promise<{ code: number; out: string }> {
  const args = [
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '-e',
    `SSH_AUTH_SOCK=${CONTAINER_SSH_DIR}/agent.sock`,
    '-v',
    `${store.groupViewDir(G)}:${CONTAINER_SSH_DIR}:ro`,
    '--entrypoint',
    'sh',
    IMAGE,
    '-c',
    script,
  ];
  try {
    const { stdout } = await promisify(execFile)('docker', args, { timeout: 60_000 });
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, out: e.stdout ?? '' };
  }
}

beforeAll(async () => {
  if (!canRun) return;
  const gen = path.join(ROOT, 'gen');
  fs.mkdirSync(gen);
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', path.join(gen, 'u'), '-N', '', '-C', 'u', '-q']);
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', path.join(gen, 'h'), '-N', '', '-q']);
  const pub = fs.readFileSync(path.join(gen, 'u.pub'), 'utf-8').trim();
  store.putKey(G, 'app', fs.readFileSync(path.join(gen, 'u')), pub, { target: 'deploy@ssh.example.test' });
  const hostPub = fs.readFileSync(path.join(gen, 'h.pub'), 'utf-8').trim().split(/\s+/).slice(0, 2).join(' ');
  store.pinHost(G, 'ssh.example.test', [`ssh.example.test ${hostPub}`]);
  syncView(G);
  expect(await ensureAgent(G)).toBe(true);
}, 30_000);
afterAll(() => {
  stopAgent(G);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe.skipIf(!canRun)('inside a container', () => {
  it('lists the key through the read-only socket, and cannot remove it', async () => {
    const r = await inContainer('ssh-add -l; echo "D=$(ssh-add -D >/dev/null 2>&1; echo $?)"; ssh-add -l | wc -l');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^256 SHA256:\S+ u \(ED25519\)/m);
    expect(r.out).toMatch(/^D=[1-9]/m);
    expect(r.out.trim().split('\n').pop()).toBe('1');
  }, 90_000);

  it('can read no private key, and cannot write the view', async () => {
    const r = await inContainer(
      `grep -rl "PRIVATE KEY" ${CONTAINER_SSH_DIR} 2>/dev/null | wc -l; ` +
        `touch ${CONTAINER_SSH_DIR}/x 2>/dev/null && echo writable || echo read-only; ls ${CONTAINER_SSH_DIR}`,
    );
    const [found, writable, ...files] = r.out.trim().split('\n');
    expect(found).toBe('0');
    expect(writable).toBe('read-only');
    expect(files.sort()).toEqual(['agent.sock', 'app.pub', 'config', 'known_hosts']);
  }, 90_000);

  it('`ssh -G app` resolves through the config: user, host, the agent and the pinned host keys', async () => {
    const r = await inContainer(`ssh -F ${CONTAINER_SSH_DIR}/config -G app`);
    expect(r.out).toMatch(/^user deploy$/m);
    expect(r.out).toMatch(/^hostname ssh\.example\.test$/m);
    expect(r.out).toMatch(new RegExp(`^identityagent ${CONTAINER_SSH_DIR}/agent.sock$`, 'm'));
    expect(r.out).toMatch(/^stricthostkeychecking true$/m);
  }, 90_000);
});
