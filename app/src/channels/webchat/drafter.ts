/**
 * Agent drafter — turn a freeform prompt into a suggested
 * { name, instructions } pair for a new agent.
 *
 * A plain host-side HTTP call through the OneCLI gateway, as containers route
 * (OneCLI injects the Anthropic auth), so the host never holds the raw key.
 * Its own OneCLI identifier keeps its proxy slot auditable. Host-side on
 * purpose: no agent SDK in the loop means no tools (e.g. `create_agent`) to lock down.
 */
import fs from 'fs';
import { ProxyAgent } from 'undici';

import { onecliSettings } from '../../onecli-settings.js';
import { log } from '../../log.js';
import { getDefaultModelId, getWebchatModel, type WebchatModel } from './db.js';
import { safeFetch } from './models.js';

// Registered with OneCLI on first draft; must match `[a-z][a-z0-9-]{0,49}`.
const DRAFTER_AGENT_ID = 'webchat-drafter';
const DRAFTER_AGENT_NAME = 'Agent Drafter';

// Fast + cheap is enough for a one-shot JSON definition; env-overridable for
// when this model is deprecated.
const DRAFTER_MODEL = process.env.WEBCHAT_DRAFTER_MODEL || 'claude-haiku-4-5';
const DRAFTER_MAX_TOKENS = 2048;

// Cap response size before JSON.parse, against a misbehaving proxy/upstream;
// 16 KB is far above any honest reply.
const MAX_RESPONSE_BYTES = 16 * 1024;

// Cache the OneCLI-derived transport so repeated drafts don't hit the gateway each time.
const TRANSPORT_CACHE_MS = 5 * 60 * 1000;
// Throttle bootstrap retries when OneCLI is consistently unreachable so
// repeated drafts don't fan out to OneCLI as fast as the user can click.
const BOOTSTRAP_RETRY_BACKOFF_MS = 30 * 1000;

const DRAFTER_SYSTEM_PROMPT = `You are an agent-definition drafter for the NanoClaw assistant platform. Given a description of what the user wants their assistant to do, return ONE JSON object describing it. NOTHING ELSE — no prose, no markdown, no code fences, no explanation.

Schema:
{"name": "<short human-friendly label, ≤ 64 chars>", "instructions": "<plain markdown system prompt, ≤ 1800 chars, written in second person ('You are…'), focused on tone, scope, and behavior>"}

Rules:
- ALWAYS respond, even for thin or unclear input — infer something reasonable.
- Never ask clarifying questions. The caller is a programmatic request.
- "name" should read like a recognizable label — Title Case is fine (e.g., "Code Reviewer", "Recipe Helper").
- "instructions" should read like a CLAUDE.md system prompt: define purpose, tone, and scope. No framing prose like "Here is your assistant:" — just the prompt itself.
- Describe the role, not capability limits. Never state that the assistant cannot access, modify, or connect to a service. If the role involves an external service (calendar, email, an API), say what to do with it, and that access is set up by the operator in the agent's Secrets settings.
- Do NOT include placeholder text like "<your instructions here>".
- Properly escape quotes and newlines inside the JSON string values.
- Output the JSON object now. Begin with { and end with }. No other characters.`;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROMPT_LENGTH = 2000;
const MAX_NAME_LENGTH = 64;
const MAX_INSTRUCTIONS_LENGTH = 2048;

// The OneCLI SDK arrives with the /add-onecli gateway skill, not with trunk.
// Load it on first use, only when OneCLI is the selected gateway, through a
// non-literal specifier — this module must typecheck and load on an install
// that runs a different gateway. Settings come from onecliSettings(), which
// reads .env as well, so a service that does not inherit it still sees them.
interface OneCLIClient {
  ensureAgent(input: { name: string; identifier: string }): Promise<unknown>;
  getContainerConfig(input: {
    agent: string;
  }): Promise<{ env: Record<string, string | undefined>; caCertificate?: string }>;
}
const ONECLI_SDK = '@onecli-sh/sdk';
let clientPromise: Promise<OneCLIClient> | null = null;
function onecliClient(): Promise<OneCLIClient> {
  const { gateway, url, apiKey } = onecliSettings();
  if (gateway !== 'onecli') {
    return Promise.reject(new DraftError(`Drafting needs the OneCLI gateway; this install uses ${gateway}`, 503));
  }
  clientPromise ??= import(ONECLI_SDK)
    .then((m: { OneCLI: new (o: { url: string; apiKey: string }) => OneCLIClient }) => new m.OneCLI({ url, apiKey }))
    .catch((err: unknown) => {
      clientPromise = null;
      log.warn('Webchat drafter: OneCLI SDK unavailable', { err });
      throw new DraftError('OneCLI SDK not installed — run /add-onecli', 503);
    });
  return clientPromise;
}

let bootstrapPromise: Promise<void> | null = null;
let bootstrapNextAttemptAfter = 0; // epoch ms; bootstrap calls before this short-circuit
let requestQueue: Promise<unknown> = Promise.resolve();
// Cached transport — populated by buildDrafterTransport, expires on a
// timer or on a 401 from Anthropic (cache likely stale; rebuild).
interface CachedTransport {
  dispatcher: ProxyAgent;
  authHeaders: Record<string, string>;
  expiresAt: number;
}
let cachedTransport: CachedTransport | null = null;

export class DraftError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface DraftedAgent {
  name: string;
  instructions: string;
}

/**
 * Idempotently register the drafter identifier with OneCLI on first use
 * (callers share the in-flight promise).
 *
 * It must stay in `all` secret mode: nothing assigns it a secret, so in
 * `selective` it would 401. Fresh identifiers default to `all`; if it is ever
 * flipped, `onecli agents set-secret-mode --id webchat-drafter --mode all`
 * restores it. An orphan scan ("identifier not in agent_groups") will flag it:
 * it is live — do not delete it or include it in an `all` → `selective` rollout.
 */
function ensureDrafterIdentity(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  // Throttle: if a recent bootstrap failed, fail fast for the cooldown
  // window instead of fanning out OneCLI calls as the user retries.
  if (Date.now() < bootstrapNextAttemptAfter) {
    return Promise.reject(new DraftError('OneCLI gateway unreachable; retry in a few seconds', 503));
  }
  bootstrapPromise = onecliClient()
    .then((onecli) => onecli.ensureAgent({ name: DRAFTER_AGENT_NAME, identifier: DRAFTER_AGENT_ID }))
    .then(() => {
      log.info('Webchat drafter identity registered with OneCLI', { identifier: DRAFTER_AGENT_ID });
    })
    .catch((err) => {
      bootstrapPromise = null; // allow retry on next call
      bootstrapNextAttemptAfter = Date.now() + BOOTSTRAP_RETRY_BACKOFF_MS;
      throw err;
    });
  return bootstrapPromise;
}

/**
 * Build an undici dispatcher + auth headers for an Anthropic call routed
 * through the OneCLI proxy.
 *
 * `getContainerConfig(identifier)` returns a per-agent proxy URL (an `aoc_*`
 * token in userinfo) and a CA cert. The proxy swaps the placeholder
 * `Authorization: Bearer <CLAUDE_CODE_OAUTH_TOKEN>` for the real token, and
 * needs `anthropic-beta: oauth-2025-04-20` for that path. The proxy host and CA
 * path in the config are container-side, so the host uses ONECLI_URL's host and
 * the inline `cfg.caCertificate`.
 */
async function buildDrafterTransport(): Promise<{
  dispatcher: ProxyAgent;
  authHeaders: Record<string, string>;
}> {
  if (cachedTransport && cachedTransport.expiresAt > Date.now()) {
    return { dispatcher: cachedTransport.dispatcher, authHeaders: cachedTransport.authHeaders };
  }
  const cfg = await (await onecliClient()).getContainerConfig({ agent: DRAFTER_AGENT_ID });
  const rawProxy = cfg.env.HTTPS_PROXY ?? cfg.env.HTTP_PROXY;
  if (!rawProxy) throw new DraftError('OneCLI gateway returned no proxy URL', 503);
  // `host.docker.internal` resolves only inside containers; ONECLI_URL's host is
  // host-reachable by construction (127.0.0.1 on macOS, the bridge IP such as
  // 172.17.0.1 on Linux). replaceAll: the name can recur (e.g. a query param).
  let onecliHost = '127.0.0.1';
  try {
    onecliHost = new URL(onecliSettings().url).hostname || '127.0.0.1';
  } catch {
    // Bad ONECLI_URL — fall through with the loopback default; surface in the
    // proxy attempt that follows so the operator gets a real error.
  }
  const proxyUri = rawProxy.replaceAll('host.docker.internal', onecliHost);

  // Always prefer the inline string — the env path is in-container only.
  // Fall back to reading the path if for some reason caCertificate is empty.
  let ca: Buffer;
  if (cfg.caCertificate) {
    ca = Buffer.from(cfg.caCertificate);
  } else if (cfg.env.NODE_EXTRA_CA_CERTS && fs.existsSync(cfg.env.NODE_EXTRA_CA_CERTS)) {
    ca = fs.readFileSync(cfg.env.NODE_EXTRA_CA_CERTS);
  } else {
    throw new DraftError('OneCLI gateway returned no CA certificate', 503);
  }

  const dispatcher = new ProxyAgent({ uri: proxyUri, requestTls: { ca } });
  const placeholderToken = cfg.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'placeholder';
  const authHeaders: Record<string, string> = {
    authorization: `Bearer ${placeholderToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
  };
  cachedTransport = { dispatcher, authHeaders, expiresAt: Date.now() + TRANSPORT_CACHE_MS };
  return { dispatcher, authHeaders };
}

/** Drop the cached transport — invoked on 401 (likely stale token / mode). */
function invalidateTransportCache(): void {
  cachedTransport = null;
}

export interface AnthropicMessagesCall {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * One Anthropic Messages call through the OneCLI proxy — the shared host-side
 * credentialed path, also used by the approval pre-judge. Reuses the drafter's
 * identity + transport cache; returns the joined text, throws DraftError.
 * No sampling params: current Claude models 400 on a non-default `temperature`.
 */
export async function anthropicMessagesViaOneCLI(call: AnthropicMessagesCall): Promise<string> {
  await ensureDrafterIdentity();
  const { dispatcher, authHeaders } = await buildDrafterTransport();

  const body = {
    model: call.model,
    max_tokens: call.maxTokens,
    system: call.system,
    messages: [{ role: 'user', content: call.user }],
  };

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(call.timeoutMs),
      // Not in the fetch typings but accepted by Node's fetch. Cast via `unknown`:
      // undici's types don't overlap @types/node's undici-types (TS2352).
      dispatcher,
    } as unknown as RequestInit & { dispatcher: ProxyAgent });
  } catch (err) {
    // Full detail (incl. undici's `err.cause`) to the log only; the caller gets
    // a generic message so internal IPs / proxy URLs don't leak.
    const cause = (err as { cause?: unknown }).cause;
    log.warn('Anthropic-via-OneCLI call: fetch threw', { err, cause });
    const e = err as { name?: string; statusCode?: number };
    if (e.name === 'OneCLIRequestError') {
      throw new DraftError('Anthropic call failed (OneCLI gateway error)', e.statusCode || 503);
    }
    throw new DraftError('Anthropic call failed (see server logs)', 503);
  }

  if (res.status === 401) {
    // Stale auth — drop cache so the next attempt rebuilds the transport.
    invalidateTransportCache();
    throw new DraftError(
      'OneCLI rejected the call (401). The webchat-drafter agent must be in `all` secret mode — nothing assigns it a secret, so `selective` leaves it with none. Check with `onecli agents list --max 500` (the list silently caps at 20) and fix with: onecli agents set-secret-mode --id <internal-id> --mode all',
      503,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log.warn('Anthropic-via-OneCLI call: non-OK response', { status: res.status, detail: detail.slice(0, 500) });
    throw new DraftError(`Anthropic upstream returned ${res.status}`, 502);
  }

  // Text first, so the size cap applies before JSON.parse.
  const rawResponseText = await res.text();
  if (rawResponseText.length > MAX_RESPONSE_BYTES) {
    throw new DraftError('Anthropic upstream returned an oversized response', 502);
  }
  let responseBody: { content?: Array<{ type: string; text?: string }> };
  try {
    responseBody = JSON.parse(rawResponseText);
  } catch {
    throw new DraftError('Anthropic upstream returned non-JSON response', 502);
  }
  return (responseBody.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

/**
 * Run a draft request through the queue. Serialized — concurrent callers
 * wait their turn so we don't fan out parallel Anthropic calls under one
 * proxy slot.
 */
export async function draftAgent(prompt: string): Promise<DraftedAgent> {
  const trimmed = (prompt ?? '').trim();
  if (!trimmed) throw new DraftError('Prompt required', 400);
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    throw new DraftError(`Prompt too long (max ${MAX_PROMPT_LENGTH} chars)`, 400);
  }

  // Chain onto the queue, swallowing the previous request's rejection so it
  // doesn't poison subsequent calls.
  const myTurn = requestQueue.then(
    () => runDraft(trimmed),
    () => runDraft(trimmed),
  );
  requestQueue = myTurn.catch(() => undefined);
  return myTurn;
}

async function runDraft(prompt: string): Promise<DraftedAgent> {
  // A local workspace default model (ollama/openai-compatible) drafts through
  // its own endpoint: a local-only install has no Anthropic credential for the
  // OneCLI path. Claude/Codex defaults set no default model and fall through.
  const defaultId = await getDefaultModelId();
  const defaultModel = defaultId ? await getWebchatModel(defaultId) : undefined;
  if (defaultModel?.endpoint && (defaultModel.kind === 'ollama' || defaultModel.kind === 'openai-compatible')) {
    return runDraftViaModel(prompt, defaultModel);
  }

  const text = await anthropicMessagesViaOneCLI({
    model: DRAFTER_MODEL,
    system: DRAFTER_SYSTEM_PROMPT,
    user: prompt,
    maxTokens: DRAFTER_MAX_TOKENS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!text) throw new DraftError('Drafter returned empty content', 502);
  return parseDraftResponse(text);
}

// Long: a thinking model on CPU can take minutes to produce the JSON.
const MODEL_REQUEST_TIMEOUT_MS = 180_000;

/**
 * Draft via the workspace default local model's OpenAI-compatible endpoint (no
 * credential; safeFetch does the host rewrite + SSRF gate). <think> traces are
 * stripped before parsing.
 */
async function runDraftViaModel(prompt: string, model: WebchatModel): Promise<DraftedAgent> {
  let res: Response;
  try {
    res = await safeFetch(`${model.endpoint!.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.model_id,
        max_tokens: DRAFTER_MAX_TOKENS,
        temperature: 0.7,
        messages: [
          { role: 'system', content: DRAFTER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        // Else a thinking model spends the whole budget reasoning and returns
        // empty content. Ollama's OpenAI-compat endpoint honours only this
        // (`think:false` is ignored); non-reasoning models ignore it.
        reasoning_effort: 'none',
      }),
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn('Webchat drafter: model endpoint fetch threw', { err, model: model.model_id });
    throw new DraftError('Drafter call to the local model failed (see server logs)', 503);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log.warn('Webchat drafter: model endpoint non-OK', { status: res.status, detail: detail.slice(0, 300) });
    throw new DraftError(`Drafter model returned ${res.status}`, 502);
  }
  const raw = await res.text();
  if (raw.length > MAX_RESPONSE_BYTES) throw new DraftError('Drafter upstream returned an oversized response', 502);
  let body: { choices?: Array<{ message?: { content?: string } }> };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new DraftError('Drafter upstream returned non-JSON response', 502);
  }
  // Belt-and-suspenders: some backends still inline <think>…</think> in content.
  const text = (body.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!text) throw new DraftError('Drafter returned empty content', 502);
  return parseDraftResponse(text);
}

function parseDraftResponse(rawText: string): DraftedAgent {
  const cleaned = stripCodeFence(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new DraftError('Drafter returned non-JSON response', 502);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DraftError('Drafter response not a JSON object', 502);
  }
  const obj = parsed as { name?: unknown; instructions?: unknown };
  if (typeof obj.name !== 'string' || typeof obj.instructions !== 'string') {
    throw new DraftError('Drafter response missing name or instructions', 502);
  }
  // Instructions keep newlines; names get none, so they can't break logs,
  // flat outputs or URL paths.
  const name = stripControlChars(obj.name, { allowNewlines: false }).trim();
  const instructions = stripControlChars(obj.instructions, { allowNewlines: true }).trim();
  if (!name) throw new DraftError('Drafter returned empty name', 502);
  if (!instructions) throw new DraftError('Drafter returned empty instructions', 502);
  if (name.length > MAX_NAME_LENGTH) {
    throw new DraftError(`Drafter name too long (>${MAX_NAME_LENGTH} chars)`, 502);
  }
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new DraftError(`Drafter instructions too long (>${MAX_INSTRUCTIONS_LENGTH} chars)`, 502);
  }
  return { name, instructions };
}

function stripControlChars(s: string, opts: { allowNewlines: boolean }): string {
  // U+0000-U+001F + DEL; allowNewlines keeps LF and CR.
  // eslint-disable-next-line no-control-regex
  const allControl = /[\x00-\x1f\x7f]/g;
  // eslint-disable-next-line no-control-regex
  const exceptNewlines = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g;
  return s.replace(opts.allowNewlines ? exceptNewlines : allControl, '');
}

function stripCodeFence(s: string): string {
  // Belt-and-suspenders: tolerate the LLM occasionally wrapping output in
  // ```json fences even though the system prompt forbids it.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i;
  const m = s.match(fence);
  return m ? m[1].trim() : s;
}
