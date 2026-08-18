/**
 * Host-side container config for the `pi` provider.
 *
 * pi reads its config from $PI_CODING_AGENT_DIR (models.json, sessions/), which
 * we pin to a per-session host directory mounted at /pi-agent. The host writes
 * models.json before each spawn so the container's pi always targets the
 * agent's CURRENT local model.
 *
 * Model resolution (first hit wins):
 *   1. The per-agent local-model wiring file the webchat model bridge writes
 *      (<agent>/.claude-shared/opencode-model.json — shared by the local
 *      harnesses; provider/model/baseURL for the assigned Ollama model).
 *   2. .env / process.env: PI_PROVIDER, PI_MODEL, ANTHROPIC_BASE_URL.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

interface LocalModelWiring {
  provider?: string;
  model?: string;
  baseURL?: string;
}

/** The per-agent local-model wiring (sessionDir is <…>/<agentGroupId>/<sessionId>). */
function readAgentWiring(sessionDir: string): LocalModelWiring {
  try {
    const file = path.join(sessionDir, '..', '.claude-shared', 'opencode-model.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as LocalModelWiring;
  } catch {
    return {};
  }
}

registerProviderContainerConfig('pi', (ctx) => {
  const piDir = path.join(ctx.sessionDir, 'pi-agent');
  fs.mkdirSync(path.join(piDir, 'sessions'), { recursive: true });

  const wiring = readAgentWiring(ctx.sessionDir);
  const dotenv = readEnvFile(['PI_PROVIDER', 'PI_MODEL', 'ANTHROPIC_BASE_URL']);
  const pick = (k: string): string | undefined => dotenv[k] || ctx.hostEnv[k];

  const provider = wiring.provider || pick('PI_PROVIDER') || 'ollama';
  // Wiring model is `<provider>/<id>` (opencode convention) — strip the prefix.
  const rawModel = wiring.model || pick('PI_MODEL') || '';
  const modelId = rawModel.replace(new RegExp(`^${provider}/`), '');
  const baseURL = wiring.baseURL || pick('ANTHROPIC_BASE_URL') || 'http://host.docker.internal:11434/v1';

  // models.json — pi's custom-provider catalog. openai-completions + the compat
  // flags Ollama-class servers need (no `developer` role, no reasoning_effort).
  const modelsJson = {
    providers: {
      [provider]: {
        baseUrl: baseURL,
        api: 'openai-completions',
        apiKey: 'placeholder',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: modelId, reasoning: true }],
      },
    },
  };
  fs.writeFileSync(path.join(piDir, 'models.json'), JSON.stringify(modelsJson, null, 2) + '\n');

  // Hostname only — NO_PROXY matches on host, which also covers the port. An
  // unparseable baseURL falls back to the local-only list rather than throwing
  // at spawn time.
  let modelHost = '';
  try {
    modelHost = new URL(baseURL).hostname;
  } catch {
    /* keep the local defaults */
  }
  const noProxyList = ['127.0.0.1', 'localhost', 'host.docker.internal', modelHost]
    .filter(Boolean)
    .join(',');

  return {
    mounts: [{ hostPath: piDir, containerPath: '/pi-agent', readonly: false }],
    env: {
      PI_CODING_AGENT_DIR: '/pi-agent',
      PI_PROVIDER: provider,
      PI_MODEL: modelId,
      // The model backend is reached directly, past the OneCLI proxy.
      //
      // The three literals below describe a LOCAL Ollama. Once inference moves
      // off-box — a LAN GPU host, the normal shape at any size — that hostname is
      // absent from the list, pi's requests route through the egress proxy, and
      // every turn fails with a bare "Connection error.": three retries, zero
      // tokens, an empty turn, and nothing in any log naming the cause.
      //
      // What makes it hard to place is that `curl` through the SAME proxy from the
      // SAME container succeeds. pi is Node/undici behind EnvHttpProxyAgent, and
      // the two clients do not treat this proxy alike — so every check reaching for
      // curl reports a healthy network while pi cannot talk at all.
      //
      // Derive the host from the resolved baseURL rather than assuming locality.
      NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, noProxyList),
      no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, noProxyList),
    },
  };
});
