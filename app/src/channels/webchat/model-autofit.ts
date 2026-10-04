/**
 * Fit context to GPU: an Ollama model registered without num_ctx runs at
 * Ollama's small default window. On registration, find the largest window
 * that still runs entirely on the GPU of the model's own host, and register a
 * `<model>-ctx<N>k` variant with it beside the original.
 *
 * Each candidate window is measured, not estimated: a variant is created
 * (/api/create, from the local model — nothing is downloaded), loaded with a
 * one-token generate, and /api/ps says how much of it sits in VRAM. Windows
 * are tried smallest first and the first that spills ends the search, so a
 * CPU-only host costs one load. Unchosen variants are deleted again. A window
 * whose `<model>-ctx<N>k` name the host already lists is not tried: that tag
 * is someone's own (an operator's, or an earlier fit), and creating the trial
 * would overwrite it and deleting it would remove it.
 *
 * Runs in the background, one model per host at a time (two loads at once
 * would measure each other), within a time limit.
 */
import { randomUUID } from 'crypto';

import { log } from '../../log.js';

import {
  assignModelToAgent,
  createWebchatModel,
  getAgentsAssignedToModel,
  getDefaultModelId,
  getFitContextToGpu,
  listWebchatModels,
  setDefaultModelId,
  type WebchatModel,
} from './db.js';
import { forgetModelHosts } from './egress-policy.js';
import { safeFetch } from './models.js';
import { parseOllamaPs, parseOllamaShow, servedContextWindow } from './ollama-context.js';
import { refreshUnassignedGroupsForDefaultModel, reloadAgentModelEnv } from './server/model-wiring.js';

/** Windows tried, as num_ctx. */
export const FIT_CANDIDATES = [8192, 12288, 16384, 32768];
const FIT_DEADLINE_MS = 15 * 60_000;
const FINISHED_TTL_MS = 10 * 60_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One measured window: the loaded variant's total size and the part of it in VRAM. */
export interface FitProbe {
  ctx: number;
  size: number;
  sizeVram: number;
}

export type FitOutcome =
  | { status: 'fitted'; ctx: number; variant: string }
  | { status: 'no-fit'; reason: 'cpu' | 'vram' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

/** The windows worth trying: above what the model already gets, within what it supports. */
export function fitCandidates(maxContext: number | null, served: number): number[] {
  return FIT_CANDIDATES.filter((c) => c > served && (!maxContext || c <= maxContext));
}

/** Entirely on the GPU. */
export function onGpu(p: FitProbe): boolean {
  return p.size > 0 && p.sizeVram >= p.size;
}

/** The largest window measured entirely on the GPU, or null. */
export function pickFit(probes: FitProbe[]): number | null {
  const fits = probes.filter(onGpu).map((p) => p.ctx);
  return fits.length ? Math.max(...fits) : null;
}

const bareRef = (id: string): string =>
  id
    .trim()
    .toLowerCase()
    .replace(/:latest$/, '');

/** `qwen3:8b` at 12288 → `qwen3:8b-ctx12k`. */
export function variantName(modelId: string, ctx: number): string {
  return `${bareRef(modelId)}-ctx${Math.round(ctx / 1024)}k`;
}

/** The tag Ollama lists a created name under. */
function listedTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

/** Does the host list this name already? Asked right before each create, so a tag made meanwhile is seen. */
async function hostHas(call: HostCall, name: string): Promise<boolean> {
  const tags = (await call('/api/tags')) as { models?: Array<{ name?: string }> };
  return (tags.models ?? []).some((m) => bareRef(String(m.name ?? '')) === bareRef(name));
}

type HostCall = (path: string, body?: unknown, timeoutMs?: number) => Promise<unknown>;

function hostCaller(endpoint: string, fetchImpl: FetchLike, deadline: number): HostCall {
  const base = endpoint.replace(/\/+$/, '');
  return async (p, body, timeoutMs = 10_000) => {
    const res = await fetchImpl(`${base}${p}`, {
      method: body === undefined ? 'GET' : p === '/api/delete' ? 'DELETE' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, deadline - Date.now()))),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${p} ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    return res.json().catch(() => ({}));
  };
}

type Precheck =
  | { status: 'skipped'; reason: string }
  | { status: 'worth'; candidates: number[]; served: number; maxContext: number | null };

/** What fitting could gain, from metadata alone — nothing is loaded. */
async function precheck(call: HostCall, modelId: string): Promise<Precheck> {
  const want = bareRef(modelId);
  if (/-ctx\d+k$/.test(want)) return { status: 'skipped', reason: 'already a fitted variant' };
  const tags = (await call('/api/tags')) as { models?: Array<{ name?: string }> };
  if (!(tags.models ?? []).some((m) => bareRef(String(m.name ?? '')) === want))
    return { status: 'skipped', reason: 'not on this host' };
  const meta = parseOllamaShow(await call('/api/show', { name: modelId }));
  if (meta.numCtx) return { status: 'skipped', reason: 'num_ctx already set' };
  const loadedCtx = parseOllamaPs(await call('/api/ps').catch(() => null), modelId);
  const served = servedContextWindow({ ...meta, loadedCtx });
  const candidates = fitCandidates(meta.maxContext, served);
  if (candidates.length === 0) return { status: 'skipped', reason: 'already at its largest window' };
  return { status: 'worth', candidates, served, maxContext: meta.maxContext };
}

export type FitBenefit = { worth: true; served: number; maxContext: number | null } | { worth: false; reason: string };

/** Could fitting give this model a larger window? Metadata only, so cheap enough to ask before offering. */
export async function fitBenefit(model: WebchatModel, fetchImpl: FetchLike = safeFetch): Promise<FitBenefit> {
  if (model.kind !== 'ollama' || !model.endpoint) return { worth: false, reason: 'not an Ollama model' };
  try {
    const out = await precheck(hostCaller(model.endpoint, fetchImpl, Date.now() + 5_000), model.model_id);
    return out.status === 'worth'
      ? { worth: true, served: out.served, maxContext: out.maxContext }
      : { worth: false, reason: out.reason };
  } catch (err) {
    return { worth: false, reason: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

/**
 * Measure and pick. Creates, loads and unloads variants on `endpoint`; leaves
 * only the chosen one behind. Never pulls: a model the host does not list is
 * skipped.
 */
export async function fitContextToGpu(
  endpoint: string,
  modelId: string,
  fetchImpl: FetchLike = safeFetch,
  deadline = Date.now() + FIT_DEADLINE_MS,
): Promise<FitOutcome & { probes?: FitProbe[] }> {
  const call = hostCaller(endpoint, fetchImpl, deadline);
  try {
    const pre = await precheck(call, modelId);
    if (pre.status === 'skipped') return pre;
    const { candidates } = pre;

    const created: string[] = [];
    const probes: FitProbe[] = [];
    const taken: string[] = [];
    let failure: string | null = null;
    for (const ctx of candidates) {
      if (Date.now() > deadline) {
        failure = 'timed out';
        break;
      }
      const name = variantName(modelId, ctx);
      // Never create (overwrite) or delete a name that is not this run's own.
      try {
        if (await hostHas(call, name)) {
          taken.push(name);
          continue;
        }
      } catch (err) {
        failure = String((err as Error)?.message ?? err);
        break;
      }
      try {
        await call('/api/create', { model: name, from: modelId, parameters: { num_ctx: ctx } }, 120_000);
        created.push(name);
        await call(
          '/api/generate',
          { model: name, prompt: '.', stream: false, options: { num_predict: 1 }, keep_alive: '30s' },
          300_000,
        );
        const ps = (await call('/api/ps')) as { models?: Array<{ name?: string; size?: number; size_vram?: number }> };
        const live = (ps.models ?? []).find((m) => m.name === listedTag(name) || m.name === name);
        probes.push({ ctx, size: live?.size ?? 0, sizeVram: live?.size_vram ?? 0 });
      } catch (err) {
        failure = String((err as Error)?.message ?? err);
        break;
      } finally {
        // Unload before the next measurement, so it sees the GPU free again.
        await call('/api/generate', { model: name, keep_alive: 0 }).catch(() => {});
      }
      if (!onGpu(probes[probes.length - 1])) break;
    }
    const chosen = failure ? null : pickFit(probes);
    for (const name of created) {
      if (chosen && name === variantName(modelId, chosen)) continue;
      await call('/api/delete', { model: name }).catch((err) =>
        log.warn('Fit context: could not delete a trial variant', { endpoint, name, err: String(err) }),
      );
    }
    if (failure) return { status: 'error', error: failure.slice(0, 200), probes };
    if (!probes.length && taken.length)
      return { status: 'skipped', reason: `the trial names are taken on this host (${taken.join(', ')})` };
    if (chosen) return { status: 'fitted', ctx: chosen, variant: listedTag(variantName(modelId, chosen)), probes };
    return { status: 'no-fit', reason: probes[0] && probes[0].sizeVram === 0 ? 'cpu' : 'vram', probes };
  } catch (err) {
    return { status: 'error', error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

// ── Jobs ─────────────────────────────────────────────────────────────────

export interface FitJob {
  host: string;
  model: string;
  status: 'queued' | 'fitting' | FitOutcome['status'];
  ctx?: number;
  variant?: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, FitJob>();
const queues = new Map<string, Promise<void>>();

const jobKey = (host: string, model: string): string => `${host}\u0000${bareRef(model)}`;

export function fitJobsSnapshot(now = Date.now()): FitJob[] {
  for (const [k, j] of jobs) if (j.finishedAt && now - j.finishedAt > FINISHED_TTL_MS) jobs.delete(k);
  return [...jobs.values()];
}

/** Register the chosen variant beside the original; agents put on the original since it was added move to it. */
async function adoptVariant(original: WebchatModel, variant: string, ctx: number): Promise<void> {
  const endpoint = original.endpoint!;
  let row = (await listWebchatModels()).find(
    (m) => m.kind === 'ollama' && m.endpoint === endpoint && bareRef(m.model_id) === bareRef(variant),
  );
  if (!row) {
    row = {
      id: randomUUID(),
      name: `${endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')} · ${bareRef(original.model_id)} @${Math.round(ctx / 1024)}k ctx`,
      kind: 'ollama',
      endpoint,
      model_id: variant,
      credential_ref: null,
      created_at: Date.now(),
    };
    await createWebchatModel(row);
    forgetModelHosts();
  }
  for (const agentGroupId of await getAgentsAssignedToModel(original.id)) {
    await assignModelToAgent(agentGroupId, row.id);
    log.info('Fit context: agent moved to the GPU-fitted variant', { agentGroupId, model: variant });
    await reloadAgentModelEnv(agentGroupId, 'Model fitted to GPU');
  }
  if ((await getDefaultModelId()) === original.id) {
    await setDefaultModelId(row.id);
    await refreshUnassignedGroupsForDefaultModel('Workspace default fitted to GPU');
  }
}

async function runJob(job: FitJob, model: WebchatModel, fetchImpl: FetchLike): Promise<void> {
  job.status = 'fitting';
  const out = await fitContextToGpu(job.host, model.model_id, fetchImpl);
  job.status = out.status;
  if (out.status === 'fitted') {
    try {
      await adoptVariant(model, out.variant, out.ctx);
      Object.assign(job, { ctx: out.ctx, variant: out.variant });
    } catch (err) {
      Object.assign(job, { status: 'error', detail: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  } else {
    job.detail = out.status === 'error' ? out.error : out.reason;
  }
  job.finishedAt = Date.now();
  log.info('Fit context to GPU', {
    host: job.host,
    model: model.model_id,
    outcome: job.status,
    ctx: job.ctx,
    variant: job.variant,
    detail: job.detail,
    probes: out.probes,
  });
}

/** Queue a fit for this registration. Returns the job, or null when the model is not one to fit. */
export function startAutoFit(model: WebchatModel, fetchImpl: FetchLike = safeFetch): FitJob | null {
  if (model.kind !== 'ollama' || !model.endpoint || /-ctx\d+k$/.test(bareRef(model.model_id))) return null;
  const host = model.endpoint.replace(/\/+$/, '');
  const key = jobKey(host, model.model_id);
  const prev = jobs.get(key);
  if (prev && !prev.finishedAt) return prev;
  const job: FitJob = { host, model: model.model_id, status: 'queued', startedAt: Date.now() };
  jobs.set(key, job);
  const next = (queues.get(host) ?? Promise.resolve())
    .then(() => runJob(job, model, fetchImpl))
    .catch((err) => {
      Object.assign(job, { status: 'error', detail: String(err).slice(0, 200), finishedAt: Date.now() });
    });
  queues.set(host, next);
  void next.finally(() => {
    if (queues.get(host) === next) queues.delete(host);
  });
  return job;
}

/** After a registration: fit the new Ollama models, when the setting is on (off by default; the UI asks instead). */
export async function autoFitNewModels(models: WebchatModel[], fetchImpl: FetchLike = safeFetch): Promise<void> {
  if (!models.some((m) => m.kind === 'ollama')) return;
  if (!(await getFitContextToGpu())) return;
  startFits(models, fetchImpl);
}

/** Fit these models now, whatever the setting (the owner said yes when adding them). Ollama models only. */
export function startFits(models: WebchatModel[], fetchImpl: FetchLike = safeFetch): number {
  let started = 0;
  for (const m of models) {
    if (m.kind !== 'ollama') continue;
    startAutoFit(m, fetchImpl);
    started++;
  }
  return started;
}

/** Wait for every queued fit (tests). */
export async function _drainFitsForTest(): Promise<void> {
  while (queues.size) await Promise.all([...queues.values()]);
}
export function _resetFitsForTest(): void {
  jobs.clear();
  queues.clear();
}
