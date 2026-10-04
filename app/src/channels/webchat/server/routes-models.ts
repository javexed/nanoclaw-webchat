// ── Model routes ─────────────────────────────────────────────────────────────
// The model roster: create (single and bulk), update, delete, the UI listing,
// endpoint management, and the two probes — discovery against a provider and
// reachability against a configured endpoint.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonObject } from './http.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { log } from '../../../log.js';
import { forgetModelHosts } from '../egress-policy.js';
import {
  createWebchatModel,
  deleteWebchatModel,
  getAgentsAssignedToModel,
  getDefaultModelId,
  getFitContextToGpu,
  getWebchatModel,
  getWebchatRoomsForAgent,
  listWebchatModels,
  setDefaultModelId,
  setFitContextToGpu,
  updateWebchatModel,
} from '../db.js';
import type { WebchatModel, WebchatModelKind } from '../db.js';
import { createContextVariant, gatherModelInventory } from '../model-manage.js';
import { autoFitNewModels, fitBenefit, fitJobsSnapshot, startFits } from '../model-autofit.js';
import { hostHealthSnapshot } from '../model-host-health.js';
import { noteRosterHosts, rosterHosts } from '../model-host-sync.js';
import { KNOWN_ANTHROPIC_MODELS, discoverOllamaModels, probeEndpoint, testModel, validateModel } from '../models.js';
import { hasFeatureInstall, installStatus, startFeatureInstall } from '../install-engine.js';
import {
  CLOUD_PROVIDERS,
  CloudModelError,
  cloudModelNames,
  isRouterEndpoint,
  listProviderModels,
  prepareCloudModel,
  removeCloudModel,
  removeRouter,
  storedProviders,
  routerEndpoint,
  routerInstalled,
  routerViaGateway,
} from '../cloud-models.js';
import {
  deriveModelServerHosts,
  listRouters,
  readRoutesConfig,
  removeRouteFromConfig,
  routerView,
  startRouterReinstall,
  writeRoutesConfig,
  type CloudModelStep,
} from '../ollama-manage.js';
import { probeContainerReachability } from '../reachability.js';
import { isOwner } from '../roles.js';
import { readBody } from './http.js';
import {
  refreshUnassignedGroupsForDefaultModel,
  reloadAgentModelEnv,
  reloadRouterModelAgents,
} from './model-wiring.js';
import { randomUUID } from 'crypto';
import type { RouteCtx } from '../server.js';

// GET /api/models/known — the curated Anthropic model-id suggestions, for the
// agent "Anthropic model" datalist. Admin-gated to match the field that uses it
// (the /api/models/discover POST is owner-only, so a scoped admin editing their
// own agent could not read the list through it).
export async function rModelsKnownGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, { models: KNOWN_ANTHROPIC_MODELS });
}

// ── Models ────────────────────────────────────────────────────────────
export async function rModelsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  // Members get the roster (pickers need id/name/kind/model_id) but not the
  // infrastructure fields — endpoint (internal model-server URLs) and
  // credential_ref stay owner-only, matching the rest of the model surface.
  return json(res, 200, await listModelsForUI(await isOwner(userId)));
}

/** Manage → Models: the cloud providers and whether the router is there. */
export async function rCloudModelsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, {
    providers: CLOUD_PROVIDERS.map(({ id, label }) => ({ id, label })),
    router: { installed: routerInstalled(), endpoint: routerEndpoint() },
    models: cloudModelNames(),
    stored: await storedProviders().catch(() => []),
  });
}

/** The provider's model ids, read with the key the vault holds. */
export async function rCloudModelsListGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  try {
    return json(ctx.res, 200, { models: await listProviderModels(ctx.url.searchParams.get('provider')) });
  } catch (err) {
    return json(ctx.res, err instanceof CloudModelError ? 409 : 502, { error: 'No list' });
  }
}

/** POST /api/models/:id/test — one tiny completion; OK or the provider's reason. */
export async function rModelTestPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const model = await getWebchatModel(decodeURIComponent(m[1]));
  if (!model) return json(ctx.res, 404, { error: 'Model not found' });
  return json(ctx.res, 200, await testModel(model));
}

/**
 * Add a cloud model: its key to the OneCLI vault for the router's identity,
 * then (re)install the router, which registers the model at the end. A failed
 * install withdraws the backend again. The key is never echoed or logged.
 */
export async function rCloudModelsPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const body = await readJsonObject<{ provider?: unknown; model_id?: unknown; api_key?: unknown }>(req, res);
  if (body === undefined) return;
  if (!hasFeatureInstall('litellm')) return json(res, 404, { error: "No install named 'litellm'" });
  const wasViaGateway = routerViaGateway();
  let prepared: Awaited<ReturnType<typeof prepareCloudModel>>;
  try {
    prepared = await prepareCloudModel({ provider: body.provider, model_id: body.model_id, api_key: body.api_key });
  } catch (err) {
    if (err instanceof CloudModelError) return json(res, 400, { error: err.message });
    log.warn('Cloud model: vault step failed', { err: String((err as Error)?.message ?? err).slice(0, 300) });
    return json(res, 502, { error: 'OneCLI failed' });
  }
  const { provider, modelId, added } = prepared;
  const cloud: CloudModelStep = {
    register: async () => {
      await registerCloudModel(`${provider.label} ${modelId}`, modelId);
      // The router's first cloud model: agents already on it (local servers, the
      // auto router) reach it through the gateway from now on.
      if (!wasViaGateway) await reloadRouterModelAgents('LiteLLM router moved behind the gateway');
    },
    rollback: async () => {
      if (!added) return;
      try {
        const twin = (await listWebchatModels()).some((x) => x.model_id === modelId && isRouterEndpoint(x.endpoint));
        await removeCloudModel(modelId, twin);
      } catch (err) {
        log.warn('Cloud model: rollback failed', { err: String((err as Error)?.message ?? err).slice(0, 300) });
      }
    },
  };
  const r = await startFeatureInstall('litellm', process.cwd(), {
    hosts: async () => (await deriveModelServerHosts()) ?? '',
    cloud,
  });
  if (!r.started) {
    await cloud.rollback();
    return json(res, 409, { error: r.error, code: r.code });
  }
  return json(res, 202, { ...(await installStatus('litellm')), started: true });
}

/** Register a cloud model the router now serves, unless a registration already names it. */
async function registerCloudModel(name: string, modelId: string): Promise<void> {
  const endpoint = routerEndpoint();
  if ((await listWebchatModels()).some((m) => m.model_id === modelId && m.endpoint === endpoint)) return;
  await createWebchatModel({
    id: randomUUID(),
    name,
    kind: 'openai-compatible',
    endpoint,
    model_id: modelId,
    credential_ref: null,
    created_at: Date.now(),
  });
  forgetModelHosts();
}

export async function rModelsPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return createModelHandler(req, res);
}

export async function rModelsDiscoverPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return discoverModelsHandler(req, res);
}

export async function rModelsProbePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return probeModelsHandler(req, res);
}

export async function rModelsReachabilityPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return reachabilityHandler(req, res);
}

// Container-side reachability preflight: does an AGENT container (not the host)
// reach this endpoint? Save-validation runs host-side, but a loopback endpoint
// the host reaches becomes host.docker.internal in the container — a path a
// firewall or loopback-only bind can silently drop. Returns a verdict + fix.
export async function reachabilityHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonObject<{ endpoint?: unknown }>(req, res);
  if (body === undefined) return;
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) return json(res, 400, { error: 'endpoint required' });
  if (/\s|[<>]/.test(endpoint)) return json(res, 400, { error: 'endpoint contains invalid characters' });
  const result = await probeContainerReachability(endpoint);
  return json(res, 200, result);
}

export async function rModelsBulkPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return bulkCreateModelsHandler(req, res);
}

export async function rModelIdPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return updateModelHandler(req, res, decodeURIComponent(m[1]));
}

export async function rModelIdDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const force = url.searchParams.get('force') === '1';
  return deleteModelHandler(res, decodeURIComponent(m[1]), force);
}

// ── Model management (Settings → Models) ──
// The endpoint an inventory/variant call targets: the first registered ollama
// model's endpoint, else the local default. Owner-configured endpoints only.
export async function manageEndpoint(): Promise<string> {
  const reg = (await listWebchatModels()).find((m) => m.kind === 'ollama' && m.endpoint);
  return reg?.endpoint ?? 'http://localhost:11434';
}

/** A registered Ollama host named by the request, else the default above; null when it names an unregistered one. */
async function requestedEndpoint(raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === '') return manageEndpoint();
  if (typeof raw !== 'string') return null;
  const want = raw.trim().replace(/\/+$/, '');
  const hit = (await listWebchatModels()).find((m) => m.kind === 'ollama' && m.endpoint?.replace(/\/+$/, '') === want);
  return hit?.endpoint ?? null;
}

export async function rModelsManageGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const endpoint = await requestedEndpoint(ctx.url.searchParams.get('endpoint'));
  if (!endpoint) return json(res, 400, { error: 'endpoint is not a registered Ollama host' });
  return json(res, 200, await gatherModelInventory(endpoint));
}

// Create a num_ctx variant of a pulled model (the 4k-default-trap fix), register
// it in the model registry, and optionally make it the workspace default in one
// step — the "Fix: create 16k variant" button.
export async function rModelsContextVariantPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  let body: { tag?: unknown; ctx?: unknown; makeDefault?: unknown; endpoint?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.tag !== 'string' || !body.tag.trim()) return json(res, 400, { error: 'tag required' });
  const ctxSize = Math.floor(Number(body.ctx));
  const endpoint = await requestedEndpoint(body.endpoint);
  if (!endpoint) return json(res, 400, { error: 'endpoint is not a registered Ollama host' });
  try {
    const variantTag = await createContextVariant(await endpoint, body.tag, ctxSize);
    const existing = (await listWebchatModels()).find((m) => m.model_id === variantTag && m.endpoint === endpoint);
    let id = existing?.id;
    if (!id) {
      id = randomUUID();
      await createWebchatModel({
        id,
        name: `${body.tag.trim()} @${Math.round(ctxSize / 1024)}k ctx`,
        kind: 'ollama',
        endpoint: await endpoint,
        model_id: variantTag,
        credential_ref: null,
        created_at: Date.now(),
      });
      forgetModelHosts();
    }
    if (body.makeDefault === true) {
      await setDefaultModelId(id);
      await refreshUnassignedGroupsForDefaultModel('Workspace default model changed (context variant)');
    }
    return json(res, 200, { ok: true, tag: variantTag, modelId: id, madeDefault: body.makeDefault === true });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** New registrations: the router follows a new host; Ollama models get fitted to the GPU (in the background). */
async function afterModelsAdded(hostsBefore: string[], added: WebchatModel[]): Promise<void> {
  if (added.length === 0) return;
  noteRosterHosts(hostsBefore, await rosterHosts());
  await autoFitNewModels(added).catch((err) => log.warn('Fit context to GPU: not started', { err: String(err) }));
}

/** GET /api/models/hosts — each model host's last health check and the GPU fits running or just finished. */
export async function rModelHostsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, {
    health: hostHealthSnapshot(),
    fits: fitJobsSnapshot(),
    fitContext: await getFitContextToGpu(),
  });
}

/**
 * POST /api/models/fit-context/start — { ids }: fit these registered Ollama
 * models to their host's GPU now. What the UI calls when the owner says yes to
 * its prompt after adding models (the setting being off).
 */
export async function rModelFitStartPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<{ ids?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
  if (!ids.length) return json(ctx.res, 400, { error: 'ids must list model ids' });
  const models = (await Promise.all(ids.map((id) => getWebchatModel(id)))).filter((m): m is WebchatModel => !!m);
  return json(ctx.res, 200, { ok: true, started: startFits(models) });
}

/**
 * POST /api/models/fit-context/check — { ids }: which of these registered
 * Ollama models could get a larger window by fitting. Metadata only; the UI
 * asks before it offers, so models already at their largest window (or with
 * num_ctx set) never prompt.
 */
export async function rModelFitCheckPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<{ ids?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
  if (!ids.length) return json(ctx.res, 400, { error: 'ids must list model ids' });
  const models = (await Promise.all(ids.map((id) => getWebchatModel(id)))).filter((m): m is WebchatModel => !!m);
  const checked = await Promise.all(models.map(async (m) => ({ id: m.id, out: await fitBenefit(m) })));
  return json(ctx.res, 200, {
    models: checked.flatMap(({ id, out }) =>
      out.worth ? [{ id, served: out.served, maxContext: out.maxContext }] : [],
    ),
  });
}

/** PUT /api/models/fit-context — { enabled }: fit new Ollama registrations to the GPU without asking. */
export async function rModelFitContextPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<{ enabled?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  if (typeof body.enabled !== 'boolean') return json(ctx.res, 400, { error: 'enabled must be a boolean' });
  await setFitContextToGpu(body.enabled);
  return json(ctx.res, 200, { ok: true, fitContext: body.enabled });
}

export interface ModelForUI extends WebchatModel {
  agents_assigned: number;
  /** Named assignees so the detail panel can say WHO, not just how many. */
  agents: Array<{ id: string; name: string }>;
  /**
   * Rooms this model reaches transitively — the union of rooms wired to any
   * agent it's assigned to — so the detail panel can link straight to them.
   */
  rooms: Array<{ id: string; name: string }>;
}

export async function listModelsForUI(includeSensitive: boolean): Promise<ModelForUI[]> {
  return Promise.all(
    (await listWebchatModels()).map(async (m) => {
      const ids = await getAgentsAssignedToModel(m.id);
      const roomMap = new Map<string, { id: string; name: string }>();
      for (const id of ids) {
        for (const r of await getWebchatRoomsForAgent(id)) roomMap.set(r.id, { id: r.id, name: r.name });
      }
      return {
        ...m,
        // Owner-only infrastructure fields — nulled for members (the endpoint is
        // an internal model-server URL; every consumer that reads it is an
        // owner-gated flow: wizard Ollama select, STT cleanup, auto-learn).
        ...(includeSensitive ? {} : { endpoint: null, credential_ref: null }),
        agents_assigned: ids.length,
        agents: await Promise.all(ids.map(async (id) => ({ id, name: (await getAgentGroup(id))?.name ?? id }))),
        rooms: [...roomMap.values()],
      };
    }),
  );
}

export async function createModelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonObject<{
    name?: unknown;
    kind?: unknown;
    endpoint?: unknown;
    model_id?: unknown;
    credential_ref?: unknown;
  }>(req, res);
  if (body === undefined) return;
  if (typeof body.name !== 'string' || !body.name.trim()) return json(res, 400, { error: 'name required' });
  if (body.kind !== 'anthropic' && body.kind !== 'ollama' && body.kind !== 'openai-compatible') {
    return json(res, 400, { error: 'kind must be "anthropic" | "ollama" | "openai-compatible"' });
  }
  if (typeof body.model_id !== 'string' || !body.model_id.trim()) {
    return json(res, 400, { error: 'model_id required' });
  }
  const endpoint =
    typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim().replace(/\/+$/, '') : null;
  const credential_ref = typeof body.credential_ref === 'string' ? body.credential_ref.trim() : null;

  // Health-check / validate before persisting (Q5 — yes, on save).
  const validationError = await validateModel({ kind: body.kind, endpoint, model_id: body.model_id.trim() });
  if (validationError) return json(res, 400, { error: validationError });

  const m: WebchatModel = {
    id: randomUUID(),
    name: body.name.trim(),
    kind: body.kind as WebchatModelKind,
    endpoint,
    model_id: body.model_id.trim(),
    credential_ref,
    created_at: Date.now(),
  };
  const hostsBefore = await rosterHosts();
  await createWebchatModel(m);
  forgetModelHosts();
  await afterModelsAdded(hostsBefore, [m]);
  // Preflight: does an agent CONTAINER reach this endpoint? (self-skips fast
  // for hosted/LAN endpoints; only spins a probe container for loopback ones.)
  const reachability = await probeContainerReachability(endpoint);
  return json(res, 200, { ok: true, model: { ...m, agents_assigned: 0 }, reachability });
}

export async function updateModelHandler(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const existing = await getWebchatModel(id);
  if (!existing) return json(res, 404, { error: 'Model not found' });
  const body = await readJsonObject<{
    name?: unknown;
    endpoint?: unknown;
    model_id?: unknown;
    credential_ref?: unknown;
  }>(req, res);
  if (body === undefined) return;
  const patch: { name?: string; endpoint?: string | null; model_id?: string; credential_ref?: string | null } = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (body.endpoint === null) patch.endpoint = null;
  else if (typeof body.endpoint === 'string') patch.endpoint = body.endpoint.trim().replace(/\/+$/, '') || null;
  if (typeof body.model_id === 'string' && body.model_id.trim()) patch.model_id = body.model_id.trim();
  if (body.credential_ref === null) patch.credential_ref = null;
  else if (typeof body.credential_ref === 'string') patch.credential_ref = body.credential_ref.trim() || null;

  // Re-validate the merged state.
  const merged = { ...existing, ...patch };
  const validationError = await validateModel({
    kind: merged.kind,
    endpoint: merged.endpoint,
    model_id: merged.model_id,
  });
  if (validationError) return json(res, 400, { error: validationError });

  const hostsBefore = await rosterHosts();
  await updateWebchatModel(id, patch);
  forgetModelHosts();
  noteRosterHosts(hostsBefore, await rosterHosts());
  // Endpoint or model_id change → re-emit env and respawn for every agent that
  // uses it, so live containers pick up the edited endpoint/model immediately.
  for (const agentGroupId of await getAgentsAssignedToModel(id)) {
    await reloadAgentModelEnv(agentGroupId, 'Webchat model updated');
  }
  return json(res, 200, { ok: true });
}

/**
 * Routing rules bound to a model's model_id, across every router profile.
 * Deleting the model would leave them dangling — classified prompts routed
 * onto a binding that no longer exists.
 */
export function routesBoundToModel(
  modelId: string,
  cfg: Record<string, unknown> | null = readRoutesConfig(),
): { router: string; route: string }[] {
  if (!cfg) return [];
  const out: { router: string; route: string }[] = [];
  for (const rname of listRouters(cfg)) {
    const view = routerView(cfg, rname);
    for (const r of view.routes) {
      if (r.model === modelId) out.push({ router: view.name, route: r.name });
    }
  }
  return out;
}

export async function deleteModelHandler(res: ServerResponse, id: string, force: boolean): Promise<void> {
  const existing = await getWebchatModel(id);
  if (!existing) return json(res, 404, { error: 'Model not found' });
  const assigned = await getAgentsAssignedToModel(id);
  // Routing rules bound to this model (matched by model_id) join the same
  // cascade-with-confirmation: surfaced in the 409, REMOVED on force — the
  // operator expected the rule to go with the model, and a dangling binding
  // 400s at classification time once the router config regenerates.
  const bound = routesBoundToModel(existing.model_id);
  if ((assigned.length > 0 || bound.length > 0) && !force) {
    return json(res, 409, {
      error: 'Model is in use. Re-request with ?force=1 to detach and delete.',
      assigned_agent_group_ids: assigned,
      routes_bound: bound,
    });
  }
  // A router's DEFAULT route can't silently vanish — every classification can
  // land on it. Rebind the default before deleting the model it points at.
  if (bound.length > 0) {
    const cfg0 = readRoutesConfig();
    const defaults = bound.filter(({ router, route }) => cfg0 && routerView(cfg0, router).default_route === route);
    if (defaults.length > 0) {
      return json(res, 409, {
        error: `Route "${defaults[0].route}" is ${defaults[0].router}'s default — rebind the default before deleting this model.`,
        routes_bound: bound,
      });
    }
  }
  if (bound.length > 0) {
    const cfg = readRoutesConfig();
    if (cfg) {
      for (const { router, route } of bound) {
        try {
          removeRouteFromConfig(cfg, router, route);
        } catch (err) {
          log.warn('Model delete: could not remove bound route', { router, route, err: String(err) });
        }
      }
      writeRoutesConfig(cfg);
    }
  }
  const hostsBefore = await rosterHosts();
  await deleteWebchatModel(id);
  noteRosterHosts(hostsBefore, await rosterHosts());
  // A cloud model: the router stops serving it (and drops the provider's vault
  // key once no model of that provider is left), in the background.
  // Matched on any local port: a registration made before LITELLM_PORT changed is still the router's.
  if (isRouterEndpoint(existing.endpoint, process.cwd(), true) && cloudModelNames().includes(existing.model_id)) {
    const twin = (await listWebchatModels()).some(
      (x) => x.model_id === existing.model_id && isRouterEndpoint(x.endpoint, process.cwd(), true),
    );
    void (async () => {
      const r = await removeCloudModel(existing.model_id, twin);
      if (!r.removed) return;
      const hosts = await deriveModelServerHosts();
      const reloadIfLeft = async (): Promise<void> => {
        if (r.leftGateway) await reloadRouterModelAgents('LiteLLM router left the gateway');
      };
      if (r.remaining === 0 && !hosts) await removeRouter().then(reloadIfLeft);
      else startRouterReinstall(process.cwd(), async () => (await deriveModelServerHosts()) ?? '', reloadIfLeft);
    })().catch((err) => log.warn('Cloud model removal failed', { err: String((err as Error)?.message ?? err) }));
  }
  // If this model was the workspace default, clear it and refresh the groups
  // that were inheriting it (they fall back to the workspace credential).
  if ((await getDefaultModelId()) === id) {
    await setDefaultModelId(null);
    await refreshUnassignedGroupsForDefaultModel('Workspace default model deleted');
  }
  // Refresh settings.json for any newly-orphaned agents and respawn them so a
  // live container doesn't keep using the now-dead ollama env block (it would
  // otherwise fail against a deleted endpoint until it idled out).
  for (const agentGroupId of assigned) {
    await reloadAgentModelEnv(agentGroupId, 'Webchat model deleted');
  }
  return json(res, 200, { ok: true, unassigned_count: assigned.length });
}

export async function probeModelsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonObject<{ url?: unknown }>(req, res);
  if (body === undefined) return;
  if (typeof body.url !== 'string' || !body.url.trim()) {
    return json(res, 400, { error: 'url required' });
  }
  // Accept bare hosts ("localhost:11434", "api.anthropic.com") as well as
  // http:// / https:// URLs. probeEndpoint races both schemes when no
  // scheme is supplied. Defensive: reject inputs that look like garbage
  // (whitespace inside, angle brackets) early so we don't waste a probe
  // round-trip on malformed input.
  const url = body.url.trim();
  if (/\s|[<>]/.test(url)) {
    return json(res, 400, { error: 'url contains invalid characters' });
  }
  try {
    const result = await probeEndpoint(url);
    return json(res, 200, result);
  } catch (err) {
    log.warn('Webchat: probe failed', { url, err });
    return json(res, 500, { error: err instanceof Error ? err.message : 'Probe failed' });
  }
}

export async function bulkCreateModelsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonObject<{ models?: unknown }>(req, res);
  if (body === undefined) return;
  if (!Array.isArray(body.models) || body.models.length === 0) {
    return json(res, 400, { error: 'models[] required' });
  }
  // Same validation per row as the single-create path. We accept a partial
  // success: rows that pass validate go in, failures come back per-index in
  // the response. The PWA can re-prompt for the failed ones.
  const created: WebchatModel[] = [];
  const failed: Array<{ index: number; error: string }> = [];
  const hostsBefore = await rosterHosts();
  for (let i = 0; i < body.models.length; i++) {
    const entry = body.models[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      failed.push({ index: i, error: 'entry must be an object' });
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const kind = entry.kind;
    const model_id = typeof entry.model_id === 'string' ? entry.model_id.trim() : '';
    const endpoint =
      typeof entry.endpoint === 'string' && entry.endpoint.trim() ? entry.endpoint.trim().replace(/\/+$/, '') : null;
    const credential_ref = typeof entry.credential_ref === 'string' ? entry.credential_ref.trim() : null;

    if (!name) {
      failed.push({ index: i, error: 'name required' });
      continue;
    }
    if (kind !== 'anthropic' && kind !== 'ollama' && kind !== 'openai-compatible') {
      failed.push({ index: i, error: 'kind must be "anthropic" | "ollama" | "openai-compatible"' });
      continue;
    }
    if (!model_id) {
      failed.push({ index: i, error: 'model_id required' });
      continue;
    }
    const validationError = await validateModel({ kind, endpoint, model_id });
    if (validationError) {
      failed.push({ index: i, error: validationError });
      continue;
    }
    const m: WebchatModel = {
      id: randomUUID(),
      name,
      kind: kind as WebchatModelKind,
      endpoint,
      model_id,
      credential_ref,
      created_at: Date.now(),
    };
    try {
      await createWebchatModel(m);
      forgetModelHosts();
      created.push(m);
    } catch (err) {
      failed.push({ index: i, error: err instanceof Error ? err.message : 'create failed' });
    }
  }
  await afterModelsAdded(hostsBefore, created);
  return json(res, 200, { ok: true, created_count: created.length, failed, created });
}

export async function discoverModelsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonObject<{ kind?: unknown; endpoint?: unknown }>(req, res);
  if (body === undefined) return;
  if (body.kind === 'anthropic') {
    return json(res, 200, { models: KNOWN_ANTHROPIC_MODELS });
  }
  if (body.kind === 'ollama') {
    if (typeof body.endpoint !== 'string' || !body.endpoint.trim()) {
      return json(res, 400, { error: 'endpoint required for kind=ollama' });
    }
    try {
      const models = await discoverOllamaModels(body.endpoint.trim());
      return json(res, 200, { models });
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : 'Ollama unreachable' });
    }
  }
  return json(res, 400, { error: 'kind must be "anthropic" or "ollama"' });
}
