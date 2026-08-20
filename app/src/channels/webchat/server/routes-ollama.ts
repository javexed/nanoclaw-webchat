// ── Ollama host management ──────────────────────────────────────────────────
//
// Route handlers for the Models tab's Ollama server cards: which hosts are
// configured, what they carry, what a pull would cost, and the pull / delete /
// cancel verbs themselves.
//
// The SSRF gate and every outbound call live in ollama-manage.ts — a host here
// is operator-supplied, so nothing in this file talks to one directly. These
// handlers are the HTTP shape around it: parse, delegate, format. Authorization
// is the route table's job (these are registered owner-only), which is why no
// handler re-checks it.
//
// Lifted out of server.ts unchanged: the block closed over nothing in that
// file's module scope, which is what made it movable without a deps seam.
import { listWebchatModels } from '../db.js';
import { prepullEstimate } from '../model-manage.js';
import { recommendForHost } from '../model-recommend.js';
import {
  cancelPull,
  deleteHostModel,
  getOllamaLocalState,
  getPullsSnapshot,
  listHostModels,
  parseConfiguredHosts,
  startPull,
} from '../ollama-manage.js';
import fs from 'fs';
import path from 'path';

import type { RouteCtx } from '../server.js';
import { json, readJsonBody } from './http.js';

export async function rOllamaHostsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const hosts = new Set<string>();
  for (const m of listWebchatModels()) {
    if (m.kind === 'ollama' && m.endpoint) hosts.add(m.endpoint.replace(/\/+$/, ''));
  }
  try {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'data/litellm/config.yaml'), 'utf8');
    for (const h of (parseConfiguredHosts(cfg) ?? '').split(',')) {
      if (h.trim()) hosts.add(h.trim().replace(/\/+$/, ''));
    }
  } catch {
    /* no litellm installed — models-derived hosts only */
  }
  return json(res, 200, { hosts: [...hosts].sort() });
}

export async function rOllamaModelsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const host = url.searchParams.get('host') || '';
  if (!host) return json(res, 400, { error: 'host required' });
  try {
    return json(res, 200, { models: await listHostModels(host) });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rOllamaPullsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, { pulls: getPullsSnapshot() });
}

// Wizard: hardware profile + a recommended local model to prefill the download.
// Also report whether a REMOTE Ollama is already in the roster — if so, local
// RAM isn't the constraint (models run on that box), so the client softens the
// "tight fit" warning.
export async function rOllamaRecommendGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const remote = (await listWebchatModels()).find((m) => {
    if (m.kind !== 'ollama' || !m.endpoint) return false;
    const host = (() => {
      try {
        return new URL(m.endpoint).hostname;
      } catch {
        return '';
      }
    })();
    return host && !['127.0.0.1', 'localhost', '::1', 'host.docker.internal'].includes(host);
  });
  return json(res, 200, {
    ...recommendForHost(),
    remoteOllama: remote ? { present: true, endpoint: remote.endpoint } : { present: false },
  });
}

// Local Ollama for the wizard: status probe + one-click rootless install.
export async function rOllamaLocalGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, await getOllamaLocalState());
}

// Pre-pull check: what would this model mean for this machine, BEFORE any
// bytes move. Read-only; the pull itself remains a separate deliberate POST.
export async function rOllamaPrepullGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const model = url.searchParams.get('model') || '';
  if (!model.trim()) return json(res, 400, { error: 'model required' });
  return json(res, 200, await prepullEstimate(model));
}

// Remove a model's files from an Ollama host. Destructive, so csrf+owner —
// the same posture as the pull that created them.
export async function rOllamaDeletePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { host?: unknown; model?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.host !== 'string' || !body.host.trim()) return json(res, 400, { error: 'host required' });
  if (typeof body.model !== 'string' || !body.model.trim()) return json(res, 400, { error: 'model required' });
  try {
    await deleteHostModel(body.host.trim(), body.model.trim());
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rOllamaPullPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { host?: unknown; model?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.host !== 'string' || !body.host.trim()) return json(res, 400, { error: 'host required' });
  if (typeof body.model !== 'string' || !body.model.trim()) return json(res, 400, { error: 'model required' });
  try {
    const job = await startPull(body.host.trim(), body.model.trim());
    return json(res, 202, { pull: job });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Stop an in-flight pull. Same csrf+owner posture as starting one: whoever may
// begin a multi-gigabyte download may also call it off.
export async function rOllamaPullCancelPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { host?: unknown; model?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.host !== 'string' || !body.host.trim()) return json(res, 400, { error: 'host required' });
  if (typeof body.model !== 'string' || !body.model.trim()) return json(res, 400, { error: 'model required' });
  // 404, not 200: "there was no such pull running" is a different fact from
  // "it is stopped now", and a UI that cannot tell them apart will claim to
  // have cancelled a pull that actually completed a moment earlier.
  if (!cancelPull(body.host.trim(), body.model.trim())) return json(res, 404, { error: 'no pull in progress' });
  return json(res, 200, { ok: true });
}
