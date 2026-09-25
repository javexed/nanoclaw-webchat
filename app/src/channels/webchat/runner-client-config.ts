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
 */
import { oidcCfg } from './auth.js';
import { getRunnerClientConfigRaw, setRunnerClientConfigRaw } from './db.js';

export type SignIn = 'microsoft' | 'network';
export interface RunnerClientConfig {
  signIn: SignIn;
  tenantId: string;
  appIdUri: string;
  clientId: string;
}
export type RunnerClientOverrides = Partial<Pick<RunnerClientConfig, 'appIdUri' | 'clientId'>>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID_URI = /^(api|https):\/\/[^\s?#]{1,200}$/;

/** What the install's OIDC settings imply. */
export function derivedClientConfig(env: NodeJS.ProcessEnv = process.env): RunnerClientConfig {
  const cfg = oidcCfg(env);
  const microsoft = cfg.enabled && cfg.provider === 'microsoft';
  const issuer = microsoft ? cfg.issuer : '';
  const audience = microsoft ? cfg.audience : '';
  return {
    signIn: microsoft ? 'microsoft' : 'network',
    tenantId: issuer.match(/\/([0-9a-f-]{36})(\/|$)/i)?.[1] ?? '',
    appIdUri: !audience ? '' : APP_ID_URI.test(audience) ? audience : `api://${audience}`,
    clientId: '',
  };
}

/**
 * Validate an owner's overrides. An empty string clears that override (the
 * derived value applies again); anything malformed is refused, not dropped.
 */
export function parseOverrides(
  raw: unknown,
): { ok: true; overrides: RunnerClientOverrides } | { ok: false; error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: RunnerClientOverrides = {};
  for (const [key, test, what] of [
    ['appIdUri', APP_ID_URI, 'an api:// or https:// URI'],
    ['clientId', GUID, 'a GUID'],
  ] as const) {
    const v = r[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !test.test(v.trim())) return { ok: false, error: `${key} must be ${what}` };
    out[key] = v.trim();
  }
  return { ok: true, overrides: out };
}

export async function getClientOverrides(): Promise<RunnerClientOverrides> {
  const raw = await getRunnerClientConfigRaw();
  if (!raw) return {};
  try {
    // Earlier versions also stored signIn and tenantId; those now follow Admin → Sign-in.
    const parsed = parseOverrides(JSON.parse(raw));
    return parsed.ok ? parsed.overrides : {};
  } catch {
    return {};
  }
}

export async function setClientOverrides(overrides: RunnerClientOverrides): Promise<void> {
  await setRunnerClientConfigRaw(Object.keys(overrides).length ? JSON.stringify(overrides) : null);
}

/** The derived settings, with the overrides applied — only when signing in with Microsoft. */
export function effectiveClientConfig(
  overrides: RunnerClientOverrides,
  derived: RunnerClientConfig = derivedClientConfig(),
): RunnerClientConfig {
  return derived.signIn === 'microsoft' ? { ...derived, ...overrides } : derived;
}
