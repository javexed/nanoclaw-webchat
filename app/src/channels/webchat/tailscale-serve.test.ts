/**
 * Tests for the `tailscale serve` control module — state probing and the
 * failure-classification that drives the "Enable HTTPS over Tailscale" UI.
 * All tailscale calls go through an injected runner, so no daemon is needed.
 */
import { describe, it, expect } from 'vitest';
import os from 'os';

import {
  getTailscaleServeState,
  enableTailscaleServe,
  serveMigrationCommands,
  servePortFor,
  serveRouting,
  serveUrlForPort,
  tailnetUrlForPort,
  type RunResult,
  type TailscaleRunner,
} from './tailscale-serve.js';

const ok = (stdout = ''): RunResult => ({ ok: true, notFound: false, stdout, stderr: '' });
const fail = (stderr = '', stdout = ''): RunResult => ({ ok: false, notFound: false, stdout, stderr });

/** Build a runner that dispatches on the first arg / subcommand. */
function runner(map: Partial<Record<string, RunResult>>, fallback: RunResult = fail('unmapped')): TailscaleRunner {
  return async (args) => {
    const key = args.join(' ');
    return map[key] ?? fallback;
  };
}

const STATUS_UP = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'node.tailnet.ts.net.' } });

describe('getTailscaleServeState', () => {
  it('reports available + url + active from a running daemon with a serve mapping', async () => {
    const state = await getTailscaleServeState(
      runner({
        'status --json': ok(STATUS_UP),
        'serve status --json': ok(JSON.stringify({ Web: { 'node.tailnet.ts.net:443': {} } })),
      }),
    );
    expect(state).toEqual({ available: true, active: true, url: 'https://node.tailnet.ts.net' });
  });

  it('strips the trailing dot from the MagicDNS name', async () => {
    const state = await getTailscaleServeState(
      runner({ 'status --json': ok(STATUS_UP), 'serve status --json': ok('{}') }),
    );
    expect(state.url).toBe('https://node.tailnet.ts.net');
    expect(state.active).toBe(false);
  });

  it('reports unavailable when `tailscale status` fails', async () => {
    const state = await getTailscaleServeState(runner({ 'status --json': fail('stopped') }));
    expect(state).toEqual({ available: false, active: false, url: null });
  });

  it('still reports available when the serve-status subcommand is unsupported (older CLI)', async () => {
    const state = await getTailscaleServeState(
      runner({ 'status --json': ok(STATUS_UP), 'serve status --json': fail('unknown flag: --json') }),
    );
    expect(state).toEqual({ available: true, active: false, url: 'https://node.tailnet.ts.net' });
  });
});

describe('enableTailscaleServe', () => {
  it('refuses when tailscale is down', async () => {
    const r = await enableTailscaleServe(3100, runner({ 'status --json': fail('stopped') }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not running or not logged in/i);
  });

  it('runs `serve --bg <port>` and returns the https url on success', async () => {
    const r = await enableTailscaleServe(
      3100,
      runner({
        'status --json': ok(STATUS_UP),
        'serve status --json': ok('{}'),
        'serve --bg 3100': ok(''),
      }),
    );
    expect(r).toEqual({ ok: true, url: 'https://node.tailnet.ts.net' });
  });

  it('classifies the certs-not-enabled failure with the admin link', async () => {
    const r = await enableTailscaleServe(
      3100,
      runner({
        'status --json': ok(STATUS_UP),
        'serve status --json': ok('{}'),
        'serve --bg 3100': fail('HTTPS is not enabled on the tailnet; enable it in the admin console'),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/certificates are not enabled/i);
    expect(r.hint).toMatch(/HTTPS Certificates/);
    expect(r.hint).toMatch(/Enable HTTPS/);
    expect(r.hintUrl).toBe('https://console.tailscale.com/admin/dns');
  });

  it('classifies a permission / operator failure', async () => {
    const r = await enableTailscaleServe(
      3100,
      runner({
        'status --json': ok(STATUS_UP),
        'serve status --json': ok('{}'),
        'serve --bg 3100': fail('access denied: this operation requires operator access'),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/operator/i);
    // No placeholder left for the operator to decode, and sudo is spelled out:
    // the hint has to be a command someone can paste at the exact moment they
    // are least equipped to guess the missing pieces.
    expect(r.hint).not.toMatch(/<user>/);
    expect(r.hint).toMatch(/sudo/);
  });

  it("resolves the username rather than relaying the daemon's $USER", async () => {
    // Verbatim stderr from tailscale 1.92.5 (snap). Its `--operator=$USER` is
    // unexpanded on a web page; assert we answer with a pasteable name.
    const real = [
      'sending serve config: Access denied: serve config denied',
      '',
      "Use 'sudo tailscale --socket /var/snap/tailscale/common/socket/tailscaled.sock serve --bg 3100'.",
      "To not require root, use 'sudo tailscale set --operator=$USER' once.",
    ].join('\n');
    const r = await enableTailscaleServe(
      3100,
      runner({ 'status --json': ok(STATUS_UP), 'serve status --json': ok('{}'), 'serve --bg 3100': fail(real) }),
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('sudo tailscale set --operator=');
    expect(r.hint).not.toContain('$USER');
    expect(r.hint).toMatch(new RegExp(`--operator=${os.userInfo().username}\\b`));
  });

  it('handles a missing tailscale binary', async () => {
    const notFound: RunResult = { ok: false, notFound: true, stdout: '', stderr: '' };
    const r = await enableTailscaleServe(
      3100,
      runner({ 'status --json': ok(STATUS_UP), 'serve status --json': ok('{}'), 'serve --bg 3100': notFound }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not installed/i);
  });
});

describe('the tailnet address of this install', () => {
  // Two installs on one machine: 443 fronts another one, 8443 fronts ours.
  const SERVE = JSON.stringify({
    TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
    Web: {
      'node-1.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3100' } } },
      'node-1.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3101' } } },
    },
  });

  it("finds the Serve mapping for THIS port, leaving another install's alone", () => {
    expect(serveUrlForPort(SERVE, 3101)).toBe('https://node-1.example.ts.net:8443');
    expect(serveUrlForPort(SERVE, 3100)).toBe('https://node-1.example.ts.net');
    expect(serveUrlForPort(SERVE, 3999)).toBeNull();
    expect(serveUrlForPort('not json', 3101)).toBeNull();
  });

  it('falls back to the node name on the tailnet when webchat itself listens there', async () => {
    const runner: TailscaleRunner = async (args) =>
      args[0] === 'serve'
        ? { ok: true, notFound: false, stdout: '{}', stderr: '' }
        : {
            ok: true,
            notFound: false,
            stdout: JSON.stringify({ Self: { DNSName: 'node-1.example.ts.net.' } }),
            stderr: '',
          };
    expect(await tailnetUrlForPort(3101, true, runner)).toBe('http://node-1.example.ts.net:3101');
    // Bound to loopback only: the tailnet cannot reach it without Serve.
    expect(await tailnetUrlForPort(3101, false, runner)).toBeNull();
  });

  it('prefers Serve (HTTPS) over the plain tailnet address', async () => {
    const runner: TailscaleRunner = async (args) =>
      args[0] === 'serve'
        ? { ok: true, notFound: false, stdout: SERVE, stderr: '' }
        : {
            ok: true,
            notFound: false,
            stdout: JSON.stringify({ Self: { DNSName: 'node-1.example.ts.net.' } }),
            stderr: '',
          };
    expect(await tailnetUrlForPort(3101, true, runner)).toBe('https://node-1.example.ts.net:8443');
  });
});

describe('the dedicated Serve listener', () => {
  it('takes WEBCHAT_SERVE_PORT, else main + 10000, and can be turned off', () => {
    expect(servePortFor(3100, {})).toBe(13100);
    expect(servePortFor(3100, { WEBCHAT_SERVE_PORT: '3199' })).toBe(3199);
    expect(servePortFor(3100, { WEBCHAT_SERVE_PORT: 'off' })).toBeNull();
    expect(servePortFor(3100, { WEBCHAT_SERVE_PORT: '0' })).toBeNull();
    expect(servePortFor(3100, { WEBCHAT_SERVE_PORT: '3100' })).toBeNull(); // the main port itself
    expect(servePortFor(3100, { WEBCHAT_SERVE_PORT: '70000' })).toBeNull();
    expect(servePortFor(60000, {})).toBeNull(); // out of range
    expect(servePortFor(0, {})).toBeNull(); // ephemeral main port
  });

  const legacy = JSON.stringify({
    Web: { 'node-1.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3100' } } } },
  });
  const moved = JSON.stringify({
    Web: { 'node-1.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:13100' } } } },
  });
  const otherPort = JSON.stringify({
    Web: { 'node-1.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3100' } } } },
  });

  it('names the command that moves Serve off the main port', () => {
    expect(serveMigrationCommands(legacy, 3100, 13100)).toEqual(['tailscale serve --bg --https=443 13100']);
    expect(serveMigrationCommands(otherPort, 3100, 13100)).toEqual(['tailscale serve --bg --https=8443 13100']);
    expect(serveMigrationCommands(moved, 3100, 13100)).toEqual([]);
    expect(serveMigrationCommands('{}', 3100, 13100)).toEqual([]);
  });

  it('reports the legacy names only while Serve proxies to the main port', async () => {
    const at =
      (json: string): TailscaleRunner =>
      async () =>
        ok(json);
    const before = await serveRouting(3100, 13100, at(legacy));
    expect(before.dedicated).toBe(false);
    expect([...before.legacyHosts]).toEqual(['node-1.example.ts.net']);
    // Different port pair → not served from the cache above.
    const after = await serveRouting(3100, 13101, at(legacy.replace('3100', '13101')));
    expect(after.dedicated).toBe(true);
    expect(after.legacyHosts.size).toBe(0);
  });

  // Serve forwards Host with its port when the front is not on 443; the bare
  // name matched nothing there, so a runner behind :8443 got 401 on upgrade.
  it('names a front on another port as Host carries it, port included', async () => {
    const routing = await serveRouting(3100, 13102, async () => ok(otherPort));
    expect([...routing.legacyHosts]).toEqual(['node-1.example.ts.net:8443']);
  });

  it('finds the HTTPS address whichever of our ports Serve proxies to', () => {
    expect(serveUrlForPort(moved, [13100, 3100])).toBe('https://node-1.example.ts.net');
    expect(serveUrlForPort(legacy, [13100, 3100])).toBe('https://node-1.example.ts.net');
    expect(serveUrlForPort(otherPort, [13100, 3100])).toBe('https://node-1.example.ts.net:8443');
  });
});
