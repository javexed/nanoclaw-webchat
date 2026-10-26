/**
 * Connect GitHub Copilot: a device-code sign-in run on a headless Linux host,
 * its token handed to the credential gateway and nowhere else.
 *
 *   pnpm exec tsx scripts/copilot-login.ts          # human output
 *   pnpm exec tsx scripts/copilot-login.ts --json   # one JSON event per line (webchat drives this)
 *
 * The Copilot CLI's own `login --device-code` runs in a throwaway container from
 * the agent image, with COPILOT_HOME on a fresh 0700 temp dir and the keyring
 * disabled, so the token lands in that dir's config.json and nowhere on the
 * host. It is read from there exactly once, checked against GitHub, saved as
 * two gateway connections, and the dir is destroyed on every exit path.
 *
 * The token is never printed, logged, put in argv or env, or written outside
 * the temp dir; no agent container ever sees it. What this leaves behind is
 * non-secret: COPILOT_API_URL in .env and data/copilot/account.json (login,
 * plan, endpoint) for status displays.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { getCredentialStore, type GatewayCredentialTarget } from '../setup/gateways/credential-store.js';
import { upsertEnvVar } from '../setup/set-env.js';

export const COPILOT_GITHUB_SECRET = 'Copilot GitHub';
export const COPILOT_API_SECRET = 'Copilot API';
/** The agent provider these credentials belong to; per-agent gateways grant them to its groups. */
export const COPILOT_PROVIDER = 'copilot';
/** The one api.github.com path the Copilot runtime calls with the device-login token. */
export const COPILOT_GITHUB_PATH = '/copilot_internal/user';
/** Must equal `COPILOT_GATEWAY_PLACEHOLDER` in the container provider (a test keeps them in sync). */
export const COPILOT_CREDENTIAL_PLACEHOLDER = 'nanoclaw-gateway-placeholder';
/** GitHub's device codes live 15 minutes; give up a little after. */
export const LOGIN_TIMEOUT_MS = 16 * 60_000;
/** Temp-dir prefix; webchat's orphan sweep matches it. */
export const LOGIN_DIR_PREFIX = 'copilot-login-';
/** Where COPILOT_HOME sits inside the throwaway container. */
const CONTAINER_HOME = '/copilot-home';
const GITHUB_API = 'https://api.github.com';
const USAGE = 'Usage: pnpm exec tsx scripts/copilot-login.ts [--json]';

export interface CopilotAccount {
  readonly apiUrl: string;
  readonly plan: string;
}

/** Non-secret record of the connection, for status displays. */
export interface CopilotAccountRecord extends CopilotAccount {
  readonly login: string | null;
  readonly connectedAt: string;
}

/** Events in `--json` mode, one per stdout line. Never carries the token. */
export type CopilotLoginEvent =
  | { event: 'device'; verificationUrl: string; userCode: string }
  | { event: 'status'; message: string }
  | { event: 'connected'; login: string | null; plan: string; apiUrl: string }
  | { event: 'error'; code: CopilotLoginErrorCode; message: string };

export type CopilotLoginErrorCode =
  | 'expired'
  | 'cancelled'
  | 'login-failed'
  | 'no-token'
  | 'rejected'
  | 'no-seat'
  | 'gateway';

export class CopilotLoginError extends Error {
  constructor(
    readonly code: CopilotLoginErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function parseCopilotAccount(body: unknown): CopilotAccount {
  const data = body as { copilot_plan?: unknown; chat_enabled?: unknown; endpoints?: { api?: unknown } };
  if (typeof data?.endpoints?.api !== 'string') {
    throw new CopilotLoginError('no-seat', 'GitHub did not return a Copilot API endpoint for this account');
  }
  const url = new URL(data.endpoints.api);
  if (url.protocol !== 'https:') {
    throw new CopilotLoginError('no-seat', `Copilot API endpoint must be HTTPS: ${url.href}`);
  }
  if (data.chat_enabled === false) {
    throw new CopilotLoginError('no-seat', 'Copilot chat is disabled for this account');
  }
  return { apiUrl: url.origin, plan: String(data.copilot_plan ?? 'unknown') };
}

/** The Copilot CLI's config.json starts with `//` comment lines. */
function parseCliConfig(configText: string): Record<string, unknown> {
  const parsed = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, '')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function lastCopilotLogin(configText: string): string | undefined {
  const last = parseCliConfig(configText).lastLoggedInUser as { host?: unknown; login?: unknown } | undefined;
  return last?.host === 'https://github.com' && typeof last.login === 'string' ? last.login : undefined;
}

const TOKEN_SHAPE = /^(gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/;

function tokenValue(value: unknown): string | undefined {
  if (typeof value === 'string') return TOKEN_SHAPE.test(value) ? value : undefined;
  if (value && typeof value === 'object') {
    for (const key of ['token', 'accessToken', 'access_token', 'value']) {
      const inner = (value as Record<string, unknown>)[key];
      if (typeof inner === 'string' && TOKEN_SHAPE.test(inner)) return inner;
    }
  }
  return undefined;
}

function deepTokens(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6) return;
  const direct = typeof value === 'string' ? tokenValue(value) : undefined;
  if (direct) out.add(direct);
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) deepTokens(inner, out, depth + 1);
  }
}

/**
 * The device-login token from the CLI's plaintext config.
 *
 * The CLI keeps it under `copilotTokens` keyed by host and login; the entry for
 * `lastLoggedInUser` wins, a lone entry is taken as is. As a fallback, exactly
 * one GitHub-token-shaped value anywhere in the file is accepted; two or more
 * cannot be told apart and nothing is guessed.
 */
export function extractCopilotToken(configText: string): { token: string; login: string | null } | null {
  let config: Record<string, unknown>;
  try {
    config = parseCliConfig(configText);
  } catch {
    return null;
  }
  const login = lastCopilotLogin(configText) ?? null;
  for (const field of ['copilotTokens', 'copilot_tokens', 'authTokens']) {
    const map = config[field];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    const entries = Object.entries(map as Record<string, unknown>)
      .map(([key, value]) => [key, tokenValue(value)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
    const mine = login ? entries.find(([key]) => key.split(/[:/]/).includes(login)) : undefined;
    if (mine) return { token: mine[1], login };
    if (entries.length === 1) return { token: entries[0][1], login };
  }
  const found = new Set<string>();
  deepTokens(config, found);
  return found.size === 1 ? { token: [...found][0], login } : null;
}

/** The verification URL and user code from the CLI's device prompt. */
export function parseDevicePrompt(text: string): { verificationUrl?: string; userCode?: string } {
  /* eslint-disable-next-line no-control-regex -- matching the escape bytes is the point */
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const url = clean.match(/https:\/\/\S*\/login\/device\S*/i)?.[0]?.replace(/[.,)]+$/, '');
  const code = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1];
  return { ...(url ? { verificationUrl: url } : {}), ...(code ? { userCode: code } : {}) };
}

/** The licensed Copilot API host takes the token host-wide, which the gateway-neutral seam expresses. */
export function copilotApiTarget(apiUrl: string): GatewayCredentialTarget {
  return {
    name: COPILOT_API_SECRET,
    kind: 'api-key',
    host: new URL(apiUrl).hostname,
    proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
    provider: COPILOT_PROVIDER,
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  };
}

/**
 * api.github.com takes the token on one exact path only: the token also carries
 * the account's repo scopes, so it must not reach the rest of the host.
 */
export function copilotGitHubTarget(): GatewayCredentialTarget {
  return {
    name: COPILOT_GITHUB_SECRET,
    kind: 'api-key',
    host: 'api.github.com',
    path: COPILOT_GITHUB_PATH,
    proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
    provider: COPILOT_PROVIDER,
    injection: { headerName: 'Authorization', valueFormat: 'token {value}' },
  };
}

export async function saveCopilotTokens(apiUrl: string, token: string, root = process.cwd()): Promise<void> {
  const store = await getCredentialStore(root);
  if (!store.connection) throw new Error('The selected gateway does not support provider credential connections.');
  if (!store.connectionPaths) throw new Error('The selected gateway cannot limit a credential to one path.');
  for (const target of [copilotGitHubTarget(), copilotApiTarget(apiUrl)]) {
    const connection = store.connection(target);
    // A plan change moves the licensed host (individual ↔ business/enterprise); follow it.
    await connection.find({ confirmHostChange: async () => true });
    await connection.save(token);
  }
}

export function accountRecordPath(root: string): string {
  return path.join(root, 'data', 'copilot', 'account.json');
}

/** Ask GitHub what the token is licensed for. Never echoes the token or a transport error. */
export async function verifyCopilotToken(token: string, fetchImpl: typeof fetch = fetch): Promise<CopilotAccount> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}${COPILOT_GITHUB_PATH}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
  } catch {
    throw new CopilotLoginError(
      'rejected',
      'Could not reach GitHub to check the sign-in. Check the network and retry.',
    );
  }
  if (response.status === 401) {
    throw new CopilotLoginError('rejected', 'GitHub rejected the sign-in (401). Sign in again.');
  }
  if (response.status === 403 || response.status === 404) {
    throw new CopilotLoginError(
      'no-seat',
      `GitHub refused Copilot for this account (${response.status}). Check that it has a Copilot seat, that the Copilot CLI policy is enabled, and that no IP allow list or sign-in policy blocks this network.`,
    );
  }
  if (!response.ok) {
    throw new CopilotLoginError('rejected', `GitHub could not check the sign-in (${response.status}). Retry shortly.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CopilotLoginError('rejected', 'GitHub returned an unreadable account response. Retry shortly.');
  }
  return parseCopilotAccount(body);
}

export interface CopilotLoginDeps {
  root: string;
  /** Where the temp COPILOT_HOME is created. */
  tmpRoot: string;
  /** Start `copilot login --device-code` with COPILOT_HOME on `home`; `name` identifies it for removal. */
  startLogin(home: string, name: string): ChildProcess;
  /** Remove a login container a cancelled or timed-out run may have orphaned. */
  removeLogin(name: string): void;
  fetch: typeof fetch;
  saveTokens(apiUrl: string, token: string): Promise<void>;
  writeEnv(key: string, value: string): void;
  emit(event: CopilotLoginEvent): void;
  timeoutMs: number;
}

export function defaultStartLogin(root: string) {
  return (home: string, name: string): ChildProcess => {
    // As the host uid, so the config the CLI writes is readable back here.
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const user = uid !== undefined && gid !== undefined ? ['--user', `${uid}:${gid}`] : [];
    return spawn(
      CONTAINER_RUNTIME_BIN,
      [
        'run',
        '--rm',
        '--name',
        name,
        ...user,
        '-e',
        `HOME=${CONTAINER_HOME}`,
        '-e',
        `COPILOT_HOME=${CONTAINER_HOME}`,
        '-e',
        `XDG_CACHE_HOME=${CONTAINER_HOME}/.cache`,
        // No keyring in the container: the token goes to the plaintext config,
        // which is the only place this flow reads it from.
        '-e',
        'COPILOT_DISABLE_KEYTAR=1',
        '-e',
        'COPILOT_AUTO_UPDATE=false',
        '-v',
        `${home}:${CONTAINER_HOME}`,
        '--entrypoint',
        'copilot',
        getDefaultContainerImage(root),
        'login',
        '--device-code',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  };
}

function defaultDeps(root: string, json: boolean): CopilotLoginDeps {
  return {
    root,
    tmpRoot: os.tmpdir(),
    startLogin: defaultStartLogin(root),
    removeLogin: (name) => {
      spawnSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], { stdio: 'ignore' });
    },
    fetch,
    saveTokens: (apiUrl, token) => saveCopilotTokens(apiUrl, token, root),
    writeEnv: (key, value) => upsertEnvVar(key, value, root),
    emit: json ? (event) => console.log(JSON.stringify(event)) : humanEmit,
    timeoutMs: LOGIN_TIMEOUT_MS,
  };
}

function humanEmit(event: CopilotLoginEvent): void {
  if (event.event === 'device') {
    console.log(`To connect GitHub Copilot, open ${event.verificationUrl} and enter the code ${event.userCode}.`);
    console.log('Sign in with your work account when GitHub asks.');
  } else if (event.event === 'status') {
    console.log(event.message);
  } else if (event.event === 'connected') {
    console.log(`Copilot connected${event.login ? ` for ${event.login}` : ''} (${event.plan}) via ${event.apiUrl}.`);
    console.log('Select it per group: ncl groups config update --id <group-id> --provider copilot');
  } else {
    console.error(event.message);
  }
}

function shred(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort; the webchat sweep removes stale login dirs */
  }
}

/**
 * Run one device-code login to completion. Resolves with the account; rejects
 * with a CopilotLoginError (also emitted as an `error` event).
 */
export async function connectCopilot(deps: CopilotLoginDeps, signal?: AbortSignal): Promise<CopilotAccountRecord> {
  const home = fs.mkdtempSync(path.join(deps.tmpRoot, LOGIN_DIR_PREFIX));
  fs.chmodSync(home, 0o700);
  const name = `nanoclaw-copilot-login-${randomBytes(6).toString('hex')}`;
  let child: ChildProcess | undefined;
  try {
    // Ask for the plaintext store explicitly too: the keyring is the CLI's
    // default and the token must land in this dir.
    fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify({ storeTokenPlaintext: true })}\n`, {
      mode: 0o600,
    });
    const started = deps.startLogin(home, name);
    child = started;
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      let announced = false;
      const prompt: { verificationUrl?: string; userCode?: string } = {};
      const onChunk = (buf: Buffer) => {
        const parsed = parseDevicePrompt(buf.toString());
        prompt.verificationUrl ??= parsed.verificationUrl;
        prompt.userCode ??= parsed.userCode;
        if (!announced && prompt.verificationUrl && prompt.userCode) {
          announced = true;
          deps.emit({ event: 'device', verificationUrl: prompt.verificationUrl, userCode: prompt.userCode });
        }
      };
      started.stdout?.on('data', onChunk);
      started.stderr?.on('data', onChunk);
      const stop = (error: CopilotLoginError) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        started.kill();
        deps.removeLogin(name);
        reject(error);
      };
      const timer = setTimeout(
        () => stop(new CopilotLoginError('expired', 'The device code expired before it was confirmed. Start again.')),
        deps.timeoutMs,
      );
      timer.unref?.();
      const onAbort = () => stop(new CopilotLoginError('cancelled', 'Cancelled.'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      started.on('error', (err) =>
        stop(new CopilotLoginError('login-failed', `Could not start the sign-in: ${err.message}`)),
      );
      started.on('exit', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(code);
      });
    });
    if (exitCode !== 0) {
      throw new CopilotLoginError('login-failed', `The sign-in did not complete (exit code ${exitCode}). Try again.`);
    }

    let configText = '';
    try {
      configText = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
    } catch {
      /* handled below */
    }
    const found = extractCopilotToken(configText);
    configText = '';
    if (!found) {
      throw new CopilotLoginError('no-token', 'The sign-in finished but left no usable token. Try again.');
    }
    // A cancel that lands after the CLI exited (its listener is gone by then)
    // must still stop the flow before anything is checked or stored.
    const cancelled = () => new CopilotLoginError('cancelled', 'Cancelled.');
    if (signal?.aborted) throw cancelled();
    deps.emit({ event: 'status', message: 'Checking the Copilot seat…' });
    const account = await verifyCopilotToken(found.token, deps.fetch);
    if (signal?.aborted) throw cancelled();
    try {
      await deps.saveTokens(account.apiUrl, found.token);
    } catch (err) {
      throw new CopilotLoginError(
        'gateway',
        `Could not store the credential in the gateway: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    deps.writeEnv('COPILOT_API_URL', account.apiUrl);
    const record: CopilotAccountRecord = { ...account, login: found.login, connectedAt: new Date().toISOString() };
    const recordFile = accountRecordPath(deps.root);
    fs.mkdirSync(path.dirname(recordFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    deps.emit({ event: 'connected', login: record.login, plan: record.plan, apiUrl: record.apiUrl });
    return record;
  } catch (err) {
    const error =
      err instanceof CopilotLoginError
        ? err
        : new CopilotLoginError('login-failed', err instanceof Error ? err.message : String(err));
    deps.emit({ event: 'error', code: error.code, message: error.message });
    throw error;
  } finally {
    if (child && child.exitCode === null) child.kill();
    shred(home);
  }
}

export async function runCopilotLogin(args = process.argv.slice(2), root = process.cwd()): Promise<void> {
  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await connectCopilot(defaultDeps(root, args.includes('--json')), controller.signal);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCopilotLogin().catch(() => {
    // Already reported through the event stream.
    process.exit(1);
  });
}
