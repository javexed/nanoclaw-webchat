// The thinking bubble for an OpenCode agent: OpenCode's event stream carries
// each tool call and the model's reasoning as message parts, and nothing passed
// them on, so the bubble stayed empty while the agent worked. This forwards
// them through the same provider-message seam the Claude provider uses:
// a tool_use per call (once it runs, with its input), and a reasoning part's
// summarised lines once the part is complete (the full text on the first).
import { summarizeThinking } from './claude.js';
import { notifyProviderMessage } from './hooks.js';

interface FeedPart {
  id?: string;
  type?: string;
  callID?: string;
  tool?: string;
  text?: string;
  time?: { end?: number };
  state?: { status?: string; input?: Record<string, unknown> };
}

/** Parts already forwarded (a part updates many times as it streams). */
const forwarded = new Set<string>();
const FORWARDED_CAP = 1000;

/** A part with no id cannot be told apart from the next one: never deduplicated. */
function firstTime(kind: string, id: string | undefined): boolean {
  if (!id) return true;
  const key = `${kind}:${id}`;
  if (forwarded.has(key)) return false;
  forwarded.add(key);
  if (forwarded.size > FORWARDED_CAP) forwarded.delete(forwarded.values().next().value as string);
  return true;
}

export function forwardOpenCodeEvent(event: { type?: string; properties?: unknown }): void {
  if (event.type !== 'message.part.updated') return;
  const part = (event.properties as { part?: FeedPart } | undefined)?.part;
  if (!part) return;
  if (part.type === 'tool') {
    const status = part.state?.status;
    // Pending parts have no input yet; a fast tool may skip straight to completed.
    if (status !== 'running' && status !== 'completed') return;
    if (!part.tool || !firstTime('tool', part.callID ?? part.id)) return;
    notifyProviderMessage({ kind: 'tool_use', toolName: part.tool, toolInput: part.state?.input });
    return;
  }
  if (part.type === 'reasoning') {
    if (!part.time?.end || !part.text?.trim() || !firstTime('reasoning', part.id)) return;
    summarizeThinking(part.text).forEach((line, i) => {
      // `detail` rides as an extra field, as in claude.ts.
      notifyProviderMessage({
        kind: 'reasoning',
        text: line,
        ...(i === 0 ? { detail: part.text } : {}),
      } as Parameters<typeof notifyProviderMessage>[0]);
    });
  }
}

export function __resetOpenCodeFeedForTest(): void {
  forwarded.clear();
}
