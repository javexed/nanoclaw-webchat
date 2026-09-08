/**
 * Consecutive-identical-tool-call detection.
 *
 * A small local model that cannot bring itself to deliver in plain text
 * sometimes reaches for a tool as its outlet and never stops. Asked "what is
 * 2 + 2", qwen3.5:4b ran `echo 4`, read its own stdout back as proof it had
 * replied, and ran it again — up to ten times, until the turn timed out having
 * sent nothing. Prompting against it was measured and does not work: the model
 * restates the rule correctly and calls the tool anyway.
 *
 * So this bounds the behaviour instead. It lives here rather than beside the
 * provider that uses it because a provider installed by a skill is absent from
 * a stock tree — untestable in CI — and because nothing about counting repeats
 * is specific to one harness.
 */

/** Consecutive identical calls tolerated before a turn is judged stuck. */
export const MAX_IDENTICAL_TOOL_CALLS = 3;

/** NUL: impossible inside a JSON string body, so no value can fake a break. */
const SEP = '\u0000';

/**
 * The signature is the call AND its result. That pairing is what keeps a
 * deliberate poll loop safe: `sleep 5; curl …` repeated until the output
 * changes breaks the chain the moment it changes, so only a run of
 * byte-identical results trips the cap. That is the honest definition of a
 * no-op — same input, same output, nothing learned.
 *
 * The accepted false positive is a poll that returns identical output
 * `MAX_IDENTICAL_TOOL_CALLS` times running. It costs a retry, not the turn.
 *
 * Fields are joined on NUL, which cannot appear in a JSON string body, so no
 * argument value can impersonate a separator and collide two distinct calls
 * into one signature.
 */
export function toolCallSignature(toolName: string, args: unknown, output: string, isError: boolean): string {
  return [toolName, JSON.stringify(args ?? {}), isError ? 'E' : 'K', output].join(SEP);
}

/** Counts how many times the same (call, result) has repeated back to back. */
export class NoopToolCallCounter {
  private last: string | null = null;
  private runs = 0;

  /**
   * @param threshold consecutive identical calls tolerated. Per-model, because
   * a model observed to loop should be cut off sooner than one that never has;
   * see the profile table. Values below 2 are refused — a single call can never
   * be a loop, and a threshold of 1 would cut off the first tool use of every
   * turn.
   */
  constructor(private readonly threshold: number = MAX_IDENTICAL_TOOL_CALLS) {
    this.threshold = Math.max(2, Math.floor(threshold) || MAX_IDENTICAL_TOOL_CALLS);
  }

  /**
   * Record one completed tool call. Returns true when it is the
   * `MAX_IDENTICAL_TOOL_CALLS`-th identical one in a row — i.e. the caller
   * should stop the turn.
   */
  record(toolName: string, args: unknown, output: string, isError: boolean): boolean {
    const sig = toolCallSignature(toolName, args, output, isError);
    this.runs = sig === this.last ? this.runs + 1 : 1;
    this.last = sig;
    return this.runs >= this.threshold;
  }

  /** Consecutive repeats counted so far, for the log line. */
  get streak(): number {
    return this.runs;
  }
}
