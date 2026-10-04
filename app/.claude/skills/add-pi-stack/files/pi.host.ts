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
 *      (<agent>/.claude-shared/local-model.json — shared by the local
 *      harnesses; provider/model/baseURL for the assigned Ollama model).
 *   2. .env / process.env: PI_PROVIDER, PI_MODEL, ANTHROPIC_BASE_URL — only
 *      when the agent has no model assigned. An assigned model pi cannot serve
 *      (a cloud model) fails the turn with a clear message instead.
 *
 * Webchat is optional. Its model bridge (assignment, host failover, the relay
 * to a model on another machine, the served window) is loaded on first spawn;
 * without it pi runs on the .env model with the default window.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { resolveWithBackgroundProbe } from '../model-profile-store.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/** The slice of webchat's model bridge pi uses. Typed here so pi builds without webchat. */
interface WebchatModelBridge {
  getEffectiveModelForAgent(
    agentGroupId: string,
  ): Promise<{ kind: string; endpoint?: string | null; name?: string; model_id?: string } | null>;
  localModelFailover(agentGroupId: string): Promise<{ baseURL: string; modelId: string } | null>;
  agentModelUrl(agentGroupId: string, url: string): Promise<string>;
  fetchOllamaModelMeta(baseURL: string, model: string): Promise<PiModelMeta | null>;
  servedModelLimits(meta: PiModelMeta): { contextWindow: number; maxTokens: number };
  clearOllamaModelMetaCache(): void;
}

/** Ollama model metadata as webchat's ollama-context reports it. */
export interface PiModelMeta {
  numCtx: number | null;
  loadedCtx?: number | null;
  maxContext: number | null;
  vision: boolean;
}

const WEBCHAT_MODULES = [
  '../channels/webchat/db.js',
  '../channels/webchat/model-host-health.js',
  '../channels/webchat/model-relay.js',
  '../channels/webchat/ollama-context.js',
];

/** Webchat itself is missing — not some module it imports, which is a real fault. */
function isWebchatAbsent(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'MODULE_NOT_FOUND') return false;
  return /Cannot find module '[^']*channels\/webchat\//.test(String(e.message));
}

/** Null when webchat is not installed. Any other import failure is a real fault and surfaces. */
async function importWebchatBridge(): Promise<WebchatModelBridge | null> {
  try {
    // Specifiers held in a variable: the compiler must not resolve modules that may be absent.
    const mods = (await Promise.all(WEBCHAT_MODULES.map((m) => import(m)))) as Array<Record<string, unknown>>;
    return Object.assign({}, ...mods) as WebchatModelBridge;
  } catch (err) {
    if (isWebchatAbsent(err)) return null;
    throw err;
  }
}

let loadWebchatBridge: () => Promise<WebchatModelBridge | null> = importWebchatBridge;
let bridgePromise: Promise<WebchatModelBridge | null> | null = null;
let bridgeLoaded: WebchatModelBridge | null = null;

async function webchatBridge(): Promise<WebchatModelBridge | null> {
  bridgePromise ??= loadWebchatBridge().then((b) => (bridgeLoaded = b));
  return bridgePromise;
}

/** Test hook: load the bridge with `loader` (one returning null stands for an install without webchat). */
export function _setWebchatBridgeLoaderForTest(loader?: () => Promise<WebchatModelBridge | null>): void {
  loadWebchatBridge = loader ?? importWebchatBridge;
  bridgePromise = null;
  bridgeLoaded = null;
}

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

/**
 * The per-agent local-model wiring (sessionDir is <…>/<agentGroupId>/<sessionId>).
 *
 * Reads BOTH names, new first. The file was `opencode-model.json` when OpenCode
 * was its only reader; pi inherited the name, and it is `local-model.json` now
 * that it wires any local harness. An install whose file predates the rename
 * still resolves here — the host writes only the new name and removes the old
 * one, so the fallback can never shadow current wiring.
 */
function readAgentWiring(sessionDir: string): LocalModelWiring {
  const shared = path.join(sessionDir, '..', '.claude-shared');
  for (const name of ['local-model.json', 'opencode-model.json']) {
    try {
      return JSON.parse(fs.readFileSync(path.join(shared, name), 'utf-8')) as LocalModelWiring;
    } catch {
      // absent or unreadable — try the next name, then give up silently: no
      // wiring is a valid state (the agent falls back to env/.env defaults).
    }
  }
  return {};
}

/**
 * Window and output budget pi is told about. pi defaults to 128k/16k for an
 * undeclared model, so it never compacts before Ollama silently truncates.
 * These apply only when the server cannot be asked.
 */
export const PI_DEFAULT_CONTEXT_WINDOW = 32768;
export const PI_DEFAULT_MAX_TOKENS = 8192;

export interface PiModelLimits {
  contextWindow: number;
  maxTokens: number;
  input: string[];
}

/** The window Ollama serves the model with (webchat's ollama-context); output gets a quarter of it. */
export async function piModelLimits(meta: PiModelMeta | null): Promise<PiModelLimits> {
  const served = meta ? (await webchatBridge())?.servedModelLimits(meta) : undefined;
  return {
    ...(served ?? { contextWindow: PI_DEFAULT_CONTEXT_WINDOW, maxTokens: PI_DEFAULT_MAX_TOKENS }),
    input: meta?.vision ? ['text', 'image'] : ['text'],
  };
}

/** Test hook: forget cached model metadata. */
export function clearPiModelMetaCache(): void {
  bridgeLoaded?.clearOllamaModelMetaCache();
}

/** Ask the model server what it runs the model with; null when it does not answer or webchat is absent. */
export async function fetchPiModelMeta(baseURL: string, model: string): Promise<PiModelMeta | null> {
  const bridge = await webchatBridge();
  return bridge ? bridge.fetchOllamaModelMeta(baseURL, model) : null;
}

/** Compaction budgets scaled to the window; pi's defaults assume a 128k one. */
function writeCompactionSettings(piDir: string, limits: PiModelLimits): void {
  const file = path.join(piDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
  } catch {
    /* none yet */
  }
  const current = (settings.compaction && typeof settings.compaction === 'object' ? settings.compaction : {}) as Record<
    string,
    unknown
  >;
  settings.compaction = {
    ...current,
    reserveTokens: limits.maxTokens,
    keepRecentTokens: Math.floor(limits.contextWindow / 4),
  };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

registerProviderContainerConfig(
  'pi',
  async (ctx) => {
    const piDir = path.join(ctx.sessionDir, 'pi-agent');
    fs.mkdirSync(path.join(piDir, 'sessions'), { recursive: true });

    const wiring = readAgentWiring(ctx.sessionDir);
    const bridge = await webchatBridge();
    // No wiring but a model assigned: the model is not one pi can serve
    // (the wiring is written for local models only). Falling back to the
    // install's .env model here would answer as a different model, silently.
    let unservable: string | undefined;
    if (!wiring.model) {
      const assigned = bridge ? await bridge.getEffectiveModelForAgent(ctx.agentGroupId).catch(() => null) : null;
      if (assigned && (assigned.kind !== 'ollama' || !assigned.endpoint))
        unservable = assigned.name || assigned.model_id;
    }
    const dotenv = readEnvFile(['PI_PROVIDER', 'PI_MODEL', 'PI_TOOLS', 'PI_THINKING', 'ANTHROPIC_BASE_URL']);
    const pick = (k: string): string | undefined => dotenv[k] || ctx.hostEnv[k];

    const provider = wiring.provider || pick('PI_PROVIDER') || 'ollama';
    // Wiring model is `<provider>/<id>` (opencode convention) — strip the prefix.
    const rawModel = wiring.model || pick('PI_MODEL') || '';
    let modelId = rawModel.replace(new RegExp(`^${provider}/`), '');
    let baseURL = wiring.baseURL || pick('ANTHROPIC_BASE_URL') || 'http://host.docker.internal:11434/v1';
    // The assigned model's host is down and another serves it: this spawn goes there.
    const failover =
      wiring.model && bridge ? await bridge.localModelFailover(ctx.agentGroupId).catch(() => null) : null;
    if (failover) ({ baseURL, modelId } = failover);
    // What the container dials: a model on another machine through its relay when the agent is filtered.
    const agentBaseURL = bridge ? await bridge.agentModelUrl(ctx.agentGroupId, baseURL) : baseURL;

    const limits = await piModelLimits(unservable ? null : await fetchPiModelMeta(baseURL, modelId));
    // models.json — pi's custom-provider catalog. openai-completions + the compat
    // flags Ollama-class servers need (no `developer` role, no reasoning_effort).
    const modelsJson = {
      providers: {
        [provider]: {
          baseUrl: agentBaseURL,
          api: 'openai-completions',
          apiKey: 'placeholder',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: modelId, reasoning: true, ...limits }],
        },
      },
    };
    fs.writeFileSync(path.join(piDir, 'models.json'), JSON.stringify(modelsJson, null, 2) + '\n');
    writeCompactionSettings(piDir, limits);

    // Hostname only — NO_PROXY matches on host, which also covers the port. An
    // unparseable baseURL falls back to the local-only list rather than throwing
    // at spawn time.
    let modelHost = '';
    try {
      modelHost = new URL(agentBaseURL).hostname;
    } catch {
      /* keep the local defaults */
    }
    const noProxyList = ['127.0.0.1', 'localhost', 'host.docker.internal', modelHost].filter(Boolean).join(',');

    // Per-model harness settings. An explicit .env value still wins — an
    // operator overriding a knob must not be silently overruled by a profile.
    const profile = resolveWithBackgroundProbe({
      dataDir: path.join(process.cwd(), 'data'),
      model: modelId,
      baseURL,
      log: (msg) => console.log(`[pi] ${msg}`),
    });
    const tools = pick('PI_TOOLS') ?? profile.tools;
    const thinking = pick('PI_THINKING') ?? profile.thinking;

    return {
      mounts: [{ hostPath: piDir, containerPath: '/pi-agent', readonly: false }],
      env: {
        PI_CODING_AGENT_DIR: '/pi-agent',
        // A hard ceiling on ONE turn. pi's idle timeout only notices silence, so
        // a model looping productively — read, edit, read, edit, as ornith did —
        // looks busy forever and never trips it. Derived from parameter count,
        // doubled for headroom; see model-profiles.ts.
        PI_TURN_TIMEOUT_MS: String(profile.turnTimeoutMs),
        ...(profile.noopCapThreshold ? { PI_NOOP_CAP: String(profile.noopCapThreshold) } : {}),
        // Tunable from .env without a code change. Unset, the container defaults
        // to tools=read,write,edit,bash and thinking=high; PI_TOOLS=none restores
        // the original toolless harness.
        ...(tools ? { PI_TOOLS: tools } : {}),
        ...(thinking ? { PI_THINKING: thinking } : {}),
        PI_PROVIDER: provider,
        PI_MODEL: modelId,
        ...(unservable ? { PI_UNSERVABLE_MODEL: unservable } : {}),
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
  },
  {
    // pi runs its own harness with a fixed toolset (read/write/edit/bash) and
    // no MCP client, so NanoClaw's `mcp__nanoclaw__*` tools are unreachable
    // from it. Without this the host composes their instruction fragments into
    // this group's project doc, and a small model handed the manual for a tool
    // it cannot call will spend the turn trying to call it.
    lacksMcpTools: true,
  },
);
