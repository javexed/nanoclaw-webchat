/**
 * The sidecar's `docker run` arguments, serve config and auth-key file, as a
 * dry run: what would be handed to Docker, checked for what must never be
 * there (TUN, NET_ADMIN, the host network, Funnel, the key itself).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { tailnetSettings } from './config.js';
import {
  assertNoFunnel,
  KEY_FILE,
  prepareDir,
  removeKeyFile,
  runArgs,
  serveConfig,
  specHash,
  writeKeyFile,
  type SidecarSpec,
} from './sidecar.js';

const st = tailnetSettings((k) =>
  k === 'NANOCLAW_WORKLOAD_TAILNET' ? '1' : k === 'NANOCLAW_WORKLOAD_TAILNET_DOMAIN' ? 'tail1.ts.net' : undefined,
);
if (!st.on || !st.ok) throw new Error('settings');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-sidecar-'));
const spec: SidecarSpec = {
  routeId: '0b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11',
  app: 'notes',
  address: '198.51.100.2',
  cfg: st.cfg,
  gatewayPort: 8470,
  dir,
  uid: 1000,
  gid: 1000,
};
const KEY = 'tskey-auth-kAbCdEf1CNTRL-0123456789abcdef';

describe('sidecar run arguments', () => {
  const args = runArgs(spec);
  const joined = args.join(' ');
  const env = (name: string) =>
    args
      .find((a) => a.startsWith(`${name}=`))
      ?.split('=')
      .slice(1)
      .join('=');

  it('never asks for a TUN device, NET_ADMIN, privileges or the host’s namespaces', () => {
    expect(joined).not.toMatch(/\/dev\/net\/tun|--device|NET_ADMIN|NET_RAW|SYS_ADMIN|--privileged|--cap-add/);
    expect(joined).not.toMatch(/--network[ =]host|--pid[ =]|--ipc|--userns|--uts/);
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--read-only']));
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  });

  it('puts it on the edge network at its fixed address, never a workload network', () => {
    expect(args[args.indexOf('--network') + 1]).toMatch(/^nc-tsedge-/);
    expect(args[args.indexOf('--ip') + 1]).toBe('198.51.100.2');
    expect(() => runArgs({ ...spec, address: '198.18.0.10' })).toThrow(/outside the edge network/);
  });

  it('runs tailscaled in userspace mode with its own state and socket, nothing listening', () => {
    expect(env('TS_USERSPACE')).toBe('true');
    expect(env('TS_STATE_DIR')).toBe('/var/lib/tailscale');
    expect(env('TS_SOCKET')).toBe('/tmp/tailscaled.sock');
    expect(env('TS_ENABLE_METRICS')).toBe('false');
    expect(env('TS_ENABLE_HEALTH_CHECK')).toBe('false');
    expect(env('TS_LOCAL_ADDR_PORT')).toBe('127.0.0.1:9002');
    expect(env('TS_HOSTNAME')).toBe('notes');
    expect(env('TS_EXTRA_ARGS')).toBe('--advertise-tags=tag:nanoclaw-app');
    expect(joined).not.toMatch(/TS_SOCKS5|TS_OUTBOUND_HTTP_PROXY|TS_ROUTES|TS_DEST_IP|advertise-exit-node/);
  });

  it('hands over the auth key as a file path, used once; the key is never an argument', () => {
    expect(env('TS_AUTHKEY')).toBe(`file:/run/ts-key/${KEY_FILE}`);
    expect(env('TS_AUTH_ONCE')).toBe('true');
    expect(args).toContain(`${dir}/key:/run/ts-key:ro`);
    expect(joined).not.toMatch(/tskey-/);
  });

  it('pins the image by digest and hashes the arguments for drift', () => {
    expect(args[args.length - 1]).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(specHash(args)).toBe(specHash(runArgs(spec)));
    expect(specHash(args)).not.toBe(specHash(runArgs({ ...spec, address: '198.51.100.3' })));
  });
});

describe('serve config', () => {
  it('serves HTTPS on 443 for the device’s own name to the gateway, without Funnel', () => {
    const cfg = serveConfig('198.51.100.1', 8470);
    expect(cfg).toEqual({
      TCP: { '443': { HTTPS: true } },
      Web: { '${TS_CERT_DOMAIN}:443': { Handlers: { '/': { Proxy: 'http://198.51.100.1:8470' } } } },
    });
    expect(JSON.stringify(cfg)).not.toMatch(/funnel/i);
  });

  it('refuses any Funnel setting', () => {
    expect(() => assertNoFunnel({ AllowFunnel: { 'notes.tail1.ts.net:443': true } })).toThrow(/Funnel/);
    expect(() => assertNoFunnel({ Web: { x: { Funnel: true } } })).toThrow(/Funnel/);
    expect(() => assertNoFunnel({ AllowFunnel: {} })).not.toThrow();
  });

  it('is written 0600 in 0700 folders', () => {
    prepareDir(spec);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'key')).mode & 0o777).toBe(0o700);
    const f = path.join(dir, 'serve', 'serve.json');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual(serveConfig('198.51.100.1', 8470));
  });
});

describe('the auth key file', () => {
  it('is 0600, holds the key alone, and is gone after removal', () => {
    prepareDir(spec);
    writeKeyFile(dir, KEY);
    const f = path.join(dir, 'key', KEY_FILE);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(f, 'utf8')).toBe(KEY);
    removeKeyFile(dir);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('refuses a value that is not an auth key', () => {
    expect(() => writeKeyFile(dir, 'tskey-client-abc')).toThrow(/unexpected shape/);
    expect(() => writeKeyFile(dir, `${KEY}\nTS_EXTRA_ARGS=x`)).toThrow(/unexpected shape/);
  });
});
