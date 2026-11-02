/**
 * Join over SSH (Scaling: Machines). An owner gives a private host and an SSH
 * login; NanoClaw's own process (never an agent) connects and runs the same
 * install command Add machine shows, under sudo, streaming its output back.
 *
 * Two steps, so a password never goes to a host nobody checked:
 *   1. probe — connect without authenticating, keep the host key's SHA256
 *      fingerprint (and the address that was checked) for 5 minutes;
 *   2. join — after the person confirms that fingerprint, connect to the SAME
 *      address, refuse if the key changed, authenticate, run the installer.
 *
 * Secrets (password, private key, passphrase) live only in this call: never
 * stored, logged, traced, audited or echoed. sudo gets the password on stdin
 * (`sudo -S -p ''`), never argv, env or a file; the installer's own stdin is
 * /dev/null so nothing after sudo can read it. With a key and no password,
 * `sudo -n`, and a clear message when sudo wants one. Any occurrence of a
 * secret in the output is masked before it is sent.
 */
import { createHash, randomBytes } from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import os from 'os';

import { Client } from 'ssh2';

import { sshInstallCommand } from './agent-scripts.js';

export const PROBE_TTL_MS = 5 * 60_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The slice of ssh2's Client this uses — a fake stands in under test. */
export interface SshStream {
  on(ev: 'data', fn: (d: Buffer) => void): SshStream;
  on(ev: 'close', fn: (code: number | null) => void): SshStream;
  stderr: { on(ev: 'data', fn: (d: Buffer) => void): unknown };
  write(s: string): unknown;
  end(): unknown;
}
export interface SshClient {
  on(ev: 'ready', fn: () => void): SshClient;
  on(ev: 'error', fn: (err: Error) => void): SshClient;
  on(ev: 'close', fn: () => void): SshClient;
  connect(cfg: Record<string, unknown>): unknown;
  exec(cmd: string, cb: (err: Error | undefined, stream: SshStream) => void): unknown;
  end(): unknown;
}
export type ClientFactory = () => SshClient;
const realClient: ClientFactory = () => new Client() as unknown as SshClient;

// ── where it may connect ──────────────────────────────────────────────────────

const v4 = (a: string): number[] | null => (net.isIPv4(a) ? a.split('.').map(Number) : null);

/** RFC 1918, the 100.64.0.0/10 tailnet range, or an IPv6 unique-local address. */
export function isPrivateTarget(a: string): boolean {
  const o = v4(a);
  if (o) {
    return (
      o[0] === 10 ||
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168) ||
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127)
    );
  }
  return net.isIPv6(a) && /^f[cd][0-9a-f]{2}:/i.test(a);
}

/** This machine's own addresses: joining itself as a machine is refused. */
export function ownAddresses(): Set<string> {
  const own = new Set<string>(['127.0.0.1', '::1']);
  try {
    for (const list of Object.values(os.networkInterfaces()))
      for (const i of list ?? []) own.add(i.address.toLowerCase().replace(/%.*$/, ''));
  } catch {
    /* no interfaces listed: the private check still applies */
  }
  return own;
}

export type Resolver = (host: string) => Promise<string[]>;
const realResolve: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** The one address to connect to, or why not: every address the name has must be private and not ours. */
export async function checkTarget(
  host: string,
  resolve: Resolver = realResolve,
  own: Set<string> = ownAddresses(),
): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const h = host.trim().replace(/^\[|\]$/g, '');
  if (!h || h.length > 253 || !/^[A-Za-z0-9.:_-]+$/.test(h)) return { ok: false, error: 'Bad host' };
  let addrs: string[];
  try {
    addrs = net.isIP(h) ? [h] : await resolve(h);
  } catch {
    return { ok: false, error: 'Host not found' };
  }
  if (!addrs.length) return { ok: false, error: 'Host not found' };
  for (const a of addrs.map((x) => x.toLowerCase())) {
    if (!isPrivateTarget(a)) return { ok: false, error: 'Private addresses only' };
    if (own.has(a)) return { ok: false, error: 'This is NanoClaw’s own host' };
  }
  return { ok: true, address: addrs[0] };
}

// ── step 1: probe ─────────────────────────────────────────────────────────────

export const fingerprint = (key: Buffer): string =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

interface Probe {
  userId: string;
  host: string;
  address: string;
  port: number;
  fingerprint: string;
  at: number;
}
const probes = new Map<string, Probe>();

export function __resetProbesForTest(): void {
  probes.clear();
}

/** Connect without authenticating and read the host key. */
export async function probeHost(
  opts: { userId: string; host: string; port: number },
  deps: { client?: ClientFactory; resolve?: Resolver; own?: Set<string>; now?: number } = {},
): Promise<{ ok: true; probeId: string; fingerprint: string; address: string } | { ok: false; error: string }> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) return { ok: false, error: 'Bad port' };
  const target = await checkTarget(opts.host, deps.resolve, deps.own);
  if (!target.ok) return target;
  const fp = await new Promise<string | null>((done) => {
    let seen: string | null = null;
    const c = (deps.client ?? realClient)();
    const finish = (): void => {
      clearTimeout(timer);
      done(seen);
    };
    const timer = setTimeout(() => {
      c.end();
      finish();
    }, CONNECT_TIMEOUT_MS);
    c.on('error', finish)
      .on('close', finish)
      .on('ready', () => {
        c.end();
        finish();
      });
    c.connect({
      host: target.address,
      port: opts.port,
      username: 'nanoclaw-probe',
      readyTimeout: CONNECT_TIMEOUT_MS,
      // Read the key, then refuse: nothing is authenticated in this step.
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key);
        return false;
      },
    });
  });
  if (!fp) return { ok: false, error: 'No SSH server answered' };
  const now = deps.now ?? Date.now();
  for (const [id, p] of probes) if (now - p.at > PROBE_TTL_MS) probes.delete(id);
  const probeId = randomBytes(16).toString('hex');
  probes.set(probeId, {
    userId: opts.userId,
    host: opts.host.trim(),
    address: target.address,
    port: opts.port,
    fingerprint: fp,
    at: now,
  });
  return { ok: true, probeId, fingerprint: fp, address: target.address };
}

// ── step 2: join ──────────────────────────────────────────────────────────────

export interface JoinSecrets {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}
export type JoinEvent = { t: 'out'; s: string } | { t: 'done'; ok: boolean; error?: string };

/** Mask every secret in a chunk of output (short ones are left: too likely to hit ordinary text). */
export function redact(s: string, secrets: Array<string | undefined>): string {
  let out = s;
  for (const x of secrets) if (x && x.length >= 4) out = out.split(x).join('***');
  return out;
}

/**
 * Run the installer over SSH for a confirmed probe. `mint` creates the join
 * token (and is only called once authenticated); `emit` gets output and the
 * result; `signal` aborts (the person cancelled or left).
 */
export async function joinHost(
  opts: { userId: string; probeId: string; confirmed: string; username: string; secrets: JoinSecrets },
  mint: () => Promise<{ host: string; port: number; pin: string; token: string }>,
  emit: (e: JoinEvent) => void,
  deps: { client?: ClientFactory; signal?: AbortSignal; now?: number; installTimeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string; host?: string; port?: number }> {
  const now = deps.now ?? Date.now();
  const probe = probes.get(opts.probeId);
  probes.delete(opts.probeId);
  const fail = (error: string, extra: { host?: string; port?: number } = {}) => {
    emit({ t: 'done', ok: false, error });
    return { ok: false, error, ...extra };
  };
  if (!probe || probe.userId !== opts.userId || now - probe.at > PROBE_TTL_MS) return fail('Connect again');
  if (opts.confirmed !== probe.fingerprint) return fail('Fingerprint not confirmed');
  const username = opts.username.trim();
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(username)) return fail('Bad username', probe);
  const { password, privateKey, passphrase } = opts.secrets;
  if (!password && !privateKey) return fail('Password or key needed', probe);
  const secrets = [password, passphrase];

  return await new Promise((done) => {
    const c = (deps.client ?? realClient)();
    let settled = false;
    let keyMismatch = false;
    let installTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(installTimer);
      deps.signal?.removeEventListener('abort', onAbort);
      c.end();
      emit(ok ? { t: 'done', ok: true } : { t: 'done', ok: false, error });
      done({ ok, error, host: probe.host, port: probe.port });
    };
    const onAbort = (): void => settle(false, 'Cancelled');
    if (deps.signal?.aborted) return settle(false, 'Cancelled');
    deps.signal?.addEventListener('abort', onAbort);
    c.on('error', (err) => {
      if (keyMismatch) return settle(false, 'Host key changed');
      const m = String(err?.message ?? '');
      settle(
        false,
        /authentication/i.test(m) ? 'Sign-in refused' : /timed? ?out/i.test(m) ? 'Timed out' : 'Connection failed',
      );
    });
    c.on('close', () => settle(false, 'Connection closed'));
    c.on('ready', () => {
      void mint().then(
        (m) => {
          if (settled) return;
          const cmd = sshInstallCommand(m.host, m.port, m.pin, m.token, password ? 'password' : 'none');
          c.exec(cmd, (err, stream) => {
            if (err || !stream) return settle(false, 'Could not run the installer');
            installTimer = setTimeout(() => settle(false, 'Timed out'), deps.installTimeoutMs ?? INSTALL_TIMEOUT_MS);
            let sudoNeedsPassword = false;
            const out = (d: Buffer): void => {
              const s = redact(d.toString('utf-8'), secrets);
              if (/a password is required/i.test(s)) sudoNeedsPassword = true;
              emit({ t: 'out', s });
            };
            stream.on('data', out);
            stream.stderr.on('data', out);
            stream.on('close', (code) => {
              if (code === 0) settle(true);
              else
                settle(false, sudoNeedsPassword ? 'sudo needs a password' : `Installer failed (exit ${code ?? '?'})`);
            });
            // sudo reads this line only if it asks; the installer's stdin is /dev/null.
            if (password) stream.write(`${password}\n`);
            stream.end();
          });
        },
        () => settle(false, 'Could not create a join token'),
      );
    });
    c.connect({
      host: probe.address,
      port: probe.port,
      username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      tryKeyboard: false,
      ...(privateKey ? { privateKey, ...(passphrase ? { passphrase } : {}) } : {}),
      ...(password ? { password } : {}),
      hostVerifier: (key: Buffer) => {
        if (fingerprint(key) === probe.fingerprint) return true;
        keyMismatch = true;
        return false;
      },
    });
  });
}
