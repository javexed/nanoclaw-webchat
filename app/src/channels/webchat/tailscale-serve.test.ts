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
    // Verbatim stderr from tailscale 1.92.5 (snap). Relaying the line it
    // suggests looks helpful and is not: `--operator=$USER` is a shell
    // variable, and nothing expands it on the way to a web page — so the hint
    // would swap one unexpanded placeholder for another. This asserts we
    // answer with a name someone can actually paste.
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
