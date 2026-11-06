/**
 * The host ssh-agent and the filtered socket a container gets, with a real
 * ssh-agent. Keys are generated at test time.
 */
import { execFile, execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Short root: unix socket paths are capped near 107 bytes.
const ROOT = fs.mkdtempSync(path.join('/tmp', 'dk-'));
vi.mock('../../config.js', () => ({ GROUPS_DIR: path.join(ROOT, 'g'), DATA_DIR: path.join(ROOT, 'd') }));

const store = await import('./store.js');
const { ensureAgent, refusal, serveFiltered, stopAgent } = await import('./agent.js');
const { syncView } = await import('./view.js');

const hasAgent = spawnSync('ssh-agent', ['-h']).error === undefined;
const G = 'ag-1';

function keygen(file: string, comment: string): void {
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', file, '-N', '', '-C', comment, '-q']);
}

let viewSock = '';
let userPub = '';
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, SSH_AUTH_SOCK: viewSock });

/**
 * Run a client against the socket WITHOUT blocking: the socket is served by
 * this same process, so a synchronous child would deadlock it.
 */
async function client(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await promisify(execFile)(cmd, args, { env: env(), timeout: 10_000 });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: (err as { code?: number }).code ?? 1, out: '' };
  }
}

beforeAll(async () => {
  if (!hasAgent) return;
  const tmp = path.join(ROOT, 'gen');
  fs.mkdirSync(tmp);
  keygen(path.join(tmp, 'user'), 'deploy@ssh.example.test');
  keygen(path.join(tmp, 'host'), '');
  userPub = fs.readFileSync(path.join(tmp, 'user.pub'), 'utf-8').trim();
  store.putKey(G, 'app', fs.readFileSync(path.join(tmp, 'user')), userPub, { target: 'deploy@ssh.example.test' });
  const hostPub = fs.readFileSync(path.join(tmp, 'host.pub'), 'utf-8').trim().split(/\s+/).slice(0, 2).join(' ');
  store.pinHost(G, 'ssh.example.test', [`ssh.example.test ${hostPub}`]);
  syncView(G);
  expect(await ensureAgent(G)).toBe(true);
  viewSock = path.join(store.groupViewDir(G), 'agent.sock');
});
afterAll(() => {
  stopAgent(G);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe.skipIf(!hasAgent)('the agent socket a container gets', () => {
  it('lists the key', async () => {
    const r = await client('ssh-add', ['-L']);
    expect(r.code).toBe(0);
    expect(r.out.trim().split(/\s+/).slice(0, 2)).toEqual(userPub.split(/\s+/).slice(0, 2));
  });

  it('will not sign on a connection not bound to the key’s server: the destination constraint holds', async () => {
    const pubFile = path.join(ROOT, 'gen', 'user.pub');
    const data = path.join(ROOT, 'gen', 'data');
    fs.writeFileSync(data, 'hello');
    const r = await client('ssh-keygen', ['-Y', 'sign', '-f', pubFile, '-n', 'file', data]);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(`${data}.sig`)).toBe(false);
  });

  it('refuses to remove or add keys', async () => {
    expect((await client('ssh-add', ['-D'])).code).not.toBe(0);
    const extra = path.join(ROOT, 'gen', 'extra');
    keygen(extra, 'extra');
    expect((await client('ssh-add', [extra])).code).not.toBe(0);
    // Still there, still one.
    expect((await client('ssh-add', ['-l'])).out.trim().split('\n')).toHaveLength(1);
  });

  it('is 0600 in the view, beside no private key; the real socket is in the store', () => {
    expect(fs.statSync(viewSock).mode & 0o777).toBe(0o600);
    const view = fs.readdirSync(store.groupViewDir(G));
    for (const f of view)
      if (fs.statSync(path.join(store.groupViewDir(G), f)).isFile())
        expect(fs.readFileSync(path.join(store.groupViewDir(G), f), 'latin1')).not.toContain('PRIVATE KEY');
    expect(fs.existsSync(path.join(store.groupStoreDir(G), 'agent.sock'))).toBe(true);
  });
});

describe('the filter', () => {
  const frame = (type: number, body: Buffer = Buffer.alloc(0)): Buffer => {
    const b = Buffer.alloc(5 + body.length);
    b.writeUInt32BE(1 + body.length, 0);
    b[4] = type;
    body.copy(b, 5);
    return b;
  };
  const str = (s: string | Buffer): Buffer => {
    const v = Buffer.isBuffer(s) ? s : Buffer.from(s);
    const b = Buffer.alloc(4 + v.length);
    b.writeUInt32BE(v.length, 0);
    v.copy(b, 4);
    return b;
  };

  it('passes listing, signing and session-bind; refuses the rest', () => {
    expect(refusal(frame(11))).toBeNull();
    expect(refusal(frame(13, str('k')))).toBeNull();
    expect(refusal(frame(27, str('session-bind@openssh.com')))).toBeNull();
    expect(refusal(frame(27, str('query')))).toBeNull();
    expect(refusal(frame(27, str('restrict-destination-v00@openssh.com')))).not.toBeNull();
    for (const t of [17, 18, 19, 20, 22, 23, 25, 26]) expect(refusal(frame(t))).not.toBeNull();
  });

  it('reports each signature with the key and the host the session was bound to', async () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'dkf-'));
    const real = path.join(dir, 'r.sock');
    const upstream = net.createServer((s) => s.on('data', () => s.write(Buffer.from([0, 0, 0, 1, 6]))));
    await new Promise<void>((r) => upstream.listen(real, r));
    const events: Array<{ keyFingerprint: string; boundHostKey: string | null }> = [];
    const front = net.createServer((c) => serveFiltered(c, real, (e) => events.push(e)));
    const fsock = path.join(dir, 'f.sock');
    await new Promise<void>((r) => front.listen(fsock, r));

    const c = net.connect(fsock);
    const replies: number[] = [];
    c.on('data', (d) => {
      for (let i = 0; i + 4 < d.length; i += 4 + d.readUInt32BE(i)) replies.push(d[i + 4]);
    });
    await new Promise<void>((r) => c.once('connect', () => r()));
    c.write(frame(27, Buffer.concat([str('session-bind@openssh.com'), str('HOSTKEY'), str('sid'), str('sig')])));
    c.write(frame(13, Buffer.concat([str('KEYBLOB'), str('data'), Buffer.alloc(4)])));
    c.write(frame(18));
    await new Promise((r) => setTimeout(r, 150));
    c.destroy();
    front.close();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });

    // Two forwarded (6 = success from the stand-in), one refused locally (5).
    expect(replies).toEqual([6, 6, 5]);
    expect(events).toHaveLength(1);
    expect(events[0].keyFingerprint).toMatch(/^SHA256:/);
    expect(events[0].boundHostKey).toMatch(/^SHA256:/);
  });
});
