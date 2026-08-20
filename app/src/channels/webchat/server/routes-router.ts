// ── Router routes ────────────────────────────────────────────────────────────
// The model-router surface: profiles, the model roster, classification,
// decisions, metrics and suggestions. The route table stays in server.ts.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { createWebchatModel, deleteWebchatModel, getAgentsAssignedToModel, listWebchatModels } from '../db.js';
import {
  RoutesUpdate,
  addRouter,
  deleteRouter,
  deriveModelServerHosts,
  dryClassify,
  getLitellmInstallState,
  getRosterRefreshState,
  getRouteSuggestions,
  getRouterInfo,
  getRouterMetrics,
  getRoutingInstallState,
  listRouters,
  mergeRoutesUpdate,
  readRoutesConfig,
  recentDecisions,
  routerView,
  startLitellmInstall,
  startRosterRefresh,
  startRoutingInstall,
  writeRoutesConfig,
} from '../ollama-manage.js';
import { randomUUID } from 'crypto';
import type { RouteCtx } from '../server.js';

export async function rRouterRoutesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const cfg = readRoutesConfig();
  // The client PROBES this on every load to decide whether to show the Auto-
  // routing tab (see probeRoutingAvailability). Answer "not installed" as a 200
  // so a routing-less install doesn't log a 404 on every page load — a 404 here
  // is a feature-detection signal, not an error.
  if (!cfg) return json(res, 200, { installed: false });
  const view = routerView(cfg, url.searchParams.get('router') ?? undefined);
  return json(res, 200, {
    installed: true,
    routers: listRouters(cfg),
    router: view.name,
    routes: view.routes,
    default_route: view.default_route ?? null,
    live: cfg.live ?? null,
    // The classifier model is infrastructure ("never a route target"), not an
    // assignable agent model. Expose its id so the Models UI can section it off
    // from selectable models instead of offering a "+" on it.
    classifier: (cfg.classifier as { model?: string } | undefined)?.model ?? null,
  });
}

// The virtual 'auto' selectable model exists iff routing is LIVE. Going live
// registers it so an agent can actually be assigned to routing; going back to
// shadow removes it — a shadow-mode 'auto' isn't a real LiteLLM model, so an
// agent left on it would break, whereas an unassigned agent falls back to a
// working default. Idempotent + keyed on model_id 'auto' (not a fixed row id),
// so a hand-created 'auto' row is respected rather than duplicated. Router
// endpoint mirrors getRouterInfo()'s (ollama-manage.ts) — keep them in step.
export async function syncAutoRouterSelectable(live: boolean): Promise<void> {
  const existing = (await listWebchatModels()).find((m) => m.model_id === 'auto');
  if (live) {
    if (!existing) {
      createWebchatModel({
        id: randomUUID(),
        name: 'auto',
        kind: 'openai-compatible',
        endpoint: 'http://host.docker.internal:4000/v1',
        model_id: 'auto',
        credential_ref: null,
        created_at: Date.now(),
      });
    }
  } else if (existing) {
    deleteWebchatModel(existing.id);
  }
}

export async function rRouterRoutesPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, url } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let update: RoutesUpdate;
  try {
    update = JSON.parse(raw) as RoutesUpdate;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const cfg = readRoutesConfig();
  if (!cfg) return json(res, 404, { error: 'Routing not installed' });
  try {
    const target = url.searchParams.get('router') ?? undefined;
    const merged = mergeRoutesUpdate(cfg, update, target);
    writeRoutesConfig(merged);
    // Register/deregister the 'auto' selectable to match the new live state.
    syncAutoRouterSelectable(Boolean((merged.live as { enabled?: boolean } | undefined)?.enabled));
    const view = routerView(merged, target);
    return json(res, 200, {
      ok: true,
      routers: listRouters(merged),
      router: view.name,
      routes: view.routes,
      default_route: view.default_route ?? null,
      live: merged.live ?? null,
    });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rRouterRoutersPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const cfg = readRoutesConfig();
  if (!cfg) return json(res, 404, { error: 'Routing not installed' });
  try {
    const next = addRouter(cfg, name); // clones the primary router as a starting point
    writeRoutesConfig(next);
    // Register the router as an openai-compatible model so agents can assign
    // it (the virtual model name = the router name, at the router endpoint).
    const endpoint = (await getRouterInfo()).endpoint;
    if (!(await listWebchatModels()).some((m) => m.model_id === name && m.endpoint === endpoint)) {
      createWebchatModel({
        id: randomUUID(),
        name,
        kind: 'openai-compatible',
        endpoint,
        model_id: name,
        credential_ref: null,
        created_at: Date.now(),
      });
    }
    return json(res, 200, { ok: true, routers: listRouters(next), router: name });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rRouterDelDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const name = decodeURIComponent(m[1]);
  const cfg = readRoutesConfig();
  if (!cfg) return json(res, 404, { error: 'Routing not installed' });
  // Refuse while an agent is still assigned to this router's model.
  const model = (await listWebchatModels()).find((m) => m.model_id === name);
  if (model) {
    const assigned = await getAgentsAssignedToModel(model.id);
    if (assigned.length > 0) {
      return json(res, 409, {
        error: `router "${name}" is assigned to ${assigned.length} agent(s) — unassign first`,
      });
    }
  }
  try {
    const next = deleteRouter(cfg, name);
    writeRoutesConfig(next);
    if (model) deleteWebchatModel(model.id);
    return json(res, 200, { ok: true, routers: listRouters(next) });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rRouterClassifyPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { prompt?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return json(res, 400, { error: 'prompt required' });
  try {
    return json(res, 200, await dryClassify(body.prompt.trim()));
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rRouterDecisionsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
  return json(res, 200, { decisions: recentDecisions(limit) });
}

export async function rRouterMetricsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days')) || 7));
  return json(res, 200, getRouterMetrics(days));
}

export async function rRouterSuggestionsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, { suggestions: await getRouteSuggestions() });
}

export async function rRouterModelsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, await getRouterInfo());
}

export async function rRouterRosterRefreshGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, getRosterRefreshState());
}

export async function rRouterRosterRefreshPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const started = startRosterRefresh();
  return json(res, started ? 202 : 409, { ...getRosterRefreshState(), started });
}

export async function rRouterInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, getRoutingInstallState());
}

export async function rRouterInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const r = startRoutingInstall();
  if (r.error === 'litellm-not-installed') {
    return json(res, 409, {
      error: 'LiteLLM is not installed. Run /add-litellm first.',
      code: 'litellm-not-installed',
    });
  }
  if (r.error === 'installer-missing') {
    return json(res, 409, {
      error: 'The add-routing skill is not present in this checkout.',
      code: 'installer-missing',
    });
  }
  return json(res, r.started ? 202 : 409, { ...getRoutingInstallState(), started: r.started });
}

export async function rRouterLitellmInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, getLitellmInstallState());
}

export async function rRouterLitellmInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  // Point LiteLLM at the operator's real model servers (a remote/LAN Ollama in
  // the roster, or the hosts an existing config already declares) — not a
  // localhost Ollama that may not exist. Falls back to the localhost default
  // only when the roster is empty.
  const r = startLitellmInstall(process.cwd(), (await deriveModelServerHosts()) ?? undefined);
  if (r.error === 'installer-missing') {
    return json(res, 409, {
      error: 'The add-litellm skill is not present in this checkout.',
      code: 'installer-missing',
    });
  }
  return json(res, r.started ? 202 : 409, { ...getLitellmInstallState(), started: r.started });
}
