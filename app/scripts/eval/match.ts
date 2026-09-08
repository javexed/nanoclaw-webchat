/**
 * Agent-behaviour evals — the matching half.
 *
 * WHAT THIS IS FOR. Nothing here covers agent-level regression. Unit tests
 * cover functions; the browser guards cover the UI; nothing answers "does this
 * agent still reach for rsync instead of scp" or "does a busy turn still
 * trigger a review". Those regressions have reached production repeatedly and
 * been found by a human noticing, which is the slowest detector available.
 *
 * ASSERTION-BASED, NOT LLM-GRADED, deliberately. A judge model would make the
 * result a second thing to debug: a red run could mean the agent regressed or
 * the judge drifted, and telling those apart costs more than the signal is
 * worth. Tool calls are a fact — the runner reads them from the session's own
 * status feed — so a case either matched or it did not.
 *
 * THIS FILE IS PURE ON PURPOSE. Running a case needs a live install with
 * containers and credentials, which CI does not have; comparing observed calls
 * against expected ones needs nothing. Splitting them means the rules that
 * decide pass or fail are themselves covered by ordinary unit tests, and only
 * the transport is untestable.
 */

/** One tool call as the status feed recorded it: the verb and its target. */
export interface ObservedCall {
  /** Tool name, verbatim from the provider (`Bash`, `write`, …). */
  tool: string;
  /** Summarised target — a path, a command — or null when the tool had none. */
  target: string | null;
}

/**
 * One expectation. `target` demands an exact string; `targetPattern` is a
 * regex source for the common case where a path is stable but a prefix is not
 * (a temp dir, a session id). Neither means the tool alone is asserted.
 */
export interface ExpectedAction {
  /** Exact tool name, compared case-insensitively. */
  tool?: string;
  /**
   * Regex alternative to `tool`, for a step more than one tool can legitimately
   * perform: `"write|edit"` accepts either.
   *
   * Matched against the WHOLE tool name and case-insensitively — the pattern is
   * wrapped in `^(?:…)$` and given the `i` flag. Both are deliberate. Partial
   * matching would make `"read"` accept a hypothetical `thread_create`, and tool
   * names are a closed vocabulary where that is never what an author meant.
   * Case-insensitivity is inherited from `tool` for the same reason it exists
   * there: providers disagree on casing (`Write` vs `write`).
   */
  toolPattern?: string;
  target?: string;
  targetPattern?: string;
}

/**
 * How strictly the observed sequence has to line up.
 *
 *   exact           the calls ARE the expectation, in order, nothing else
 *   ordered_subset  each expectation appears, in this relative order, extras ok
 *   subset          each appears somewhere, order irrelevant
 *   contains_any    at least one appears — for "did it use SOME search tool"
 *
 * `ordered_subset` is the useful default: it pins the sequence that matters
 * without failing the moment an agent adds a reasonable extra step.
 */
export type MatchMode = 'exact' | 'ordered_subset' | 'subset' | 'contains_any';

export interface EvalCase {
  name: string;
  /** The message to send. */
  prompt: string;
  /** The webchat room to send it to. */
  room: string;
  /**
   * Score only this agent's calls. Status frames are broadcast room-wide, so in
   * a room with several wired agents another agent's work would otherwise be
   * counted against this case. Omit in a single-agent room.
   */
  agent?: string;
  expected: ExpectedAction[];
  /**
   * Calls that must NOT appear, whatever else does. `expected` can only say
   * what should happen; some contracts are about what should not — "answer this
   * from knowledge, do not reach for a shell". Expressing that as an empty
   * `expected` under `exact` also bans the legitimate ways of answering, so it
   * gets its own list. A single match here fails the case regardless of score.
   */
  forbidden?: ExpectedAction[];
  matchMode?: MatchMode;
  /** Give up after this long. A stuck turn must not hang the suite. */
  timeoutMs?: number;
  /** Run this many times; a flaky agent is a failing agent, so all must pass. */
  runs?: number;
}

export interface MatchResult {
  matched: number;
  total: number;
  /** matched/total, or 1 when nothing was expected. Pass at exactly 1. */
  score: number;
  passed: boolean;
  /** Expectations that never matched, for the failure line. */
  missing: ExpectedAction[];
  /** Observed calls that matched a `forbidden` entry, for the failure line. */
  violations?: ObservedCall[];
}

/**
 * Does one observed call trip one `forbidden` entry?
 *
 * An entry naming no tool matches nothing. `callMatches` assumes a tool is
 * named and would throw on it, and the alternative reading — a bare
 * `{ target: … }` banning every tool that touches that target — is not what
 * anyone writing a ban list means. Silent over-banning is the worse failure.
 */
function forbids(observed: ObservedCall, entry: ExpectedAction): boolean {
  if (entry.tool === undefined && entry.toolPattern === undefined) return false;
  return callMatches(observed, entry);
}

/** Does one observed call satisfy one expectation? */
export function callMatches(observed: ObservedCall, expected: ExpectedAction): boolean {
  // Tool names are compared case-insensitively because providers disagree on
  // the casing of the same tool — Claude reports `Write` and `Bash`, pi reports
  // `write` and `bash`. Comparing providers is the point of this harness, so a
  // case must not have to be rewritten to point at a different one.
  if (expected.toolPattern !== undefined) {
    try {
      // Whole-name match, case-insensitive — see the field's doc comment.
      if (!new RegExp(`^(?:${expected.toolPattern})$`, 'i').test(observed.tool)) return false;
    } catch {
      return false; // unparseable pattern: an authoring bug, not a match
    }
  } else if (expected.tool !== undefined) {
    if (observed.tool.toLowerCase() !== expected.tool.toLowerCase()) return false;
  } else {
    // Neither named. Matching everything would silently pass a case that
    // asserts nothing, which is worse than failing it.
    return false;
  }
  if (expected.target !== undefined) return observed.target === expected.target;
  if (expected.targetPattern !== undefined) {
    // An unparseable pattern is a case-authoring bug; treat it as no match
    // rather than throwing mid-suite and losing the other cases' results.
    try {
      return observed.target !== null && new RegExp(expected.targetPattern).test(observed.target);
    } catch {
      return false;
    }
  }
  return true; // tool alone
}

export function matchCalls(
  observed: ObservedCall[],
  expected: ExpectedAction[],
  mode: MatchMode = 'ordered_subset',
  forbidden: ExpectedAction[] = [],
): MatchResult {
  // A forbidden call fails the case whatever the score says, so find them first
  // and let every return below carry them. Score still reports how much of
  // `expected` was met — "did the right things AND a banned one" is a more
  // useful failure line than a bare 0.
  const violations = forbidden.length ? observed.filter((o) => forbidden.some((f) => forbids(o, f))) : undefined;
  const clean = !violations?.length;

  const total = expected.length;
  if (total === 0) {
    // Nothing required. Under `exact` that is still an assertion — "these calls
    // and no others" with no calls named means the agent should not have
    // reached for a tool at all, which is how a case pins "just answer the
    // question". Every other mode has nothing to check.
    const passed = mode !== 'exact' || observed.length === 0;
    return { matched: 0, total: 0, score: passed ? 1 : 0, passed: passed && clean, missing: [], violations };
  }

  const missing: ExpectedAction[] = [];
  let matched = 0;

  if (mode === 'exact') {
    const sameLength = observed.length === expected.length;
    expected.forEach((e, i) => {
      const o = observed[i];
      if (o && callMatches(o, e)) matched += 1;
      else missing.push(e);
    });
    const score = matched / total;
    // Length is part of the assertion here: "these calls and no others".
    return { matched, total, score, passed: sameLength && matched === total && clean, missing, violations };
  }

  if (mode === 'ordered_subset') {
    let cursor = 0;
    for (const e of expected) {
      const at = observed.findIndex((o, i) => i >= cursor && callMatches(o, e));
      if (at === -1) missing.push(e);
      else {
        matched += 1;
        cursor = at + 1; // consume, so a repeated expectation needs a repeated call
      }
    }
  } else {
    // subset / contains_any: position-free, but each observed call is still
    // consumed once so two expectations cannot both claim the same call.
    const taken = new Set<number>();
    for (const e of expected) {
      const at = observed.findIndex((o, i) => !taken.has(i) && callMatches(o, e));
      if (at === -1) missing.push(e);
      else {
        matched += 1;
        taken.add(at);
      }
    }
  }

  const score = matched / total;
  const passed = mode === 'contains_any' ? matched > 0 : matched === total;
  return { matched, total, score, passed: passed && clean, missing, violations };
}

/** One-line description of an expectation, for failure output. */
export function describeExpected(e: ExpectedAction): string {
  const tool = e.toolPattern !== undefined ? `/${e.toolPattern}/` : (e.tool ?? '?');
  if (e.target !== undefined) return `${tool}(${e.target})`;
  if (e.targetPattern !== undefined) return `${tool}(/${e.targetPattern}/)`;
  return `${tool}(*)`;
}
