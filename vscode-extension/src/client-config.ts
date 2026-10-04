// The sign-in settings central hands out (Manage → Runners), so a developer
// only has to click "Connect VS Code" in webchat. They arrive two ways: in the
// connect link itself, and from GET /api/runners/client-config on every
// connect. They are central's to set (Manage → Runners); there is no local
// override.
import { secureOrigin, type SignIn } from './protocol.js';
import { parsePublicKey } from './release-signing.js';

export interface ClientConfig {
  signIn?: SignIn;
  tenantId?: string;
  appIdUri?: string;
  clientId?: string;
}
export const CLIENT_KEYS = ['signIn', 'tenantId', 'appIdUri', 'clientId'] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only an app's own `api://` URI. An https one also names Microsoft's own
// APIs (https://management.azure.com): a link or a server that could set it
// would get the developer a token for those, sent to a server of its choosing.
const APP_ID_URI = /^api:\/\/[^\s?#]{1,200}$/;

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

/**
 * `vscode://<extension id>/connect?server=…&tenantId=…`: the server, plus
 * whatever sign-in settings and release signing key it carries (an offer
 * only: the key is pinned on the developer's confirmation).
 */
export function parseConnectQuery(
  query: string,
): { serverUrl: string; config: ClientConfig; releaseKey?: string } | { error: string } {
  const q = new URLSearchParams(query);
  let u: URL;
  try {
    u = new URL(q.get('server') ?? '');
  } catch {
    return { error: 'the link names no server' };
  }
  // The origin only: central is reached there whatever the path (chat-render.ts
  // apiUrl), and a path would give release pins a second name to miss by.
  const serverUrl = u.origin;
  if (!secureOrigin(serverUrl)) return { error: `${serverUrl} is not https` };
  const releaseKey = parsePublicKey(q.get('releaseKey'));
  return { serverUrl, config: sanitizeClientConfig(Object.fromEntries(q)), ...(releaseKey ? { releaseKey } : {}) };
}

/** Per key: central's value, else the built-in default. */
export function resolveClientConfig(central: ClientConfig): {
  signIn: SignIn;
  tenantId: string;
  appIdUri: string;
  clientId: string;
} {
  return {
    signIn: central.signIn ?? 'microsoft',
    tenantId: central.tenantId ?? '',
    appIdUri: central.appIdUri ?? '',
    clientId: central.clientId ?? '',
  };
}

/** Which sign-in settings central changed from what was remembered for it (a first answer changes nothing). */
export function signInChanges(prev: ClientConfig | null, next: ClientConfig): Array<(typeof CLIENT_KEYS)[number]> {
  if (!prev) return [];
  return CLIENT_KEYS.filter((k) => (prev[k] ?? '') !== (next[k] ?? ''));
}
