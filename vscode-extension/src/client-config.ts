// The sign-in settings central hands out (Manage → Runners), so a developer
// only has to click "Connect VS Code" in webchat. They arrive two ways: in the
// connect link itself, and from GET /api/runners/client-config on every
// connect. A value the user set in their own settings always wins.
import { secureOrigin, type SignIn } from './protocol.js';

export interface ClientConfig {
  signIn?: SignIn;
  tenantId?: string;
  appIdUri?: string;
  clientId?: string;
}
export const CLIENT_KEYS = ['signIn', 'tenantId', 'appIdUri', 'clientId'] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID_URI = /^(api|https):\/\/[^\s?#]{1,200}$/;

/** Only well-formed values survive: a bad link or response can't plant anything else. */
export function sanitizeClientConfig(raw: unknown): ClientConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ClientConfig = {};
  if (r.signIn === 'microsoft' || r.signIn === 'network') out.signIn = r.signIn;
  if (typeof r.tenantId === 'string' && GUID.test(r.tenantId)) out.tenantId = r.tenantId;
  if (typeof r.appIdUri === 'string' && APP_ID_URI.test(r.appIdUri)) out.appIdUri = r.appIdUri;
  if (typeof r.clientId === 'string' && GUID.test(r.clientId)) out.clientId = r.clientId;
  return out;
}

/** `vscode://nanoclaw.vscode/connect?server=…&tenantId=…`: the server, plus whatever sign-in settings it carries. */
export function parseConnectQuery(query: string): { serverUrl: string; config: ClientConfig } | { error: string } {
  const q = new URLSearchParams(query);
  let u: URL;
  try {
    u = new URL(q.get('server') ?? '');
  } catch {
    return { error: 'the link names no server' };
  }
  const serverUrl = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  if (!secureOrigin(serverUrl)) return { error: `${serverUrl} is not https` };
  return { serverUrl, config: sanitizeClientConfig(Object.fromEntries(q)) };
}

/** Per key: the user's own setting, else central's, else the built-in default. */
export function resolveClientConfig(
  own: ClientConfig,
  central: ClientConfig,
): { signIn: SignIn; tenantId: string; appIdUri: string; clientId: string } {
  return {
    signIn: own.signIn ?? central.signIn ?? 'microsoft',
    tenantId: own.tenantId ?? central.tenantId ?? '',
    appIdUri: own.appIdUri ?? central.appIdUri ?? '',
    clientId: own.clientId ?? central.clientId ?? '',
  };
}
