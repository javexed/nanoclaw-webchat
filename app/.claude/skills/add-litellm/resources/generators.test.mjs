/**
 * generators.test.mjs — fixture-driven tests for gen-config.mjs.
 * Runs with plain `node --test` (no vitest — this skill has no core
 * integration points; see docs/skill-guidelines.md). No network: fixtures
 * stand in for the hosts' roster endpoints (Ollama /api/tags shape and
 * OpenAI-compatible /v1/models shape).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate as genConfig, opt } from './gen-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(HERE, 'fixtures/rosters.json'), 'utf8'));
const OLLAMA_HOSTS = ['http://localhost:11434', 'http://10.0.0.5:11434'];
const ALL_HOSTS = [...OLLAMA_HOSTS, 'http://10.0.0.7:8000'];

test('model_list covers all hosts, localhost rewritten for the container', async () => {
  const yaml = await genConfig({ hosts: OLLAMA_HOSTS, fixtures });
  // (values containing ':' are YAML-quoted by the generator — regexes allow it)
  assert.match(yaml, /api_base: "?http:\/\/host\.docker\.internal:11434"?/);
  assert.match(yaml, /api_base: "?http:\/\/10\.0\.0\.5:11434"?/);
  // ollama_chat prefix (chat + tool-call support)
  assert.match(yaml, /model: "?ollama_chat\/qwen2\.5-coder:14b"?/);
});

test('same tag on two hosts = two deployments under one model_name (load-balanced)', async () => {
  const yaml = await genConfig({ hosts: OLLAMA_HOSTS, fixtures });
  const dupes = yaml.match(/model_name: "?qwen2\.5-coder:14b"?/g);
  assert.equal(dupes.length, 2);
});

test('OpenAI-compatible host: openai/ prefix + placeholder api_key, no ollama coupling', async () => {
  const yaml = await genConfig({ hosts: ['http://10.0.0.7:8000'], fixtures });
  assert.match(yaml, /model: "?openai\/mistral-7b-instruct"?/);
  assert.match(yaml, /api_base: "?http:\/\/10\.0\.0\.7:8000"?/);
  // keyless server still needs LiteLLM's required api_key field — placeholder only
  assert.match(yaml, /api_key: keyless/);
  assert.doesNotMatch(yaml, /ollama_chat\//);
});

test('cross-kind load balancing: same model on ollama + openai hosts shares one model_name', async () => {
  const yaml = await genConfig({ hosts: ALL_HOSTS, fixtures });
  const dupes = yaml.match(/model_name: "?qwen2\.5-coder:14b"?/g);
  assert.equal(dupes.length, 3); // 2 ollama deployments + 1 openai-compat
  assert.match(yaml, /model: "?ollama_chat\/qwen2\.5-coder:14b"?/);
  assert.match(yaml, /model: "?openai\/qwen2\.5-coder:14b"?/);
});

test('keyless + agentic obligations: no master_key setting, generous timeouts', async () => {
  const yaml = await genConfig({ hosts: ALL_HOSTS, fixtures });
  // settings, not the explanatory comment that names them
  assert.doesNotMatch(yaml, /^\s*master_key\s*:/m);
  assert.doesNotMatch(yaml, /^\s*database_url\s*:/im);
  assert.match(yaml, /request_timeout: 600/);
  assert.match(yaml, /num_retries: 2/);
});

test('Claude-harness /v1/messages goes to chat/completions, not the Responses API', async () => {
  const yaml = await genConfig({ hosts: ['http://10.0.0.7:8000'], fixtures });
  assert.match(yaml, /^ {2}use_chat_completions_url_for_anthropic_messages: true$/m);
});

test('no classifier coupling in the minimal skill (dependent layers own that)', async () => {
  const yaml = await genConfig({ hosts: ALL_HOSTS, fixtures });
  assert.doesNotMatch(yaml, /callbacks/);
  assert.doesNotMatch(yaml, /fallbacks/);
});

test('empty roster is a hard error', async () => {
  await assert.rejects(
    () => genConfig({ hosts: ['http://localhost:11434'], fixtures: { 'http://localhost:11434': { models: [] } } }),
    /no models discovered/,
  );
});

test('unrecognizable roster shape is a hard error naming the host', async () => {
  await assert.rejects(
    () => genConfig({ hosts: ['http://bad:1'], fixtures: { 'http://bad:1': { nope: true } } }),
    /neither Ollama nor OpenAI/,
  );
});

// ── keyed backends (opt-in) ────────────────────────────────────────────────

const KEYED = [
  { model_name: 'gpt-4o', model: 'openai/gpt-4o', api_key_env: 'OPENAI_API_KEY' },
  { model_name: 'claude-sonnet', model: 'anthropic/claude-sonnet-4-6', api_key_env: 'ANTHROPIC_API_KEY' },
];

test('keyed backends: os.environ refs only, and master_key turns on', async () => {
  const yaml = await genConfig({ hosts: OLLAMA_HOSTS, fixtures, backends: KEYED });
  assert.match(yaml, /model: openai\/gpt-4o/);
  assert.match(yaml, /api_key: os\.environ\/OPENAI_API_KEY/);
  assert.match(yaml, /api_key: os\.environ\/ANTHROPIC_API_KEY/);
  // proxy auth is mandatory once a paid key sits behind the endpoint
  assert.match(yaml, /^general_settings:$/m);
  assert.match(yaml, /^\s*master_key: os\.environ\/LITELLM_MASTER_KEY$/m);
  // discovered local deployments are unaffected
  assert.match(yaml, /model: "?ollama_chat\/qwen2\.5-coder:14b"?/);
});

test('keyed backends: a literal api_key value is a hard error', async () => {
  await assert.rejects(
    () =>
      genConfig({
        hosts: [],
        backends: [{ model_name: 'x', model: 'openai/x', api_key: 'sk-oops-a-real-key' }],
      }),
    /literal api_key values are forbidden/,
  );
});

test('keyed backends: api_key_env must be an env-var NAME; fields required', async () => {
  await assert.rejects(
    () => genConfig({ hosts: [], backends: [{ model_name: 'x', model: 'openai/x', api_key_env: 'sk-value-here' }] }),
    /must be an ENV_VAR_NAME/,
  );
  await assert.rejects(
    () => genConfig({ hosts: [], backends: [{ model_name: 'x', api_key_env: 'K' }] }),
    /missing required field model/,
  );
});

test('keyed-only config (no local hosts) is valid', async () => {
  const yaml = await genConfig({ hosts: [], backends: KEYED });
  assert.match(yaml, /model_name: gpt-4o/);
  assert.doesNotMatch(yaml, /ollama_chat\//);
});

test('keyless path is byte-identical with backends absent vs empty', async () => {
  const a = await genConfig({ hosts: OLLAMA_HOSTS, fixtures });
  const b = await genConfig({ hosts: OLLAMA_HOSTS, fixtures, backends: [] });
  assert.equal(a, b);
  assert.doesNotMatch(a, /general_settings/);
});

test('gateway backend: placeholder key, proxy auth on, no env-file key name; cloud-only with no hosts', async () => {
  const yaml = await genConfig({
    hosts: [],
    backends: [{ model_name: 'command-a', model: 'cohere_chat/command-a-03-2025', gateway: true }],
  });
  assert.match(yaml, /model: cohere_chat\/command-a-03-2025/);
  assert.match(yaml, /api_key: gateway-managed/);
  // The gateway adds the provider key on the way out: whoever reaches the port spends it.
  assert.match(yaml, /^\s*master_key: os\.environ\/LITELLM_MASTER_KEY$/m);
  assert.doesNotMatch(yaml, /api_key: os\.environ/);
});

test('a gateway backend may not also name an env key; a keyed one still turns proxy auth on', async () => {
  await assert.rejects(
    genConfig({ hosts: [], backends: [{ model_name: 'm', model: 'openai/m', gateway: true, api_key_env: 'K' }] }),
    /exclusive/,
  );
  const yaml = await genConfig({
    hosts: [],
    backends: [
      { model_name: 'a', model: 'cohere_chat/a', gateway: true },
      { model_name: 'b', model: 'openai/b', api_key_env: 'OPENAI_API_KEY' },
    ],
  });
  assert.match(yaml, /master_key: os\.environ\/LITELLM_MASTER_KEY/);
});

test('a host that does not answer is skipped, the others still served, the header keeps it', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('http://10.0.0.9:11434')) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 });
  };
  const yaml = await genConfig({ hosts: ['http://10.0.0.9:11434', 'http://10.0.0.5:11434'], fetchImpl });
  assert.match(yaml, /^# hosts: http:\/\/10\.0\.0\.9:11434, http:\/\/10\.0\.0\.5:11434$/m);
  assert.match(yaml, /api_base: "?http:\/\/10\.0\.0\.5:11434"?/);
  assert.doesNotMatch(yaml, /api_base: "?http:\/\/10\.0\.0\.9/);
});

test('every host down and nothing else declared is still an error', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(genConfig({ hosts: ['http://10.0.0.9:11434'], fetchImpl }), /no models discovered/);
});

test('a flag never takes the next flag as its value; an empty value is still a value', () => {
  assert.equal(opt(['--hosts', 'http://a:11434', '--out', 'x'], 'hosts', 'd'), 'http://a:11434');
  assert.equal(opt(['--hosts', '', '--out', 'x'], 'hosts', 'd'), '');
  assert.equal(opt(['--out', 'x'], 'hosts', 'd'), 'd');
  assert.throws(() => opt(['--hosts', '--out', 'x'], 'hosts', 'd'), /--hosts needs a value/);
  assert.throws(() => opt(['--out'], 'out', null), /--out needs a value/);
});
