/**
 * Per-member Grok device login.
 *
 * The wizard already has a device-login flow, and it is deliberately NOT reused:
 * that one is globally single-flight, owner-guarded, and lands the INSTALL-WIDE
 * credential. All three are wrong here. Two members must be able to sign in at
 * once, neither is an owner, and each result belongs to that member's vault
 * secret rather than the workspace's.
 *
 * What is shared is the hard-won part — scraping the URL and code out of the
 * CLI's human-facing output, and converting its auth.json — imported from
 * grok-auth-flow rather than written twice.
 *
 * WHY THIS EXISTS AT ALL. Members could already have per-member credentials
 * stored, refreshed and injected; what they could not do was PRODUCE one. The
 * only way to mint a Grok credential was a terminal, which is not available to
 * someone reading a room on their phone — the exact case that prompted this.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDefaultContainerImage } from '../../../install-slug.js';
import { log } from '../../../log.js';
import { credentialsFromCliAuth, parseDevicePrompt } from './grok-auth-flow.js';
import { grokAvailable } from './providers.js';

/** Device codes expire in ~10-15 min; reap a little after so nothing lingers. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const GROK_HOME = '/home/node/.grok';

export type MemberLoginOutcome = 'pending' | 'complete' | 'expired' | 'failed';

interface MemberLogin {
  userId: string;
  outcome: MemberLoginOutcome;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: number;
  error: string | null;
  /** The credential, held only until the caller claims it. Never serialised. */
  credential: Record<string, unknown> | null;
  tmpDir: string | null;
  proc: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Keyed by user: single-flight PER MEMBER, not per install. */
const logins = new Map<string, MemberLogin>();

export interface MemberLoginProgress {
  running: boolean;
  outcome: MemberLoginOutcome | null;
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  expiresInMs: number | null;
}

export function getMemberLoginProgress(userId: string): MemberLoginProgress {
  const l = logins.get(userId);
  if (!l)
    return { running: false, outcome: null, verificationUrl: null, userCode: null, error: null, expiresInMs: null };
  const running = l.outcome === 'pending';
  return {
    running,
    outcome: l.outcome,
    verificationUrl: l.verificationUrl,
    userCode: l.userCode,
    error: l.error,
    expiresInMs: running ? Math.max(0, l.startedAt + LOGIN_TIMEOUT_MS - Date.now()) : null,
  };
}

/** Hand the finished credential to the caller ONCE, then forget it. */
export function claimMemberCredential(userId: string): Record<string, unknown> | null {
  const l = logins.get(userId);
  if (!l || l.outcome !== 'complete' || !l.credential) return null;
  const cred = l.credential;
  // Cleared on claim so a completed login cannot be replayed into a second
  // vault secret by a repeated poll.
  l.credential = null;
  return cred;
}

/**
 * Put a claimed credential back after a FAILED store. Claim-then-store means a
 * transient vault outage would otherwise destroy the credential while the
 * outcome stayed 'complete' — the next poll then reports success with nothing
 * stored. Restoring makes the next poll retry the store instead.
 */
export function restoreMemberCredential(userId: string, cred: Record<string, unknown>): void {
  const l = logins.get(userId);
  if (l && l.outcome === 'complete' && !l.credential) l.credential = cred;
}

function shredTmp(l: MemberLogin): void {
  if (!l.tmpDir) return;
  try {
    fs.rmSync(l.tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  l.tmpDir = null;
}

function finish(l: MemberLogin, outcome: MemberLoginOutcome, error?: string): void {
  if (l.timer) clearTimeout(l.timer);
  l.timer = null;
  l.outcome = outcome;
  l.error = error ?? null;
  l.proc = null;
  shredTmp(l);
}

export function cancelMemberLogin(userId: string): { cancelled: boolean } {
  const l = logins.get(userId);
  if (!l || l.outcome !== 'pending') return { cancelled: false };
  try {
    l.proc?.kill();
  } catch {
    /* already gone */
  }
  finish(l, 'failed', 'Cancelled.');
  return { cancelled: true };
}

export interface StartMemberLoginResult {
  started: boolean;
  error?: 'already-running' | 'not-installed';
}

export function startMemberLogin(userId: string, root = process.cwd()): StartMemberLoginResult {
  const existing = logins.get(userId);
  // Single-flight per member. Another member signing in concurrently is fine
  // and expected — that is the whole point of this being keyed by user.
  if (existing?.outcome === 'pending') return { started: false, error: 'already-running' };
  if (!grokAvailable()) return { started: false, error: 'not-installed' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-member-login-'));
  fs.chmodSync(dir, 0o700);

  const l: MemberLogin = {
    userId,
    outcome: 'pending',
    verificationUrl: null,
    userCode: null,
    startedAt: Date.now(),
    error: null,
    credential: null,
    tmpDir: dir,
    proc: null,
    timer: null,
  };
  logins.set(userId, l);

  const proc = spawn(
    'docker',
    [
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
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  l.proc = proc;

  const onChunk = (buf: Buffer) => {
    const parsed = parseDevicePrompt(buf.toString());
    if (parsed.verificationUrl && !l.verificationUrl) l.verificationUrl = parsed.verificationUrl;
    if (parsed.userCode && !l.userCode) l.userCode = parsed.userCode;
  };
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk);

  proc.on('error', (err) => finish(l, 'failed', `Could not start the login: ${err.message}`));

  proc.on('exit', (code) => {
    if (l.outcome !== 'pending') return; // cancelled or expired already
    if (code !== 0) return finish(l, 'failed', `The login exited with code ${code}.`);
    let cred: Record<string, unknown> | null = null;
    try {
      cred = credentialsFromCliAuth(JSON.parse(fs.readFileSync(path.join(l.tmpDir ?? '', 'auth.json'), 'utf8')));
    } catch {
      cred = null;
    }
    if (!cred) return finish(l, 'failed', 'The login finished but produced no usable session. Try again.');
    // Held in memory only, and shredded from disk immediately: the caller
    // claims it on the next poll and stores it in the member's vault secret.
    l.credential = cred;
    finish(l, 'complete');
    log.info(`Grok member login completed (${userId})`);
  });

  l.timer = setTimeout(() => {
    if (l.outcome !== 'pending') return;
    try {
      l.proc?.kill();
    } catch {
      /* already gone */
    }
    finish(l, 'expired', 'The device code expired before it was confirmed. Start again.');
  }, LOGIN_TIMEOUT_MS);
  l.timer.unref?.();

  return { started: true };
}

/** Test seam: drop all member login state. */
export function __resetMemberLogins(): void {
  for (const l of logins.values()) {
    if (l.timer) clearTimeout(l.timer);
    shredTmp(l);
  }
  logins.clear();
}
