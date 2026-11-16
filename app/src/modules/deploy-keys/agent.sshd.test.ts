/**
 * A real login through the filtered socket, against user-mode sshd on
 * loopback: the key's own server (host key pinned) lets it in; a server with
 * any other host key gets no signature, even when the client trusts it. A key
 * with two targets works on both, also as a jump chain (the second hop
 * tunnelled through the first with ProxyJump), and on nothing else. A signing
 * request on a connection that never bound its session is refused.
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
/** A second agent whose key has two targets. */
const G2 = 'ag-2';
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
async function startSshd(hostKey: string, addr = '127.0.0.1'): Promise<number> {
  const port = await freePort();
  const cfg = path.join(gen, `sshd-${port}`);
  fs.writeFileSync(
    cfg,
    [
      `Port ${port}`,
      `ListenAddress ${addr}`,
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
      const c = net.connect(port, addr, () => (c.destroy(), r(true)));
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
/** Host C, on 127.0.0.2: the multi-target key's second server. */
let secondPort = 0;
let multiSock = '';
let multiConfig = '';

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

  // The second agent: one key, targets A (127.0.0.1) and C (127.0.0.2), both pinned.
  const secondHost = keygen('host-c');
  secondPort = await startSshd('host-c', '127.0.0.2');
  store.putKey(
    G2,
    'multi',
    fs.readFileSync(path.join(gen, 'user')),
    fs.readFileSync(path.join(gen, 'user.pub'), 'utf-8'),
    { targets: [`${USER}@127.0.0.1`, `${USER}@127.0.0.2 via ${USER}@127.0.0.1`] },
  );
  store.pinHost(G2, '127.0.0.1', [`127.0.0.1 ${pinnedHost}`]);
  store.pinHost(G2, '127.0.0.2', [`127.0.0.2 ${secondHost}`]);
  expect(await ensureAgent(G2)).toBe(true);
  multiSock = path.join(store.groupViewDir(G2), 'agent.sock');

  // The client config, shaped like the generated one (view.ts) plus test ports:
  // the jump target's entry says ProxyJump <the first target's alias>.
  const kh = path.join(gen, 'kh-multi');
  fs.writeFileSync(
    kh,
    [
      `[127.0.0.1]:${pinnedPort} ${pinnedHost}`,
      `[127.0.0.2]:${secondPort} ${secondHost}`,
      `[127.0.0.1]:${otherPort} ${otherHost}`,
    ].join('\n') + '\n',
  );
  const block = (alias: string, host: string, port: number, jump?: string, sock = multiSock): string[] => [
    `Host ${alias}`,
    `  HostName ${host}`,
    `  Port ${port}`,
    `  User ${USER}`,
    `  IdentityAgent ${sock}`,
    `  IdentityFile ${path.join(gen, 'user.pub')}`,
    '  IdentitiesOnly yes',
    '  BatchMode yes',
    `  UserKnownHostsFile ${kh}`,
    '  StrictHostKeyChecking yes',
    ...(jump ? [`  ProxyJump ${jump}`] : []),
  ];
  multiConfig = path.join(gen, 'ssh-config');
  fs.writeFileSync(
    multiConfig,
    [
      ...block('multi', '127.0.0.1', pinnedPort),
      ...block('multi.2', '127.0.0.2', secondPort),
      ...block('multi.2-via', '127.0.0.2', secondPort, 'multi'),
      // Not a target: server B, directly and through the jump.
      ...block('elsewhere', '127.0.0.1', otherPort),
      ...block('elsewhere-via', '127.0.0.1', otherPort, 'multi'),
      // The first agent's key has target A only: the jump works, the hop to C does not.
      ...block('only-a', '127.0.0.1', pinnedPort, undefined, viewSock),
      ...block('only-a-to-c', '127.0.0.2', secondPort, 'only-a', viewSock),
    ].join('\n') + '\n',
  );
}, 30_000);

afterAll(() => {
  stopAgent(G);
  stopAgent(G2);
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

/** ssh with the multi-target config, by alias. */
async function sshAlias(alias: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)('ssh', ['-F', multiConfig, alias, 'echo LOGIN-OK'], {
      timeout: 20_000,
      env: { PATH: process.env.PATH },
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

describe.skipIf(!canRun)('a key with several targets', () => {
  it('logs in to its first target', async () => {
    expect((await sshAlias('multi')).out.trim()).toBe('LOGIN-OK');
  }, 30_000);

  it('logs in to its second target directly', async () => {
    expect((await sshAlias('multi.2')).out.trim()).toBe('LOGIN-OK');
  }, 30_000);

  it('logs in to its second target through the first, as a jump chain', async () => {
    const r = await sshAlias('multi.2-via');
    expect(r.err).not.toMatch(/refused/);
    expect(r.out.trim()).toBe('LOGIN-OK');
  }, 30_000);

  it('gets no signature from a server that is not a target, directly or through the jump', async () => {
    for (const alias of ['elsewhere', 'elsewhere-via']) {
      const r = await sshAlias(alias);
      expect(r.out).not.toContain('LOGIN-OK');
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/Permission denied \(publickey\)|agent refused operation/);
    }
  }, 60_000);

  it('control: a key without the second target gets through the jump but not onto the second server', async () => {
    expect((await sshAlias('only-a')).out.trim()).toBe('LOGIN-OK');
    const r = await sshAlias('only-a-to-c');
    expect(r.out).not.toContain('LOGIN-OK');
    expect(r.err).toMatch(/Permission denied \(publickey\)|agent refused operation/);
  }, 60_000);
});

/** One agent-protocol exchange on a fresh connection; returns the reply's message type. */
function agentRequest(sock: string, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = Buffer.alloc(0);
    c.on('connect', () => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      c.write(Buffer.concat([len, body]));
    });
    c.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 5 && buf.length >= 4 + buf.readUInt32BE(0)) {
        c.destroy();
        resolve(buf[4]);
      }
    });
    c.on('error', reject);
    setTimeout(() => (c.destroy(), reject(new Error('no reply'))), 5000);
  });
}

const sshStr = (b: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};

describe.skipIf(!canRun)('a client that never binds its session', () => {
  it('is refused a signature by a constrained key, which an unconstrained agent would give', async () => {
    const blob = Buffer.from(fs.readFileSync(path.join(gen, 'user.pub'), 'utf-8').trim().split(/\s+/)[1], 'base64');
    // SSH_AGENTC_SIGN_REQUEST (13): key blob, data, flags. No session-bind first,
    // as an SSH library that does not bind (e.g. Node ssh2) would send it.
    const sign = Buffer.concat([Buffer.from([13]), sshStr(blob), sshStr(Buffer.from('to be signed')), Buffer.alloc(4)]);
    expect(await agentRequest(viewSock, sign)).toBe(5); // SSH_AGENT_FAILURE

    const sock = path.join(gen, 'plain2.sock');
    const agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
      await promisify(execFile)('ssh-add', ['-q', path.join(gen, 'user')], {
        env: { PATH: process.env.PATH, SSH_AUTH_SOCK: sock },
      });
      expect(await agentRequest(sock, sign)).toBe(14); // SSH_AGENT_SIGN_RESPONSE
    } finally {
      agent.kill();
    }
  }, 30_000);
});
