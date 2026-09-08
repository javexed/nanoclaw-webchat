/**
 * First-use capability probe for a local model the profile table does not know.
 *
 * WHAT IT MEASURES, and why that one thing. Across every failure worth fixing
 * in this harness, one behaviour predicted the rest: whether a model reaches
 * for a tool to answer a question it already knows. qwen3.5:4b did — it ran
 * `echo 4` for "what is 2 + 2", read its own stdout back as proof it had
 * replied, and looped. ornith-1.5:9b did not, and passed everything the other
 * failed. So the probe asks exactly that question, with one tool in reach, and
 * watches whether the model uses it.
 *
 * It talks to the model's OpenAI-compatible endpoint directly instead of
 * driving the full agent stack. A probe that needed a container, a session and
 * a websocket would be slower than the thing it is deciding about, and would
 * fail for reasons that have nothing to do with the model.
 *
 * The classifier is pure and separately tested. Only `probeModel` touches the
 * network, and a probe that cannot run returns null — an unknown model falls
 * back to the documented default rather than to a guess.
 */
import type { ModelProfile } from './model-profiles.js';

/** One probe round: did the model call a tool, and did it produce text? */
export interface ProbeRound {
  calledTool: boolean;
  answeredInText: boolean;
}

export interface ProbeVerdict {
  /** Rounds where the model reached for a tool it did not need. */
  reachedForTool: number;
  rounds: number;
  /** Fewer than half the rounds reached for a tool. */
  disciplined: boolean;
}

/**
 * Majority vote over rounds. A single round is not enough: the behaviour was
 * measured as intermittent, roughly one run in three, so one sample would
 * mis-profile a model about as often as it profiled it correctly.
 */
export function classifyRounds(rounds: ProbeRound[]): ProbeVerdict | null {
  if (rounds.length === 0) return null;
  const reachedForTool = rounds.filter((r) => r.calledTool).length;
  return {
    reachedForTool,
    rounds: rounds.length,
    disciplined: reachedForTool * 2 < rounds.length,
  };
}

/**
 * Settings implied by a verdict.
 *
 * Only ONE thing is switched here, and deliberately so. The three-model sweep
 * showed the models differing in capability and latency, not in what harness
 * knobs they wanted: nothing justified changing `tools`, `thinking`, or whether
 * the message tool exists. The single decision with evidence behind it is how
 * quickly to cut off a loop, because exactly one model was observed to loop and
 * the default let two duplicate messages reach a person first.
 *
 * Everything else stays at the documented default. A probe that flipped knobs
 * it had not measured would be guessing with more ceremony.
 */
export function profileFromVerdict(verdict: ProbeVerdict): ModelProfile {
  return {
    noopCapThreshold: verdict.disciplined ? 3 : 2,
    notes:
      `Probed: reached for a tool in ${verdict.reachedForTool}/${verdict.rounds} rounds ` +
      `of a question needing none.`,
  };
}

const PROBE_PROMPT = 'What is 2 + 2? Answer with just the number.';
const PROBE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'bash',
    description: 'Run a shell command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to run.' } },
      required: ['command'],
    },
  },
};

interface ChatChoice {
  message?: { content?: string | null; tool_calls?: unknown[] };
}

/** One round against an OpenAI-compatible endpoint. Null when it cannot run. */
export async function probeRound(baseURL: string, model: string, timeoutMs = 60_000): Promise<ProbeRound | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer placeholder' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        tools: [PROBE_TOOL],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: ChatChoice[] };
    const msg = body.choices?.[0]?.message;
    if (!msg) return null;
    return {
      calledTool: Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0,
      answeredInText: typeof msg.content === 'string' && msg.content.trim().length > 0,
    };
  } catch {
    // Unreachable endpoint, bad JSON, timeout: all mean "no verdict", never
    // "badly behaved model". Caller falls back to the default profile.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a model over several rounds. Returns null when no round succeeded, so
 * a network problem can never be recorded as a behavioural finding.
 */
export async function probeModel(
  baseURL: string,
  model: string,
  rounds = 3,
): Promise<{ verdict: ProbeVerdict; profile: ModelProfile } | null> {
  const results: ProbeRound[] = [];
  for (let i = 0; i < rounds; i++) {
    const r = await probeRound(baseURL, model);
    if (r) results.push(r);
  }
  const verdict = classifyRounds(results);
  if (!verdict) return null;
  return { verdict, profile: profileFromVerdict(verdict) };
}
