/**
 * Cloud models behind the LiteLLM router (Manage → Models, owners only).
 *
 * The provider key goes to the OneCLI vault and is assigned to one identity:
 * the router's own (`litellm-<install>`, selective, so no other secret reaches
 * it). The router container's outbound traffic leaves through the OneCLI
 * gateway under that identity, and the gateway adds the key per request;
 * LiteLLM itself holds only a placeholder. The key is never written to this
 * host's disk or to NanoClaw's database, and it is never read back.
 *
 * The key is injected only on each provider's inference and model-list paths
 * (CloudProvider.paths), so LiteLLM's pass-through routes (/cohere/*,
 * /mistral/*: files, fine-tunes, batches) never carry it.
 *
 * The router takes a password (LiteLLM's master key, data/litellm/master.key)
 * whenever it serves a cloud model: the gateway adds the provider key to
 * everything it sends, so an open port would spend that key for anyone who
 * reaches it. Agents never hold the master key. The router shares a network
 * with OneCLI's container only, and agents call it by container name THROUGH
 * the gateway, which adds the master key from the vault on inference paths
 * only (the router secrets, assigned through tool-secrets' reconcile to the
 * agents whose model the router serves, and to no other: syncRouterSecretHold
 * re-checks it at each spawn, so a model change follows). Central's own calls
 * go to loopback and send it themselves (routerAuthHeaders).
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { realOnecliAdmin, type OnecliAdmin, type SecretRow } from '../../modules/user-credentials/onecli-admin.js';
import {
  reconcileAllAgents,
  reconcileGroupAgents,
  registerAssignedSecretSource,
} from '../../modules/tool-secrets/index.js';
import { listGroupMemberEnrollments } from '../../modules/user-credentials/db.js';
import { userCredsAgentIdentifier } from '../../modules/user-credentials/identity.js';
import { getEffectiveModelForAgent } from './db.js';

export interface CloudProvider {
  id: string;
  label: string;
  /** LiteLLM's model prefix for the provider. */
  prefix: string;
  /**
   * The provider's own OpenAI-compatible endpoint, when LiteLLM should pass
   * through to it (prefix openai/) instead of translating. Cohere: LiteLLM's
   * cohere_chat streaming drops tool calls, so an agent's turn came back empty
   * whenever the model used a tool; Cohere's /compatibility/v1 streams them.
   */
  apiBase?: string;
  /** The host LiteLLM calls (the vault secret's host pattern). */
  host: string;
  /**
   * The request paths the key is injected on (OneCLI path patterns, query
   * ignored): inference first — the one agents stream on — then the model list.
   */
  paths: readonly string[];
  header: string;
  format: string;
  /**
   * The most output tokens the provider's models take per reply. Claude Code
   * asks for more (32k) unless told (CLAUDE_CODE_MAX_OUTPUT_TOKENS), and a
   * provider refuses the whole turn when over: Command A caps at 8192.
   */
  maxOutput: number;
  /** The provider's model catalogue, and the chat model ids in its answer. */
  list: { url: string; ids: (body: Record<string, unknown>) => string[] };
}

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const openaiIds = (b: Row) =>
  rows(b.data)
    .map((m) => String(m.id ?? ''))
    .filter(Boolean);

export const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  {
    id: 'cohere',
    label: 'Cohere',
    prefix: 'openai/',
    apiBase: 'https://api.cohere.com/compatibility/v1',
    host: 'api.cohere.com',
    paths: ['/compatibility/v1/chat/completions', '/v1/models'],
    header: 'Authorization',
    format: 'Bearer {value}',
    maxOutput: 8192,
    list: {
      url: 'https://api.cohere.com/v1/models?endpoint=chat&page_size=200',
      ids: (b) =>
        rows(b.models)
          .map((m) => String(m.name ?? ''))
          .filter(Boolean),
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    prefix: 'openai/',
    host: 'api.openai.com',
    paths: ['/v1/chat/completions', '/v1/responses', '/v1/models'],
    header: 'Authorization',
    format: 'Bearer {value}',
    maxOutput: 16384,
    list: {
      url: 'https://api.openai.com/v1/models',
      ids: (b) => openaiIds(b).filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id)),
    },
  },
  {
    id: 'mistral',
    label: 'Mistral',
    prefix: 'mistral/',
    host: 'api.mistral.ai',
    paths: ['/v1/chat/completions', '/v1/models'],
    header: 'Authorization',
    format: 'Bearer {value}',
    maxOutput: 8192,
    list: { url: 'https://api.mistral.ai/v1/models', ids: openaiIds },
  },
  {
    id: 'gemini',
    label: 'Gemini',
    prefix: 'gemini/',
    host: 'generativelanguage.googleapis.com',
    paths: ['/v1beta/models/*:streamGenerateContent', '/v1beta/models/*:generateContent', '/v1beta/models'],
    header: 'x-goog-api-key',
    format: '{value}',
    maxOutput: 8192,
    list: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      ids: (b) =>
        rows(b.models)
          .filter(
            (m) =>
              rows(m.supportedGenerationMethods).length === 0 ||
              String(m.supportedGenerationMethods).includes('generateContent'),
          )
          .map((m) => String(m.name ?? '').replace(/^models\//, ''))
          .filter(Boolean),
    },
  },
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_KEY = 4096;
const DIR = 'data/litellm';

/** The router's OneCLI identity: one per install, holding only provider keys. */
export const routerIdentity = (): string =>
  `litellm-${INSTALL_SLUG}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63);

/** Port and container name; a second install on the host sets its own (LITELLM_PORT, LITELLM_CONTAINER). */
export function routerSettings(root = process.cwd()): { port: number; container: string } {
  const env = { ...readEnvFile(['LITELLM_PORT', 'LITELLM_CONTAINER'], root), ...pick(process.env) };
  const port = Number(env.LITELLM_PORT) || 4000;
  return { port, container: env.LITELLM_CONTAINER || 'nanoclaw-litellm' };
}
function pick(e: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['LITELLM_PORT', 'LITELLM_CONTAINER']) if (e[k]) out[k] = String(e[k]);
  return out;
}

/**
 * A cloud model's registered endpoint. Loopback, as central reaches it; an
 * agent's environment rewrites it to host.docker.internal (models.ts
 * containerReachableUrl), and the egress filter passes the port to it.
 */
export const routerEndpoint = (root = process.cwd()): string => `http://127.0.0.1:${routerSettings(root).port}/v1`;

export const routerInstalled = (root = process.cwd()): boolean => fs.existsSync(path.join(root, DIR, 'config.yaml'));

/** The port the router listens on inside its container (install-litellm.sh --port 4000). */
const ROUTER_CONTAINER_PORT = 4000;

/** Is the router behind the gateway (it serves cloud models: the OneCLI proxy settings are there)? */
export const routerViaGateway = (root = process.cwd()): boolean => fs.existsSync(path.join(root, DIR, 'onecli.env'));

/** The router as agents call it through the gateway: its container name on OneCLI's network. */
export const routerGatewayBase = (root = process.cwd()): string =>
  `http://${routerSettings(root).container}:${ROUTER_CONTAINER_PORT}`;

/**
 * Does this endpoint name the router? Loopback or host.docker.internal on its
 * port: cloud models register 127.0.0.1, the auto router host.docker.internal.
 * With `anyPort`, on any port (a registration made before the port changed).
 */
export function isRouterEndpoint(endpoint: string | null | undefined, root = process.cwd(), anyPort = false): boolean {
  if (!endpoint) return false;
  try {
    const u = new URL(endpoint);
    return (
      ['127.0.0.1', 'localhost', 'host.docker.internal'].includes(u.hostname) &&
      (anyPort || Number(u.port || 80) === routerSettings(root).port)
    );
  } catch {
    return false;
  }
}

/** The router's base as an agent dials it, when that is through the gateway; null otherwise. */
export function agentRouterBase(endpoint: string | null | undefined, root = process.cwd()): string | null {
  return isRouterEndpoint(endpoint, root) && routerViaGateway(root) ? routerGatewayBase(root) : null;
}

const MASTER_KEY = 'master.key';

/** The router's master key, created (mode 600) if there is none; install-litellm.sh uses the same file. */
export function ensureMasterKey(root = process.cwd()): string {
  const file = path.join(root, DIR, MASTER_KEY);
  try {
    const have = fs.readFileSync(file, 'utf8').trim();
    if (have) return have;
  } catch {
    /* none yet */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = `sk-${crypto.randomBytes(32).toString('hex')}`;
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

/**
 * Central's own request to `url`: the master key when it is the router on
 * loopback and the router has one. Agents never come through here.
 */
export function routerAuthHeaders(url: string, root = process.cwd()): Record<string, string> {
  try {
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) || Number(u.port || 80) !== routerSettings(root).port)
      return {};
    const key = fs.readFileSync(path.join(root, DIR, MASTER_KEY), 'utf8').trim();
    return key ? { Authorization: `Bearer ${key}` } : {};
  } catch {
    return {};
  }
}

/**
 * The router secrets: the master key, on inference paths only. The master key
 * is LiteLLM's admin credential too, and its admin routes include ones that
 * run commands by design (MCP server tests, config updates); added to every
 * path, it would make every agent a router admin. An admin route arrives
 * without it and is refused. One secret per path (a OneCLI secret has one
 * path pattern; `*` is a prefix match): what Claude Code and OpenCode call,
 * and the model list.
 */
export const ROUTER_PATHS: ReadonlyArray<{ id: string; pathPattern: string }> = [
  { id: 'messages', pathPattern: '/v1/messages*' },
  { id: 'chat', pathPattern: '/v1/chat/completions*' },
  { id: 'models', pathPattern: '/v1/models*' },
];
const routerSecretPrefix = (): string => `LiteLLM ${INSTALL_SLUG} router`;
const routerSecretName = (pathId: string): string => `${routerSecretPrefix()} ${pathId}`;

/** Every router secret in the vault, by name (an older path-less one included, so it is cleaned up). */
async function routerSecrets(admin: OnecliAdmin): Promise<Array<{ id: string; name: string }>> {
  const prefix = routerSecretPrefix();
  return (await admin.listAllSecrets())
    .filter((s) => s.name === prefix || s.name?.startsWith(`${prefix} `))
    .map((s) => ({ id: s.id, name: s.name! }));
}

/**
 * Does the router serve this group's model (its own assignment, else the
 * workspace default)? Registered on loopback or host.docker.internal on the
 * router's port (isRouterEndpoint), or by the router's container name.
 */
export async function routerServesGroup(agentGroupId: string, root = process.cwd()): Promise<boolean> {
  const model = await getEffectiveModelForAgent(agentGroupId).catch(() => null);
  if (!model?.endpoint) return false;
  if (isRouterEndpoint(model.endpoint, root)) return true;
  try {
    return new URL(model.endpoint).hostname === routerSettings(root).container;
  } catch {
    return false;
  }
}

// Only the agents whose model the router serves hold the router secrets
// (tool-secrets writes them into those agents' lists and drops them from the
// rest). An agent on another model has no business spending the router's
// cloud keys. Note an agent in OneCLI's `all` secret mode is still offered
// every secret whose host matches; credential isolation is what makes this
// assignment the whole story.
registerAssignedSecretSource({
  ids: async (admin) => (await routerSecrets(admin).catch(() => [])).map((s) => s.id),
  wants: (agentGroupId) => routerServesGroup(agentGroupId),
});

/**
 * At spawn: does this group's agent (and each member's) hold the router
 * secrets exactly when the router serves its model? If not — its model
 * changed, or the install predates this rule — re-apply its assignments.
 * A no-op without cloud models; never throws (a spawn does not wait on it).
 */
export async function syncRouterSecretHold(
  agentGroupId: string,
  admin: OnecliAdmin = realOnecliAdmin,
  root = process.cwd(),
): Promise<void> {
  try {
    if (!routerViaGateway(root)) return;
    const ids = (await routerSecrets(admin)).map((s) => s.id);
    if (!ids.length) return;
    const want = await routerServesGroup(agentGroupId, root);
    const identities = [
      agentGroupId,
      ...(await listGroupMemberEnrollments(agentGroupId)).map((r) => userCredsAgentIdentifier(agentGroupId, r.user_id)),
    ];
    for (const identity of identities) {
      const agentId = await admin.findAgentId(identity);
      if (!agentId) continue;
      const held = new Set(await admin.listAgentSecretIds(agentId));
      if (ids.every((id) => held.has(id) === want)) continue;
      await reconcileGroupAgents(admin, agentGroupId);
      log.info('Router secrets re-assigned for a model change', { agentGroupId, held: want });
      return;
    }
  } catch (err) {
    log.warn('Router secret assignment check failed', { agentGroupId, err });
  }
}

/**
 * The router secrets, created or brought up to date (an older path-less one
 * removed), then every agent's assignment re-applied so the ones the router
 * serves hold them.
 */
export async function ensureRouterSecret(admin: OnecliAdmin, root = process.cwd()): Promise<void> {
  const key = ensureMasterKey(root);
  const have = await routerSecrets(admin);
  for (const p of ROUTER_PATHS) {
    const found = have.find((s) => s.name === routerSecretName(p.id));
    if (found) await admin.updateSecretValue(found.id, key);
    else
      await admin.createGenericSecret(routerSecretName(p.id), key, {
        hostPattern: routerSettings(root).container,
        pathPattern: p.pathPattern,
        headerName: 'Authorization',
        valueFormat: 'Bearer {value}',
      });
  }
  for (const old of have.filter((s) => s.name === routerSecretPrefix())) await admin.deleteSecret(old.id);
  await reconcileAllAgents(admin);
}

/** OneCLI's container: the gateway the router's network is shared with. */
const onecliContainer = (): string =>
  process.env.ONECLI_GATEWAY_CONTAINER ||
  readEnvFile(['ONECLI_GATEWAY_CONTAINER']).ONECLI_GATEWAY_CONTAINER ||
  'onecli';

/** The network the router shares with OneCLI's container only (install-litellm.sh makes it). */
export const routerNetwork = (root = process.cwd()): string => `${routerSettings(root).container}-gateway`;

type Runtime = (args: string[]) => Promise<void>;
const runtimeQuiet: Runtime = (args) =>
  new Promise((resolve) => execFile(CONTAINER_RUNTIME_BIN, args, { timeout: 10_000 }, () => resolve()));

let networkCheckedAt = 0;
const NETWORK_CHECK_MS = 60_000;

/**
 * Re-attach OneCLI's container to the router's network. Recreating OneCLI's
 * container (an upgrade, a compose up) drops the attachment, and the agents'
 * route to the router with it. Cheap and idempotent ("already connected" is
 * ignored); at most once a minute, from the spawn path.
 */
export async function ensureRouterNetwork(root = process.cwd(), run: Runtime = runtimeQuiet): Promise<void> {
  if (!routerViaGateway(root) || Date.now() - networkCheckedAt < NETWORK_CHECK_MS) return;
  networkCheckedAt = Date.now();
  await run(['network', 'connect', routerNetwork(root), onecliContainer()]);
}

export interface GatewayConfig {
  env: Record<string, string>;
  caCertificate: string;
}
export interface CloudModelDeps {
  admin: OnecliAdmin;
  /** OneCLI's container configuration for an identity (proxy URL, CA). */
  containerConfig: (identity: string) => Promise<GatewayConfig>;
}

const ONECLI_SDK = '@onecli-sh/sdk';
type OneCLICtor = new (o: { url?: string; apiKey?: string }) => {
  getContainerConfig(o: { agent: string }): Promise<{ env: unknown; caCertificate: string }>;
};

async function defaultContainerConfig(identity: string): Promise<GatewayConfig> {
  const env = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']);
  // The SDK comes with the OneCLI gateway skill; without it there is no vault to use.
  // A variable specifier, so a tree without the skill still compiles (as drafter.ts does).
  const { OneCLI } = (await import(ONECLI_SDK)) as { OneCLI: OneCLICtor };
  const onecli = new OneCLI({
    url: process.env.ONECLI_URL || env.ONECLI_URL,
    apiKey: process.env.ONECLI_API_KEY || env.ONECLI_API_KEY,
  });
  const c = await onecli.getContainerConfig({ agent: identity });
  return { env: c.env as Record<string, string>, caCertificate: c.caCertificate };
}

export class CloudModelError extends Error {}

export interface CloudModelInput {
  provider: unknown;
  model_id: unknown;
  api_key: unknown;
}

/**
 * Store the key in the vault for the router's identity, point the router's
 * traffic at the gateway, and declare the backend. The caller then (re)runs
 * the router install and registers the model.
 */
export async function prepareCloudModel(
  input: CloudModelInput,
  root = process.cwd(),
  deps: CloudModelDeps = { admin: realOnecliAdmin, containerConfig: defaultContainerConfig },
): Promise<{ provider: CloudProvider; modelId: string; added: boolean }> {
  const provider = CLOUD_PROVIDERS.find((p) => p.id === input.provider);
  if (!provider) throw new CloudModelError('Unknown provider');
  const modelId = typeof input.model_id === 'string' ? input.model_id.trim() : '';
  if (!MODEL_ID.test(modelId)) throw new CloudModelError('Invalid model');
  const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  if (apiKey.length > MAX_KEY || /\s/.test(apiKey)) throw new CloudModelError('Invalid key');

  const { admin } = deps;
  const identity = routerIdentity();
  const agentId = await admin.ensureAgent('LiteLLM router', identity);
  await admin.setSecretMode(agentId, 'selective');
  const secrets = await admin.listAllSecrets();
  // No key given: the one already in the vault for this provider stays.
  if (!apiKey && !secrets.some((s) => s.name === secretName(provider, 0))) throw new CloudModelError('Invalid key');
  const secretIds = await ensureProviderSecrets(admin, provider, apiKey, secrets);
  const assigned = await admin.listAgentSecretIds(agentId);
  const missing = secretIds.filter((id) => !assigned.includes(id));
  if (missing.length) await admin.setSecrets(agentId, [...assigned, ...missing]);

  writeGatewayFiles(root, await deps.containerConfig(identity));
  await ensureRouterSecret(admin, root);
  const added = !cloudModelNames(root).includes(modelId);
  upsertBackend(root, {
    model_name: modelId,
    model: `${provider.prefix}${modelId}`,
    gateway: true,
    provider: provider.id,
    ...(provider.apiBase ? { api_base: provider.apiBase } : {}),
  });
  return { provider, modelId, added };
}

/** One vault secret per injected path; the first keeps the name keys stored before paths were scoped. */
const secretName = (p: CloudProvider, i: number): string =>
  i === 0 ? `LiteLLM ${INSTALL_SLUG} ${p.id}` : `LiteLLM ${INSTALL_SLUG} ${p.id} ${i + 1}`;
const isProviderSecret = (p: CloudProvider, name: string | undefined): boolean =>
  name === secretName(p, 0) || (name ?? '').startsWith(`${secretName(p, 0)} `);

/**
 * The provider's secrets, one per path, each scoped to its path. With a key
 * every one is written; without, the stored ones are only re-scoped (a key
 * stored before scoping is narrowed to the inference path) and the rest wait
 * for the key to be given again.
 */
async function ensureProviderSecrets(
  admin: OnecliAdmin,
  provider: CloudProvider,
  apiKey: string,
  secrets: SecretRow[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, pathPattern] of provider.paths.entries()) {
    const name = secretName(provider, i);
    const existing = secrets.find((s) => s.name === name);
    if (existing) {
      if (apiKey) await admin.updateSecretValue(existing.id, apiKey);
      if (existing.pathPattern !== pathPattern) await admin.updateSecretPathPattern(existing.id, pathPattern);
      ids.push(existing.id);
    } else if (apiKey) {
      ids.push(
        await admin.createGenericSecret(name, apiKey, {
          hostPattern: provider.host,
          pathPattern,
          headerName: provider.header,
          valueFormat: provider.format,
        }),
      );
    }
  }
  return ids;
}

/** Narrow every stored cloud key to its provider's paths (a key stored before scoping injected on every path). */
export async function restrictCloudSecrets(admin: OnecliAdmin = realOnecliAdmin): Promise<void> {
  const secrets = await admin.listAllSecrets();
  for (const p of CLOUD_PROVIDERS) await ensureProviderSecrets(admin, p, '', secrets);
}

/** Providers whose key the vault holds for this install, on every path the provider needs. */
export async function storedProviders(admin: OnecliAdmin = realOnecliAdmin): Promise<string[]> {
  const names = new Set((await admin.listAllSecrets()).map((s) => s.name));
  return CLOUD_PROVIDERS.filter((p) => p.paths.every((_, i) => names.has(secretName(p, i)))).map((p) => p.id);
}

/** Run curl through the router's gateway identity: its key is added on the way, never seen here. */
export type GatewayGet = (url: string, root: string) => Promise<string>;
const gatewayGet: GatewayGet = (url, root) =>
  new Promise((resolve, reject) => {
    const env = fs.readFileSync(path.join(root, DIR, 'onecli.env'), 'utf8');
    const proxy = /^HTTPS_PROXY=(.+)$/m.exec(env)?.[1];
    if (!proxy) return reject(new CloudModelError('No router'));
    // From the host, the gateway answers where OneCLI's API does (the bridge address).
    const onecli = readEnvFile(['ONECLI_URL']).ONECLI_URL || process.env.ONECLI_URL || '';
    let host = '172.17.0.1';
    try {
      host = new URL(onecli).hostname || host;
    } catch {
      /* default bridge */
    }
    execFile(
      'curl',
      ['-sS', '--max-time', '20', '--cacert', path.join(root, DIR, 'onecli-ca.pem'), url],
      // The proxy URL carries the identity's token: in the environment, not argv.
      {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HTTPS_PROXY: proxy.replace('host.docker.internal', host) },
        maxBuffer: 8 << 20,
      },
      (err, out) => (err ? reject(err) : resolve(String(out))),
    );
  });

/** The provider's chat model ids, read with the stored key. */
export async function listProviderModels(
  providerId: unknown,
  root = process.cwd(),
  get: GatewayGet = gatewayGet,
): Promise<string[]> {
  const provider = CLOUD_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) throw new CloudModelError('Unknown provider');
  if (!fs.existsSync(path.join(root, DIR, 'onecli.env'))) throw new CloudModelError('No router');
  let body: Row;
  try {
    body = JSON.parse(await get(provider.list.url, root)) as Row;
  } catch {
    throw new CloudModelError('No list');
  }
  return [...new Set(provider.list.ids(body))].sort();
}

/**
 * Stop serving a deleted cloud model: drop its backend, and the provider's
 * vault key once no backend of that provider is left. Returns what is left,
 * so the caller reloads the router (or removes it when nothing is).
 */
export async function removeCloudModel(
  modelId: string,
  stillRegistered: boolean,
  root = process.cwd(),
  admin: OnecliAdmin = realOnecliAdmin,
): Promise<{ removed: boolean; remaining: number; leftGateway?: boolean }> {
  const file = path.join(root, DIR, 'backends.json');
  let list: Backend[];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8')) as Backend[];
  } catch {
    return { removed: false, remaining: 0 };
  }
  const gone = list.find((b) => b.gateway === true && b.model_name === modelId);
  // Another registration still uses it (a second name for the same model).
  if (!gone || stillRegistered) return { removed: false, remaining: list.length };
  list = list.filter((b) => b !== gone);
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  const provider = providerOf(gone);
  if (provider && !list.some((b) => b.gateway === true && providerOf(b) === provider)) {
    for (const s of await admin.listAllSecrets())
      if (isProviderSecret(provider, s.name)) await admin.deleteSecret(s.id);
  }
  // The last cloud model: the router serves local servers only, directly again.
  const leftGateway = !list.some((b) => b.gateway === true);
  if (leftGateway) await dropGateway(root, admin);
  return { removed: true, remaining: list.length, leftGateway };
}

/**
 * The router leaves the gateway: its proxy settings go, and the router secret
 * with every agent's hold on it. The next install starts it without them.
 */
async function dropGateway(root: string, admin: OnecliAdmin, run: Runtime = runtimeQuiet): Promise<void> {
  for (const f of ['onecli.env', 'onecli-ca.pem']) fs.rmSync(path.join(root, DIR, f), { force: true });
  const secrets = await routerSecrets(admin).catch(() => []);
  for (const s of secrets) await admin.deleteSecret(s.id);
  if (secrets.length) await reconcileAllAgents(admin);
  // Best effort: the network goes once nothing but OneCLI is on it (docker refuses while the router is).
  await run(['network', 'disconnect', routerNetwork(root), onecliContainer()]);
  await run(['network', 'rm', routerNetwork(root)]);
}

/** No model left: remove the router container, its config and its gateway settings (the provider keys are already gone). */
export async function removeRouter(
  root = process.cwd(),
  admin: OnecliAdmin = realOnecliAdmin,
  run: Runtime = runtimeQuiet,
): Promise<void> {
  await run(['rm', '-f', routerSettings(root).container]);
  for (const f of ['config.yaml', 'backends.json']) fs.rmSync(path.join(root, DIR, f), { force: true });
  await dropGateway(root, admin, run);
  // And its OneCLI identity (the provider keys are already gone).
  const agentId = await admin.findAgentId(routerIdentity());
  if (agentId) await admin.deleteAgent(agentId);
}

const SYSTEM_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];

/** The router container's proxy settings (onecli.env, 0600) and CA trust: system roots plus OneCLI's CA. */
export function writeGatewayFiles(root: string, cfg: GatewayConfig): void {
  const dir = path.join(root, DIR);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    if (cfg.env[k]) lines.push(`${k}=${cfg.env[k]}`);
  }
  if (!lines.length) throw new CloudModelError('OneCLI gave no proxy');
  lines.push('SSL_CERT_FILE=/etc/onecli/ca.pem', 'REQUESTS_CA_BUNDLE=/etc/onecli/ca.pem');
  // Local model servers stay direct (the gateway cannot resolve host.docker.internal);
  // the installer adds the configured hosts and the classifier.
  lines.push('NO_PROXY=localhost,127.0.0.1,host.docker.internal', 'no_proxy=localhost,127.0.0.1,host.docker.internal');
  fs.writeFileSync(path.join(dir, 'onecli.env'), lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(path.join(dir, 'onecli.env'), 0o600);
  const system = SYSTEM_BUNDLES.find((f) => fs.existsSync(f));
  const roots = system ? fs.readFileSync(system, 'utf8') : '';
  fs.writeFileSync(path.join(dir, 'onecli-ca.pem'), `${roots}\n${cfg.caCertificate}\n`, { mode: 0o644 });
}

/**
 * A backend's provider: recorded since providers can share a LiteLLM prefix
 * (Cohere passes through as openai/); older entries by their prefix.
 */
function providerOf(b: Backend): CloudProvider | undefined {
  return b.provider
    ? CLOUD_PROVIDERS.find((p) => p.id === b.provider)
    : (CLOUD_PROVIDERS.find((p) => b.model.startsWith(p.prefix) && !p.apiBase) ??
        (b.model.startsWith('cohere_chat/') ? CLOUD_PROVIDERS.find((p) => p.id === 'cohere') : undefined));
}

interface Backend {
  model_name: string;
  model: string;
  gateway?: boolean;
  api_key_env?: string;
  api_base?: string;
  /** Which CLOUD_PROVIDERS entry (gen-config ignores it). */
  provider?: string;
}

/** The cloud models the router serves (gateway backends): selectable models, not routing backends. */
export function cloudModelNames(root = process.cwd()): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, DIR, 'backends.json'), 'utf8'));
    return Array.isArray(raw) ? (raw as Backend[]).filter((b) => b.gateway === true).map((b) => b.model_name) : [];
  } catch {
    return [];
  }
}

/** The output cap for a cloud model the router serves at `endpoint`, or null for any other model. */
export function cloudModelMaxOutput(
  modelId: string,
  endpoint: string | null | undefined,
  root = process.cwd(),
): number | null {
  if (!isRouterEndpoint(endpoint, root)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, DIR, 'backends.json'), 'utf8')) as Backend[];
    const b = Array.isArray(raw) ? raw.find((x) => x.gateway === true && x.model_name === modelId) : undefined;
    return b ? (providerOf(b)?.maxOutput ?? null) : null;
  } catch {
    return null;
  }
}

export function upsertBackend(root: string, b: Backend): void {
  const file = path.join(root, DIR, 'backends.json');
  let list: Backend[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) list = raw as Backend[];
  } catch {
    /* none yet */
  }
  list = list.filter((x) => x.model_name !== b.model_name);
  list.push(b);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
}
