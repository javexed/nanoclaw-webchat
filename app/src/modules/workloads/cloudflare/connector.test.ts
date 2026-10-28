/**
 * The connector's `docker run` arguments, as a dry run: hardening, the edge
 * network at its fixed address, the token as a file and nowhere else.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-conn-'));
vi.mock('../../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../../config.js')>()),
  DATA_DIR: DATA,
}));

const { connectorArgs, tokenDir, writeTokenFile, TOKEN_FILE } = await import('./connector.js');
const { cloudflareSettings } = await import('./config.js');

const VARS: Record<string, string> = {
  NANOCLAW_WORKLOAD_CLOUDFLARE: '1',
  NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN: 'example-apps.net',
  NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID: 'b'.repeat(32),
  NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN: 'team.cloudflareaccess.com',
};
const s = cloudflareSettings((k) => VARS[k], {});
if (!s.on || !s.ok) throw new Error('settings');
const cfg = s.cfg;
const TUNNEL = '11111111-2222-4333-8444-555555555555';

describe('the connector container', () => {
  const args = connectorArgs({ cfg, tunnelId: TUNNEL, uid: 1000, gid: 1000 });
  const opt = (flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

  it('is hardened like the sidecars', () => {
    expect(opt('--cap-drop')).toEqual(['ALL']);
    expect(opt('--security-opt')).toEqual(['no-new-privileges']);
    expect(args).toContain('--read-only');
    expect(opt('--user')).toEqual(['1000:1000']);
    expect(opt('--pids-limit')).toEqual(['128']);
    expect(opt('--memory')).toEqual(['256m']);
    expect(opt('--log-opt')).toEqual(['max-size=10m', 'max-file=3']);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--cap-add');
  });

  it('sits on the edge network at its fixed address, never the host network', () => {
    expect(opt('--network')).toEqual([expect.stringMatching(/^nc-tsedge-/)]);
    expect(opt('--ip')).toEqual(['198.51.100.239']);
    expect(args.join(' ')).not.toMatch(/--network host|-p |--publish/);
  });

  it('runs the pinned image, no autoupdate, metrics on its own loopback, remote diagnostics off', () => {
    const image = args.indexOf(cfg.image);
    expect(image).toBeGreaterThan(0);
    expect(args.slice(image + 1)).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--edge-ip-version',
      '4',
      '--metrics',
      '127.0.0.1:20241',
      '--management-diagnostics=false',
      '--loglevel',
      'info',
      'run',
      '--token-file',
      '/run/cf/token',
    ]);
  });

  it('gets the token as a read-only mounted 0600 file: no -e, no --token', () => {
    expect(opt('-v')).toEqual([`${tokenDir()}:/run/cf:ro`]);
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--env');
    expect(args).not.toContain('--token');
    writeTokenFile('eyJ'.padEnd(120, 'A'));
    const f = path.join(tokenDir(), TOKEN_FILE);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(tokenDir()).mode & 0o777).toBe(0o700);
    expect(() => writeTokenFile('not a token\n')).toThrow(/unexpected shape/);
  });

  it('refuses a tunnel id or address that is not the expected shape', () => {
    expect(() => connectorArgs({ cfg, tunnelId: 'x; rm -rf /', uid: 1, gid: 1 })).toThrow();
    expect(() => connectorArgs({ cfg: { ...cfg, connector: '10.0.0.5' }, tunnelId: TUNNEL, uid: 1, gid: 1 })).toThrow();
  });
});
