/**
 * Fit context to GPU against a fake Ollama: /api/tags, /api/show, /api/ps,
 * /api/create, /api/generate and /api/delete, with a GPU of a given size. The
 * window chosen is the largest measured entirely in VRAM; trial variants are
 * deleted; nothing is pulled; and the variant is registered beside the
 * original, taking over the agents put on the original meanwhile.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reloads: [] as string[], defaults: [] as string[] }));
vi.mock('./server/model-wiring.js', () => ({
  reloadAgentModelEnv: async (id: string) => void h.reloads.push(id),
  refreshUnassignedGroupsForDefaultModel: async (reason: string) => void h.defaults.push(reason),
}));

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import {
  assignModelToAgent,
  createWebchatModel,
  getAssignedModelForAgent,
  getDefaultModelId,
  listWebchatModels,
  setDefaultModelId,
  getFitContextToGpu,
  setFitContextToGpu,
  type WebchatModel,
} from './db.js';
import {
  _drainFitsForTest,
  _resetFitsForTest,
  autoFitNewModels,
  fitBenefit,
  startFits,
  fitCandidates,
  fitContextToGpu,
  fitJobsSnapshot,
  pickFit,
  startAutoFit,
  variantName,
} from './model-autofit.js';

const HOST = 'http://192.0.2.69:11434';
const GB = 1e9;

interface FakeOpts {
  /** VRAM free for one model, bytes; 0 = no GPU. */
  vram: number;
  models?: Record<string, { numCtx?: number; maxContext?: number }>;
  loadedCtx?: number;
}

/** A model of 5 GB whose footprint grows 0.15 GB per 1k of window. */
function fakeOllama(opts: FakeOpts) {
  const models: Record<string, { numCtx?: number; maxContext?: number }> = {
    'qwen3:8b': { maxContext: 40960 },
    ...opts.models,
  };
  const loaded = new Map<string, number>();
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const p = new URL(url).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    const ok = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
    switch (p) {
      case '/api/tags':
        calls.push('tags');
        return ok({
          models: Object.keys(models).map((name) => ({ name: name.includes(':') ? name : `${name}:latest` })),
        });
      case '/api/show': {
        calls.push(`show ${body.name}`);
        const m = models[body.name];
        if (!m) return new Response('not found', { status: 404 });
        return ok({
          parameters: m.numCtx ? `num_ctx ${m.numCtx}` : 'stop "<|im_end|>"',
          model_info: { 'qwen3.context_length': m.maxContext ?? 40960 },
        });
      }
      case '/api/create':
        calls.push(`create ${body.model} ${body.parameters.num_ctx}`);
        if (!models[body.from]) return new Response('pull model manifest: file does not exist', { status: 500 });
        models[body.model] = { numCtx: body.parameters.num_ctx, maxContext: models[body.from].maxContext };
        return ok({ status: 'success' });
      case '/api/generate':
        if (body.keep_alive === 0) {
          calls.push(`unload ${body.model}`);
          loaded.delete(body.model);
        } else {
          calls.push(`load ${body.model}`);
          loaded.set(body.model, models[body.model].numCtx ?? 4096);
        }
        return ok({ done: true });
      case '/api/ps':
        return ok({
          models: [
            ...[...loaded].map(([name, ctx]) => {
              const size = 5 * GB + (ctx / 1024) * 0.15 * GB;
              return {
                name: name.includes(':') ? name : `${name}:latest`,
                size,
                size_vram: Math.min(size, opts.vram),
                context_length: ctx,
              };
            }),
            ...(opts.loadedCtx
              ? [{ name: 'qwen3:8b', size: 6 * GB, size_vram: 6 * GB, context_length: opts.loadedCtx }]
              : []),
          ],
        });
      case '/api/delete':
        calls.push(`delete ${body.model}`);
        delete models[body.model];
        return ok({});
    }
    return new Response('no', { status: 404 });
  });
  return { fetchImpl, calls, models };
}

describe('selection', () => {
  it('candidates sit above the served window and within the model limit', () => {
    expect(fitCandidates(40960, 4096)).toEqual([8192, 12288, 16384, 32768]);
    expect(fitCandidates(16384, 4096)).toEqual([8192, 12288, 16384]);
    expect(fitCandidates(null, 12288)).toEqual([16384, 32768]);
    expect(fitCandidates(8192, 8192)).toEqual([]);
  });

  it('picks the largest window entirely in VRAM', () => {
    expect(
      pickFit([
        { ctx: 8192, size: 6, sizeVram: 6 },
        { ctx: 12288, size: 7, sizeVram: 7 },
        { ctx: 16384, size: 8, sizeVram: 7.5 },
      ]),
    ).toBe(12288);
    expect(pickFit([{ ctx: 8192, size: 6, sizeVram: 0 }])).toBeNull();
  });

  it('names a variant after its model and window', () => {
    expect(variantName('qwen3:8b', 12288)).toBe('qwen3:8b-ctx12k');
    expect(variantName('llama3.2:latest', 32768)).toBe('llama3.2-ctx32k');
  });
});

describe('fitBenefit (the check before the UI offers a fit)', () => {
  const row = (model_id: string, kind: WebchatModel['kind'] = 'ollama'): WebchatModel => ({
    id: 'm1',
    name: model_id,
    kind,
    endpoint: HOST,
    model_id,
    credential_ref: null,
    created_at: 0,
  });

  it("a model at Ollama's default window that supports more is worth fitting — and nothing is loaded", async () => {
    const o = fakeOllama({ vram: 8 * GB });
    expect(await fitBenefit(row('qwen3:8b'), o.fetchImpl)).toEqual({ worth: true, served: 4096, maxContext: 40960 });
    expect(o.calls.some((c) => /^(create|load|delete)/.test(c))).toBe(false);
  });

  it('num_ctx already set, a fitted variant, or a model at its largest window: not worth it', async () => {
    const o = fakeOllama({
      vram: 8 * GB,
      models: { 'llama3.2:3b': { numCtx: 8192, maxContext: 131072 }, 'tiny:1b': { maxContext: 4096 } },
    });
    expect(await fitBenefit(row('llama3.2:3b'), o.fetchImpl)).toMatchObject({
      worth: false,
      reason: 'num_ctx already set',
    });
    expect(await fitBenefit(row('qwen3:8b-ctx12k'), o.fetchImpl)).toMatchObject({ worth: false });
    expect(await fitBenefit(row('tiny:1b'), o.fetchImpl)).toMatchObject({ worth: false });
  });

  it('not Ollama, or the host is unreachable: not worth it, no throw', async () => {
    expect(await fitBenefit(row('gpt-x', 'openai-compatible'), vi.fn())).toMatchObject({ worth: false });
    const down = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(await fitBenefit(row('qwen3:8b'), down)).toMatchObject({ worth: false });
  });
});

describe('fitContextToGpu', () => {
  it("never creates over, or deletes, a variant name the host already lists (an operator's own tag)", async () => {
    const o = fakeOllama({ vram: 7.0 * GB, models: { 'qwen3:8b-ctx8k': { numCtx: 8192, maxContext: 40960 } } });
    const out = await fitContextToGpu(HOST, 'qwen3:8b', o.fetchImpl);
    // 8k is skipped, not measured: 12k fits, 16k spills.
    expect(out).toMatchObject({ status: 'fitted', ctx: 12288, variant: 'qwen3:8b-ctx12k' });
    const touched = o.calls.filter((c) => /^(create|delete|load|unload) qwen3:8b-ctx8k\b/.test(c));
    expect(touched).toEqual([]);
    expect(o.calls.filter((c) => /^(create|delete)/.test(c))).toEqual([
      'create qwen3:8b-ctx12k 12288',
      'create qwen3:8b-ctx16k 16384',
      'delete qwen3:8b-ctx16k',
    ]);
  });

  it('skips, touching nothing, when every trial name is taken', async () => {
    const taken = Object.fromEntries(
      ['8k', '12k', '16k', '32k'].map((k) => [`qwen3:8b-ctx${k}`, { numCtx: 1, maxContext: 40960 }]),
    );
    const o = fakeOllama({ vram: 7.0 * GB, models: taken });
    const out = await fitContextToGpu(HOST, 'qwen3:8b', o.fetchImpl);
    expect(out).toMatchObject({ status: 'skipped' });
    expect(o.calls.some((c) => /^(create|delete|load|unload)/.test(c))).toBe(false);
  });

  it('8 GB: 12k is the largest on the GPU; 16k spills, ends the search, and is deleted with 8k', async () => {
    const o = fakeOllama({ vram: 7.0 * GB });
    const out = await fitContextToGpu(HOST, 'qwen3:8b', o.fetchImpl);
    expect(out).toMatchObject({ status: 'fitted', ctx: 12288, variant: 'qwen3:8b-ctx12k' });
    expect(o.calls.filter((c) => /^(create|delete)/.test(c))).toEqual([
      'create qwen3:8b-ctx8k 8192',
      'create qwen3:8b-ctx12k 12288',
      'create qwen3:8b-ctx16k 16384',
      'delete qwen3:8b-ctx8k',
      'delete qwen3:8b-ctx16k',
    ]);
    // Each trial is unloaded before the next is measured.
    expect(o.calls.filter((c) => /^(load|unload)/.test(c))).toEqual([
      'load qwen3:8b-ctx8k',
      'unload qwen3:8b-ctx8k',
      'load qwen3:8b-ctx12k',
      'unload qwen3:8b-ctx12k',
      'load qwen3:8b-ctx16k',
      'unload qwen3:8b-ctx16k',
    ]);
    expect(Object.keys(o.models).sort()).toEqual(['qwen3:8b', 'qwen3:8b-ctx12k']);
  });

  it('a big GPU gets the largest candidate the model supports', async () => {
    const o = fakeOllama({ vram: 48 * GB, models: { 'qwen3:8b': { maxContext: 16384 } } });
    expect(await fitContextToGpu(HOST, 'qwen3:8b', o.fetchImpl)).toMatchObject({ ctx: 16384 });
    expect(o.calls.some((c) => c.includes('ctx32k'))).toBe(false);
  });

  it('CPU only: one trial, "no GPU fit", nothing left behind', async () => {
    const o = fakeOllama({ vram: 0 });
    expect(await fitContextToGpu(HOST, 'qwen3:8b', o.fetchImpl)).toMatchObject({ status: 'no-fit', reason: 'cpu' });
    expect(o.calls.filter((c) => c.startsWith('create'))).toEqual(['create qwen3:8b-ctx8k 8192']);
    expect(Object.keys(o.models)).toEqual(['qwen3:8b']);
  });

  it('a model that already sets num_ctx is never touched', async () => {
    const o = fakeOllama({ vram: 8 * GB, models: { 'qwen3:8b-ctx12k': { numCtx: 12288 } } });
    expect(await fitContextToGpu(HOST, 'qwen3:8b-ctx12k', o.fetchImpl)).toMatchObject({ status: 'skipped' });
    expect(o.calls.some((c) => /^(create|load)/.test(c))).toBe(false);
  });

  it('a model the host does not have is skipped, never pulled', async () => {
    const o = fakeOllama({ vram: 8 * GB });
    expect(await fitContextToGpu(HOST, 'gemma3:27b', o.fetchImpl)).toEqual({
      status: 'skipped',
      reason: 'not on this host',
    });
    expect(o.calls).toEqual(['tags']);
  });

  it('windows at or below the one already served are not tried', async () => {
    const o = fakeOllama({ vram: 48 * GB, loadedCtx: 16384 });
    await fitContextToGpu(HOST, 'qwen3:8b', o.fetchImpl);
    expect(o.calls.filter((c) => c.startsWith('create'))).toEqual(['create qwen3:8b-ctx32k 32768']);
  });

  it('a failed trial cleans up and reports the error', async () => {
    const o = fakeOllama({ vram: 8 * GB });
    const real = o.fetchImpl.getMockImplementation()!;
    o.fetchImpl.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/api/generate') && String(init?.body).includes('ctx12k","prompt')
        ? new Response('out of memory', { status: 500 })
        : real(url, init),
    );
    const out = await fitContextToGpu(HOST, 'qwen3:8b', o.fetchImpl);
    expect(out).toMatchObject({ status: 'error', error: expect.stringContaining('out of memory') });
    expect(Object.keys(o.models)).toEqual(['qwen3:8b']);
  });
});

describe('registration', () => {
  let dir: string;
  const original: WebchatModel = {
    id: 'orig',
    name: '192.0.2.69:11434 · qwen3:8b',
    kind: 'ollama',
    endpoint: HOST,
    model_id: 'qwen3:8b',
    credential_ref: null,
    created_at: 1,
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofit-'));
    await initDb(path.join(dir, 'test.db'));
    await runMigrations(getDb());
    await getDb().run(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1','ag-1','ag-1',NULL,'t')`,
    );
    await createWebchatModel(original);
    h.reloads = [];
    h.defaults = [];
    _resetFitsForTest();
  });
  afterEach(async () => {
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers the variant beside the original and moves the agent assigned in the same flow', async () => {
    await assignModelToAgent('ag-1', 'orig');
    await setDefaultModelId('orig');
    const o = fakeOllama({ vram: 7 * GB });
    const job = startAutoFit(original, o.fetchImpl);
    expect(job).toMatchObject({ status: 'queued', host: HOST, model: 'qwen3:8b' });
    await _drainFitsForTest();
    const rows = await listWebchatModels();
    const variant = rows.find((m) => m.model_id === 'qwen3:8b-ctx12k')!;
    expect(variant).toMatchObject({ kind: 'ollama', endpoint: HOST, name: '192.0.2.69:11434 · qwen3:8b @12k ctx' });
    expect(rows.some((m) => m.id === 'orig')).toBe(true);
    expect((await getAssignedModelForAgent('ag-1'))?.id).toBe(variant.id);
    expect(await getDefaultModelId()).toBe(variant.id);
    expect(h.reloads).toEqual(['ag-1']);
    expect(fitJobsSnapshot()).toEqual([
      expect.objectContaining({ status: 'fitted', ctx: 12288, variant: 'qwen3:8b-ctx12k' }),
    ]);
  });

  it('no GPU fit: the original stays alone and the job says why', async () => {
    const o = fakeOllama({ vram: 0 });
    startAutoFit(original, o.fetchImpl);
    await _drainFitsForTest();
    expect((await listWebchatModels()).map((m) => m.id)).toEqual(['orig']);
    expect(fitJobsSnapshot()).toEqual([expect.objectContaining({ status: 'no-fit', detail: 'cpu' })]);
  });

  it('one model per host at a time', async () => {
    const o = fakeOllama({ vram: 7 * GB, models: { 'gemma3:4b': { maxContext: 8192 } } });
    let inFlight = 0;
    let most = 0;
    const real = o.fetchImpl.getMockImplementation()!;
    o.fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await real(url, init);
      } finally {
        inFlight--;
      }
    });
    startAutoFit(original, o.fetchImpl);
    startAutoFit({ ...original, id: 'g', model_id: 'gemma3:4b' }, o.fetchImpl);
    await _drainFitsForTest();
    expect(most).toBe(1);
  });

  it('off by default: a registration starts nothing (the UI asks instead)', async () => {
    const o = fakeOllama({ vram: 7 * GB });
    expect(await getFitContextToGpu()).toBe(false);
    await autoFitNewModels([original], o.fetchImpl);
    expect(fitJobsSnapshot()).toEqual([]);
  });

  it('a settings read that fails reads as off', async () => {
    await getDb().run('DROP TABLE webchat_settings');
    expect(await getFitContextToGpu()).toBe(false);
  });

  it('startFits fits what the owner said yes to, whatever the setting; Ollama models only', async () => {
    const o = fakeOllama({ vram: 7 * GB });
    expect(startFits([original, { ...original, id: 'x', kind: 'openai-compatible' }], o.fetchImpl)).toBe(1);
    expect(fitJobsSnapshot()).toHaveLength(1);
    await _drainFitsForTest();
  });

  it('the setting turns it off; variants and other kinds are never fitted', async () => {
    const o = fakeOllama({ vram: 7 * GB });
    await setFitContextToGpu(false);
    await autoFitNewModels([original], o.fetchImpl);
    expect(fitJobsSnapshot()).toEqual([]);
    await setFitContextToGpu(true);
    expect(startAutoFit({ ...original, model_id: 'qwen3:8b-ctx12k' }, o.fetchImpl)).toBeNull();
    expect(startAutoFit({ ...original, kind: 'openai-compatible' }, o.fetchImpl)).toBeNull();
    await autoFitNewModels([original], o.fetchImpl);
    expect(fitJobsSnapshot()).toHaveLength(1);
    await _drainFitsForTest();
  });
});
