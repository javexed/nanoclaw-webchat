/**
 * Webchat env preload — side-effect module.
 *
 * The webchat adapter reads its config via `process.env.WEBCHAT_*` at
 * module-init time (top-level `const X = process.env.X || ...`). v2 trunk's
 * service runners (systemd unit, launchd plist) deliberately do NOT load
 * `.env` into process.env — `src/env.ts` keeps secrets out of the inherited
 * environment by reading on demand via `readEnvFile`.
 *
 * That means a service-managed host has `WEBCHAT_ENABLED` unset and the
 * factory returns null ("Channel credentials missing, skipping").
 *
 * This shim bridges the two: at import time it reads the webchat-relevant
 * keys from `.env` and sets them on `process.env` ONLY if not already set
 * (so an explicit Environment= line in the unit still wins). Importing it
 * first in `webchat/index.ts` guarantees it runs before any transitive
 * import (server.ts, auth.ts, etc.) evaluates its module-level constants.
 *
 * Only webchat-specific keys are populated — nothing leaks for other
 * channels.
 */
import { readEnvFile } from '../../env.js';

const WEBCHAT_ENV_KEYS = [
  'WEBCHAT_ENABLED',
  'WEBCHAT_HOST',
  'WEBCHAT_PORT',
  'WEBCHAT_TOKEN',
  'WEBCHAT_TAILSCALE',
  'WEBCHAT_TRUSTED_PROXY_IPS',
  'WEBCHAT_TRUSTED_PROXY_HEADER',
  'WEBCHAT_OIDC_ISSUER',
  'WEBCHAT_OIDC_AUDIENCE',
  'WEBCHAT_OIDC_JWKS_URI',
  'WEBCHAT_OIDC_CLIENT_SECRET',
  'WEBCHAT_OIDC_LOGIN',
  'WEBCHAT_OIDC_PROVIDER',
  'WEBCHAT_OIDC_NAME',
  'WEBCHAT_OIDC_AUTHORIZE_URL',
  'WEBCHAT_OIDC_TOKEN_URL',
  'WEBCHAT_OIDC_TOKEN_AUTH',
  'WEBCHAT_PUBLIC_URL',
  'WEBCHAT_ALLOWED_HOSTS',
  'WEBCHAT_TLS_CERT',
  'WEBCHAT_TLS_KEY',
  'WEBCHAT_PUBLIC_DIR',
  'WEBCHAT_RUNNER_ENABLED',
  'WEBCHAT_RUNNER_MAILBOX_PORT',
  'WEBCHAT_RUNNER_AUTO_GROUP',
  'WEBCHAT_VAPID_PUBLIC_KEY',
  'WEBCHAT_VAPID_PRIVATE_KEY',
  'WEBCHAT_VAPID_SUBJECT',
  'WEBCHAT_DRAFTER_MODEL',
  'WEBCHAT_BLOCK_PRIVATE_IPS',
  'WEBCHAT_TTS_ENABLED',
  'WEBCHAT_TTS_ENDPOINT',
  'WEBCHAT_TTS_MODEL',
  'WEBCHAT_TTS_VOICE',
  'WEBCHAT_STT_ENABLED',
  'WEBCHAT_STT_PROVIDER',
  'WEBCHAT_STT_URL',
  'WEBCHAT_STT_MODEL',
  'WEBCHAT_STT_LANG',
  'WEBCHAT_STT_API_KEY',
  'OLLAMA_HOST',
  'AGENT_DISPLAY_NAME',
  // Not webchat-specific, but the webchat Settings "install <channel/provider>"
  // flow runs the skill engine IN THIS HOST PROCESS, and the engine reads
  // NANOCLAW_CHANNELS_REMOTE_URL from process.env to resolve a `from-branch`
  // payload's source repo (e.g. a fork or private mirror carrying `providers-grok`). A
  // service-managed host never inherits .env, so without loading it here the
  // engine falls back to the nanocoai default and can't find fork-only branches.
  'NANOCLAW_CHANNELS_REMOTE_URL',
  // Audit retention's starting values (src/audit.ts); Admin → Audit log overrides them.
  'NANOCLAW_AUDIT_KEEP_DAYS',
  'NANOCLAW_AUDIT_MAX_MB',
];

const fromFile = readEnvFile(WEBCHAT_ENV_KEYS);
for (const [k, v] of Object.entries(fromFile)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
