/**
 * Admin → Publishing's words and checks: status lines in a few words with the
 * full reason kept for a tooltip, the Workloads and Confined builds lines with
 * the command that fixes what is missing, and what the owner types refused per
 * field.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { OFF_REASON, type PreflightResult } from './preflight.js';
import {
  applyWorkloads,
  buildsStatus,
  SettingRefused,
  shortReason,
  statusLine,
  validateCloudflare,
  validateTailnet,
  workloadsStatus,
} from './publishing-settings.js';

describe('the Workloads and Confined builds lines', () => {
  const ROOT = '/srv/nanoclaw';
  const SLICE = 'nanoclaw-wl-abc.slice';
  const failed = (reason: string, isolationOpen = false): PreflightResult => ({
    ok: false,
    reason,
    isolationOpen,
    at: 1,
  });
  const st = (p: PreflightResult | null, running = false) => workloadsStatus(true, p, running, ROOT, SLICE);

  it('Off, Checking… until a check has run since it was turned on, then Ready', () => {
    expect(workloadsStatus(false, null, false, ROOT, SLICE)).toMatchObject({ text: 'Off', ok: false, fix: '' });
    expect(st(null)).toMatchObject({ text: 'Checking…', checking: true });
    expect(st(failed(OFF_REASON))).toMatchObject({ text: 'Checking…', checking: true });
    expect(st({ ok: true, reason: '', isolationOpen: false, at: 1 })).toMatchObject({
      text: 'Ready',
      ok: true,
      checking: false,
      fix: '',
    });
  });

  it('names what is missing in a few words, with the one command that fixes it', () => {
    const rules = st(
      failed(
        'workload containers can reach this host: the host rules are missing (run deploy/workloads-host-rules.sh --install-unit as root)',
        true,
      ),
    );
    expect(rules).toMatchObject({
      text: 'Host rules missing',
      fix: 'sudo bash /srv/nanoclaw/deploy/workloads-host-rules.sh --install-unit',
    });
    expect(rules.detail).toMatch(/^Workload containers can reach this host/);
    expect(
      st(
        failed(
          `the workload slice ${SLICE} does not exist: run deploy/workloads-slice.sh --name ${SLICE} --memory <size> as root`,
        ),
      ),
    ).toMatchObject({
      text: 'Slice missing',
      fix: `sudo bash /srv/nanoclaw/deploy/workloads-slice.sh --name ${SLICE} --memory 8G`,
    });
    expect(st(failed(`${SLICE} has no memory ceiling (MemoryMax)`)).text).toBe('Slice missing');
    expect(st(failed('docker compose is not installed on this host')).text).toBe('Docker Compose missing');
    expect(st(failed('docker buildx is not installed on this host')).fix).toMatch(/docker-buildx-plugin/);
    expect(st(failed('the workload isolation check could not run: no docker'))).toMatchObject({
      text: 'Check failed',
      fix: '',
    });
    expect(st(failed('something new'))).toMatchObject({ text: 'Not available', detail: 'Something new' });
  });

  it('a failure being checked again keeps its words and asks the page to look again', () => {
    expect(st(failed('docker compose is not installed on this host'), true)).toMatchObject({
      text: 'Docker Compose missing',
      checking: true,
    });
  });

  it('confined builds: Off, gVisor missing with the script, or Ready', () => {
    expect(buildsStatus(false, false, ROOT).text).toBe('Off');
    expect(buildsStatus(true, false, ROOT)).toMatchObject({
      text: 'gVisor missing',
      fix: 'bash /srv/nanoclaw/deploy/install-gvisor.sh',
    });
    expect(buildsStatus(true, true, ROOT)).toMatchObject({ text: 'Ready', ok: true });
  });

  it('the switches are their .env keys; switching workloads on checks the host at once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-switch-'));
    try {
      const env: NodeJS.ProcessEnv = {};
      let checks = 0;
      const check = async () => void checks++;
      await applyWorkloads(root, { on: true, confinedBuilds: true }, env, check);
      expect(env).toMatchObject({ NANOCLAW_WORKLOADS: '1', NANOCLAW_WORKLOAD_CONFINED_BUILDS: '1' });
      expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).toMatch(/^NANOCLAW_WORKLOADS=1$/m);
      expect(checks).toBe(1);
      await applyWorkloads(root, { confinedBuilds: false }, env, check);
      expect(env.NANOCLAW_WORKLOAD_CONFINED_BUILDS).toBeUndefined();
      expect(checks).toBe(1);
      await applyWorkloads(root, { on: false }, env, check);
      expect(env.NANOCLAW_WORKLOADS).toBeUndefined();
      expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).not.toMatch(/NANOCLAW_WORKLOADS=/);
      await expect(applyWorkloads(root, { on: 'yes' }, env, check)).rejects.toMatchObject({ field: 'on' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('status lines', () => {
  it('Connected, Off, Not connected, or the one thing missing in a few words', () => {
    expect(statusLine('tailnet', { state: 'connected', warnings: [] })).toMatchObject({ text: 'Connected', ok: true });
    expect(statusLine('tailnet', { state: 'off', warnings: [] }).text).toBe('Off');
    const vault = statusLine('tailnet', {
      state: 'missing',
      missing: 'the Tailscale OAuth client is not in the vault (Connect)',
      warnings: [],
    });
    expect(vault).toMatchObject({ text: 'Not connected', needsConnect: true });
    expect(vault.detail).toBe('The Tailscale OAuth client is not in the vault (Connect)');
  });

  it('never says vault or (Connect), and stays short', () => {
    const reasons = [
      'NANOCLAW_WORKLOAD_TAILNET_DOMAIN is not set (your tailnet’s DNS name, e.g. tail1234.ts.net)',
      'the host rules for the edge network are missing (sudo deploy/workloads-host-rules.sh --gateway 198.51.100.1:8470 --install-unit)',
      'the app gateway must listen on the edge address: set NANOCLAW_WORKLOAD_GATEWAY_BIND=198.51.100.1',
      'the app gateway is off (set NANOCLAW_WORKLOAD_GATEWAY_PORT)',
      'workloads are off on this host (NANOCLAW_WORKLOADS=1)',
      'the nanoclaw-cloudflare identity is missing in OneCLI (Connect again)',
      '2 OneCLI identities are in "all" secret mode and would be given the Cloudflare API token too: switch them to selective',
      'the app domain apps.example.com is the same site as NanoClaw’s own chat.example.com (both under example.com): use a different registrable domain',
      'HTTP 403 from api.cloudflare.com',
    ];
    const got = reasons.map((r) => shortReason('cloudflare', r));
    expect(got).toEqual([
      'Tailnet name missing',
      'Host rules missing',
      'App gateway bind address wrong',
      'App gateway off',
      'Workloads off',
      'Not connected',
      'OneCLI identities in all mode',
      'App domain is NanoClaw’s own site',
      'Cloudflare API not answering',
    ]);
    for (const t of got) {
      expect(t).not.toMatch(/vault|\(Connect\)/i);
      expect(t.split(' ').length).toBeLessThanOrEqual(6);
    }
  });

  it('warnings are short too, with the full text kept', () => {
    const s = statusLine('cloudflare', { state: 'connected', warnings: ['the tunnel is degraded'] });
    expect(s.warnings).toEqual([{ text: 'Tunnel not healthy', detail: 'The tunnel is degraded' }]);
  });
});

describe('what the owner types', () => {
  it('a tailnet name', () => {
    expect(validateTailnet({ on: true, domain: 'Tail1234.ts.net.' })).toEqual({ on: true, domain: 'tail1234.ts.net' });
    expect(() => validateTailnet({ domain: 'example.com' })).toThrow(SettingRefused);
    expect(() => validateTailnet({ on: 'yes' })).toThrow(SettingRefused);
  });

  it('a Cloudflare app domain on NanoClaw’s own site is refused under the field', () => {
    try {
      validateCloudflare({ domain: 'apps.example.com' }, ['chat.example.com']);
      throw new Error('not refused');
    } catch (err) {
      expect(err).toBeInstanceOf(SettingRefused);
      expect((err as SettingRefused).field).toBe('domain');
      expect((err as SettingRefused).message).toBe('Same site as NanoClaw (example.com)');
    }
    expect(validateCloudflare({ domain: 'example-apps.net' }, ['chat.example.com'])).toEqual({
      domain: 'example-apps.net',
    });
  });

  it('IDs and the team domain', () => {
    expect(validateCloudflare({ accountId: 'A'.repeat(32) }, [])).toEqual({ accountId: 'a'.repeat(32) });
    expect(() => validateCloudflare({ zoneId: 'xyz' }, [])).toThrow(/zone ID/);
    expect(validateCloudflare({ teamDomain: 'https://Team.cloudflareaccess.com/' }, [])).toEqual({
      teamDomain: 'team.cloudflareaccess.com',
    });
    expect(() => validateCloudflare({ teamDomain: 'team.example.com' }, [])).toThrow(SettingRefused);
  });
});
