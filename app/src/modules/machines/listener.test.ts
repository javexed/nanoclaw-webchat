/**
 * Joining end to end: a real TLS listener, real openssl certificates, a test
 * database. A machine joins with a one-time token, reports with its client
 * certificate, renews, and is cut off when revoked.
 */
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb, initTestDb } from '../../db/connection.js';
import { moduleWebchatMachineIsolation, moduleWebchatMachineMembers } from '../../channels/webchat/migration.js';
import { caPaths, certFingerprint, ensureCa, isMachineLeaf, issueMachineCert, publicKeyPin } from './ca.js';
import { machineHandler, workerHashes } from './listener.js';
import {
  addMember,
  availableOn,
  clampHealth,
  createJoinToken,
  getMember,
  isolationRefusal,
  isolationStatus,
  ISOLATION_FRESH_MS,
  MAX_CPUS,
  MAX_MEM_MB,
  memberByCert,
  publicView,
  recordHealth,
  removeMember,
  revokeMember,
  setCap,
  setWorkloadsOn,
  spendJoinToken,
  TOKEN_TTL_MS,
} from './members.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-machines-'));
const paths = caPaths(path.join(tmp, 'ca'));
let server: https.Server;
let port = 0;

const openssl = (args: string[]): string => execFileSync('openssl', args, { encoding: 'utf8' });

/** A machine's key and certificate request, as install.sh makes them. */
function machineKey(name: string): { key: string; csr: string } {
  const key = path.join(tmp, `${name}.key`);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  const csr = openssl(['req', '-new', '-key', key, '-subj', '/CN=nanoclaw-machine']);
  return { key: fs.readFileSync(key, 'utf8'), csr };
}

function call(
  method: string,
  url: string,
  body?: string,
  client?: { key: string; cert: string },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: url,
        method,
        rejectUnauthorized: false,
        ...(client ?? {}),
        headers: body ? { 'content-type': 'application/json' } : {},
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  ensureCa(paths, ['127.0.0.1']);
  const handler = machineHandler({ port: 0, bind: '127.0.0.1', address: '127.0.0.1' }, paths);
  server = https.createServer(
    {
      key: fs.readFileSync(paths.serverKey),
      cert: fs.readFileSync(paths.serverCert),
      ca: fs.readFileSync(paths.caCert),
      requestCert: true,
      rejectUnauthorized: false,
    },
    (req, res) => void handler(req, res),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  await initTestDb();
  await moduleWebchatMachineMembers.up(getDb() as never);
  await moduleWebchatMachineIsolation.up(getDb() as never);
  await getDb().exec('DELETE FROM machine_members; DELETE FROM machine_join_tokens;');
});

describe('the CA', () => {
  it('keeps its keys private and its certificates once made', () => {
    expect(fs.statSync(paths.caKey).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.dir).mode & 0o777).toBe(0o700);
    const before = fs.readFileSync(paths.serverCert, 'utf8');
    ensureCa(paths);
    expect(fs.readFileSync(paths.serverCert, 'utf8')).toBe(before);
  });

  it('pins the server key the way curl --pinnedpubkey does', () => {
    const viaOpenssl = execFileSync(
      'sh',
      [
        '-c',
        `openssl x509 -in ${paths.serverCert} -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`,
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(publicKeyPin(fs.readFileSync(paths.serverCert, 'utf8'))).toBe(viaOpenssl);
  });

  it('issues a one-day client certificate for a valid request, and refuses junk', () => {
    const { csr } = machineKey('ca-test');
    const c = issueMachineCert(csr, paths);
    expect(c.expiresAt - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(c.expiresAt - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
    expect(
      new crypto.X509Certificate(c.cert).checkIssued(new crypto.X509Certificate(fs.readFileSync(paths.caCert))),
    ).toBe(true);
    expect(() => issueMachineCert('not a csr', paths)).toThrow(/invalid/);
    const tampered = csr.replace(/[A-Za-z](?=[^\n]*\n-----END)/, (ch) => (ch === 'A' ? 'B' : 'A'));
    expect(() => issueMachineCert(tampered, paths)).toThrow(/invalid/);
  });
});

describe('the CA constraints', () => {
  const text = (file: string) =>
    execFileSync('openssl', ['x509', '-in', file, '-noout', '-text'], { encoding: 'utf8' });

  it('the CA signs leaves only (pathlen:0); every leaf is critical CA:FALSE with one purpose', () => {
    expect(text(paths.caCert)).toMatch(/Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
    const server = text(paths.serverCert);
    expect(server).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(server).toMatch(/Key Usage: critical\s+Digital Signature\n/);
    expect(server).toMatch(/Extended Key Usage:\s+TLS Web Server Authentication\n/);
    expect(server).not.toContain('TLS Web Client Authentication');
    const c = issueMachineCert(machineKey('purpose').csr, paths);
    const file = path.join(tmp, 'purpose.crt');
    fs.writeFileSync(file, c.cert);
    const client = text(file);
    expect(client).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(client).toMatch(/Extended Key Usage:\s+TLS Web Client Authentication\n/);
    expect(client).not.toContain('TLS Web Server Authentication');
  });

  it('a certificate signed by a machine leaf does not verify', () => {
    const { key: leafKey, csr } = machineKey('signer');
    const leaf = path.join(tmp, 'signer.crt');
    fs.writeFileSync(leaf, issueMachineCert(csr, paths).cert);
    const leafKeyFile = path.join(tmp, 'signer.key.pem');
    fs.writeFileSync(leafKeyFile, leafKey);
    const victimCsr = path.join(tmp, 'victim.csr');
    fs.writeFileSync(victimCsr, machineKey('victim').csr);
    const forged = path.join(tmp, 'victim.crt');
    openssl(['x509', '-req', '-in', victimCsr, '-CA', leaf, '-CAkey', leafKeyFile, '-days', '1', '-out', forged]);
    const chain = path.join(tmp, 'chain.pem');
    fs.writeFileSync(chain, fs.readFileSync(leaf));
    const r = spawnSync('openssl', ['verify', '-CAfile', paths.caCert, '-untrusted', chain, forged], {
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
  });

  it("only a machine's client certificate passes as a machine", () => {
    expect(isMachineLeaf({ ca: false, ext_key_usage: ['1.3.6.1.5.5.7.3.2'] })).toBe(true);
    expect(isMachineLeaf({ ca: false, ext_key_usage: ['1.3.6.1.5.5.7.3.1'] })).toBe(false);
    expect(isMachineLeaf({ ca: true, ext_key_usage: ['1.3.6.1.5.5.7.3.2'] })).toBe(false);
    expect(isMachineLeaf({ ca: false })).toBe(false);
    expect(isMachineLeaf(null)).toBe(false);
  });

  it("the listener's own certificate is refused as a client", async () => {
    const r = await call('POST', '/report', '{}', {
      key: fs.readFileSync(paths.serverKey, 'utf8'),
      cert: fs.readFileSync(paths.serverCert, 'utf8'),
    });
    expect(r.status).toBe(403);
  });
});

describe('join tokens', () => {
  it('work once', async () => {
    const { token } = await createJoinToken('worker', 'webchat:owner');
    expect(await spendJoinToken(token)).toBe('worker');
    expect(await spendJoinToken(token)).toBeNull();
  });

  it('expire after an hour, and unknown ones are refused', async () => {
    const now = Date.now();
    const { token } = await createJoinToken('worker', null, now);
    expect(await spendJoinToken(token, now + TOKEN_TTL_MS + 1)).toBeNull();
    expect(await spendJoinToken('x'.repeat(43))).toBeNull();
  });

  it('are stored hashed', async () => {
    const { token } = await createJoinToken('worker', null);
    const row = (await getDb().get('SELECT token_hash FROM machine_join_tokens')) as { token_hash: string };
    expect(row.token_hash).not.toContain(token);
  });
});

describe('a machine joining and reporting', () => {
  async function join(name = 'app1') {
    const { token } = await createJoinToken('worker', null);
    const { key, csr } = machineKey(name);
    const facts = { hostname: name, cpus: 4, memTotalMb: 16000, diskTotalGb: 64 };
    const r = await call('POST', '/enroll', JSON.stringify({ token, csr: Buffer.from(csr).toString('base64'), facts }));
    return { token, key, r };
  }
  const certOf = (text: string): string => text.slice(text.indexOf('-----BEGIN CERTIFICATE'));

  it('serves a reachability check and the installer with the key pin', async () => {
    expect((await call('GET', '/healthz')).text).toBe('ok');
    const s = (await call('GET', '/install.sh')).text;
    expect(s).toContain(publicKeyPin(fs.readFileSync(paths.serverCert, 'utf8')));
    expect(s).toContain('command -v docker');
  });

  it('joins with a token, once', async () => {
    const { token, r } = await join();
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/^id m-[0-9a-f]{8}\nname app1\nrole worker\n-----BEGIN CERTIFICATE/);
    const again = await call('POST', '/enroll', JSON.stringify({ token, csr: 'x', facts: {} }));
    expect(again.status).toBe(403);
  });

  it('reports health with its certificate; NanoClaw works out what it may use', async () => {
    const { key, r } = await join();
    const cert = certOf(r.text);
    const health = {
      cpus: 4,
      memTotalMb: 16000,
      memUsedMb: 7000,
      memNanoclawMb: 1000,
      cpuUsed: 1.5,
      cpuNanoclaw: 0.5,
      diskTotalGb: 64,
      diskFreeGb: 30,
    };
    const rep = await call('POST', '/report', JSON.stringify(health), { key, cert });
    expect(rep).toEqual({ status: 200, text: 'ok' });
    const m = (await memberByCert(certFingerprint(cert)))!;
    expect(Object.values(m.peaks)[0]).toEqual({ memMb: 6000, cpus: 1 });
    expect(availableOn(m)).toMatchObject({ memMb: 16000 - 6000 - 2400, cpus: 2.4 });
    await setCap(m.id, { memMb: 4096, cpus: null });
    expect(availableOn((await getMember(m.id))!)).toMatchObject({ memMb: 4096, memBy: 'cap' });
  });

  it('refuses a report with no certificate, or a certificate from another CA', async () => {
    expect((await call('POST', '/report', '{}')).status).toBe(403);
    const otherKey = path.join(tmp, 'other.key');
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', otherKey]);
    const self = openssl(['req', '-x509', '-new', '-key', otherKey, '-subj', '/CN=x', '-days', '1']);
    expect((await call('POST', '/report', '{}', { key: fs.readFileSync(otherKey, 'utf8'), cert: self })).status).toBe(
      403,
    );
  });

  it('renews: the new certificate works, the old one until it expires', async () => {
    const { key, r } = await join();
    const old = certOf(r.text);
    const keyFile = path.join(tmp, 'renew.key');
    fs.writeFileSync(keyFile, key);
    const req2 = openssl(['req', '-new', '-key', keyFile, '-subj', '/CN=nanoclaw-machine']);
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const q = https.request(
        { host: '127.0.0.1', port, path: '/renew', method: 'POST', rejectUnauthorized: false, key, cert: old },
        (s) => {
          let t = '';
          s.on('data', (c) => (t += c));
          s.on('end', () => resolve({ status: s.statusCode ?? 0, text: t }));
        },
      );
      q.on('error', reject);
      q.end(req2);
    });
    expect(res.status).toBe(200);
    const fresh = res.text;
    expect(certFingerprint(fresh)).not.toBe(certFingerprint(old));
    const health = JSON.stringify({ memTotalMb: 16000, memUsedMb: 1, cpus: 4 });
    expect((await call('POST', '/report', health, { key, cert: fresh })).status).toBe(200);
    expect((await call('POST', '/report', health, { key, cert: old })).status).toBe(200);
  });

  it('a revoked machine is refused at once, and can then be removed', async () => {
    const { key, r } = await join();
    const cert = certOf(r.text);
    const m = (await memberByCert(certFingerprint(cert)))!;
    expect(await removeMember(m.id)).toBe(false);
    await revokeMember(m.id);
    expect((await call('POST', '/report', '{}', { key, cert })).status).toBe(403);
    expect(await removeMember(m.id)).toBe(true);
  });

  it('names a second machine with the same hostname apart', async () => {
    await join('box');
    const { r } = await join('box');
    expect(r.text).toMatch(/\nname box-2\n/);
  });
});

describe('health records', () => {
  it('count only non-NanoClaw use toward the peak', async () => {
    const { token } = await createJoinToken('worker', null);
    await spendJoinToken(token);
    const m = await addMember(
      token,
      'worker',
      { hostname: 'h', cpus: 2, memTotalMb: 8000 },
      { fingerprint: 'fp', expiresAt: Date.now() + 1e7 },
    );
    await recordHealth(m.id, { memUsedMb: 5000, memNanoclawMb: 4000, cpuUsed: 1, cpuNanoclaw: 1 });
    const after = (await getMember(m.id))!;
    expect(Object.values(after.peaks)[0]).toEqual({ memMb: 1000, cpus: 0 });
  });

  it('a report can never make a machine bigger than it was when it joined', async () => {
    const { token } = await createJoinToken('worker', null);
    await spendJoinToken(token);
    const m = await addMember(
      token,
      'worker',
      { hostname: 'small', cpus: 2, memTotalMb: 4000, diskTotalGb: 50 },
      { fingerprint: 'fp-small', expiresAt: Date.now() + 1e7 },
    );
    const before = availableOn(m);
    await recordHealth(m.id, {
      cpus: 512,
      memTotalMb: 4_000_000,
      memUsedMb: 9_000_000,
      memNanoclawMb: 9_000_000,
      cpuUsed: 900,
      cpuNanoclaw: 900,
      diskTotalGb: 900_000,
      diskFreeGb: 1e12,
      load1: 1e20,
    });
    const after = (await getMember(m.id))!;
    expect(after.health).toMatchObject({
      cpus: 2,
      memTotalMb: 4000,
      memUsedMb: 4000,
      memNanoclawMb: 4000,
      cpuUsed: 2,
      cpuNanoclaw: 2,
      diskTotalGb: 50,
      diskFreeGb: 50,
      load1: 100_000,
    });
    expect(availableOn(after).memMb).toBeLessThanOrEqual(before.memMb);
    expect(availableOn(after).cpus).toBeLessThanOrEqual(before.cpus);
  });

  it('parts never exceed their whole, and bad numbers count as nothing', () => {
    const h = clampHealth(
      { cpus: 4, memTotalMb: 8000, memUsedMb: 3000, memNanoclawMb: 5000, cpuUsed: 1, cpuNanoclaw: 3, diskFreeGb: 10 },
      { cpus: 8, memTotalMb: 16000 },
    );
    expect(h).toMatchObject({ cpus: 4, memTotalMb: 8000, memUsedMb: 3000, memNanoclawMb: 3000, cpuNanoclaw: 1 });
    // A smaller machine than it joined as (a resized VM) is taken as is; no disk total means no free disk.
    expect(h.diskFreeGb).toBe(0);
    const junk = clampHealth({ cpus: -1, memTotalMb: Number.NaN, memUsedMb: Infinity } as never, {
      cpus: 2,
      memTotalMb: 1000,
    });
    expect(junk).toMatchObject({ cpus: 2, memTotalMb: 1000, memUsedMb: 0 });
    // Facts it never gave: the hard bounds still hold.
    expect(clampHealth({ cpus: 1e9, memTotalMb: 1e15 }, { cpus: 0, memTotalMb: 0 })).toMatchObject({
      cpus: MAX_CPUS,
      memTotalMb: MAX_MEM_MB,
    });
  });
});

describe('a worker\'s isolation check and "Run workloads here"', () => {
  async function worker() {
    const { token } = await createJoinToken('worker', null);
    await spendJoinToken(token);
    return addMember(
      token,
      'worker',
      { hostname: 'w', cpus: 2, memTotalMb: 8000 },
      { fingerprint: `fp-${Math.random()}`, expiresAt: Date.now() + 1e7 },
    );
  }

  it('a newly joined worker runs no workloads and has no isolation result', async () => {
    const m = await worker();
    expect(m.workloadsOn).toBe(false);
    expect(m.isolation).toBeNull();
    expect(isolationStatus(m)).toBe('unknown');
    expect(isolationRefusal(m)).toMatch(/worker w hasn't passed the isolation check/);
    expect(publicView(m)).toMatchObject({ workloadsOn: false, isolation: { status: 'unknown', at: null } });
    await setWorkloadsOn(m.id, true);
    expect((await getMember(m.id))!.workloadsOn).toBe(true);
  });

  it("health carries the result; its time is central's clock minus the age the worker gives", async () => {
    const m = await worker();
    const now = 1_800_000_000_000;
    await recordHealth(m.id, { memUsedMb: 1, isolation: 'ok', isolationAgeMs: 120_000 }, now);
    let after = (await getMember(m.id))!;
    expect(after).toMatchObject({ isolation: 'ok', isolationAt: now - 120_000 });
    expect(isolationStatus(after, now)).toBe('ok');
    expect(isolationStatus(after, now - 120_000 + ISOLATION_FRESH_MS)).toBe('stale');
    // report.sh sends no isolation: the last result stands.
    await recordHealth(m.id, { memUsedMb: 2 }, now + 60_000);
    expect((await getMember(m.id))!.isolation).toBe('ok');
    // The check got through: open, however recent.
    await recordHealth(m.id, { isolation: 'open', isolationAgeMs: 0 }, now + 120_000);
    after = (await getMember(m.id))!;
    expect(isolationStatus(after, now + 120_000)).toBe('open');
    expect(isolationRefusal(after, now + 120_000)).toMatch(/host rules are missing/);
    // No usable age: it counts as never run, so it cannot pass.
    for (const age of [undefined, -5, 'soon', 30 * 86_400_000]) {
      await recordHealth(m.id, { isolation: 'ok', isolationAgeMs: age as never }, now);
      expect(isolationStatus((await getMember(m.id))!, now)).toBe('stale');
    }
    // Anything else is ignored.
    await recordHealth(m.id, { isolation: 'fine' as never, isolationAgeMs: 0 }, now);
    expect((await getMember(m.id))!.isolation).toBe('ok');
  });

  it('central hashes every file the worker installer fetches; a missing one has no hash', () => {
    const h = workerHashes((n) => (n === 'mux.js' ? 'x' : n === 'workloads-host-rules.sh' ? '#!/bin/sh\n' : null));
    expect(h['mux.js']).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
    expect(h['workloads-host-rules.sh']).toMatch(/^[0-9a-f]{64}$/);
    expect(h['worker-main.js']).toBeUndefined();
  });
});
