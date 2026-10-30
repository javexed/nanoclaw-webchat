/**
 * NanoClaw's own certificate authority for machines (Scaling design: joining
 * and identity). Kept in DATA_DIR/machines-ca, 0700, keys 0600:
 *
 *   ca.key / ca.crt          — signs machine certificates (10 years)
 *   server.key / server.crt  — the machine listener's TLS certificate
 *
 * Machines pin the server key (`pin`: sha256 of its public key, base64, the
 * form curl's --pinnedpubkey takes) on first contact, so the install command
 * needs no public CA. Machine certificates last a day and are renewed over
 * the listener; a machine is known by its certificate's fingerprint, not by
 * the name it put in its request.
 *
 * Node cannot create X.509 certificates, so this drives the openssl CLI
 * (present on every Linux host NanoClaw supports) with files in a private
 * temp dir.
 */
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../../config.js';

/** Machine certificates last one day; renewal starts when 12 hours are left. */
export const CERT_DAYS = 1;
export const RENEW_BEFORE_MS = 12 * 3600_000;

export interface CaPaths {
  dir: string;
  caKey: string;
  caCert: string;
  serverKey: string;
  serverCert: string;
}

export function caPaths(dir = path.join(DATA_DIR, 'machines-ca')): CaPaths {
  return {
    dir,
    caKey: path.join(dir, 'ca.key'),
    caCert: path.join(dir, 'ca.crt'),
    serverKey: path.join(dir, 'server.key'),
    serverCert: path.join(dir, 'server.crt'),
  };
}

const openssl = (args: string[], input?: string): string =>
  execFileSync('openssl', args, { input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ca-'));
  fs.chmodSync(dir, 0o700);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Create the CA and the server certificate once; later calls leave them alone. */
export function ensureCa(p: CaPaths = caPaths(), serverNames: string[] = []): void {
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.dir, 0o700);
  if (!fs.existsSync(p.caKey) || !fs.existsSync(p.caCert)) {
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p.caKey]);
    fs.chmodSync(p.caKey, 0o600);
    openssl([
      'req',
      '-x509',
      '-new',
      '-key',
      p.caKey,
      '-sha256',
      '-days',
      '3650',
      '-subj',
      '/CN=NanoClaw machines CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-out',
      p.caCert,
    ]);
  }
  if (!fs.existsSync(p.serverKey) || !fs.existsSync(p.serverCert)) {
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p.serverKey]);
    fs.chmodSync(p.serverKey, 0o600);
    withTemp((tmp) => {
      const csr = path.join(tmp, 'server.csr');
      const ext = path.join(tmp, 'server.ext');
      openssl(['req', '-new', '-key', p.serverKey, '-subj', '/CN=NanoClaw machine listener', '-out', csr]);
      const sans = [...new Set(['127.0.0.1', ...serverNames])]
        .map((n) => (/^[\d.]+$|:/.test(n) ? `IP:${n}` : `DNS:${n}`))
        .join(',');
      fs.writeFileSync(ext, `basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${sans}\n`);
      openssl([
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        p.caCert,
        '-CAkey',
        p.caKey,
        '-sha256',
        '-days',
        '3650',
        '-set_serial',
        `0x${crypto.randomBytes(16).toString('hex')}`,
        '-extfile',
        ext,
        '-out',
        p.serverCert,
      ]);
    });
  }
}

/** sha256 of a certificate's public key, base64 — curl's --pinnedpubkey form. */
export function publicKeyPin(certPem: string): string {
  const der = new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64');
}

/** A certificate's own fingerprint, as Node's TLS reports a peer's (`fingerprint256`). */
export function certFingerprint(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

export interface IssuedCert {
  cert: string;
  fingerprint: string;
  expiresAt: number;
}

/**
 * Sign a machine's certificate request. The request must carry a valid
 * self-signature (proof the machine holds the key); its subject is ignored.
 */
export function issueMachineCert(csrPem: string, p: CaPaths = caPaths()): IssuedCert {
  if (typeof csrPem !== 'string' || !csrPem.includes('BEGIN CERTIFICATE REQUEST') || csrPem.length > 8192) {
    throw new Error('invalid certificate request');
  }
  return withTemp((tmp) => {
    const csr = path.join(tmp, 'm.csr');
    const ext = path.join(tmp, 'm.ext');
    fs.writeFileSync(csr, csrPem);
    // Some openssl builds exit 0 on a failed self-signature check: read its verdict instead.
    const check = spawnSync('openssl', ['req', '-in', csr, '-noout', '-verify'], { encoding: 'utf8' });
    if (check.status !== 0 || !/verify OK/i.test(`${check.stdout}${check.stderr}`)) {
      throw new Error('invalid certificate request');
    }
    fs.writeFileSync(
      ext,
      'basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature\n',
    );
    let cert: string;
    try {
      cert = openssl([
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        p.caCert,
        '-CAkey',
        p.caKey,
        '-sha256',
        '-days',
        String(CERT_DAYS),
        '-set_serial',
        `0x${crypto.randomBytes(16).toString('hex')}`,
        '-extfile',
        ext,
      ]);
    } catch {
      throw new Error('invalid certificate request');
    }
    const x = new crypto.X509Certificate(cert);
    return { cert, fingerprint: x.fingerprint256, expiresAt: Date.parse(x.validTo) };
  });
}
