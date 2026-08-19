/**
 * Grok credential status for the setup wizard.
 *
 * Grok does not fit the credState() path that Claude and Codex share. Those
 * resolve through a `user_credentials` row or an OneCLI vault secret; Grok's
 * device-code login writes a file on the host instead — deliberately, so the
 * refresh token stays outside every container mount.
 *
 * READ-ONLY, and defensively so: this runs on a wizard page load, and a
 * malformed or half-written credential file must render "not connected" rather
 * than throw inside a status response. It never returns the tokens themselves —
 * only whether one exists, who it belongs to, and when it expires.
 *
 * The path is owned by src/providers/grok-auth.ts (sharedCredentialsPath). It is
 * duplicated rather than imported because that module ships with the Grok
 * payload: importing it would make this file fail to load on an install that
 * has never run /add-grok. The `grokAvailable()` guard below means the constant
 * is only ever used once the payload IS present.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../../config.js';
import { grokAvailable } from './providers.js';

export interface GrokStatus {
  /** A credential exists and has not expired. */
  connected: boolean;
  /** True when the provider payload is installed at all. */
  available: boolean;
  /** Account the credential belongs to, for the connected line. */
  email?: string;
  /** ISO-8601 expiry of the current access token. */
  expiresAt?: string;
  /** A credential exists but its access token is past expiry. */
  expired?: boolean;
}

/** Mirrors sharedCredentialsPath() in the provider payload. */
function credentialsPath(): string {
  return path.join(DATA_DIR, 'grok', 'credentials.json');
}

export function grokStatus(): GrokStatus {
  const available = grokAvailable();
  if (!available) return { connected: false, available: false };

  let raw: string;
  try {
    raw = fs.readFileSync(credentialsPath(), 'utf8');
  } catch {
    return { connected: false, available: true }; // never authenticated
  }

  try {
    const creds = JSON.parse(raw) as { email?: unknown; expiresAt?: unknown };
    const expiresAt = typeof creds.expiresAt === 'string' ? creds.expiresAt : undefined;
    const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
    // An unparseable expiry is treated as expired: claiming "connected" on a
    // credential we cannot reason about is the failure mode that sends an
    // operator hunting through logs instead of re-running the login.
    const expired = Number.isNaN(parsed) || parsed <= Date.now();
    return {
      connected: !expired,
      available: true,
      ...(typeof creds.email === 'string' ? { email: creds.email } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(expired ? { expired: true } : {}),
    };
  } catch {
    return { connected: false, available: true }; // corrupt file — re-authenticate
  }
}
