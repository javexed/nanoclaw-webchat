/**
 * Per-model harness settings for local models.
 *
 * WHY THIS EXISTS. Two models of the SAME family, with the same declared
 * capabilities, the same context window and the same quantisation, behaved
 * completely differently in the same harness: qwen3.5:4b reached for a shell to
 * answer "what is 2 + 2" and looped on its delivery tool, while ornith-1.5:9b
 * answered in text and never touched a tool it did not need. Ollama exposes no
 * flag for that difference. The only metadata separating them is parameter
 * count, so anything finer has to be stated or measured, not inferred.
 *
 * Resolution order, first hit wins:
 *   1. an exact entry in PROFILES, keyed by model id
 *   2. a cached probe result for that model (see model-probe.ts)
 *   3. DEFAULT_PROFILE
 *
 * Only the timeout is derived from metadata, because parameter count genuinely
 * predicts latency and being wrong costs a longer wait rather than a wrong
 * harness. Everything else is declared or probed.
 */

/** What the harness needs to decide before it spawns a local-model agent. */
export interface ModelProfile {
  /** `--tools` allowlist for pi, or 'none'. Absent = harness default. */
  tools?: string;
  /** `--thinking` level. Absent = harness default. */
  thinking?: string;
  /**
   * Register the `message` delivery tool. Worth it for a model that invents
   * one; dead weight for a model that just replies in text, and it gives a
   * poorly-disciplined model one more thing to loop on.
   */
  messageTool?: boolean;
  /** How long one turn may take. Derived from size when not stated. */
  turnTimeoutMs?: number;
  /**
   * Consecutive identical tool calls tolerated before the turn is cut short.
   * Lower for a model that loops: qwen3.5:4b emitted five identical `message`
   * calls where the default of 3 let two duplicates through first.
   */
  noopCapThreshold?: number;
  /** Free text for whoever reads this table next. */
  notes?: string;
}

/**
 * The safe default: tools on, because turning them OFF was measured and is far
 * worse — a toolless qwen3.5:4b took 263s to answer "what is 2 + 2" against
 * 21-38s with tools, and timed out every eval run. Small local models are not
 * made safer by taking their tools away.
 */
export const DEFAULT_PROFILE: Readonly<ModelProfile> = Object.freeze({
  tools: 'read,write,edit,bash,message',
  thinking: 'high',
  messageTool: true,
  notes: 'Harness default. Nothing measured for this model.',
});

/**
 * Measured entries. Add a row only with evidence behind it — this table is
 * meant to record what was observed, not what someone assumed.
 *
 * KEYS ARE BARE MODEL IDS — `qwen3.5:4b`, not `ollama/qwen3.5:4b`. The caller
 * strips the provider prefix before resolving (that is what reaches the model
 * server, and what PI_MODEL shows). Keyed with the prefix, every lookup misses
 * SILENTLY: the resolver falls through to the default, the timeout collapses to
 * the floor, and nothing logs a word. Shipped that way once and the live
 * container came up with a 120s budget and no cap.
 *
 * Rows carry an explicit turnTimeoutMs because parameter size is not available
 * at spawn — it needs a round trip to the model server, which the spawn path
 * does not take. The derived value is noted beside each so the two stay legible
 * together.
 */
export const PROFILES: Readonly<Record<string, ModelProfile>> = Object.freeze({
  // Measured 2026-08-23, same six cases, same code, one sweep.
  //
  // Note what the rows do NOT say. None of them changes `tools` or `thinking`,
  // because nothing in the sweep justified changing either — the differences
  // between these models were handled by the always-on invariants and by the
  // derived timeout, not by per-model switches. Resist filling these in from
  // intuition; an unmeasured row is worse than no row, because it looks
  // authoritative.
  'llama3.2:3b': {
    // 3/6. Perfect tool discipline (3/3 on the plain question, never reached
    // for a shell, zero tool sends) and simply not capable of the file work:
    // one partial write, then two runs where it did nothing at all. Discipline
    // and capability are separate axes — this model has the first without the
    // second, which is why parameter count alone cannot pick a harness.
    noopCapThreshold: 3,
    turnTimeoutMs: 180_000, // deriveTurnTimeoutMs(3.2)
    notes: '3/6 sweep. Chat-capable, not file-capable. No looping observed.',
  },
  'qwen3.5:4b': {
    // 5/6, up from 3/6 before duplicate-suppression existed. Capable at file
    // work, poor discipline when answering: it loops on whatever delivery
    // affordance it has. This sweep it emitted five identical `message` calls
    // — the cap fired once and two duplicates were dropped before reaching
    // anyone. Tighter cap because it is the one model observed to loop.
    noopCapThreshold: 2,
    turnTimeoutMs: 220_000, // deriveTurnTimeoutMs(4.7)
    notes: '5/6 sweep (was 3/6 pre-dedupe). Loops on the delivery tool; cap fired.',
  },
  'ornith-1.5:9b': {
    // 5/6. Capable and disciplined; the single failure was writing the answer
    // to /tmp/answer.txt instead of replying, once in three runs. Delivers
    // almost entirely as prose — one tool send across six runs — which means
    // lenientOutput is load-bearing for it.
    noopCapThreshold: 3,
    turnTimeoutMs: 335_000, // deriveTurnTimeoutMs(9.0)
    notes: '5/6 sweep. Capable + disciplined. Delivers as prose; needs lenientOutput.',
  },
});

/**
 * Turn budget from parameter count, fitted to a three-model sweep rather than
 * to taste. Slowest observed turn per model, same six cases:
 *
 *   llama3.2:3b     3.2B    90s
 *   qwen3.5:4b      4.7B   144s
 *   ornith-1.5:9b   9.0B   168s
 *
 * Note how weakly it scales — nearly 3x the parameters for under 2x the time.
 * An earlier linear guess (30s per billion) overshot to 660s at 9B, which is
 * not a backstop, it is a licence to loop for eleven minutes. The fit through
 * those points is about 13.4s per billion over a 47s floor; doubled, that
 * leaves roughly 2x headroom over anything actually measured.
 *
 * Generous on purpose all the same: a turn cut off early reads as a capability
 * failure and sends someone chasing the wrong bug.
 */
export function deriveTurnTimeoutMs(parameterSizeB: number | null): number {
  const FLOOR_MS = 120_000;
  const CEILING_MS = 900_000;
  if (parameterSizeB === null || !Number.isFinite(parameterSizeB) || parameterSizeB <= 0) return FLOOR_MS;
  const estimate = Math.round((13_400 * parameterSizeB + 47_000) * 2);
  return Math.min(CEILING_MS, Math.max(FLOOR_MS, estimate));
}

/**
 * Ollama reports parameter size as a display string ("4.7B", "9.0B", "1.5b").
 * Returns null for anything unparseable rather than guessing a number, so the
 * caller falls back to the floor instead of inventing a budget.
 */
export function parseParameterSize(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*([\d.]+)\s*([BM])\s*$/i.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return m[2]!.toUpperCase() === 'M' ? value / 1000 : value;
}

/** A probe result cached on disk, shaped like the table's own entries. */
export interface CachedProfile extends ModelProfile {
  /** Model id this was measured for. */
  model: string;
  /** ISO-8601 UTC. Lets a reader judge whether it predates a model update. */
  measuredAt: string;
  /**
   * Whatever Ollama reported as `details.parameter_size` when this was cached,
   * so a later spawn can derive a timeout without another metadata round trip.
   * Null when it was never available.
   */
  parameterSizeRaw?: string | null;
}

export interface ResolveInput {
  model: string;
  /** Raw `details.parameter_size` from Ollama, when available. */
  parameterSize?: string | null;
  /** Cached probe results, keyed by model id. */
  cache?: Record<string, CachedProfile>;
  /**
   * The declared table. Defaults to PROFILES; injectable so precedence is
   * testable while the shipped table is still empty, and so an install can
   * supply its own without editing this file.
   */
  table?: Record<string, ModelProfile>;
}

export interface ResolvedProfile extends ModelProfile {
  turnTimeoutMs: number;
  /** Where the settings came from, for logging and for the operator's sanity. */
  source: 'table' | 'probe' | 'default';
}

/**
 * Resolve the harness settings for one model.
 *
 * The table beats the cache on purpose: a hand-written entry is someone's
 * decision, and a probe must never quietly overrule it.
 */
export function resolveModelProfile(input: ResolveInput): ResolvedProfile {
  const table = (input.table ?? PROFILES)[input.model];
  const cached = input.cache?.[input.model];
  const base: ModelProfile = table ?? cached ?? DEFAULT_PROFILE;
  const source: ResolvedProfile['source'] = table ? 'table' : cached ? 'probe' : 'default';
  return {
    ...DEFAULT_PROFILE,
    ...base,
    turnTimeoutMs: base.turnTimeoutMs ?? deriveTurnTimeoutMs(parseParameterSize(input.parameterSize)),
    source,
  };
}
