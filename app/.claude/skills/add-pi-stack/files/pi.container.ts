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

import { registerProvider } from './provider-registry.js';
import { notifyProviderMessage } from './hooks.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';

const REASONING_MIN_CHUNK = 80;
const REASONING_LINE_MAX = 200;
const IDLE_TIMEOUT_MS = Number(process.env.PI_IDLE_TIMEOUT_MS) || 300_000;

// Same thinking-stall recovery as the opencode provider: a small thinking model
// can emit only reasoning and stop. Retry the turn with qwen's /no_think soft
// switch (inert on other models), remember the model, cap the retries.
const THINKING_OFF_DIRECTIVE = '/no_think';
const MAX_STALL_RETRIES = 2;
const thinkingOffModels = new Set<string>();

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
}

interface TurnResult {
  text: string;
  sawReasoning: boolean;
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
  private runTurn(text: string, sessionId: string, emit: (ev: ProviderEvent) => void): Promise<TurnResult> {
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
      const tools = (process.env.PI_TOOLS ?? 'read,write,edit,bash').trim();
      const toolsEnabled = Boolean(tools) && tools !== 'none';
      if (!toolsEnabled) args.push('--no-tools');
      else args.push('--tools', tools);

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
      let lastActivity = Date.now();
      const idle = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
          clearInterval(idle);
          child.kill('SIGKILL');
          reject(new Error(`pi idle timeout (${IDLE_TIMEOUT_MS}ms)`));
        }
      }, 5000);

      const rl = createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
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
            for (const l of reasoningChunks(grown)) emit({ type: 'reasoning', message: l });
            reasoningEmitted = reasoningBuffer.length;
          }
        } else if (ev.type === 'tool_execution_start' && ev.toolName) {
          // Tool telemetry. pi runs its own tools, so nothing passes through
          // the Claude pre-tool hook that normally feeds this seam — without
          // this line a pi agent shows reasoning and then silence while it
          // works, and the floor/thinking-bubble read as idle mid-turn.
          notifyProviderMessage({ kind: 'tool_use', toolName: ev.toolName, toolInput: ev.args });
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
        if (code === 0) resolve({ text: finalText, sawReasoning });
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
      'The <message> envelope is OUTPUT FORMATTING, not a tool: write the tags in your reply text. ' +
        'There is no send_message tool and no messaging tool of any kind — your tools only read and change files ' +
        'and run commands.',
    ].join('\n');
    this.currentSystem = base ? `${base}\n\n${addressing}` : addressing;

    const pending: Array<{ text: string; retries: number }> = [];
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
        const turn = self.runTurn(text, sessionId, (ev) => buffered.push(ev));
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
        yield { type: 'result', text: result.text || null };
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

registerProvider('pi', (opts) => new PiProvider(opts));
