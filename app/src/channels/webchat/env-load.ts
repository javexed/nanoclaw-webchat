/**
 * Webchat env preload — side-effect module.
 *
 * Webchat reads `process.env.WEBCHAT_*` at module init, but trunk's service
 * units deliberately do not load `.env` into process.env (src/env.ts keeps
 * secrets out of the inherited environment). At import time this copies the
 * listed keys from `.env` into process.env ONLY where unset (an explicit
 * Environment= still wins). Imported first in index.ts so it runs before any
 * module-level constant is evaluated. Only the keys below are populated.
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
  'WEBCHAT_RUNNER_AUTO_GROUP',
  'WEBCHAT_RUNNER_ORIGINS',
  'WEBCHAT_EXEC_RELAY',
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
  // Not webchat-specific: Settings' install flow runs the skill engine in this
  // process, and it reads this to resolve a `from-branch` payload's repo (a
  // fork or mirror); without it the engine falls back to the default remote.
  'NANOCLAW_CHANNELS_REMOTE_URL',
  // Audit retention's starting values (src/audit.ts); Admin → Audit log overrides them.
  'NANOCLAW_AUDIT_KEEP_DAYS',
  'NANOCLAW_AUDIT_MAX_MB',
];

const fromFile = readEnvFile(WEBCHAT_ENV_KEYS);
for (const [k, v] of Object.entries(fromFile)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
