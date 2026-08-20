/**
 * Approval pre-judge (fork-owned) — an OPTIONAL LLM triage tier in front of
 * human approvals.
 *
 * When an approval hold is created, `maybePrejudgeApproval` (called from
 * `requestApproval`, see primitive.ts) can consult a locally-hosted roster
 * model (webchat_models) with a strict rubric: is this specific request
 * routine, low-stakes, and reversible? On a clean `approve` verdict the
 * approval is resolved through the EXACT same dispatch path a human Approve
 * click takes (response-handler's `resolveApprovalAsApproved`), the agent is
 * notified with an "Auto-approved (pre-judge)" marker, and an audit line is
 * logged. On ANYTHING else — model off, action not opted in, never-list hit,
 * timeout, non-200, unparseable output, or a non-approve verdict — the flow
 * falls through to normal human delivery, exactly as today.
 *
 * Conservative by construction:
 *   - OFF twice over by default: no model configured AND an empty opt-in
 *     action list. Both must be set (owner-only webchat API) before anything
 *     is pre-judged.
 *   - There is NO auto-deny. The model can only approve or escalate; deny
 *     stays human-only (a wrong auto-deny is worse than a wait).
 *   - A hardcoded never-list overrides the opt-in list — privilege,
 *     credential, and supply-chain changes always reach a human.
 *   - Every failure mode escalates. A broken model costs a wait, never an
 *     unattended action.
 *   - Per-request verdicts only — no caching.
 *
 * Docs: docs/webchat/approval-prejudge.md
 */
import {
  getApprovalPrejudgeActions,
  getApprovalPrejudgeModelId,
  getApprovalTriage,
  getWebchatModel,
  storeApprovalTriage,
  type WebchatModel,
} from '../../channels/webchat/db.js';
import { anthropicMessagesViaOneCLI, type AnthropicMessagesCall } from '../../channels/webchat/drafter.js';
import { safeFetch } from '../../channels/webchat/models.js';
import { redactSensitiveData } from '../../channels/webchat/redact.js';
import { getPendingApproval } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import { notifyAgent } from './primitive.js';
import { resolveApprovalAsApproved } from './response-handler.js';

// Short timeout: the pre-judge runs inline in requestApproval, so a slow
// model delays card delivery for everyone. A local model that can't answer
// in 10s isn't fit for triage — escalate.
export const PREJUDGE_TIMEOUT_MS = 10_000;

// Output cap for the anthropic-kind judge call — the verdict JSON is one
// short line, so a small budget keeps the (proxied) call fast and cheap.
export const PREJUDGE_ANTHROPIC_MAX_TOKENS = 256;

const MAX_PAYLOAD_CHARS = 2000;
const MAX_QUESTION_CHARS = 1000;
const MAX_REASON_CHARS = 300;

// ── Never-list ──
// Overrides the opt-in list. Actions and payload shapes that must ALWAYS
// reach a human, no matter what the owner opted in:
//   - onecli_credential  — credential use; also resolved via a different
//     (in-memory promise) path that this dispatcher cannot drive.
//   - install_packages   — supply chain: new code baked into the image.
//   - add_mcp_server     — new tool/capability surface for the agent.
// Payload patterns (matched against the RAW payload JSON, any action):
//   - cli_scope changes  — container privilege level.
//   - roles grant/revoke — user privilege.
//   - groups config verbs — container config (packages, MCP servers).
export const NEVER_AUTO_APPROVE_ACTIONS: ReadonlySet<string> = new Set([
  'onecli_credential',
  'install_packages',
  'add_mcp_server',
]);

export const NEVER_AUTO_APPROVE_PATTERNS: readonly RegExp[] = [
  /\bcli_scope\b/i,
  /\broles\s+(grant|revoke)\b/i,
  /\bconfig\s+(update|add-mcp-server|remove-mcp-server|add-package|remove-package)\b/i,
];

export function isNeverAutoApprovable(action: string, payloadJson: string): boolean {
  if (NEVER_AUTO_APPROVE_ACTIONS.has(action)) return true;
  return NEVER_AUTO_APPROVE_PATTERNS.some((re) => re.test(payloadJson));
}

// ── Triage flags ──
//
// A CLOSED vocabulary of checkable claims ABOUT the request — deliberately not
// a self-assessment. This design already refuses to let the model withhold a
// human review (there is no auto-deny, see the header); a "risk: low /
// confidence: 0.92" chip would ask the approver to trust that same model to
// REASSURE them instead, with no fail-safe behind it. Self-reported confidence
// is also poorly calibrated — especially in the small local models this feature
// targets — and a precise-looking number invites clicking through the one card
// whose entire purpose is to make a human look.
//
// A claim like "touches credentials" is different in kind: the payload renders
// directly beneath it, so a wrong claim is visibly wrong. Wrong claims are
// self-correcting; a wrong confidence score is not.
//
// CLOSED because these land in stored rows and are compared across requests.
// Values outside the vocabulary are DROPPED, never rendered — a model inventing
// a confident-sounding category is precisely what must not reach the card.
export const TRIAGE_FLAGS = [
  'credentials', // reads, writes, or rotates a secret
  'permissions', // changes a role, scope, or access grant
  'install', // adds or changes software / dependencies
  'capability', // grants the agent a new tool or endpoint
  'destructive', // deletes or overwrites data
  'irreversible', // cannot be undone by a later action
  'outbound', // sends data off-box
  'bulk', // affects many objects or users at once
] as const;
export type TriageFlag = (typeof TRIAGE_FLAGS)[number];
const TRIAGE_FLAG_SET: ReadonlySet<string> = new Set(TRIAGE_FLAGS);

/**
 * Which tier produced this result. Meaningful here precisely because the
 * judgment completes BEFORE the card exists, so a card cannot stream a verdict
 * in the way a live-grading UI would.
 *
 *   unscreened  — no judgment was made (feature off, action not opted in, or
 *                 the approval targets a named approver). Rendered EXPLICITLY:
 *                 once chips exist, an absence of chips must never be read as
 *                 "screened, nothing found".
 *   heuristic   — the deterministic never-list decided; no model was consulted.
 *   model       — the triage model was consulted.
 *   unavailable — screening was wanted but could not run (model missing or
 *                 erroring). Also distinct from "screened and clean".
 */
export type TriageTier = 'unscreened' | 'heuristic' | 'model' | 'unavailable';

/**
 * Flags derivable WITHOUT a model, straight from the never-list that already
 * governs this request. Always trustworthy and always computed — so even an
 * unscreened card still shows what the never-list knows about it.
 *
 * Kept in step with NEVER_AUTO_APPROVE_* above: every entry there maps to a
 * flag here, and a test asserts the two never drift apart.
 */
export function heuristicFlags(action: string, payloadJson: string): TriageFlag[] {
  const out = new Set<TriageFlag>();
  if (action === 'onecli_credential') out.add('credentials');
  if (action === 'install_packages') out.add('install');
  if (action === 'add_mcp_server') out.add('capability');
  if (/\bcli_scope\b/i.test(payloadJson)) out.add('permissions');
  if (/\broles\s+(grant|revoke)\b/i.test(payloadJson)) out.add('permissions');
  if (/\bconfig\s+(add|remove)-package\b/i.test(payloadJson)) out.add('install');
  if (/\bconfig\s+(add|remove)-mcp-server\b/i.test(payloadJson)) out.add('capability');
  if (/\bconfig\s+update\b/i.test(payloadJson)) out.add('capability');
  return [...out];
}

/** Validate model-proposed flags against the closed vocabulary. */
export function parseFlags(raw: unknown): TriageFlag[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<TriageFlag>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toLowerCase();
    if (TRIAGE_FLAG_SET.has(key)) out.add(key as TriageFlag);
  }
  return [...out];
}

// ── Prompt redaction ──
// Reuse the webchat redaction layer (redact.ts) and supplement the few
// agent-runner redactSecrets patterns it lacks (container/agent-runner/src/
// formatter.ts): bare Bearer tokens, OneCLI proxy tokens, MCP relay tokens.
const SUPPLEMENT_PATTERNS: readonly RegExp[] = [
  /\b(aoc_[A-Za-z0-9]{8,})/g, // OneCLI proxy tokens
  /\b(mcr_[A-Za-z0-9]{8,})/g, // MCP relay tokens
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
];

export function redactForPrompt(text: string): string {
  let out = redactSensitiveData(text);
  for (const re of SUPPLEMENT_PATTERNS) {
    out = out.replace(re, (_m, prefix: string) =>
      typeof prefix === 'string' && /^Bearer\s+$/i.test(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  return out;
}

// ── Rubric ──
// The system prompt sent to the triage model. Deliberately biased toward
// escalation: approve is only allowed for clearly routine, reversible
// requests, and the model is told it cannot reject anything.
export const PREJUDGE_RUBRIC = [
  'You are a pre-approval triage assistant for a personal automation system.',
  'An agent requested a privileged action that is normally held for a human approver.',
  'Your ONLY decision: is this specific request routine, low-stakes, and easily reversible?',
  '',
  'Rules:',
  '- If the action could change permissions, roles, credentials, installed software, or system configuration, respond escalate.',
  '- If the request is destructive, irreversible, unusual, ambiguous, or you are unsure for ANY reason, respond escalate.',
  '- Respond approve ONLY when the request is clearly routine and easily reversible.',
  '- You cannot reject a request. A human reviews everything you do not approve, so escalate is always safe.',
  '',
  // Flags describe the REQUEST, they do not grade your own certainty. Do not
  // ask this model for a risk level or a confidence score — see TRIAGE_FLAGS.
  'Also label what the request touches, using ONLY these words:',
  '  credentials  — reads, writes, or rotates a secret',
  '  permissions  — changes a role, scope, or access grant',
  '  install      — adds or changes software or dependencies',
  '  capability   — grants the agent a new tool or endpoint',
  '  destructive  — deletes or overwrites data',
  '  irreversible — cannot be undone by a later action',
  '  outbound     — sends data off this machine',
  '  bulk         — affects many objects or users at once',
  'Use only words from that list, only when they clearly apply, and [] when none do.',
  'These describe the request itself — a human checks them against the payload, so do not guess.',
  '',
  'Respond with ONLY a JSON object — no prose, no code fences:',
  '{"verdict":"approve"|"escalate","reason":"<one short sentence>","flags":["<word>",…],"reversible":"yes"|"no"|"unknown"}',
].join('\n');

// ── Core ──

export interface PrejudgeResult {
  verdict: 'approve' | 'escalate';
  reason: string;
  /** Which tier decided — drives how the card explains why it is asking. */
  tier: TriageTier;
  /** Model-proposed claims, validated against the closed vocabulary. */
  flags: TriageFlag[];
  /**
   * Deterministic claims from the never-list. Kept SEPARATE from `flags` on
   * purpose: the card shows both, and a disagreement (the never-list flagged
   * `credentials`, the model did not mention it) is itself information the
   * approver can act on.
   */
  heuristic: TriageFlag[];
  reversible: 'yes' | 'no' | 'unknown';
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Model-kind gate — the single definition of "usable as a judge", shared by
 * the runtime path below and the webchat PUT validation (server.ts), so the
 * two can never drift:
 *   - `anthropic` kind: endpoint is NULL by design — the call routes through
 *     the OneCLI gateway (same credentialed path as the webchat drafter).
 *   - `ollama` / `openai-compatible`: need a reachable endpoint.
 */
export function isUsableJudgeModel(model: WebchatModel | undefined): model is WebchatModel {
  if (!model) return false;
  if (model.kind === 'anthropic') return true;
  return !!model.endpoint && (model.kind === 'ollama' || model.kind === 'openai-compatible');
}

/** Injectable seams for tests. Defaults are the real config/roster/fetch. */
export interface PrejudgeDeps {
  fetchFn?: FetchLike;
  /** Anthropic Messages call via the OneCLI proxy (anthropic-kind judges). */
  anthropicFn?: (call: AnthropicMessagesCall) => Promise<string>;
  getModelId?: () => string | null;
  getActions?: () => string[];
  getModel?: (id: string) => WebchatModel | undefined;
}

const escalate = (reason: string, tier: TriageTier = 'model', extra: Partial<PrejudgeResult> = {}): PrejudgeResult => ({
  verdict: 'escalate',
  reason,
  tier,
  flags: [],
  heuristic: [],
  reversible: 'unknown',
  ...extra,
});

/**
 * Parse the model's output into a verdict. Strict: after stripping an
 * optional single code fence, the content must be a JSON object whose
 * `verdict` is exactly `"approve"` — anything else (including `"deny"`,
 * `"reject"`, prose, truncation) escalates.
 *
 * Flags and reversibility are parsed SEPARATELY and defensively, after the
 * verdict is already decided. That ordering is deliberate: describing a request
 * must never be able to change the decision about it, so a garbage `flags`
 * value costs the card some chips and nothing else.
 */
export function parseVerdict(content: string): PrejudgeResult {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return escalate('unparseable model output');
  }
  if (typeof parsed !== 'object' || parsed === null) return escalate('unparseable model output');
  const record = parsed as Record<string, unknown>;
  const reason =
    typeof record.reason === 'string' && record.reason.trim()
      ? redactForPrompt(record.reason.trim().slice(0, MAX_REASON_CHARS))
      : '';
  const flags = parseFlags(record.flags);
  const reversible =
    record.reversible === 'yes' || record.reversible === 'no' ? record.reversible : ('unknown' as const);
  if (record.verdict === 'approve') {
    return {
      verdict: 'approve',
      reason: reason || 'model judged the request routine and reversible',
      tier: 'model',
      flags,
      heuristic: [],
      reversible,
    };
  }
  return escalate(reason || 'model did not approve', 'model', { flags, reversible });
}

/**
 * Consult the configured triage model about one approval. Never throws; every
 * failure mode returns `{ verdict: 'escalate' }`. `question` is the human-
 * readable card body from requestApproval (not persisted on the row).
 */
export async function prejudgeApproval(
  approval: PendingApproval,
  question?: string,
  deps: PrejudgeDeps = {},
): Promise<PrejudgeResult> {
  // Deterministic and model-free, so it rides along on EVERY outcome below —
  // an unscreened card still shows what the never-list knows about the request.
  const heuristic = heuristicFlags(approval.action, approval.payload);
  const withHeuristic = (reason: string, tier: TriageTier) => escalate(reason, tier, { heuristic });

  const modelId = await (deps.getModelId ?? getApprovalPrejudgeModelId)();
  if (!modelId) return withHeuristic('pre-judge is not configured (no model)', 'unscreened');
  const actions = await (deps.getActions ?? getApprovalPrejudgeActions)();
  if (!actions.includes(approval.action)) return withHeuristic('action is not opted in to pre-judge', 'unscreened');
  // A targeted approval names its approver deliberately — never intercept.
  if (approval.approver_user_id) return withHeuristic('approval targets a specific approver', 'unscreened');
  if (isNeverAutoApprovable(approval.action, approval.payload)) {
    return withHeuristic('action matches the never-auto-approve list', 'heuristic');
  }
  const model = await (deps.getModel ?? getWebchatModel)(modelId);
  if (!isUsableJudgeModel(model)) {
    return withHeuristic('configured pre-judge model is unavailable', 'unavailable');
  }

  const lines = [
    `Action: ${approval.action}`,
    `Title: ${redactForPrompt(approval.title)}`,
    question ? `Request: ${redactForPrompt(question.slice(0, MAX_QUESTION_CHARS))}` : null,
    `Payload: ${redactForPrompt(approval.payload.slice(0, MAX_PAYLOAD_CHARS))}`,
  ].filter((l): l is string => l !== null);

  try {
    if (model.kind === 'anthropic') {
      // Claude judge — the same OneCLI-proxied Messages call the webchat
      // drafter makes (drafter.ts): the host never holds a raw Anthropic
      // key. No temperature: current Claude models (Sonnet 5, Opus 4.7+)
      // reject non-default sampling params with a 400, which would turn
      // every consult into an escalation. Same timeout, same strict
      // verdict parsing, same fail-safes — any throw escalates below.
      const anthropicFn = deps.anthropicFn ?? anthropicMessagesViaOneCLI;
      const content = (
        await anthropicFn({
          model: model.model_id,
          system: PREJUDGE_RUBRIC,
          user: lines.join('\n'),
          maxTokens: PREJUDGE_ANTHROPIC_MAX_TOKENS,
          timeoutMs: PREJUDGE_TIMEOUT_MS,
        })
      ).trim();
      if (!content) return withHeuristic('empty model response', 'unavailable');
      return { ...parseVerdict(content), heuristic };
    }

    const fetchFn = deps.fetchFn ?? safeFetch;
    // Non-anthropic kinds passed isUsableJudgeModel, which requires an
    // endpoint for them — the assertion is guaranteed by the gate above.
    const res = await fetchFn(`${model.endpoint!.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.model_id,
        temperature: 0,
        messages: [
          { role: 'system', content: PREJUDGE_RUBRIC },
          { role: 'user', content: lines.join('\n') },
        ],
      }),
      signal: AbortSignal.timeout(PREJUDGE_TIMEOUT_MS),
    });
    if (!res.ok) return withHeuristic(`model returned ${res.status}`, 'unavailable');
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) return withHeuristic('empty model response', 'unavailable');
    return { ...parseVerdict(content), heuristic };
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-safe contract: any error (timeout, network, JSON body) must escalate to a human, never propagate
  } catch (err) {
    return withHeuristic(`model call failed: ${err instanceof Error ? err.message : String(err)}`, 'unavailable');
  }
}

/** Extra injectable seams for the short-circuit wiring (tests). */
export interface MaybePrejudgeDeps extends PrejudgeDeps {
  /** Persist the triage record the card reads. Injectable for tests. */
  storeTriage?: (approvalId: string, triage: Parameters<typeof storeApprovalTriage>[1]) => void;
  getApproval?: (approvalId: string) => PendingApproval | undefined;
  resolve?: (approval: PendingApproval, userId: string) => Promise<void>;
  notify?: (session: Session, text: string) => void;
}

/**
 * The requestApproval hook. Returns `true` when the approval was auto-
 * approved and fully resolved (caller must skip card delivery), `false` in
 * every other case (caller proceeds exactly as today). Never throws.
 */
export async function maybePrejudgeApproval(
  approvalId: string,
  session: Session,
  question?: string,
  deps: MaybePrejudgeDeps = {},
): Promise<boolean> {
  try {
    const modelId = await (deps.getModelId ?? getApprovalPrejudgeModelId)();
    if (!modelId) return false; // feature off — zero overhead, no logging
    const approval = await (deps.getApproval ?? getPendingApproval)(approvalId);
    if (!approval) return false;
    const actions = await (deps.getActions ?? getApprovalPrejudgeActions)();
    if (!actions.includes(approval.action)) return false; // not opted in — silent

    const result = await prejudgeApproval(approval, question, deps);
    if (result.verdict !== 'approve') {
      // The reason used to live only in this log line. It is the single most
      // useful thing the approver could know — why this is in front of them —
      // so it is recorded for the card as well. Best-effort: a triage write
      // must never be able to block the approval itself.
      try {
        (deps.storeTriage ?? storeApprovalTriage)(approvalId, {
          tier: result.tier,
          reason: result.reason,
          flags: result.flags,
          heuristicFlags: result.heuristic,
          reversible: result.reversible,
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- description must never break delivery
      } catch (err) {
        log.error('Approval triage record failed (card will omit it)', { approvalId, err });
      }
      log.info('Approval pre-judge escalated to human', {
        action: approval.action,
        approvalId,
        model: modelId,
        reason: result.reason,
        tier: result.tier,
        flags: result.flags,
      });
      return false;
    }

    // Audit line FIRST, then the agent-visible marker, then the same dispatch
    // a human Approve takes (claim → handler → resolved-callbacks → wake).
    log.info('Approval auto-approved (pre-judge)', {
      action: approval.action,
      approvalId,
      model: modelId,
      reason: result.reason,
    });
    (deps.notify ?? notifyAgent)(session, `Auto-approved (pre-judge): ${result.reason}`);
    await (deps.resolve ?? resolveApprovalAsApproved)(approval, `prejudge:${modelId}`);
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-safe contract: a pre-judge crash must fall through to normal human delivery
  } catch (err) {
    log.error('Approval pre-judge failed — falling back to human approval', { approvalId, err });
    return false;
  }
}

// ── Card view ──

/** What an approval card renders about how the request was triaged. */
export interface ApprovalTriageView {
  tier: TriageTier;
  reason: string;
  flags: TriageFlag[];
  heuristic: TriageFlag[];
  reversible: 'yes' | 'no' | 'unknown';
}

/**
 * Assemble the triage a card should show.
 *
 * The heuristic flags are recomputed here rather than read back from the row.
 * They are a pure function of (action, payload), so this is always available —
 * including for an approval raised while the feature was off, or before the
 * feature existed at all. The stored `heuristic_flags` column is kept as an
 * audit record of what the never-list said AT DECISION TIME, which is a
 * different question and can legitimately diverge if the never-list changes.
 *
 * No stored row means no judgment was made: that renders as `unscreened`, which
 * is the honest reading for both a feature-off approval and a legacy one. This
 * is why absence is a valid state rather than a gap to paper over — with chips
 * on the card, "nothing shown" must never be mistaken for "screened, clean".
 */
export async function buildApprovalTriageView(
  approvalId: string,
  action: string,
  payloadJson: string,
  deps: {
    getTriage?: (
      approvalId: string,
    ) => ReturnType<typeof getApprovalTriage> | Awaited<ReturnType<typeof getApprovalTriage>>;
  } = {},
): Promise<ApprovalTriageView> {
  const heuristic = heuristicFlags(action, payloadJson);
  const row = await (deps.getTriage ?? getApprovalTriage)(approvalId);
  if (!row) return { tier: 'unscreened', reason: '', flags: [], heuristic, reversible: 'unknown' };
  return {
    tier: row.tier,
    reason: row.reason,
    flags: parseFlags(row.flags),
    heuristic,
    reversible: row.reversible,
  };
}
