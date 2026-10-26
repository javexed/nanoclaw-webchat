// node --test coverage for bind-routes.mjs's pure logic.
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseParamB,
  matchCatalog,
  scoreModel,
  chooseBindings,
  applyDecisions,
  localModels,
  mergeCatalog,
  routers,
  routerAuthHeaders,
} from './bind-routes.mjs';

const CATALOG = {
  max_comfortable_b: 14,
  size_penalty_per_b: 4,
  entries: [
    { pattern: 'ornith', quality: { code: 88, general: 60 } },
    { pattern: 'qwen3-coder', quality: { code: 92 } },
    { pattern: 'qwen3.5', quality: { code: 62, general: 62 } },
    { pattern: 'gemma', quality: { general: 75, reasoning: 72 } },
    { pattern: 'arch-router', quality: {} },
  ],
};

const ROUTES = {
  routes: [
    { name: 'code', description: 'd', model: 'qwen3.5:4b' },
    { name: 'general', description: 'd', model: 'gemma4:latest' },
    { name: 'reasoning', description: 'd', model: 'gemma4:latest', pinned: true },
  ],
};

test('parseParamB reads sizes from ids', () => {
  assert.equal(parseParamB('qwen3-coder:30b'), 30);
  assert.equal(parseParamB('ornith-9b'), 9);
  assert.equal(parseParamB('qwen3.5:4b'), 4);
  assert.equal(parseParamB('gemma4:latest'), null);
});

test('size penalty demotes an oversized specialist below a right-sized one', () => {
  // qwen3-coder:30b → 92 − (30−14)×4 = 28; ornith 9b → 88.
  assert.equal(scoreModel('qwen3-coder:30b', 'code', CATALOG), 28);
  assert.equal(scoreModel('ornith:latest', 'code', CATALOG), 88);
});

test('unknown models and capability-less entries never score', () => {
  assert.equal(scoreModel('mystery-model:7b', 'code', CATALOG), null);
  assert.equal(scoreModel('hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M', 'code', CATALOG), null);
});

test('chooseBindings rebinds code to ornith, respects pins', () => {
  const roster = ['qwen3.5:4b', 'gemma4:latest', 'ornith:latest', 'qwen3-coder:30b', 'arch-router-1.5b'];
  const { decisions, unknown } = chooseBindings(structuredClone(ROUTES), roster, CATALOG);
  const by = Object.fromEntries(decisions.map((d) => [d.route, d]));
  assert.equal(by.code.chosen, 'ornith:latest');
  assert.equal(by.code.changed, true);
  assert.equal(by.general.chosen, 'gemma4:latest');
  assert.equal(by.general.changed, false);
  assert.equal(by.reasoning.pinned, true);
  assert.deepEqual(unknown, []);
});

test('a route with no scored candidate keeps its current binding', () => {
  const routes = { routes: [{ name: 'vision', description: 'd', model: 'llava:7b' }] };
  const { decisions } = chooseBindings(routes, ['gemma4:latest'], CATALOG);
  assert.equal(decisions[0].chosen, 'llava:7b');
  assert.equal(decisions[0].changed, false);
});

test('applyDecisions writes only unpinned changes', () => {
  const cfg = structuredClone(ROUTES);
  const { decisions } = chooseBindings(structuredClone(ROUTES), ['ornith:latest', 'gemma4:latest'], CATALOG);
  applyDecisions(cfg, decisions);
  assert.equal(cfg.routes[0].model, 'ornith:latest'); // code rebound
  assert.equal(cfg.routes[2].model, 'gemma4:latest'); // pinned untouched
});

test('mergeCatalog puts local entries first and lets knobs override', () => {
  const merged = mergeCatalog(CATALOG, {
    max_comfortable_b: 30,
    entries: [{ pattern: 'qwen3-coder', quality: { code: 99 } }],
  });
  // Local entry wins the match, and the raised comfort ceiling kills the penalty.
  assert.equal(scoreModel('qwen3-coder:30b', 'code', merged), 99);
});

test('unknown roster models are reported', () => {
  const { unknown } = chooseBindings(structuredClone(ROUTES), ['brand-new-thing:8b'], CATALOG);
  assert.deepEqual(unknown, ['brand-new-thing:8b']);
});

test('routers(): old single-router format normalizes to a one-entry map', () => {
  const cfg = { live: { model_name: 'auto', timeout_ms: 8000 }, default_route: 'general', routes: [{ name: 'code', model: 'x' }] };
  const m = routers(cfg);
  assert.deepEqual(Object.keys(m), ['auto']);
  assert.equal(m.auto.routes, cfg.routes); // SAME reference — mutations write back
  assert.equal(m.auto.default_route, 'general');
});

test('routers(): new multi-router format passes through unchanged', () => {
  const cfg = { routers: { auto: { routes: [] }, 'auto-vision': { routes: [] } } };
  assert.deepEqual(Object.keys(routers(cfg)), ['auto', 'auto-vision']);
});

test('multi-router: each router binds independently from the shared roster', () => {
  const cfg = {
    routers: {
      auto: { routes: [{ name: 'code', model: 'old' }] },
      'auto-general': { routes: [{ name: 'general', model: 'old' }] },
    },
  };
  const roster = ['ornith:latest', 'gemma4:latest'];
  for (const [, router] of Object.entries(routers(cfg))) {
    const { decisions } = chooseBindings(router, roster, CATALOG);
    applyDecisions(router, decisions);
  }
  assert.equal(cfg.routers.auto.routes[0].model, 'ornith:latest'); // code → ornith (88)
  assert.equal(cfg.routers['auto-general'].routes[0].model, 'gemma4:latest'); // general → gemma (75)
});

// ── Context annotation (max_prompt_tokens for the hook's context guard) ────
import { usablePromptTokens, annotateContext } from './bind-routes.mjs';

test('usablePromptTokens halves the window (Ollama reserves ~half for generation)', () => {
  assert.equal(usablePromptTokens(16384), 8192);
  assert.equal(usablePromptTokens(4096), 2048);
});

test('annotateContext stamps bound routes, skips unbound, counts changes', () => {
  const router = {
    routes: [
      { name: 'general', model: 'qwen3-8b-16k:latest' },
      { name: 'code', model: 'qwen3:8b' },
      { name: 'unbound' },
    ],
  };
  const changed = annotateContext(router, { 'qwen3-8b-16k:latest': 16384, 'qwen3:8b': 4096 });
  assert.equal(changed, 2);
  assert.equal(router.routes[0].max_prompt_tokens, 8192);
  assert.equal(router.routes[1].max_prompt_tokens, 2048);
  assert.equal(router.routes[2].max_prompt_tokens, undefined);
});

test('annotateContext leaves models missing from the ctx map alone (probe failure ≠ guard off)', () => {
  const router = { routes: [{ name: 'general', model: 'mystery:latest', max_prompt_tokens: 5000 }] };
  assert.equal(annotateContext(router, {}), 0);
  assert.equal(router.routes[0].max_prompt_tokens, 5000);
});

test('annotateContext is idempotent (no change → 0)', () => {
  const router = { routes: [{ name: 'general', model: 'm', max_prompt_tokens: 8192 }] };
  assert.equal(annotateContext(router, { m: 16384 }), 0);
});

test('the roster read carries the master key only when the router config turns auth on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-routes-'));
  try {
    fs.writeFileSync(path.join(dir, 'master.key'), 'sk-abc\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'model_list: []\n# no master_key here\n');
    assert.deepEqual(routerAuthHeaders(dir), {});
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'general_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n');
    assert.deepEqual(routerAuthHeaders(dir), { Authorization: 'Bearer sk-abc' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Local only: a keyed cloud model is never auto-bound ──────────────────────

const ROUTER_CONFIG = `# Generated by add-litellm/gen-config.mjs — regenerate, do not hand-edit.
model_list:
  - model_name: gemma4:latest
    litellm_params:
      model: ollama_chat/gemma4:latest
      api_base: http://gpu:11434
  - model_name: qwen-vllm
    litellm_params:
      model: openai/qwen-vllm
      api_base: http://gpu:8000/v1
      api_key: keyless
  - model_name: deepseek-r1
    litellm_params:
      model: deepseek/deepseek-reasoner
      api_key: os.environ/DEEPSEEK_API_KEY
  - model_name: mistral-large
    litellm_params:
      model: mistral/mistral-large-latest
      api_key: gateway-managed
  - model_name: minimax
    litellm_params:
      model: ollama_chat/minimax
      api_base: http://gpu:11434
  - model_name: minimax
    litellm_params:
      model: minimax/abab
      api_key: os.environ/MINIMAX_API_KEY

litellm_settings:
  request_timeout: 600
`;

const CLOUD_CATALOG = {
  ...CATALOG,
  entries: [
    { pattern: 'deepseek', quality: { reasoning: 95, code: 90 } },
    { pattern: 'mistral', quality: { general: 90 } },
    { pattern: 'minimax', quality: { general: 99 } },
    ...CATALOG.entries,
  ],
};

test('localModels: keyless hosts are local; keyed, gateway and mixed names are not', () => {
  assert.deepEqual([...localModels(ROUTER_CONFIG)].sort(), ['gemma4:latest', 'qwen-vllm']);
  assert.deepEqual([...localModels('')], []);
});

test('a cloud model matching a catalog pattern is not bound; a local one still is', () => {
  const roster = ['deepseek-r1', 'mistral-large', 'minimax', 'gemma4:latest'];
  const local = localModels(ROUTER_CONFIG);
  const cfg = {
    routes: [
      { name: 'reasoning', description: 'd', model: 'gemma4:latest' },
      { name: 'general', description: 'd', model: 'gemma4:latest' },
    ],
  };
  const { decisions } = chooseBindings(cfg, roster, CLOUD_CATALOG, local);
  for (const d of decisions) assert.equal(d.chosen, 'gemma4:latest', d.route);
  // Without the local filter the catalog would have picked the cloud models.
  const open = chooseBindings(cfg, roster, CLOUD_CATALOG).decisions;
  assert.deepEqual(
    open.map((d) => d.chosen),
    ['deepseek-r1', 'minimax'],
  );
});

test('an unpinned route bound to a cloud model loses it; a pinned one keeps it', () => {
  const cfg = {
    routes: [
      { name: 'code', description: 'd', model: 'deepseek-r1' },
      { name: 'reasoning', description: 'd', model: 'deepseek-r1', pinned: true },
    ],
  };
  const { decisions } = chooseBindings(cfg, ['deepseek-r1'], CLOUD_CATALOG, localModels(ROUTER_CONFIG));
  applyDecisions(cfg, decisions);
  assert.equal(cfg.routes[0].model, undefined);
  assert.equal(cfg.routes[1].model, 'deepseek-r1');
});

test('--apply without a router config refuses, and leaves routes.json alone', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-routes-noconfig-'));
  try {
    const routesPath = path.join(dir, 'routes.json');
    const before = JSON.stringify(ROUTES, null, 2) + '\n';
    fs.writeFileSync(routesPath, before);
    const script = new URL('./bind-routes.mjs', import.meta.url).pathname;
    const run = (...extra) =>
      spawnSync(
        process.execPath,
        [script, '--routing-dir', dir, '--roster', 'qwen3.5:4b,gemma4:latest', '--no-ctx', ...extra],
        { encoding: 'utf8' },
      );
    const applied = run('--apply');
    assert.notEqual(applied.status, 0);
    assert.match(applied.stderr, /router config not found/);
    assert.equal(fs.readFileSync(routesPath, 'utf8'), before);
    // A dry run still previews.
    assert.equal(run().status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
