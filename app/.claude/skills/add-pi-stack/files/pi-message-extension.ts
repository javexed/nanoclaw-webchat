/**
 * pi extension: the `message` tool.
 *
 * WHY THIS EXISTS. pi's model kept inventing this tool. Asked a plain question,
 * qwen3.5:4b emitted `{"name":"message","arguments":{"to":"pi-soak"}}` and got
 * back "Tool message not found" — then fell back to `echo 4`, read its own
 * stdout as proof it had replied, and looped until the turn died. The prompt
 * told it in so many words that no messaging tool exists; it called one anyway.
 *
 * Both failures are the same drive: the model is trying to DELIVER, and given
 * tools it reaches for a delivery-shaped one. Instructing it not to was measured
 * and does not work. So stop fighting the instinct and make it correct — the
 * tool it reaches for now exists and routes into NanoClaw delivery.
 *
 * WHAT THIS FILE DOES NOT DO. It never writes the message. The agent-runner
 * owns the outbound DB (one writer per file, always), so it watches pi's event
 * stream and performs the real send when this tool reports success. This half
 * exists to give the MODEL an honest answer, because a tool that always claims
 * success recreates the silent failure that caused the looping.
 *
 * Validation is against a snapshot the provider writes next to this file before
 * every spawn. A snapshot rather than a live lookup because this runs in pi's
 * process, which has no database; destinations change rarely, and the provider
 * re-reads the real table when it does the actual send.
 *
 * NO IMPORTS FROM pi OR typebox — deliberately. This file sits under
 * container/agent-runner/src (the only tree mounted into the container), so
 * agent-runner's tsc compiles it even though only pi ever loads it. Importing
 * pi's types would fail that build, since pi is not an agent-runner dependency.
 * The parameter schema is therefore a plain JSON Schema literal, which is what
 * typebox's Type.Object() produces anyway.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

/** The slice of pi's ExtensionAPI this file uses. */
interface PiExtensionApi {
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
  }): void;
}

interface DestinationSnapshot {
  name: string;
  label?: string;
}

/** Written by the pi provider at spawn. Absent = we cannot check, so allow. */
function readDestinations(): DestinationSnapshot[] | null {
  const dir = process.env.PI_CODING_AGENT_DIR || '/pi-agent';
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'destinations.json'), 'utf-8'));
    return Array.isArray(parsed) ? (parsed as DestinationSnapshot[]) : null;
  } catch {
    return null;
  }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], details: {}, isError: true };
}

export default function (pi: PiExtensionApi): void {
  pi.registerTool({
    name: 'message',
    label: 'Message',
    description:
      'Send a message to one of your named destinations. This is how you talk to a person — ' +
      'it is the only thing that reaches them. Printing to stdout with echo or writing a file does not.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination name, exactly as listed in your instructions.' },
        text: { type: 'string', description: 'What to say. Plain text.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
      const to = String(params.to ?? '').trim();
      const text = String(params.text ?? '');
      if (!to) return fail('`to` is required — name the destination.');
      if (!text.trim()) return fail('`text` is required — an empty message is never delivered.');

      const known = readDestinations();
      if (known && !known.some((d) => d.name === to)) {
        // The honest answer. Guessing "delivered" here is what made the model
        // loop in the first place.
        const options = known.length > 0 ? known.map((d) => d.name).join(', ') : '(none configured)';
        return fail(`Unknown destination "${to}". Your destinations are: ${options}`);
      }

      // Success is reported here; the send itself happens in the agent-runner
      // when it sees this call complete without error.
      return { content: [{ type: 'text', text: `Delivered to ${to}.` }], details: {} };
    },
  });
}
