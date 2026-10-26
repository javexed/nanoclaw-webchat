/**
 * GitHub Copilot connection, driven from Settings: status, a device-code
 * sign-in, and disconnect.
 *
 * WHY THE SIGN-IN RUNS AS A CHILD SCRIPT. The /add-copilot payload ships
 * `scripts/copilot-login.ts`, which runs the Copilot CLI's device login in a
 * throwaway container, reads the token once, checks it with GitHub and stores
 * it in the credential gateway. This file starts that script with `--json` and
 * reads its events. The token therefore never enters this process at all:
 * not its memory, its logs, or its responses. It is also the same code path
 * the terminal uses, so the two cannot drift.
 *
 * WHY NOTHING HERE IMPORTS THE PAYLOAD. It only exists once /add-copilot has
 * run; a static import would break the build of every install without it.
 * The event shape and the status file path are mirrored below for that reason
 * (same as grok-status.ts), and every entry point checks copilotAvailable().
 *
 * Same SHAPE as grok-auth-flow.ts — module-level state, `start` returning
 * {started,error}, a `get` the route reports, a `cancel` — so the route pair
 * reads like the others.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { CONTAINER_RUNTIME_BIN } from '../../../container-runtime.js';
import { restartAgentGroupContainersWhenIdle } from '../../../container-restart-idle.js';
import { log } from '../../../log.js';
import { realOnecliAdmin, type OnecliAdmin } from '../../../modules/user-credentials/onecli-admin.js';
import { removeEnv } from '../env-write.js';
import { copilotAvailable } from './providers.js';

/** The script's own expiry is 16 minutes; the server gives up a little after. */
const LOGIN_TIMEOUT_MS = 17 * 60_000;
/** Mirrors LOGIN_DIR_PREFIX in the payload's scripts/copilot-login.ts. */
const LOGIN_DIR_PREFIX = 'copilot-login-';
/** Mirrors the login container name the payload's script gives each run. */
const LOGIN_CONTAINER_PREFIX = 'nanoclaw-copilot-login-';
/** Mirrors COPILOT_GITHUB_SECRET / COPILOT_API_SECRET in the payload. */
export const COPILOT_SECRET_NAMES: ReadonlySet<string> = new Set(['Copilot GitHub', 'Copilot API']);

export type CopilotLoginOutcome = 'pending' | 'complete' | 'expired' | 'failed';

/** One `--json` event from the login script. Mirrors CopilotLoginEvent in the payload. */
type LoginEvent =
  | { event: 'device'; verificationUrl: string; userCode: string }
  | { event: 'status'; message: string }
  | { event: 'connected'; login: string | null; plan: string; apiUrl: string }
  | { event: 'error'; code: string; message: string };

export interface CopilotLoginProgress {
  running: boolean;
  outcome: CopilotLoginOutcome | null;
  verificationUrl: string | null;
  userCode: string | null;
  /** A progress line from the script ("Checking the Copilot seat…"). */
  message: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /** Milliseconds until the code expires; null when not running. */
  expiresInMs: number | null;
}

interface LoginState extends Omit<CopilotLoginProgress, 'expiresInMs'> {
  proc: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const idle = (): LoginState => ({
  running: false,
  outcome: null,
  verificationUrl: null,
  userCode: null,
  message: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  proc: null,
  timer: null,
});

let state: LoginState = idle();

export function getCopilotLoginProgress(): CopilotLoginProgress {
  const { proc: _proc, timer: _timer, ...visible } = state;
  return {
    ...visible,
    expiresInMs:
      state.running && state.startedAt !== null ? Math.max(0, state.startedAt + LOGIN_TIMEOUT_MS - Date.now()) : null,
  };
}

/** Parse one stdout line; anything that is not a known event is ignored, never echoed. */
export function parseLoginEvent(line: string): LoginEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const e = raw as Record<string, unknown>;
  if (e?.event === 'device' && typeof e.verificationUrl === 'string' && typeof e.userCode === 'string') {
    // Only a GitHub device page is ever shown as a link.
    if (!/^https:\/\/github\.com\/login\/device\b/.test(e.verificationUrl)) return null;
    return { event: 'device', verificationUrl: e.verificationUrl, userCode: e.userCode };
  }
  if (e?.event === 'status' && typeof e.message === 'string') return { event: 'status', message: e.message };
  if (e?.event === 'connected' && typeof e.plan === 'string' && typeof e.apiUrl === 'string')
    return { event: 'connected', login: typeof e.login === 'string' ? e.login : null, plan: e.plan, apiUrl: e.apiUrl };
  if (e?.event === 'error' && typeof e.message === 'string')
    return { event: 'error', code: typeof e.code === 'string' ? e.code : 'login-failed', message: e.message };
  return null;
}

/** How the script is started. Replaced in tests with a fake that prints events. */
export type LoginSpawner = (root: string) => ChildProcess;

/**
 * `node --import tsx` rather than `pnpm exec tsx`: one process, so a cancel's
 * SIGTERM reaches the script itself, which removes its container and temp dir.
 */
export const spawnLoginScript: LoginSpawner = (root) =>
  spawn(process.execPath, ['--import', 'tsx', 'scripts/copilot-login.ts', '--json'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

let spawner: LoginSpawner = spawnLoginScript;

/** Test seam. */
export function __setCopilotLoginSpawner(fn: LoginSpawner | null): void {
  spawner = fn ?? spawnLoginScript;
}

function finish(outcome: CopilotLoginOutcome, error?: string): void {
  if (state.timer) clearTimeout(state.timer);
  Object.assign(state, {
    running: false,
    outcome,
    finishedAt: Date.now(),
    error: error ?? null,
    proc: null,
    timer: null,
  });
}

/**
 * Remove login directories a killed host left behind. The script deletes its
 * own on every exit path it gets to run; a host restart mid-login kills it
 * first. Only directories older than the login timeout, so a live flow in
 * another process is never touched.
 */
export function sweepOrphanedCopilotLoginDirs(now = Date.now(), tmp = os.tmpdir()): number {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(LOGIN_DIR_PREFIX)) continue;
    const dir = path.join(tmp, name);
    try {
      if (now - fs.statSync(dir).mtimeMs < LOGIN_TIMEOUT_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/** Runs the container runtime and resolves with its stdout ('' on failure). */
export type RuntimeRunner = (args: string[]) => Promise<string>;

const runRuntime: RuntimeRunner = (args) =>
  new Promise((resolve) =>
    execFile(CONTAINER_RUNTIME_BIN, args, { timeout: 15_000 }, (err, stdout) => resolve(err ? '' : String(stdout))),
  );

/**
 * Remove login containers a killed host left behind (the script runs each
 * with --rm, but a host killed mid-login can strand one, still holding the
 * temp dir's token mount). Same age rule as the dirs: a container younger
 * than the login timeout may belong to a live flow — this install's or
 * another's on the same runtime — and is left alone.
 */
export async function sweepOrphanedCopilotLoginContainers(now = Date.now(), run = runRuntime): Promise<number> {
  const out = await run([
    'ps',
    '-a',
    '--filter',
    `name=${LOGIN_CONTAINER_PREFIX}`,
    '--format',
    '{{.Names}}|{{.CreatedAt}}',
  ]);
  let removed = 0;
  for (const line of out.split('\n')) {
    const [name, created = ''] = line.trim().split('|');
    if (!name?.startsWith(LOGIN_CONTAINER_PREFIX)) continue;
    // "2026-10-26 04:06:00 +0000 UTC"
    const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)/.exec(created);
    const at = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : NaN;
    if (!Number.isFinite(at) || now - at < LOGIN_TIMEOUT_MS) continue;
    await run(['rm', '-f', name]);
    removed += 1;
  }
  return removed;
}

/** Host start: clear what a login killed with the host left behind. */
export async function sweepOrphanedCopilotLogins(): Promise<void> {
  const dirs = sweepOrphanedCopilotLoginDirs();
  const containers = copilotAvailable() ? await sweepOrphanedCopilotLoginContainers() : 0;
  if (dirs || containers) log.info('Removed orphaned GitHub Copilot sign-in leftovers', { dirs, containers });
}

export interface StartResult {
  started: boolean;
  error?: 'already-running' | 'not-installed';
}

export function startCopilotLogin(root = process.cwd()): StartResult {
  if (state.running) return { started: false, error: 'already-running' };
  if (!copilotAvailable()) return { started: false, error: 'not-installed' };
  sweepOrphanedCopilotLoginDirs();

  state = { ...idle(), running: true, outcome: 'pending', startedAt: Date.now() };
  const proc = spawner(root);
  state.proc = proc;

  let buffered = '';
  let connected = false;
  let failure: { code: string; message: string } | null = null;
  proc.stdout?.on('data', (buf: Buffer) => {
    buffered += buf.toString();
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      const e = parseLoginEvent(line);
      if (!e || state.proc !== proc) continue;
      if (e.event === 'device') {
        state.verificationUrl = e.verificationUrl;
        state.userCode = e.userCode;
      } else if (e.event === 'status') state.message = e.message;
      else if (e.event === 'connected') connected = true;
      else if (e.event === 'error') failure = { code: e.code, message: e.message };
    }
  });
  // stderr is drained, never logged: it is the script's and the CLI's prose.
  proc.stderr?.on('data', () => {});

  proc.on('error', (err) => {
    if (state.proc !== proc) return;
    finish('failed', `Could not start the sign-in: ${err.message}`);
  });
  proc.on('exit', (code) => {
    // Identity check: a cancel-then-restart leaves this one dying while a new
    // flow already owns the state.
    if (state.proc !== proc || !state.running) return;
    if (code === 0 && connected) {
      finish('complete');
      void restartCopilotGroups('GitHub Copilot connected');
      return;
    }
    const why = failure as { code: string; message: string } | null;
    finish(why?.code === 'expired' ? 'expired' : 'failed', why?.message ?? `The sign-in exited with code ${code}.`);
  });

  state.timer = setTimeout(() => {
    if (!state.running || state.proc !== proc) return;
    proc.kill('SIGTERM');
    finish('expired', 'The device code expired before it was confirmed. Start again.');
  }, LOGIN_TIMEOUT_MS);
  state.timer.unref?.();
  return { started: true };
}

export function cancelCopilotLogin(): { cancelled: boolean } {
  if (!state.running) return { cancelled: false };
  // SIGTERM, not SIGKILL: the script handles it by removing its login
  // container and shredding its temp dir.
  state.proc?.kill('SIGTERM');
  finish('failed', 'Cancelled.');
  return { cancelled: true };
}

/** Test seam: drop all state between cases. */
export function __resetCopilotLoginState(): void {
  if (state.timer) clearTimeout(state.timer);
  state = idle();
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface CopilotStatus {
  /** The provider payload is installed. */
  available: boolean;
  /** A sign-in completed and its gateway credentials are still recorded. */
  connected: boolean;
  login?: string;
  plan?: string;
  apiUrl?: string;
  connectedAt?: string;
}

/** Mirrors accountRecordPath() in the payload. Non-secret. */
export function accountFile(root: string): string {
  return path.join(root, 'data', 'copilot', 'account.json');
}

/** OneCLI's record of the secret ids each provider's sign-in saved. */
function providerRecordFile(root: string): string {
  return path.join(root, 'data', 'onecli', 'provider-credentials.json');
}

/** Recorded ids for copilot; null when there is no record to consult (another gateway, or none yet). */
export function recordedCopilotIds(root: string): string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(providerRecordFile(root), 'utf8');
  } catch {
    return null;
  }
  try {
    const ids = (JSON.parse(raw) as { providers?: Record<string, unknown> }).providers?.copilot;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return null;
  }
}

/**
 * READ-ONLY and defensive: it runs on a Settings page load, so a missing or
 * half-written file reads as "not connected" rather than throwing.
 */
export function copilotStatus(root = process.cwd()): CopilotStatus {
  const available = copilotAvailable();
  if (!available) return { available: false, connected: false };
  let account: Record<string, unknown>;
  try {
    account = JSON.parse(fs.readFileSync(accountFile(root), 'utf8')) as Record<string, unknown>;
  } catch {
    return { available, connected: false };
  }
  if (typeof account.apiUrl !== 'string') return { available, connected: false };
  // Disconnected outside webchat (the record lost its ids) reads as not connected.
  const ids = recordedCopilotIds(root);
  if (ids !== null && ids.length === 0) return { available, connected: false };
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    available,
    connected: true,
    ...(str(account.login) ? { login: str(account.login) } : {}),
    ...(str(account.plan) ? { plan: str(account.plan) } : {}),
    apiUrl: account.apiUrl,
    ...(str(account.connectedAt) ? { connectedAt: str(account.connectedAt) } : {}),
  };
}

// ── Disconnect ──────────────────────────────────────────────────────────────

type RecordUpdater = (
  dataDir: string,
  change: (r: { providers: Record<string, string[]> }) => void,
) => Promise<unknown>;

/**
 * The OneCLI payload's locked record writer, when that gateway is installed.
 * Held in a `string`-typed variable so TypeScript does not resolve a module
 * that is legitimately absent from trees without OneCLI.
 */
async function loadRecordUpdater(): Promise<RecordUpdater | null> {
  const specifier: string = '../../../gateway-providers/onecli-provider-credentials.js';
  try {
    const mod = (await import(specifier)) as { updateProviderCredentials?: RecordUpdater };
    return mod.updateProviderCredentials ?? null;
  } catch {
    return null;
  }
}

export interface DisconnectDeps {
  admin: Pick<OnecliAdmin, 'listAllSecrets' | 'deleteSecret'>;
  updateRecord: RecordUpdater | null;
}

/**
 * Remove what a sign-in stored: the two gateway secrets, their recorded ids,
 * the status file and COPILOT_API_URL.
 *
 * Only secrets that are BOTH recorded for copilot AND carry one of the names
 * the sign-in uses are deleted — on a gateway shared with other installs a
 * name alone could be someone else's entry.
 */
export async function disconnectCopilot(root = process.cwd(), deps?: DisconnectDeps): Promise<{ deleted: number }> {
  const d = deps ?? { admin: realOnecliAdmin, updateRecord: await loadRecordUpdater() };
  const recorded = new Set(recordedCopilotIds(root) ?? []);
  let deleted = 0;
  if (recorded.size > 0) {
    const secrets = await d.admin.listAllSecrets();
    for (const s of secrets) {
      if (!recorded.has(s.id) || !COPILOT_SECRET_NAMES.has(s.name ?? '')) continue;
      await d.admin.deleteSecret(s.id);
      deleted += 1;
    }
    if (d.updateRecord) {
      await d.updateRecord(path.join(root, 'data'), (r) => {
        delete r.providers.copilot;
      });
    }
  }
  fs.rmSync(accountFile(root), { force: true });
  removeEnv(root, 'COPILOT_API_URL');
  log.info('GitHub Copilot disconnected', { deleted });
  return { deleted };
}

/**
 * Respawn running Copilot groups once idle, so a new sign-in's credentials are
 * granted to them (a gateway that grants per agent does it at spawn).
 */
export async function restartCopilotGroups(reason: string): Promise<void> {
  for (const g of await getAllAgentGroups()) {
    if ((await getContainerConfig(g.id))?.provider !== 'copilot') continue;
    try {
      await restartAgentGroupContainersWhenIdle(g.id, reason);
    } catch (err) {
      log.warn('Copilot: restart after a credential change failed', { agentGroupId: g.id, err: String(err) });
    }
  }
}
