/**
 * A real login through the filtered socket, against two user-mode sshd on
 * loopback: the key's own server (host key pinned) lets it in; a server with
 * any other host key gets no signature, even when the client trusts it.
 * Needs sshd and ssh; skipped without them. Keys are generated at test time.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ROOT = fs.mkdtempSync(path.join('/tmp', 'dkl-'));
vi.mock('../../config.js', () => ({ GROUPS_DIR: path.join(ROOT, 'g'), DATA_DIR: path.join(ROOT, 'd') }));

const store = await import('./store.js');
const { ensureAgent, stopAgent } = await import('./agent.js');

const SSHD = '/usr/sbin/sshd';
const canRun = fs.existsSync(SSHD) && execFileSync('sh', ['-c', 'command -v ssh || true']).toString().trim() !== '';
const G = 'ag-1';
const USER = os.userInfo().username;
const gen = path.join(ROOT, 'gen');

function keygen(name: string): string {
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', path.join(gen, name), '-N', '', '-C', name, '-q']);
  return fs
    .readFileSync(path.join(gen, `${name}.pub`), 'utf-8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const daemons: ChildProcess[] = [];
async function startSshd(hostKey: string): Promise<number> {
  const port = await freePort();
  const cfg = path.join(gen, `sshd-${port}`);
  fs.writeFileSync(
    cfg,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${path.join(gen, hostKey)}`,
      `AuthorizedKeysFile ${path.join(gen, 'authorized_keys')}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
      `PidFile ${cfg}.pid`,
    ].join('\n') + '\n',
  );
  const d = spawn(SSHD, ['-D', '-f', cfg, '-E', `${cfg}.log`], { stdio: 'ignore' });
  daemons.push(d);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((r) => {
      const c = net.connect(port, '127.0.0.1', () => (c.destroy(), r(true)));
      c.on('error', () => r(false));
    });
    if (up) return port;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('sshd did not start');
}

let viewSock = '';
let pinnedPort = 0;
let otherPort = 0;
let otherKnown = '';

/** ssh as a container would run it, asynchronously: the socket is served by this process. */
async function login(port: number, knownHosts: string): Promise<{ code: number; out: string; err: string }> {
  const args = [
    '-F',
    '/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    `IdentityAgent=${viewSock}`,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `IdentityFile=${path.join(gen, 'user.pub')}`,
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'StrictHostKeyChecking=yes',
    '-p',
    String(port),
    `${USER}@127.0.0.1`,
    'echo LOGIN-OK',
  ];
  try {
    const { stdout, stderr } = await promisify(execFile)('ssh', args, {
      timeout: 20_000,
      env: { PATH: process.env.PATH },
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

beforeAll(async () => {
  if (!canRun) return;
  fs.mkdirSync(gen);
  const userPub = keygen('user');
  fs.writeFileSync(path.join(gen, 'authorized_keys'), userPub + '\n', { mode: 0o600 });
  const pinnedHost = keygen('host-a');
  const otherHost = keygen('host-b');
  pinnedPort = await startSshd('host-a');
  otherPort = await startSshd('host-b');

  // The store pins host A only, as the key's target.
  store.putKey(
    G,
    'app',
    fs.readFileSync(path.join(gen, 'user')),
    fs.readFileSync(path.join(gen, 'user.pub'), 'utf-8'),
    {
      target: `${USER}@127.0.0.1`,
    },
  );
  store.pinHost(G, '127.0.0.1', [`127.0.0.1 ${pinnedHost}`]);
  expect(await ensureAgent(G)).toBe(true);
  viewSock = path.join(store.groupViewDir(G), 'agent.sock');

  // The client side's own known_hosts: one per server, so only the agent decides.
  fs.writeFileSync(path.join(gen, 'kh-a'), `[127.0.0.1]:${pinnedPort} ${pinnedHost}\n`);
  otherKnown = path.join(gen, 'kh-b');
  fs.writeFileSync(otherKnown, `[127.0.0.1]:${otherPort} ${otherHost}\n`);
}, 30_000);

afterAll(() => {
  stopAgent(G);
  for (const d of daemons) d.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe.skipIf(!canRun)('logging in through the filtered socket', () => {
  it('works against the key’s own server, and stamps its last use', async () => {
    const r = await login(pinnedPort, path.join(gen, 'kh-a'));
    expect(r.err).not.toMatch(/refused/);
    expect(r.out.trim()).toBe('LOGIN-OK');
    expect(store.readMeta(store.groupStoreDir(G), 'app').lastUsedAt).toBeTruthy();
  }, 30_000);

  it('gets no signature from any other server, even one the client trusts', async () => {
    const r = await login(otherPort, otherKnown);
    expect(r.out).not.toContain('LOGIN-OK');
    expect(r.code).not.toBe(0);
    // Once the session is bound to this server, the agent no longer even lists
    // the key, so the client has nothing to offer.
    expect(r.err).toMatch(/Permission denied \(publickey\)|agent refused operation/);
  }, 30_000);

  it('control: the same key, loaded without the constraint, would have logged in there', async () => {
    const sock = path.join(gen, 'plain.sock');
    const agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
      await promisify(execFile)('ssh-add', ['-q', path.join(gen, 'user')], {
        env: { PATH: process.env.PATH, SSH_AUTH_SOCK: sock },
      });
      const saved = viewSock;
      viewSock = sock;
      const r = await login(otherPort, otherKnown);
      viewSock = saved;
      expect(r.out.trim()).toBe('LOGIN-OK');
    } finally {
      agent.kill();
    }
  }, 30_000);
});
