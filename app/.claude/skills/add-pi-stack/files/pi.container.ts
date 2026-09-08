/**
 * Container-side `pi` provider — runs each turn through the pi coding agent
 * (@earendil-works/pi-coding-agent) in one-shot JSON mode against a LOCAL
 * OpenAI-compatible backend (Ollama), configured by the host provider via
 * models.json in $PI_CODING_AGENT_DIR.
 *
 * Why pi for local models: its harness is minimal by design (4 built-in tools,
 * no 16k coding preamble) and we pass our own `--system-prompt`, so the model
 * sees NanoClaw's instructions rather than a coding-assistant persona — the
 * smallest prompt of any harness here. Tools (read/write/edit/bash) are ON by
 * default via PI_TOOLS; they were disabled wholesale when the target was a 3B
 * model, but a toolless agent that still SAYS "creating hello.sh now" is worse
 * than a slightly larger prompt. Set PI_TOOLS=none to go back.
 *
 * Reasoning arrives as structured thinking_delta events (pi parses <think>),
 * which map 1:1 onto the runner's reasoning telemetry. Depth is PI_THINKING
 * (default 'low' — chat-first work rarely needs pi's own 'medium').
 *
 * Process model: one `pi -p --mode json` process per queued message —
 * continuation via `--session-id` (pi creates the id if missing, so the
 * runner mints its own). No server process, no SSE subscription.
 */
import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { registerProvider } from './provider-registry.js';
import { MAX_IDENTICAL_TOOL_CALLS, NoopToolCallCounter } from '../noop-tool-cap.js';
import { sendMessage } from '../mcp-tools/core.js';
import { getAllDestinations } from '../destinations.js';
import { notifyProviderMessage } from './hooks.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';

const REASONING_MIN_CHUNK = 80;
const REASONING_LINE_MAX = 200;
const IDLE_TIMEOUT_MS = Number(process.env.PI_IDLE_TIMEOUT_MS) || 300_000;
// Hard ceiling on ONE turn, derived per model by the host (model-profiles.ts).
// IDLE_TIMEOUT_MS only notices SILENCE, so a model looping productively looks
// busy forever: ornith-1.5:9b ran read -> edit -> read -> edit past five
// minutes, re-deciding whether a comment belongs above a shebang, and nothing
// stopped it. 0 disables. Generous on purpose: a backstop, not a scheduler.
const TURN_TIMEOUT_MS = Number(process.env.PI_TURN_TIMEOUT_MS) || 0;

// Same thinking-stall recovery as the opencode provider: a small thinking model
// can emit only reasoning and stop. Retry the turn with qwen's /no_think soft
// switch (inert on other models), remember the model, cap the retries.
const THINKING_OFF_DIRECTIVE = '/no_think';
const MAX_STALL_RETRIES = 2;

/**
 * The delivery tool pi's model kept inventing before it existed. Registered by
 * the extension beside this file; see pi-message-extension.ts for why.
 */
const MESSAGE_TOOL = 'message';
const MESSAGE_EXTENSION_PATH = fileURLToPath(new URL('./pi-message-extension.ts', import.meta.url));
const thinkingOffModels = new Set<string>();

// NO-OP TOOL-CALL CAP. pi owns its own agentic loop, so the only lever this
// side of it is to watch the event stream and cut the turn off. The detector
// and the reasoning behind its signature live in ../noop-tool-cap.ts.

function log(msg: string): void {
  console.error(`[pi-provider] ${msg}`);
}

/** Sentence/line-boundary chunking for the reasoning feed (cosmetic). */
function reasoningChunks(delta: string): string[] {
  return delta
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
    .map((s) => (s.length > REASONING_LINE_MAX ? `${s.slice(0, REASONING_LINE_MAX - 1)}…` : s));
}

interface PiEvent {
  type?: string;
  id?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string; thinking?: string }> };
  assistantMessageEvent?: { type?: string; delta?: string };
  /** tool_execution_start / _end carry the call pi is about to run. */
  toolName?: string;
  args?: Record<string, unknown>;
  /** Pairs _start with _end: pi may interleave calls, so never assume order. */
  toolCallId?: string;
  /** tool_execution_end only — what the call actually produced. */
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  /**
   * Whether the call THREW. A tool that returns a failure result cleanly — the
   * message tool rejecting an unknown destination, say — leaves this false and
   * sets `result.isError` instead. Read both; see toolFailed().
   */
  isError?: boolean;
}

/**
 * True when a completed call did not succeed, by either of pi's two channels.
 * Getting this wrong is not cosmetic: treating a rejected send as a success is
 * precisely the silent failure the message tool exists to remove.
 */
function toolFailed(ev: PiEvent): boolean {
  return ev.isError === true || ev.result?.isError === true;
}

interface TurnResult {
  text: string;
  sawReasoning: boolean;
  /** The turn was cut short by the no-op tool-call cap, not by pi finishing. */
  loopedToolCall?: boolean;
  /** At least one `message` tool call delivered during this turn. */
  deliveredViaMessageTool?: boolean;
}

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;
  private activeChild: ChildProcess | null = null;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  // pi loads context from AGENTS.md files natively; NanoClaw's instructions
  // travel in --system-prompt instead, so there is no session hook to register.
  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {}

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /session.*(not found|invalid|corrupt)|ENOENT.*sessions/i.test(msg);
  }

  /**
   * Run ONE message through a fresh `pi -p --mode json` process. Yields
   * reasoning lines through `emit`; resolves with the final assistant text.
   */
  private runTurn(
    text: string,
    sessionId: string,
    emit: (ev: ProviderEvent) => void,
    opts: { toolsOff?: boolean } = {},
  ): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      const piDir = process.env.PI_CODING_AGENT_DIR || '/pi-agent';
      const args = [
        '--mode',
        'json',
        '-p',
        '--provider',
        process.env.PI_PROVIDER || 'ollama',
        '--model',
        process.env.PI_MODEL || '',
        '--api-key',
        'placeholder',
        '--session-dir',
        `${piDir}/sessions`,
        '--session-id',
        sessionId,
      ];
      // TOOLS. pi ships read/bash/edit/write. They were disabled wholesale for
      // the smallest possible prompt, which was the right call for a 3B model;
      // a 9B-class local model can afford the preamble and is far more useful
      // able to actually DO things. PI_TOOLS is the knob: a comma-separated
      // allowlist, or the literal 'none' to restore the toolless behaviour.
      // MESSAGE_TOOL is not optional scenery: --tools is an allowlist that
      // covers extension tools too, so leaving it out silently filters the
      // extension's tool back out and we are exactly where we started.
      const tools = (process.env.PI_TOOLS ?? `read,write,edit,bash,${MESSAGE_TOOL}`).trim();
      // opts.toolsOff is the no-op cap's retry: the model already proved this
      // turn that it will not stop calling a tool, so take the tool away. Note
      // this also flips the prompt to REPLACE below, which is right — with no
      // tools there is no tool documentation of pi's worth keeping.
      const toolsEnabled = opts.toolsOff !== true && Boolean(tools) && tools !== 'none';
      if (!toolsEnabled) args.push('--no-tools');
      else {
        args.push('--tools', tools);
        // The destination snapshot the extension validates against. Rewritten
        // every spawn so a newly-wired destination is visible without a
        // restart, and so a removed one stops being offered.
        try {
          writeFileSync(
            path.join(piDir, 'destinations.json'),
            JSON.stringify(
              getAllDestinations().map((d) => ({ name: d.name, label: d.displayName })),
              null,
              2,
            ),
          );
        } catch (e) {
          // A missing snapshot makes the extension permissive, not broken:
          // it stops pre-validating and the real send still checks.
          log(`pi: could not write destinations snapshot: ${String(e)}`);
        }
        args.push('--extension', MESSAGE_EXTENSION_PATH);
      }

      // THINKING. Counter-intuitive but measured: starving a reasoning model's
      // budget makes it SLOWER, not faster. Same task (write a hello.sh, chmod
      // it, report the path) on ornith-1.5:9b:
      //
      //   low  → 660s wall, 68 reasoning events, replied "Creating hello.sh
      //          now." before doing the work and never confirmed
      //   high → 130s wall, 17 reasoning events, replied "Done — <path> is
      //          executable and prints hello world"
      //
      // Five times faster on a quarter of the reasoning: given room to plan
      // once, it acts; starved, it flails in fragments that never converge.
      // pi's own default is 'medium'. off|minimal|low|medium|high|xhigh|max.
      const thinking = (process.env.PI_THINKING ?? 'high').trim();
      if (thinking) args.push('--thinking', thinking);

      const system = this.currentSystem;
      if (system) {
        // REPLACE vs APPEND — this decides whether tools work at all.
        //
        // `--system-prompt` replaces pi's own prompt, INCLUDING the part that
        // documents its tools. The model still receives tool schemas over the
        // API, but a small local model leans on prompt guidance; without it, it
        // invents a plausible interface instead of calling anything. Measured
        // on ornith with tools enabled, same task each time:
        //
        //   pi's own prompt (no override)   18 real tool calls
        //   ours via --system-prompt         0 — it emitted
        //                                    `<code>write_file path=…></code>`,
        //                                    its own invention, and no file
        //
        // So with tools ON we APPEND: pi keeps its tool documentation and our
        // instructions ride on top. With tools OFF the original reasoning still
        // holds — replace outright for the smallest possible prompt, which is
        // the whole point of pi for a small model.
        args.push(toolsEnabled ? '--append-system-prompt' : '--system-prompt', system);
      }
      args.push(text);

      // stdin MUST be closed ('ignore'): pi in print mode also accepts piped
      // stdin and waits for its EOF before starting the turn — an open pipe
      // hangs the whole query.
      // cwd is load-bearing once tools are on: pi resolves read/write/edit
      // paths against it, so an unset cwd would put the agent's files wherever
      // the runner started rather than in its workspace.
      const child = spawn('pi', args, {
        cwd: this.currentCwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeChild = child;

      let finalText = '';
      let sawReasoning = false;
      let reasoningEmitted = 0;
      let reasoningBuffer = '';
      let stderrTail = '';
      // No-op cap bookkeeping. `argsByCallId` bridges _start (which carries the
      // args) to _end (which carries the result), because pi may interleave
      // calls and the two halves of one call must be matched by id, not order.
      const argsByCallId = new Map<string, unknown>();
      const noopCounter = new NoopToolCallCounter(Number(process.env.PI_NOOP_CAP) || MAX_IDENTICAL_TOOL_CALLS);
      let killedForLoop = false;
      let killedForTurnBudget = false;
      let deliveredViaMessageTool = false;
      // Identical sends already made THIS turn. Giving the model a real
      // delivery tool moved its loop onto that tool: measured on qwen3.5:4b,
      // a plain question produced five identical `message` calls, and unlike
      // the echo loop it replaced, every one of them actually reached the
      // person. The cap below stops the runaway but only on the third call,
      // so two duplicates would still land. Sending the same text to the same
      // destination twice in one turn is never what anyone wants; drop it.
      const sentThisTurn = new Set<string>();
      let lastActivity = Date.now();
      const startedAt = Date.now();
      const idle = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
          clearInterval(idle);
          child.kill('SIGKILL');
          reject(new Error(`pi idle timeout (${IDLE_TIMEOUT_MS}ms)`));
          return;
        }
        if (TURN_TIMEOUT_MS > 0 && Date.now() - startedAt > TURN_TIMEOUT_MS) {
          // Resolve, not reject: whatever text the turn produced is worth
          // delivering, and an over-long turn is not an error the user needs
          // shown as one.
          log(`pi: turn exceeded ${TURN_TIMEOUT_MS}ms - cutting it short`);
          killedForTurnBudget = true;
          clearInterval(idle);
          child.kill('SIGKILL');
        }
      }, 5000);

      const rl = createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        // Buffered lines can still arrive after the cap SIGKILLs the child;
        // ignore them rather than log and re-kill a corpse.
        if (killedForLoop) return;
        lastActivity = Date.now();
        let ev: PiEvent;
        try {
          ev = JSON.parse(line) as PiEvent;
        } catch {
          return; // non-JSON noise
        }
        if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'thinking_delta') {
          sawReasoning = true;
          // Deltas are token-sized; buffer and emit on natural boundaries.
          reasoningBuffer += ev.assistantMessageEvent.delta ?? '';
          const grown = reasoningBuffer.slice(reasoningEmitted);
          if (grown.length >= REASONING_MIN_CHUNK || /[.!?\n]/.test(grown)) {
            for (const l of reasoningChunks(grown)) notifyProviderMessage({ kind: 'reasoning', text: l }); // seam: direct, no ProviderEvent
            reasoningEmitted = reasoningBuffer.length;
          }
        } else if (ev.type === 'tool_execution_start' && ev.toolName) {
          // Tool telemetry. pi runs its own tools, so nothing passes through
          // the Claude pre-tool hook that normally feeds this seam — without
          // this line a pi agent shows reasoning and then silence while it
          // works, and the floor/thinking-bubble read as idle mid-turn.
          notifyProviderMessage({ kind: 'tool_use', toolName: ev.toolName, toolInput: ev.args });
          if (ev.toolCallId) argsByCallId.set(ev.toolCallId, ev.args ?? {});
          emit({ type: 'activity' });
        } else if (ev.type === 'tool_execution_end' && ev.toolCallId) {
          const args = argsByCallId.get(ev.toolCallId);
          argsByCallId.delete(ev.toolCallId);
          // The real send. The extension told the model "Delivered to X"; this
          // is what makes that true. Doing it here rather than in the extension
          // keeps one writer on the outbound DB, and doing it on _end rather
          // than _start means a rejected destination never delivers.
          if (ev.toolName === MESSAGE_TOOL && !toolFailed(ev) && isRecord(args)) {
            deliveredViaMessageTool = true;
            const sig = `${String(args.to ?? '')}\u0000${String(args.text ?? '')}`;
            if (sentThisTurn.has(sig)) {
              log(`pi: dropping duplicate message to "${String(args.to ?? '')}" (already sent this turn)`);
            } else {
              sentThisTurn.add(sig);
              void deliverPiMessage(args);
            }
          }
          if (args !== undefined) {
            const output = (ev.result?.content ?? []).map((c) => c.text ?? '').join('');
            if (noopCounter.record(ev.toolName ?? '', args, output, toolFailed(ev))) {
              log(
                `pi: ${noopCounter.streak} identical ${ev.toolName ?? 'tool'} calls with identical output — ` +
                  `cutting the turn short (cap ${MAX_IDENTICAL_TOOL_CALLS})`,
              );
              killedForLoop = true;
              clearInterval(idle);
              child.kill('SIGKILL');
              return;
            }
          }
          emit({ type: 'activity' });
        } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
          finalText = (ev.message.content ?? [])
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
        } else {
          emit({ type: 'activity' });
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
      child.on('error', (err) => {
        clearInterval(idle);
        reject(err);
      });
      child.on('exit', (code) => {
        clearInterval(idle);
        this.activeChild = null;
        // We killed it on purpose, so a nonzero code here is expected and must
        // not surface as a turn error. Hand back whatever text exists (usually
        // none) plus the flag the caller retries on.
        if (killedForTurnBudget) return resolve({ text: finalText, sawReasoning, deliveredViaMessageTool });
        if (killedForLoop)
          return resolve({ text: finalText, sawReasoning, loopedToolCall: true, deliveredViaMessageTool });
        if (code === 0) resolve({ text: finalText, sawReasoning, deliveredViaMessageTool });
        else reject(new Error(`pi exited ${code}${stderrTail ? `: ${stderrTail.slice(-400)}` : ''}`));
      });
    });
  }

  private currentSystem: string | undefined;
  /** The agent's workspace. Tools write RELATIVE to pi's cwd, so this must be
   *  set or an enabled write/edit lands wherever the runner happens to live. */
  private currentCwd: string | undefined;

  query(input: QueryInput): AgentQuery {
    this.activeSessionId = input.continuation || undefined;
    this.currentCwd = input.cwd;
    // Reinforce the addressing rule for small models: without the heavier
    // harness scaffolding they often put the SENDER's name in `to=` (which the
    // runner drops as an unknown destination) — especially when the room shares
    // the agent's own name. A concrete copy-the-from-attribute example fixes
    // what an abstract rule doesn't.
    const base = input.systemContext?.instructions;
    const addressing = [
      "ADDRESSING RULE (critical): copy the from= attribute of the incoming <message> tag into your reply's to= attribute, EXACTLY.",
      'Example: incoming `<message from="assistant" sender="alice">hi</message>` → reply `<message to="assistant">hello!</message>`.',
      'The sender= value is a person, never a valid to= destination. Even if the destination name matches your own name, use it — it is the room, not you.',
      // Since tools were enabled, models started reading the addressing rule as
      // a TOOL contract: qwen emitted `send_message(to="pi-soak")`, a tool that
      // does not exist, having turned "send a message to pi-soak" into a call.
      // pi ignored it and the real reply still landed, but it costs a call and
      // muddies the tool feed. Say plainly which of the two it is.
      // This clause used to deny every messaging tool. It had to change the
      // moment one existed — a prompt that contradicts the tool list is the
      // original bug in this family, and the model quoted the old denial back
      // while calling the tool anyway.
      'You have a `message` tool: message(to, text) delivers to a named destination. ' +
        'Prefer it. The <message to="…"> envelope in your reply text does the same thing and still works, ' +
        'but the tool tells you whether the destination was valid, which the envelope cannot. ' +
        'These two are the ONLY ways to reach a person: printing with echo or writing a file reaches nobody.',
      // MEASURED DEAD END — do not add a fourth clause here telling the model
      // that stdout is not delivery. It was tried, against qwen3.5:4b:
      //
      //   'TOOL OUTPUT IS NOT A REPLY. Whatever a command prints — echo,
      //    printf, cat — comes back only to you; the person never sees it. …
      //    A question you can answer from your own knowledge needs no command.'
      //
      //   plain-question eval, 6 clean-session runs   2 passed
      //   the same eval without the clause, 5 runs    3 passed
      //
      // The counts alone would only say "no improvement". The transcripts say
      // why. The model READ the new clause, restated it correctly — "the rules
      // say questions that can be answered from knowledge need no command, this
      // is basic math so I should just answer directly without tools" — and
      // then called bash anyway, six times. One run reached for `write` to
      // /tmp/answer.txt instead, having learned only that bash was disfavoured.
      //
      // Its stated policy already matches the instruction. That is why more
      // instruction has no lever: the failure is between intent and action, not
      // in what the model believes about delivery. Fix it somewhere other than
      // the prompt — a larger model, or a cap on repeated no-op tool calls.
    ].join('\n');
    this.currentSystem = base ? `${base}\n\n${addressing}` : addressing;

    const pending: Array<{ text: string; retries: number; toolsOff?: boolean }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    pending.push({ text: input.prompt, retries: 0 });

    const kick = (): void => {
      waiting?.();
    };
    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      const sessionId = self.activeSessionId ?? randomUUID();
      self.activeSessionId = sessionId;
      yield { type: 'init', continuation: sessionId };

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }
        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const item = pending.shift()!;
        const modelKey = process.env.PI_MODEL || '';
        let text = item.text;
        if (thinkingOffModels.has(modelKey) && !text.includes(THINKING_OFF_DIRECTIVE)) {
          text = `${text}\n${THINKING_OFF_DIRECTIVE}`;
        }

        // Bridge push-parsed events out of runTurn's callback into this
        // generator: buffer + drain between awaits.
        const buffered: ProviderEvent[] = [];
        const turn = self.runTurn(text, sessionId, (ev) => buffered.push(ev), { toolsOff: item.toolsOff === true });
        let result: TurnResult;
        try {
          for (;;) {
            while (buffered.length) yield buffered.shift()!;
            const done = await Promise.race([turn.then(() => true), new Promise((r) => setTimeout(r, 250, false))]);
            if (done) break;
          }
          while (buffered.length) yield buffered.shift()!;
          result = await turn;
        } catch (err) {
          self.activeSessionId = undefined;
          throw err;
        }

        // No-op tool-call cap. MUST be checked before the thinking-stall
        // recovery below: a capped turn also has no text and did reason, so the
        // stall branch would claim it first and retry with /no_think — which
        // leaves the tool in place and the model loops again on the retry.
        //
        // Retry once with tools off. This is not a nudge, it is removal of the
        // affordance being misused: with no tool to call, a reply in text is
        // the only move left. Guarded by item.toolsOff so a turn can never
        // ping-pong here.
        if (result.loopedToolCall && !item.toolsOff) {
          log('pi: retrying the capped turn with tools off');
          pending.unshift({ text: item.text, retries: item.retries, toolsOff: true });
          continue;
        }

        // Thinking-stall recovery (same shape as the opencode provider).
        if (!result.text && result.sawReasoning && item.retries < MAX_STALL_RETRIES) {
          thinkingOffModels.add(modelKey);
          log(
            `pi: reasoning-only turn on ${modelKey} — retry ${item.retries + 1}/${MAX_STALL_RETRIES} with thinking off`,
          );
          pending.unshift({
            text: text.includes(THINKING_OFF_DIRECTIVE) ? text : `${text}\n${THINKING_OFF_DIRECTIVE}`,
            retries: item.retries + 1,
          });
          continue;
        }
        // DOUBLE-DELIVERY GUARD. When the message tool already delivered, the
        // model's closing text is a confirmation to itself — "Message delivered
        // successfully to pi-soak" — and this group runs with lenientOutput, so
        // the poll-loop would send that unwrapped prose as a SECOND message.
        // Measured: every tool-delivered turn produced two.
        //
        // Only prose is dropped. Text carrying its own <message> envelope is
        // passed through untouched: that is a real delivery, possibly to a
        // different destination, and swallowing it would lose a message rather
        // than de-duplicate one.
        const redundantConfirmation = result.deliveredViaMessageTool === true && !/<message\b/i.test(result.text);
        yield { type: 'result', text: redundantConfirmation ? null : result.text || null };
      }
    }

    return {
      push(message: string): void {
        pending.push({ text: message, retries: 0 });
        kick();
      },
      end(): void {
        ended = true;
        kick();
      },
      events: gen(),
      abort: (): void => {
        aborted = true;
        this.activeChild?.kill('SIGKILL');
        kick();
      },
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Hand the model's `message` call to the same code path the MCP `send_message`
 * tool uses, so routing, thread resolution and destination checks stay in one
 * place. Errors are logged, never thrown: the turn is still in flight and a
 * failed send must not take it down.
 */
async function deliverPiMessage(args: Record<string, unknown>): Promise<void> {
  try {
    const res = await sendMessage.handler({ to: String(args.to ?? ''), text: String(args.text ?? '') });
    const failed = (res as { isError?: boolean }).isError === true;
    if (failed) log(`pi: message tool reported success but the send failed: ${JSON.stringify(res)}`);
  } catch (e) {
    log(`pi: message tool delivery threw: ${String(e)}`);
  }
}

registerProvider('pi', (opts) => new PiProvider(opts));
