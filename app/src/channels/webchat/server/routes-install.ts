// ── Install routes ───────────────────────────────────────────────────────────
// The GET/POST pairs that drive every optional stack's install: the coding-agent
// harnesses (Codex, OpenCode, pi), local models (Ollama) and the speech stacks
// (TTS, STT). Each is the same contract — GET reports status, POST starts the
// job — which is why they come out as one module.
//
// The route TABLE stays in server.ts; only the handlers live here.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { defaultProviderChanges, readDefaultProvider } from './default-provider.js';
import { cancelGrokLogin, getGrokLoginProgress, startGrokLogin } from './grok-auth-flow.js';
import { grokStatus } from './grok-status.js';
import { scheduleHostRestart } from '../ollama-manage.js';
import { upsertEnv } from '../env-write.js';
import { availableProviders, grokAvailable } from './providers.js';
import { hasFeatureInstall, installStatus, startFeatureInstall } from '../install-engine.js';
import type { RouteCtx } from '../server.js';

export async function rOllamaInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return installPost(ctx.res, 'ollama');
}

// ── Feature installs on the engine ──────────────────────────────────────────
// One GET/POST pair for every registered feature: GET is the status, POST starts
// the chain and answers 202 with the status, or 409 with the refusal's code —
// `already-installed`, `already-running`, `skill-missing`, `pnpm-missing`. The
// per-feature paths (/api/codex/install …) are bindings of the same pair; the
// generic /api/install/:feature is the one new clients should use.
export async function installGet(res: ServerResponse, feature: string): Promise<void> {
  if (!hasFeatureInstall(feature)) return json(res, 404, { error: `No install named '${feature}'` });
  return json(res, 200, await installStatus(feature));
}

/**
 * Start `feature` with `args` and answer with the status. A refusal is 409 with
 * the engine's code — except the codes in `badRequest`, which say the CALLER's
 * input was wrong (a malformed token) and are 400.
 */
export async function installPost(
  res: ServerResponse,
  feature: string,
  args?: unknown,
  badRequest: string[] = [],
): Promise<void> {
  if (!hasFeatureInstall(feature)) return json(res, 404, { error: `No install named '${feature}'` });
  const r = await startFeatureInstall(feature, process.cwd(), args);
  if (!r.started) return json(res, badRequest.includes(r.code) ? 400 : 409, { error: r.error, code: r.code });
  return json(res, 202, { ...(await installStatus(feature)), started: true });
}

export async function rInstallGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  return installGet(ctx.res, m[1]);
}

export async function rInstallPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  return installPost(ctx.res, m[1]);
}

const bound = (feature: string) => ({
  get: async (ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> => installGet(ctx.res, feature),
  post: async (ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> => installPost(ctx.res, feature),
});
export const { get: rCodexInstallGet, post: rCodexInstallPost } = bound('codex');
export const { get: rGrokInstallGet, post: rGrokInstallPost } = bound('grok');
export const { get: rOpencodeInstallGet, post: rOpencodeInstallPost } = bound('opencode');
export const { get: rPiInstallGet, post: rPiInstallPost } = bound('pi');

export const { get: rWebchatTtsInstallGet, post: rWebchatTtsInstallPost } = bound('tts');

export async function rWebchatSttInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return installGet(ctx.res, 'stt');
}

export async function rWebchatSttInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { provider?: unknown; model?: unknown; apiKey?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  return installPost(res, 'stt', {
    provider: body.provider === 'elevenlabs' ? 'elevenlabs' : 'local',
    model: typeof body.model === 'string' ? body.model : undefined,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
  });
}

/**
 * Grok device login — the same GET-reports / POST-starts contract as the
 * installs above, with one extra verb: a login can be abandoned, and the
 * container behind it must not outlive the operator's interest in it.
 */
export async function rGrokLoginGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, { ...getGrokLoginProgress(), installed: grokAvailable() });
}

export async function rGrokLoginPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const verb = m[1];
  if (verb === 'cancel') return json(res, 200, { ...cancelGrokLogin(), ...getGrokLoginProgress() });

  const r = startGrokLogin();
  if (r.error === 'not-installed')
    return json(res, 409, {
      error: 'The Grok provider is not installed — run /add-grok, then rebuild the agent image.',
      code: 'not-installed',
    });
  if (r.error === 'already-running')
    // Not an error worth surfacing as one: another tab already started it, and
    // the progress body tells this client everything it needs to render.
    return json(res, 200, { ...getGrokLoginProgress(), started: false });
  return json(res, 202, { ...getGrokLoginProgress(), started: true });
}

/**
 * The install-wide default provider for NEW agents — what the wizard's engine
 * choice should actually mean beyond its own create step.
 */
export async function rWorkspaceProviderGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, { provider: readDefaultProvider(), available: availableProviders() });
}

export async function rWorkspaceProviderPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { provider?: unknown };
  try {
    body = JSON.parse(raw) as { provider?: unknown };
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const provider = String(body.provider ?? '').toLowerCase();
  // 'claude' is always valid — it is the built-in default and the way back.
  const allowed = new Set(['claude', ...availableProviders()]);
  if (!allowed.has(provider)) return json(res, 400, { error: `provider must be one of: ${[...allowed].join(', ')}` });

  // A default nobody can authenticate is worse than no default: every new agent
  // would fail at its first message. Selecting an engine is not enough — the
  // credential has to actually be connected.
  if (provider === 'grok' && !grokStatus().connected)
    return json(res, 409, {
      error: 'Grok is not connected — finish the sign-in before making it the default.',
      code: 'not-connected',
    });

  const changed = defaultProviderChanges(provider);
  if (!changed) return json(res, 200, { provider, changed: false, restarting: false });

  upsertEnv(process.cwd(), 'DEFAULT_AGENT_PROVIDER', provider);
  // config.ts caches this in a const at import, so the running host cannot see
  // the new value — restart, exactly as the Codex/OpenCode installs do. Only on
  // a real change, so finishing the wizard on the current default is free.
  scheduleHostRestart();
  return json(res, 200, { provider, changed: true, restarting: true });
}
