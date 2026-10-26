import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COPILOT_API_SECRET,
  COPILOT_CREDENTIAL_PLACEHOLDER,
  COPILOT_GITHUB_SECRET,
  LOGIN_DIR_PREFIX,
  accountRecordPath,
  connectCopilot,
  copilotApiTarget,
  copilotGitHubTarget,
  extractCopilotToken,
  lastCopilotLogin,
  parseCopilotAccount,
  parseDevicePrompt,
  type CopilotLoginDeps,
  type CopilotLoginEvent,
} from './copilot-login.js';

// A real-looking token shape so the extractor accepts it; obviously fake.
const TOKEN = 'gho_FAKEfakeFAKEfakeFAKEfake0123456789'; // leak-scan-allow

describe('parseCopilotAccount', () => {
  it.each([
    ['individual', 'https://api.individual.githubcopilot.com'],
    ['business', 'https://api.business.githubcopilot.com'],
    ['enterprise', 'https://api.enterprise.githubcopilot.com/'],
  ])('returns the %s endpoint origin', (plan, api) => {
    expect(parseCopilotAccount({ copilot_plan: plan, chat_enabled: true, endpoints: { api } })).toEqual({
      apiUrl: new URL(api).origin,
      plan,
    });
  });

  it('rejects missing, non-HTTPS, and chat-disabled accounts', () => {
    expect(() => parseCopilotAccount({})).toThrow('did not return');
    expect(() => parseCopilotAccount({ endpoints: { api: 'http://api.business.githubcopilot.com' } })).toThrow('HTTPS');
    expect(() =>
      parseCopilotAccount({ chat_enabled: false, endpoints: { api: 'https://api.business.githubcopilot.com' } }),
    ).toThrow('disabled');
  });
});

describe('lastCopilotLogin', () => {
  it('reads the last github.com login from the commented CLI config', () => {
    const config = `// managed automatically\n{"lastLoggedInUser": {"host": "https://github.com", "login": "octo"}}`;
    expect(lastCopilotLogin(config)).toBe('octo');
  });

  it('ignores logins on other hosts', () => {
    expect(lastCopilotLogin('{"lastLoggedInUser": {"host": "https://ghe.example", "login": "octo"}}')).toBeUndefined();
  });
});

describe('copilotApiTarget', () => {
  it('scopes the token host-wide to the licensed API host with a bearer header', () => {
    expect(copilotApiTarget('https://api.business.githubcopilot.com')).toEqual({
      name: COPILOT_API_SECRET,
      kind: 'api-key',
      host: 'api.business.githubcopilot.com',
      proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
      provider: 'copilot',
      injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
  });

  it('names the provider so per-agent gateways grant it to Copilot groups', () => {
    expect(copilotApiTarget('https://api.individual.githubcopilot.com').provider).toBe('copilot');
  });

  it('uses the placeholder the container provider sends', () => {
    // scripts/ and container/ are siblings both in the payload and once installed.
    const source = path.join(import.meta.dirname, '..', 'container', 'agent-runner', 'src', 'providers', 'copilot.ts');
    expect(fs.readFileSync(source, 'utf8')).toContain(
      `COPILOT_GATEWAY_PLACEHOLDER = '${COPILOT_CREDENTIAL_PLACEHOLDER}'`,
    );
  });
});

describe('copilotGitHubTarget', () => {
  it('limits api.github.com to the one Copilot path, for the copilot provider', () => {
    expect(copilotGitHubTarget()).toEqual({
      name: COPILOT_GITHUB_SECRET,
      kind: 'api-key',
      host: 'api.github.com',
      path: '/copilot_internal/user',
      proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
      provider: 'copilot',
      injection: { headerName: 'Authorization', valueFormat: 'token {value}' },
    });
  });
});

describe('parseDevicePrompt', () => {
  it('reads the URL and code the CLI prints (captured from CLI 1.0.103)', () => {
    const out =
      'To authenticate, visit https://github.com/login/device and enter code 1743-CF8F\n' +
      'Waiting for authorization...\n';
    expect(parseDevicePrompt(out)).toEqual({
      verificationUrl: 'https://github.com/login/device',
      userCode: '1743-CF8F',
    });
  });

  it('survives colour codes and reports nothing for unrelated output', () => {
    expect(parseDevicePrompt('\x1b[1mhttps://github.com/login/device\x1b[0m code \x1b[32mABCD-1234\x1b[0m')).toEqual({
      verificationUrl: 'https://github.com/login/device',
      userCode: 'ABCD-1234',
    });
    expect(parseDevicePrompt('Waiting for authorization...')).toEqual({});
  });
});

describe('extractCopilotToken', () => {
  it('takes the last-logged-in user entry from copilotTokens', () => {
    const config = `// comment\n${JSON.stringify({
      lastLoggedInUser: { host: 'https://github.com', login: 'octo' },
      copilotTokens: { 'https://github.com:someone': 'gho_other0000', 'https://github.com:octo': TOKEN },
    })}`;
    expect(extractCopilotToken(config)).toEqual({ token: TOKEN, login: 'octo' });
  });

  it('accepts a lone entry, or one object-wrapped token', () => {
    expect(extractCopilotToken(JSON.stringify({ copilotTokens: { any: TOKEN } }))).toEqual({
      token: TOKEN,
      login: null,
    });
    expect(extractCopilotToken(JSON.stringify({ copilotTokens: { any: { token: TOKEN } } }))?.token).toBe(TOKEN);
  });

  it('falls back to a single token-shaped value, never guessing between several', () => {
    expect(extractCopilotToken(JSON.stringify({ somewhere: { deep: TOKEN } }))?.token).toBe(TOKEN);
    expect(extractCopilotToken(JSON.stringify({ a: TOKEN, b: 'gho_another000000' }))).toBeNull();
  });

  it('returns null for an empty, unparseable or token-less config', () => {
    expect(extractCopilotToken('')).toBeNull();
    expect(extractCopilotToken('{not json')).toBeNull();
    expect(extractCopilotToken(JSON.stringify({ storeTokenPlaintext: true }))).toBeNull();
  });
});

// ── The device flow, end to end against a fake CLI ──────────────────────────
// The fake is a real child process: it prints the device prompt the way the
// CLI does, then (per mode) writes a plaintext config into COPILOT_HOME.
const FAKE_CLI = `
const fs = require('fs');
const path = require('path');
const [home, mode, token] = process.argv.slice(2);
process.stdout.write('To authenticate, visit https://github.com/login/device and enter code 1743-CF8F\\n');
process.stderr.write('Waiting for authorization...\\n');
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
setTimeout(() => {
  if (mode === 'fail') process.exit(3);
  const config = { storeTokenPlaintext: true, lastLoggedInUser: { host: 'https://github.com', login: 'octo' } };
  if (mode !== 'notoken') config.copilotTokens = { 'https://github.com:octo': token };
  fs.writeFileSync(path.join(home, 'config.json'), '// managed\\n' + JSON.stringify(config));
  process.exit(0);
}, 50);
`;

describe('connectCopilot', () => {
  let dir: string;
  let fake: string;
  let events: CopilotLoginEvent[];
  let consoleOut: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-login-test-'));
    fs.mkdirSync(path.join(dir, 'tmp'));
    fs.mkdirSync(path.join(dir, 'root'));
    fake = path.join(dir, 'fake-copilot.cjs');
    fs.writeFileSync(fake, FAKE_CLI);
    events = [];
    consoleOut = [];
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
        consoleOut.push(a.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const account = {
    copilot_plan: 'business',
    chat_enabled: true,
    endpoints: { api: 'https://api.business.githubcopilot.com' },
  };

  function deps(mode: string, overrides: Partial<CopilotLoginDeps> = {}) {
    const saved: Array<{ apiUrl: string; token: string }> = [];
    const env: Record<string, string> = {};
    const removed: string[] = [];
    const fetchCalls: Array<{ url: string; auth: string | null }> = [];
    const d: CopilotLoginDeps = {
      root: path.join(dir, 'root'),
      tmpRoot: path.join(dir, 'tmp'),
      startLogin: (home) => spawn(process.execPath, [fake, home, mode, TOKEN], { stdio: ['ignore', 'pipe', 'pipe'] }),
      removeLogin: (name) => removed.push(name),
      fetch: (async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify(account), { status: 200 });
      }) as typeof fetch,
      saveTokens: async (apiUrl, token) => {
        saved.push({ apiUrl, token });
      },
      writeEnv: (key, value) => {
        env[key] = value;
      },
      emit: (event) => events.push(event),
      timeoutMs: 10_000,
      ...overrides,
    };
    return { d, saved, env, removed, fetchCalls };
  }

  const leftovers = () => fs.readdirSync(path.join(dir, 'tmp')).filter((n) => n.startsWith(LOGIN_DIR_PREFIX));
  const tokenLeaked = () => [...consoleOut, ...events.map((e) => JSON.stringify(e))].some((l) => l.includes(TOKEN));

  it('streams the code, verifies the token, stores both connections and shreds the temp dir', async () => {
    const { d, saved, env, fetchCalls } = deps('ok');
    const record = await connectCopilot(d);
    expect(events[0]).toEqual({
      event: 'device',
      verificationUrl: 'https://github.com/login/device',
      userCode: '1743-CF8F',
    });
    expect(events.at(-1)).toEqual({
      event: 'connected',
      login: 'octo',
      plan: 'business',
      apiUrl: 'https://api.business.githubcopilot.com',
    });
    expect(fetchCalls).toEqual([{ url: 'https://api.github.com/copilot_internal/user', auth: `token ${TOKEN}` }]);
    expect(saved).toEqual([{ apiUrl: 'https://api.business.githubcopilot.com', token: TOKEN }]);
    expect(env).toEqual({ COPILOT_API_URL: 'https://api.business.githubcopilot.com' });
    expect(record).toMatchObject({ login: 'octo', plan: 'business' });
    const onDisk = fs.readFileSync(accountRecordPath(d.root), 'utf8');
    expect(onDisk).not.toContain(TOKEN);
    expect(JSON.parse(onDisk)).toMatchObject({
      login: 'octo',
      plan: 'business',
      apiUrl: 'https://api.business.githubcopilot.com',
    });
    expect(fs.statSync(accountRecordPath(d.root)).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
    expect(tokenLeaked()).toBe(false);
  });

  it.each([
    ['fail', 'login-failed'],
    ['notoken', 'no-token'],
  ])('reports a %s sign-in and stores nothing', async (mode, code) => {
    const { d, saved, env } = deps(mode);
    await expect(connectCopilot(d)).rejects.toMatchObject({ code });
    expect(events.at(-1)).toMatchObject({ event: 'error', code });
    expect(saved).toEqual([]);
    expect(env).toEqual({});
    expect(fs.existsSync(accountRecordPath(d.root))).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(tokenLeaked()).toBe(false);
  });

  it.each([
    [401, 'rejected'],
    [403, 'no-seat'],
    [500, 'rejected'],
  ])('refuses a token GitHub answers %s for, without echoing it', async (status, code) => {
    const { d, saved } = deps('ok', {
      fetch: (async () => new Response('{"message":"Bad credentials"}', { status })) as unknown as typeof fetch,
    });
    await expect(connectCopilot(d)).rejects.toMatchObject({ code });
    expect(saved).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(tokenLeaked()).toBe(false);
  });

  it('refuses an account with no Copilot endpoint or chat disabled', async () => {
    const { d, saved } = deps('ok', {
      fetch: (async () =>
        new Response(
          JSON.stringify({ chat_enabled: false, endpoints: { api: 'https://api.business.githubcopilot.com' } }),
          {
            status: 200,
          },
        )) as unknown as typeof fetch,
    });
    await expect(connectCopilot(d)).rejects.toMatchObject({ code: 'no-seat' });
    expect(saved).toEqual([]);
  });

  it('a network failure does not surface the transport error', async () => {
    const { d } = deps('ok', {
      fetch: (async () => {
        throw new Error(`connect failed for token ${TOKEN}`);
      }) as unknown as typeof fetch,
    });
    await expect(connectCopilot(d)).rejects.toMatchObject({ code: 'rejected' });
    expect(tokenLeaked()).toBe(false);
  });

  it('a cancel during the seat check stores nothing', async () => {
    const controller = new AbortController();
    const { d, saved, env } = deps('ok', {
      fetch: (async () => {
        controller.abort();
        return new Response(JSON.stringify(account), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(connectCopilot(d, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(saved).toEqual([]);
    expect(env).toEqual({});
    expect(fs.existsSync(accountRecordPath(d.root))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('reports a gateway failure and leaves no env or record behind', async () => {
    const { d, env } = deps('ok', {
      saveTokens: async () => {
        throw new Error('OneCLI unreachable');
      },
    });
    await expect(connectCopilot(d)).rejects.toMatchObject({ code: 'gateway' });
    expect(env).toEqual({});
    expect(fs.existsSync(accountRecordPath(d.root))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('cancels: kills the login, removes its container and shreds the dir', async () => {
    const { d, removed } = deps('hang');
    const controller = new AbortController();
    const run = connectCopilot(d, controller.signal);
    await vi.waitFor(() => expect(events[0]?.event).toBe('device'));
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(removed).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  it('expires a code nobody confirms', async () => {
    const { d, removed } = deps('hang', { timeoutMs: 300 });
    await expect(connectCopilot(d)).rejects.toMatchObject({ code: 'expired' });
    expect(removed).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });
});
