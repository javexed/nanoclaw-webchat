// ── Install routes ───────────────────────────────────────────────────────────
// The GET/POST pairs that drive every optional stack's install: the coding-agent
// harnesses (Codex, OpenCode, pi), local models (Ollama) and the speech stacks
// (TTS, STT). Each is the same contract — GET reports status, POST starts the
// job — which is why they come out as one module.
//
// The route TABLE stays in server.ts; only the handlers live here.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { codexAvailable, opencodeAvailable, piAvailable } from './providers.js';
import {
  getCodexInstallProgress,
  getOpencodeInstallProgress,
  getPiInstallProgress,
  getSttInstallState,
  getTtsInstallState,
  startCodexInstall,
  startOllamaInstall,
  startOpencodeInstall,
  startPiInstall,
  startSttInstall,
  startTtsInstall,
} from '../ollama-manage.js';
import type { RouteCtx } from '../server.js';

export async function rOllamaInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const result = startOllamaInstall();
  return json(res, result.started ? 200 : 409, result);
}

export async function rCodexInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, { ...getCodexInstallProgress(), installed: codexAvailable() });
}

export async function rCodexInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  if (codexAvailable()) return json(res, 409, { error: 'Codex is already installed', code: 'already-installed' });
  const r = startCodexInstall();
  if (r.error === 'skill-missing')
    return json(res, 409, { error: 'The add-codex skill is not present in this checkout.', code: 'skill-missing' });
  return json(res, r.started ? 202 : 409, {
    ...getCodexInstallProgress(),
    installed: codexAvailable(),
    started: r.started,
  });
}

export async function rOpencodeInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, { ...getOpencodeInstallProgress(), installed: opencodeAvailable() });
}

export async function rOpencodeInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  if (opencodeAvailable()) return json(res, 409, { error: 'OpenCode is already installed', code: 'already-installed' });
  const r = startOpencodeInstall();
  if (r.error === 'skill-missing')
    return json(res, 409, {
      error: 'The add-opencode-stack skill is not present in this checkout.',
      code: 'skill-missing',
    });
  return json(res, r.started ? 202 : 409, {
    ...getOpencodeInstallProgress(),
    installed: opencodeAvailable(),
    started: r.started,
  });
}

// pi harness install — same two-phase (build → restart) contract as OpenCode.
export async function rPiInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, { ...getPiInstallProgress(), installed: piAvailable() });
}

export async function rPiInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  if (piAvailable()) return json(res, 409, { error: 'pi is already installed', code: 'already-installed' });
  const r = startPiInstall();
  if (r.error === 'skill-missing')
    return json(res, 409, {
      error: 'The add-pi-stack skill is not present in this checkout.',
      code: 'skill-missing',
    });
  return json(res, r.started ? 202 : 409, {
    ...getPiInstallProgress(),
    installed: piAvailable(),
    started: r.started,
  });
}

export async function rWebchatTtsInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, await getTtsInstallState());
}

export async function rWebchatTtsInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const r = startTtsInstall();
  if (!r.started && r.error === 'installer-missing') {
    return json(res, 409, { error: 'The /add-webchat-tts installer is missing from this checkout.' });
  }
  return json(res, r.started ? 202 : 409, { ...(await getTtsInstallState()), started: r.started });
}

export async function rWebchatSttInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, getSttInstallState());
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
  const provider = body.provider === 'elevenlabs' ? 'elevenlabs' : 'local';
  const r = startSttInstall({
    provider,
    model: typeof body.model === 'string' ? body.model : undefined,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
  });
  if (!r.started) {
    const msg =
      r.error === 'installer-missing'
        ? 'The add-webchat-dictation installer is missing from this checkout.'
        : r.error === 'missing-key'
          ? 'An ElevenLabs API key is required.'
          : r.error === 'bad-model'
            ? 'Unknown model.'
            : 'An install is already running.';
    return json(res, 409, { error: msg });
  }
  return json(res, 202, { ...getSttInstallState(), started: true });
}
