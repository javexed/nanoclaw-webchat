/**
 * The VS Code extension's sign-in settings, served by central so a developer
 * never types them. They follow Admin → Sign-in: with Microsoft as the OIDC
 * provider the extension signs in with Microsoft (tenant and app from the same
 * settings auth.ts verifies against); otherwise over the network (Tailscale).
 * The extension uses VS Code's built-in Microsoft account support, so another
 * OIDC provider cannot sign it in.
 *
 * Two values can be overridden there, both optional: the App ID URI (when the
 * registration's is not api://<client id>) and a client id of the extension's
 * own. None of them is a secret: tenant, client and app ids are public.
 *
 * A third, independent of the sign-in: the operator's release signing key
 * (public half), which the extension offers to pin for this server so it can
 * verify runner updates and the agent image (runner-extension.ts).
 */
import { log } from '../../log.js';
import { oidcCfg } from './auth.js';
import { getRunnerClientConfigRaw, setRunnerClientConfigRaw } from './db.js';
import { parseReleaseKey } from './runner-extension.js';

export type SignIn = 'microsoft' | 'network';
export interface RunnerClientConfig {
  signIn: SignIn;
  tenantId: string;
  appIdUri: string;
  clientId: string;
  /** Only when the install names one. */
  releaseKey?: string;
}
export type RunnerClientOverrides = Partial<Pick<RunnerClientConfig, 'appIdUri' | 'clientId' | 'releaseKey'>>;
const OVERRIDE_KEYS = ['appIdUri', 'clientId', 'releaseKey'] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// api:// only — the extension takes nothing else from central: an https URI
// can also name Microsoft's own APIs, a token for which central must never be
// able to ask a developer's editor for. A verified-domain https App ID URI is
// set in the extension's own settings instead.
const APP_ID_URI = /^api:\/\/[^\s?#]{1,200}$/;

/** What the install's OIDC settings imply. */
export function derivedClientConfig(env: NodeJS.ProcessEnv = process.env): RunnerClientConfig {
  const cfg = oidcCfg(env);
  const microsoft = cfg.enabled && cfg.provider === 'microsoft';
  const issuer = microsoft ? cfg.issuer : '';
  const audience = microsoft ? cfg.audience : '';
  return {
    signIn: microsoft ? 'microsoft' : 'network',
    tenantId: issuer.match(/\/([0-9a-f-]{36})(\/|$)/i)?.[1] ?? '',
    appIdUri:
      !audience || /^https:\/\//.test(audience) ? '' : APP_ID_URI.test(audience) ? audience : `api://${audience}`,
    clientId: '',
  };
}

/** Each override field on its own: the valid ones, and an error per malformed one. */
function checkFields(raw: unknown): { overrides: RunnerClientOverrides; errors: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const overrides: RunnerClientOverrides = {};
  const errors: string[] = [];
  for (const [key, test, what] of [
    ['appIdUri', APP_ID_URI, "an api:// URI (an https one goes in the extension's own settings)"],
    ['clientId', GUID, 'a GUID'],
  ] as const) {
    const v = r[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !test.test(v.trim())) errors.push(`${key} must be ${what}`);
    else overrides[key] = v.trim();
  }
  const key = r.releaseKey;
  if (key !== undefined && key !== null && key !== '') {
    const parsed = parseReleaseKey(key);
    if (!parsed) errors.push('releaseKey must be an Ed25519 public key (ed25519:<base64>)');
    else overrides.releaseKey = parsed;
  }
  return { overrides, errors };
}

/**
 * Validate an owner's overrides. An empty string clears that override (the
 * derived value applies again); anything malformed is refused, not dropped.
 */
export function parseOverrides(
  raw: unknown,
): { ok: true; overrides: RunnerClientOverrides } | { ok: false; error: string } {
  const { overrides, errors } = checkFields(raw);
  return errors.length ? { ok: false, error: errors[0] } : { ok: true, overrides };
}

/**
 * The stored overrides, field by field: one that no longer validates (a rule
 * tightened since it was saved) is dropped alone, and the others still apply.
 */
export function readStoredOverrides(raw: string): { overrides: RunnerClientOverrides; dropped: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { overrides: {}, dropped: ['the stored value is not JSON'] };
  }
  // Earlier versions also stored signIn and tenantId; those now follow Admin → Sign-in.
  const { overrides, errors } = checkFields(parsed);
  return { overrides, dropped: errors };
}

/**
 * An owner's change applied to the stored overrides: a field the body names
 * replaces (an empty one clears), a field it leaves out is kept — the sign-in
 * page and the release key are saved from different places.
 */
export function mergeOverrides(
  current: RunnerClientOverrides,
  raw: unknown,
  parsed: RunnerClientOverrides,
): RunnerClientOverrides {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: RunnerClientOverrides = { ...current };
  for (const k of OVERRIDE_KEYS) {
    if (!(k in body)) continue;
    if (parsed[k] !== undefined) out[k] = parsed[k];
    else delete out[k];
  }
  return out;
}

export async function getClientOverrides(): Promise<RunnerClientOverrides> {
  const raw = await getRunnerClientConfigRaw();
  if (!raw) return {};
  const { overrides, dropped } = readStoredOverrides(raw);
  if (dropped.length) log.warn('Runner client overrides: stored values dropped', { dropped });
  return overrides;
}

export async function setClientOverrides(overrides: RunnerClientOverrides): Promise<void> {
  await setRunnerClientConfigRaw(Object.keys(overrides).length ? JSON.stringify(overrides) : null);
}

/** The derived settings, with the sign-in overrides applied only when signing in with Microsoft; the release key always. */
export function effectiveClientConfig(
  overrides: RunnerClientOverrides,
  derived: RunnerClientConfig = derivedClientConfig(),
): RunnerClientConfig {
  const { releaseKey, ...signIn } = overrides;
  const base = derived.signIn === 'microsoft' ? { ...derived, ...signIn } : derived;
  return releaseKey ? { ...base, releaseKey } : base;
}
