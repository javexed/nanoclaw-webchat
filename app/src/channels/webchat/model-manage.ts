/**
 * Model management — a holistic inventory of local (Ollama) models with the
 * three fitness facts that actually decide whether an agent works, computed
 * server-side so the UI can show them at a glance:
 *
 *   1. CONTEXT — the model's *configured* runtime window (Ollama defaults every
 *      model to 4k regardless of its advertised max), vs. the agent's prompt
 *      size. Ollama reserves ~half the window for generation, so the usable
 *      prompt budget is ctx/2; a prompt over that gets silently truncated —
 *      the "model sees 12% of its instructions" failure.
 *   2. VRAM — will the model + KV cache fit the GPU, spill to CPU (slow), or
 *      not run at all. Estimates, labelled as such.
 *   3. STATE — pulled / registered / workspace default / loaded right now.
 *
 * Also provides the fix for the 4k-default trap: create a `num_ctx` variant of
 * a pulled model (what `ollama create` does) and register it in one step.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getDefaultModelId, listWebchatModels, type WebchatModel } from './db.js';
import { safeFetch } from './models.js';

/** Ollama refs are lowercase with no whitespace (same rule as the pull fix). */
function normalizeOllamaModelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

const execFileP = promisify(execFile);

/** Ollama loads every model at 4k context unless a variant overrides num_ctx. */
const OLLAMA_DEFAULT_CTX = 4096;

/**
 * Agent prompt budget (tokens) the context check compares against. The lean
 * local-model prompt measures ~6.5k tokens; the full OpenCode coding-agent
 * prompt ~17k. Estimates from live measurement — good enough for a fit badge.
 */
export const AGENT_PROMPT_TOKENS = { lean: 6500, full: 17000 };

export interface GpuInfo {
  totalMB: number;
  usedMB: number;
}

export interface ManagedModel {
  /** Ollama tag, e.g. "qwen3:8b" or "qwen3-8b-16k:latest". */
  tag: string;
  endpoint: string;
  pulled: boolean;
  sizeBytes: number | null;
  paramSize: string | null; // "8.2B"
  quant: string | null; // "Q4_K_M"
  family: string | null;
  maxContext: number | null; // architecture ceiling from model_info
  configuredCtx: number; // runtime num_ctx (variant PARAMETER or the 4k default)
  loadedVramBytes: number | null; // non-null when loaded right now (api/ps)
  loadedTotalBytes: number | null;
  registryId: string | null; // webchat_models id when registered
  registryName: string | null;
  isDefault: boolean;
  fit: {
    /** 'fits' | 'truncates' — configured ctx/2 vs the lean agent prompt. */
    context: 'fits' | 'truncates';
    /** 'fits' | 'spills' | 'unknown' — est. footprint vs GPU VRAM. */
    vram: 'fits' | 'spills' | 'unknown';
    /** Estimated total footprint driving the vram verdict (bytes). */
    estFootprintBytes: number | null;
  };
}

export interface ModelInventory {
  gpu: GpuInfo | null;
  agentPromptTokens: typeof AGENT_PROMPT_TOKENS;
  models: ManagedModel[];
}

async function readGpu(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'],
      {
        timeout: 4000,
      },
    );
    const [total, used] = stdout
      .trim()
      .split('\n')[0]
      .split(',')
      .map((s) => parseInt(s.trim(), 10));
    if (Number.isFinite(total) && Number.isFinite(used)) return { totalMB: total, usedMB: used };
  } catch {
    /* no NVIDIA GPU / no nvidia-smi — verdicts become 'unknown' */
  }
  return null;
}

interface OllamaShow {
  parameters?: string;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
  model_info?: Record<string, unknown>;
}

/** Pull the architecture context ceiling out of model_info's family-prefixed key. */
function maxContextFrom(info: Record<string, unknown> | undefined): number | null {
  if (!info) return null;
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith('.context_length') && typeof v === 'number') return v;
  }
  return null;
}

/** A variant's Modelfile PARAMETER shows up in `parameters`; absent → Ollama's 4k default. */
function configuredCtxFrom(parameters: string | undefined): number {
  const m = parameters?.match(/num_ctx\s+(\d+)/);
  return m ? parseInt(m[1], 10) : OLLAMA_DEFAULT_CTX;
}

/**
 * Estimated total memory footprint: model file + KV cache + runtime overhead.
 * KV scales with context and model size; calibrated against live observations
 * (qwen3:8b Q4: 5.2GB file → 7GB at 16k ctx, 10GB at 32k). Estimate only —
 * the UI labels it "est." and the loaded case shows real numbers instead.
 */
function estimateFootprint(sizeBytes: number | null, ctx: number, paramSize: string | null): number | null {
  if (sizeBytes == null) return null;
  const paramsB = paramSize ? parseFloat(paramSize) : 8;
  const kvBytes = ctx * 96_000 * (Number.isFinite(paramsB) ? paramsB / 8 : 1);
  const overhead = 500_000_000;
  return sizeBytes + kvBytes + overhead;
}

export interface PrepullEstimate {
  /** Total registry download, or null when the manifest was unreachable. */
  sizeBytes: number | null;
  estFootprintBytes: number | null;
  vramFit: 'fits' | 'spills' | 'unknown';
  gpu: GpuInfo | null;
}

/**
 * What would pulling this model mean for THIS machine — answered BEFORE any
 * bytes move. Ollama's registry serves image manifests over plain HTTPS, so
 * the download size is knowable up front: sum the layer sizes. Only the
 * default registry is inspected; a ref carrying its own registry host
 * (`host.tld/name`, `host:port/name`) returns unknown rather than a guess.
 *
 * Size and VRAM only. The 4k-context caveat used to ride along here and was
 * removed: pre-pull it compares Ollama's fixed 4k default against a fixed
 * prompt budget, so it produced the identical warning for every model on
 * every pull — a constant cannot inform a choice between models, and a
 * warning that always fires is one people stop reading. The context verdict
 * belongs after the pull (gatherModelInventory), where it reads the model's
 * REAL configured num_ctx and where creating a variant can actually fix it.
 */
export async function prepullEstimate(model: string): Promise<PrepullEstimate> {
  const gpu = await readGpu();
  // The footprint estimate still needs a context to size the KV cache against;
  // Ollama's default is what an un-tuned pull will actually load at.
  const assumedCtx = OLLAMA_DEFAULT_CTX;
  const unknown: PrepullEstimate = { sizeBytes: null, estFootprintBytes: null, vramFit: 'unknown', gpu };

  const raw = (model || '').trim();
  if (!raw) return unknown;
  const [refPart, tag = 'latest'] = raw.split(':');
  const segs = refPart.split('/');
  // A registry host can only BE a host when something follows it. Testing the
  // first segment for a dot unconditionally rejected every bare name that has
  // one — llama3.2, qwen2.5, phi3.5 — which is most of the popular families,
  // and they are exactly the refs whose size a user most wants up front.
  if (segs.length > 2) return unknown;
  if (segs.length === 2 && (segs[0].includes('.') || segs[0].includes(':'))) return unknown; // custom registry — no guess
  const ns = segs.length === 2 ? segs[0] : 'library';
  const name = segs.length === 2 ? segs[1] : segs[0];
  if (!/^[a-z0-9._-]+$/i.test(ns) || !/^[a-z0-9._-]+$/i.test(name) || !/^[a-z0-9._-]+$/i.test(tag)) return unknown;

  let sizeBytes: number | null = null;
  try {
    const res = await fetch(`https://registry.ollama.ai/v2/${ns}/${name}/manifests/${encodeURIComponent(tag)}`, {
      headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const m = (await res.json()) as { layers?: Array<{ size?: number }>; config?: { size?: number } };
      const total = (m.layers ?? []).reduce((a, l) => a + (l.size ?? 0), 0) + (m.config?.size ?? 0);
      if (total > 0) sizeBytes = total;
    }
  } catch {
    /* registry unreachable — the verdict degrades to unknown, the pull is unaffected */
  }
  if (sizeBytes == null) return unknown;

  // Parameter count guessed from the tag ("14b", "1.7b") — good enough for the
  // KV-cache term; estimateFootprint falls back to 8B when unparseable.
  const paramGuess = /(^|[^0-9.])(\d+(?:\.\d+)?)b\b/i.exec(tag)?.[2] ?? null;
  const est = estimateFootprint(sizeBytes, assumedCtx, paramGuess ? `${paramGuess}B` : null);
  let vramFit: PrepullEstimate['vramFit'] = 'unknown';
  if (gpu && est != null) vramFit = est <= gpu.totalMB * 1_000_000 ? 'fits' : 'spills';
  return { sizeBytes, estFootprintBytes: est, vramFit, gpu };
}

/**
 * Assemble the inventory for one Ollama endpoint: every pulled tag (api/tags),
 * enriched with api/show details, live-load state (api/ps), registry links,
 * and computed fit verdicts.
 */
export async function gatherModelInventory(endpoint: string): Promise<ModelInventory> {
  const base = endpoint.replace(/\/+$/, '');
  const gpu = await readGpu();

  const registry = (await listWebchatModels()).filter((m: WebchatModel) => m.kind === 'ollama');
  const defaultId = getDefaultModelId();

  let tags: Array<{ name: string; size?: number }> = [];
  try {
    const res = await safeFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) tags = ((await res.json()) as { models?: Array<{ name: string; size?: number }> }).models ?? [];
  } catch {
    /* endpoint down — return registry-only entries below */
  }

  let loaded: Array<{ name: string; size?: number; size_vram?: number }> = [];
  try {
    const res = await safeFetch(`${base}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) loaded = ((await res.json()) as { models?: typeof loaded }).models ?? [];
  } catch {
    /* fine — nothing loaded */
  }

  // Registered-but-not-pulled models still appear (with pulled:false) so the
  // operator can see dead registry entries.
  const tagSet = new Map(tags.map((t) => [t.name, t]));
  for (const r of registry) {
    if (![...tagSet.keys()].some((t) => t === r.model_id || t.split(':')[0] === r.model_id.split(':')[0])) {
      tagSet.set(r.model_id, { name: r.model_id });
    }
  }

  const models: ManagedModel[] = [];
  for (const [tag, t] of tagSet) {
    let show: OllamaShow = {};
    try {
      const res = await safeFetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tag }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) show = (await res.json()) as OllamaShow;
    } catch {
      /* leave details null */
    }
    const pulled = tags.some((x) => x.name === tag);
    const configuredCtx = configuredCtxFrom(show.parameters);
    const reg = await registry.find((r) => r.model_id === tag || `${r.model_id}:latest` === tag || r.model_id === `${tag}`);
    const live = loaded.find((l) => l.name === tag);
    const sizeBytes = t.size ?? null;
    const paramSize = show.details?.parameter_size ?? null;
    const est = estimateFootprint(sizeBytes, configuredCtx, paramSize);
    // Usable prompt budget is ~half the window (Ollama reserves the rest for
    // generation) — compare against the LEAN agent prompt (the local path).
    const contextFit = configuredCtx / 2 >= AGENT_PROMPT_TOKENS.lean ? 'fits' : 'truncates';
    let vramFit: 'fits' | 'spills' | 'unknown' = 'unknown';
    if (live && typeof live.size === 'number' && typeof live.size_vram === 'number') {
      vramFit = live.size_vram >= live.size ? 'fits' : 'spills'; // real, not estimated
    } else if (gpu && est != null) {
      vramFit = est <= gpu.totalMB * 1_000_000 ? 'fits' : 'spills';
    }
    models.push({
      tag,
      endpoint: base,
      pulled,
      sizeBytes,
      paramSize,
      quant: show.details?.quantization_level ?? null,
      family: show.details?.family ?? null,
      maxContext: maxContextFrom(show.model_info),
      configuredCtx,
      loadedVramBytes: live?.size_vram ?? null,
      loadedTotalBytes: live?.size ?? null,
      registryId: reg?.id ?? null,
      registryName: reg?.name ?? null,
      isDefault: reg != null && reg.id === (await defaultId),
      fit: { context: contextFit, vram: vramFit, estFootprintBytes: est },
    });
  }

  // Defaults first, then registered, then by size — the ones you act on are on top.
  models.sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      Number(b.registryId != null) - Number(a.registryId != null) ||
      (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
  );
  return { gpu, agentPromptTokens: AGENT_PROMPT_TOKENS, models };
}

/**
 * Create a num_ctx variant of a pulled model (the fix for the 4k-default trap):
 * `<base>-<N>k` via Ollama's /api/create. Returns the new tag. The caller
 * registers/assigns it via the existing model-registry endpoints.
 */
export async function createContextVariant(endpoint: string, rawTag: string, ctx: number): Promise<string> {
  const base = endpoint.replace(/\/+$/, '');
  const tag = normalizeOllamaModelName(rawTag);
  if (!Number.isFinite(ctx) || ctx < 2048 || ctx > 262_144) throw new Error(`Invalid context size: ${ctx}`);
  const variant = `${tag.replace(/[:/]/g, '-').replace(/-latest$/, '')}-${Math.round(ctx / 1024)}k`;
  const res = await safeFetch(`${base}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: variant, from: tag, parameters: { num_ctx: ctx } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama create failed (${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  return `${variant}:latest`;
}
