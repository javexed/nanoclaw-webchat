/**
 * Grok device-code login, driven from the wizard.
 *
 * Same SHAPE as the Codex/OpenCode installs — module-level state, a `start` that
 * returns {started,error}, a `get` the route reports, and a `cancel` — so the
 * route pair reads identically to every other long-running job here.
 *
 * NOT an InstallState, though, and deliberately so. Those model a CHAIN of
 * commands this process runs to completion. A device login is a different
 * animal: it finishes when a HUMAN confirms a code on another device, it can
 * expire, its useful output is scraped from stdout while it runs, and its
 * working directory holds a live refresh token that must be destroyed on every
 * exit path. Forcing it into InstallState would mean an eleventh copy of a
 * pattern the backlog already wants collapsed, in the one case that does not fit.
 *
 * THE CLI PATH STILL WORKS. `setup --step provider-auth grok` remains the
 * supported route for headless installs with no browser reach, and both write
 * the same credential file. They must never run at once, which is what the
 * single-flight guard below is for; the wizard re-reads status on every refresh,
 * so a credential that appeared via the CLI is picked up rather than clobbered.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from '../../../config.js';
import { getDefaultContainerImage } from '../../../install-slug.js';
import { grokAvailable } from './providers.js';

/** Device codes are short-lived; xAI's are ~10-15 min. Give up a little after. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** The CLI's home inside the throwaway container. */
const GROK_HOME = '/home/node/.grok';

export type GrokLoginOutcome = 'pending' | 'complete' | 'expired' | 'failed';

interface GrokLoginState {
  running: boolean;
  outcome: GrokLoginOutcome | null;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /** Not reported to the client. */
  tmpDir: string | null;
  proc: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const state: GrokLoginState = {
  running: false,
  outcome: null,
  verificationUrl: null,
  userCode: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  tmpDir: null,
  proc: null,
  timer: null,
};

/** What the route reports. Deliberately excludes the process and the temp dir. */
export interface GrokLoginProgress {
  running: boolean;
  outcome: GrokLoginOutcome | null;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /** Milliseconds until the code expires; null when not running. */
  expiresInMs: number | null;
}

export function getGrokLoginProgress(): GrokLoginProgress {
  const expiresInMs =
    state.running && state.startedAt !== null ? Math.max(0, state.startedAt + LOGIN_TIMEOUT_MS - Date.now()) : null;
  return {
    running: state.running,
    outcome: state.outcome,
    verificationUrl: state.verificationUrl,
    userCode: state.userCode,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    error: state.error,
    expiresInMs,
  };
}

/**
 * Pull the verification URL and user code out of the CLI's human-facing output.
 *
 * Exported for test: this is scraping, so it is the part most likely to break on
 * a CLI update, and the failure would otherwise be a wizard that spins forever
 * showing no code.
 */
export function parseDevicePrompt(text: string): { verificationUrl?: string; userCode?: string } {
  // Strip ANSI so a colourised URL still matches.
  /* eslint-disable-next-line no-control-regex -- matching the escape bytes is the point */
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const url = clean.match(/https?:\/\/\S*device\S*/i)?.[0]?.replace(/[.,)]+$/, '');
  // Codes render as XXXX-XXXX; take it from the URL when present so the two agree.
  const fromUrl = url?.match(/user_code=([A-Z0-9-]+)/i)?.[1];
  const standalone = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1];
  return {
    ...(url ? { verificationUrl: url } : {}),
    ...(fromUrl || standalone ? { userCode: fromUrl ?? standalone } : {}),
  };
}

/**
 * Convert the CLI's auth.json into the host credential file.
 *
 * The SHAPE is owned by src/providers/grok-auth.ts, which ships with the Grok
 * payload. It is duplicated rather than imported for the same reason
 * grok-status.ts duplicates the path: importing would make this module fail to
 * compile on a tree that has never installed the provider, which includes CI.
 */
export function credentialsFromCliAuth(raw: Record<string, unknown>): Record<string, unknown> | null {
  for (const [key, value] of Object.entries(raw)) {
    const e = value as Record<string, unknown>;
    if (typeof e?.key !== 'string' || typeof e?.refresh_token !== 'string') continue;
    const [issuer, clientId] = key.split('::');
    return {
      accessToken: e.key,
      refreshToken: e.refresh_token,
      expiresAt: typeof e.expires_at === 'string' ? e.expires_at : new Date().toISOString(),
      issuer: typeof e.oidc_issuer === 'string' ? e.oidc_issuer : (issuer ?? ''),
      clientId: typeof e.oidc_client_id === 'string' ? e.oidc_client_id : (clientId ?? ''),
      ...(typeof e.email === 'string' ? { email: e.email } : {}),
      ...(typeof e.user_id === 'string' ? { userId: e.user_id } : {}),
      // create_time is REQUIRED by the CLI when the credential is materialised
      // back into a container — see grok-auth.ts. Carry it, never synthesise.
      ...(typeof e.create_time === 'string' ? { createdAt: e.create_time } : {}),
    };
  }
  return null;
}

function credentialsPath(): string {
  return path.join(DATA_DIR, 'grok', 'credentials.json');
}

/** Destroy the temp dir. It holds a full auth.json, refresh token included. */
function shredTmp(): void {
  if (!state.tmpDir) return;
  try {
    fs.rmSync(state.tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort — a leftover temp dir is reported, never thrown */
  }
  state.tmpDir = null;
}

function finish(outcome: GrokLoginOutcome, error?: string): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.running = false;
  state.outcome = outcome;
  state.finishedAt = Date.now();
  state.error = error ?? null;
  state.proc = null;
  shredTmp();
}

export interface StartResult {
  started: boolean;
  error?: 'already-running' | 'not-installed';
}

/**
 * Remove login directories left by a flow that never finished.
 *
 * finish() shreds the temp dir on every exit path, but a host RESTART mid-login
 * runs none of them — the process simply goes away, and the directory outlives
 * it. Observed: a dozen of them accumulated during development restarts. They
 * were empty (the token only lands once the login completes, and an abandoned
 * login never gets that far), so this is hygiene rather than exposure — but the
 * one that is NOT empty is exactly the one worth never leaving behind.
 *
 * Only sweeps directories older than the login timeout, so a concurrent flow in
 * another process is never pulled out from under itself.
 */
export function sweepOrphanedLoginDirs(now = Date.now()): number {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith('grok-wizard-login-')) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (now - fs.statSync(dir).mtimeMs < LOGIN_TIMEOUT_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* another process may have removed it already */
    }
  }
  return removed;
}

export function startGrokLogin(root = process.cwd()): StartResult {
  // Single-flight: two tabs, or a tab racing the CLI, must not drive two logins
  // into one credential file.
  if (state.running) return { started: false, error: 'already-running' };
  if (!grokAvailable()) return { started: false, error: 'not-installed' };

  // A restart mid-login leaves its directory behind; clear stale ones before
  // adding another.
  sweepOrphanedLoginDirs();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-wizard-login-'));
  fs.chmodSync(dir, 0o700);

  Object.assign(state, {
    running: true,
    outcome: 'pending' as GrokLoginOutcome,
    verificationUrl: null,
    userCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    tmpDir: dir,
  });

  const args = [
    'run',
    '--rm',
    '-i',
    '-v',
    `${dir}:${GROK_HOME}`,
    '--entrypoint',
    'grok',
    getDefaultContainerImage(root),
    '--no-auto-update',
    'login',
    '--device-auth',
  ];
  const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  state.proc = proc;

  const onChunk = (buf: Buffer) => {
    const parsed = parseDevicePrompt(buf.toString());
    if (parsed.verificationUrl && !state.verificationUrl) state.verificationUrl = parsed.verificationUrl;
    if (parsed.userCode && !state.userCode) state.userCode = parsed.userCode;
  };
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk); // the CLI prints the prompt to either stream

  proc.on('error', (err) => finish('failed', `Could not start the login: ${err.message}`));

  proc.on('exit', (code) => {
    if (!state.running) return; // already cancelled or timed out
    if (code !== 0) return finish('failed', `The login exited with code ${code}.`);
    const file = path.join(state.tmpDir ?? '', 'auth.json');
    let creds: Record<string, unknown> | null = null;
    try {
      creds = credentialsFromCliAuth(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>);
    } catch {
      creds = null;
    }
    if (!creds) return finish('failed', 'The login finished but produced no usable session. Try again.');
    try {
      const target = credentialsPath();
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(target), 0o700);
      fs.writeFileSync(target, JSON.stringify(creds, null, 2), { mode: 0o600 });
      fs.chmodSync(target, 0o600);
    } catch (err) {
      return finish('failed', `Could not store the credential: ${err instanceof Error ? err.message : String(err)}`);
    }
    finish('complete');
  });

  // A device code outlives no page, but it does expire. Reap the container so a
  // forgotten tab cannot leave one running until the daemon restarts.
  state.timer = setTimeout(() => {
    if (!state.running) return;
    try {
      state.proc?.kill();
    } catch {
      /* already gone */
    }
    finish('expired', 'The device code expired before it was confirmed. Start again.');
  }, LOGIN_TIMEOUT_MS);
  state.timer.unref?.();

  return { started: true };
}

export function cancelGrokLogin(): { cancelled: boolean } {
  if (!state.running) return { cancelled: false };
  try {
    state.proc?.kill();
  } catch {
    /* already gone */
  }
  finish('failed', 'Cancelled.');
  return { cancelled: true };
}

/** Test seam: drop all state between cases. */
export function __resetGrokLoginState(): void {
  if (state.timer) clearTimeout(state.timer);
  shredTmp();
  Object.assign(state, {
    running: false,
    outcome: null,
    verificationUrl: null,
    userCode: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    tmpDir: null,
    proc: null,
    timer: null,
  });
}
