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
 * (default 'high' — see the measurement in runTurn).
 *
 * Process model: one `pi -p --mode json` process per queued message —
 * continuation via `--session-id` (pi creates the id if missing, so the
 * runner mints its own). No server process, no SSE subscription.
 */
import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
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

// Thinking-stall recovery: a small thinking model can emit only reasoning and
// stop. Retry the turn with qwen's /no_think soft switch (inert on other
// models), remember the model, cap the retries.
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

/**
 * Splits a stream into lines on '\n' ONLY. readline also breaks on U+2028 and
 * U+2029, which JSON.stringify leaves unescaped inside strings, so a model
 * writing either character cut its event in two and both halves failed to parse.
 */
export class JsonLineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines;
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

/** pi gets SIGTERM first so its handler can reap tool children and close the session. Read per stop. */
function stopGraceMs(): number {
  return Number(process.env.PI_STOP_GRACE_MS) || 3000;
}
/** After SIGKILL, how long a stop still waits for the exit before giving up on it. */
const KILL_WAIT_MS = 1000;

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* group already gone, or not a group leader: signal the handle */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

/**
 * SIGTERM the process group, then SIGKILL it if pi has not exited after the
 * grace. Resolves once pi has exited — or, should it outlive even SIGKILL,
 * shortly after — so a caller can wait before the next spawn reuses its
 * session.
 */
export function stopProcessTree(child: ChildProcess, graceMs = stopGraceMs()): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalProcessGroup(child, 'SIGKILL');
      giveUp = setTimeout(resolve, KILL_WAIT_MS);
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(force);
      if (giveUp) clearTimeout(giveUp);
      resolve();
    });
    signalProcessGroup(child, 'SIGTERM');
  });
}

/** A small model's prompt budget is tight; memory beyond this is trimmed. */
const MEMORY_MAX_CHARS = Number(process.env.PI_MEMORY_MAX_CHARS) || 8000;
const MEMORY_HOOK_TIMEOUT_MS = 10_000;

/** Run `command` in a shell with `input` on stdin; never rejects. */
function runHookCommand(
  command: string,
  input: string,
  timeoutMs: number,
): Promise<{ stdout: string; status: number | null; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    const finish = (r: { stdout: string; status: number | null; error?: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ stdout, status: null, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', (err) => finish({ stdout, status: null, error: err.message }));
    child.on('close', (code) => finish({ stdout, status: code }));
    child.stdin?.on('error', () => {
      /* the hook need not read its input */
    });
    child.stdin?.end(input);
  });
}

/**
 * Run the registered memory session hook (startup source) and return its
 * output, trimmed to `maxChars`. Failures log and return undefined. Async:
 * the hook runs every turn and must not block the runner while it does.
 */
export async function runPiMemoryHook(
  hook: MemorySessionHookRegistration | undefined,
  maxChars = MEMORY_MAX_CHARS,
): Promise<string | undefined> {
  if (!hook || !hook.sources.includes('startup')) return undefined;
  const res = await runHookCommand(
    hook.command,
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
    MEMORY_HOOK_TIMEOUT_MS,
  );
  if (res.error || res.status !== 0) {
    log(`memory session hook failed (${res.error ?? `exit ${String(res.status)}`}); continuing without memory`);
    return undefined;
  }
  const out = res.stdout.trim();
  if (!out || out.length <= maxChars) return out || undefined;
  return (
    `${out.slice(0, maxChars)}\n` +
    `[memory truncated to ${maxChars} characters — the files under /workspace/agent/memory/ are authoritative; read them for the rest]`
  );
}

/** The text of an assistant message, joined across its text parts. */
function assistantText(message: PiEvent['message']): string {
  return (message?.content ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

const ENVELOPE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

/**
 * The turn's result text: the last assistant message, preceded by any complete
 * <message> envelope an EARLIER message of the turn wrote. Without this an
 * envelope written before a tool call was lost to the closing "Done.". Earlier
 * prose is not carried (it was narration between calls), an envelope the last
 * message repeats is not carried twice, and neither is one the `message` tool
 * already sent (`toolSent` holds `${to}\0${text}` signatures).
 */
export function composeTurnText(texts: string[], toolSent: ReadonlySet<string> = new Set()): string {
  const last = texts.at(-1) ?? '';
  const sent = new Set(
    [...toolSent].map((sig) => sig.replace(/\u0000([\s\S]*)$/, (_, t: string) => `\u0000${t.trim()}`)),
  );
  const seen = new Set<string>();
  for (const m of last.matchAll(ENVELOPE_RE)) seen.add(`${m[1]}\u0000${m[2].trim()}`);
  const carried: string[] = [];
  for (const earlier of texts.slice(0, -1)) {
    for (const m of earlier.matchAll(ENVELOPE_RE)) {
      const sig = `${m[1]}\u0000${m[2].trim()}`;
      if (seen.has(sig) || sent.has(sig)) continue;
      seen.add(sig);
      carried.push(m[0]);
    }
  }
  return [...carried, last].filter(Boolean).join('\n\n');
}

/** Map a backend error onto the runner's terminal-error classes. */
function classifyBackendError(message: string): string | undefined {
  if (/connection error|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up/i.test(message)) {
    return 'network';
  }
  if (/model .*not found|\b404\b/i.test(message)) return 'config';
  return undefined;
}

/** The one-line notice for a model the pi harness cannot serve. */
export function unservableModelMessage(model: string): string {
  return (
    `This agent's model (${model}) is not a local model, and the pi harness only runs local Ollama models. ` +
    'Assign the agent a local model, or switch it to a different harness.'
  );
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_ARGS = 4;

/** True when the host declared the current model as taking images. */
function modelTakesImages(piDir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path.join(piDir, 'models.json'), 'utf-8')) as {
      providers?: Record<string, { models?: Array<{ input?: string[] }> }>;
    };
    return Object.values(parsed.providers ?? {}).some((p) => (p.models ?? []).some((m) => m.input?.includes('image')));
  } catch {
    return false;
  }
}

/**
 * `@path` arguments for the image attachments the formatter listed in the
 * prompt (`[image: cat.png — saved to /workspace/…]`). Vision models only: pi
 * attaches an @-image as image content. A missing file makes pi exit, so each
 * path is checked first.
 */
export function imageFileArgs(text: string, piDir: string): string[] {
  if (!modelTakesImages(piDir)) return [];
  const args: string[] = [];
  for (const m of text.matchAll(/\[[^\]:\n]+: [^\]\n]*? — saved to (\/[^\]\n]+)\]/g)) {
    const file = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (!IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    try {
      if (!existsSync(file) || statSync(file).size === 0) continue;
    } catch {
      continue;
    }
    if (!args.includes(`@${file}`)) args.push(`@${file}`);
    if (args.length >= MAX_IMAGE_ARGS) break;
  }
  return args;
}

interface PiEvent {
  type?: string;
  id?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    /** 'error' when the backend request failed; pi still exits 0 in json mode. */
    stopReason?: string;
    errorMessage?: string;
  };
  /** thinking_end carries the whole block in `content`. */
  assistantMessageEvent?: { type?: string; delta?: string; content?: string };
  /** auto_retry_start / auto_retry_end. */
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
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
  /** The backend request failed (after pi's own retries). */
  error?: string;
}

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;
  /** Stops the running pi process, if any (SIGTERM, then SIGKILL after a grace). */
  private stopActive: (() => void) | null = null;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  private memoryHook: MemorySessionHookRegistration | undefined;

  // pi has no session-start hook, so the memory renderer runs per spawn and
  // its output rides in the appended system prompt.
  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memoryHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /session.*(not found|invalid|corrupt)|ENOENT.*sessions/i.test(msg);
  }

  /**
   * Run ONE message through a fresh `pi -p --mode json` process. Yields
   * reasoning lines through `emit`; resolves with the final assistant text.
   */
  private async runTurn(
    text: string,
    sessionId: string,
    emit: (ev: ProviderEvent) => void,
    opts: { toolsOff?: boolean } = {},
  ): Promise<TurnResult> {
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
    // Memory rides only on the APPEND path (tools on): the replace path exists
    // for the smallest possible prompt. Read before the spawn, off the event loop.
    const memory = toolsEnabled && this.currentSystem ? await runPiMemoryHook(this.memoryHook) : undefined;
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
        //
        args.push(
          toolsEnabled ? '--append-system-prompt' : '--system-prompt',
          memory ? `${memory}\n\n${system}` : system,
        );
      }
      args.push(...imageFileArgs(text, piDir), text);

      // stdin MUST be closed ('ignore'): pi in print mode also accepts piped
      // stdin and waits for its EOF before starting the turn — an open pipe
      // hangs the whole query.
      // cwd is load-bearing once tools are on: pi resolves read/write/edit
      // paths against it, so an unset cwd would put the agent's files wherever
      // the runner started rather than in its workspace.
      // detached: pi leads its own process group, so a stop reaches what it spawned.
      const child = spawn('pi', args, {
        cwd: this.currentCwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      // Text of every assistant message this turn, in order; see composeTurnText.
      const assistantTexts: string[] = [];
      let turnError: string | undefined;
      // Set once we decide to stop pi: anything it prints while shutting down
      // (an aborted partial message, say) is not part of the turn.
      let stopping = false;
      let stopped: Promise<void> | null = null;
      // Resolves once pi has exited (bounded): a turn that ends in a stop
      // settles only then, so the next turn never runs a second pi on the
      // same --session-id while this one is still shutting down.
      const stop = (): Promise<void> => {
        stopping = true;
        stopped ??= stopProcessTree(child);
        return stopped;
      };
      this.stopActive = () => void stop();
      let idleTimedOut = false;
      const idleError = (): Error => new Error(`pi idle timeout (${IDLE_TIMEOUT_MS}ms)`);
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
          idleTimedOut = true;
          // Usually 'close' settles first, with this same error; this covers
          // a pi that outlives SIGKILL.
          void stop().then(() => reject(idleError()));
          return;
        }
        if (TURN_TIMEOUT_MS > 0 && Date.now() - startedAt > TURN_TIMEOUT_MS) {
          // Resolve, not reject: whatever text the turn produced is worth
          // delivering, and an over-long turn is not an error the user needs
          // shown as one.
          log(`pi: turn exceeded ${TURN_TIMEOUT_MS}ms - cutting it short`);
          killedForTurnBudget = true;
          clearInterval(idle);
          stop();
        }
      }, 5000);

      const onLine = (line: string): void => {
        // Buffered lines can still arrive after we stop the child; ignore
        // them rather than log and re-stop a process on its way out.
        if (stopping) return;
        lastActivity = Date.now();
        let ev: PiEvent;
        try {
          ev = JSON.parse(line) as PiEvent;
        } catch {
          return; // non-JSON noise
        }
        if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'thinking_end') {
          // The whole block rides `detail` on its first line, for the bubble's
          // click-to-expand; the feed lines above are clipped.
          const full = ev.assistantMessageEvent.content ?? '';
          const tail = reasoningChunks(reasoningBuffer.slice(reasoningEmitted));
          reasoningEmitted = reasoningBuffer.length;
          const lines = tail.length > 0 ? tail : reasoningChunks(full).slice(-1);
          lines.forEach((l, i) => {
            notifyProviderMessage({
              kind: 'reasoning',
              text: l,
              ...(i === 0 && full.trim() ? { detail: full } : {}),
            } as Parameters<typeof notifyProviderMessage>[0]); // seam: direct, no ProviderEvent
          });
          emit({ type: 'activity' });
        } else if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'thinking_delta') {
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
              stop();
              return;
            }
          }
          emit({ type: 'activity' });
        } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
          // pi exits 0 in json mode even when the backend failed; the failure
          // is only visible here. A later good message (pi's own retry
          // succeeding) clears it, and a failed message's partial text is not
          // part of the reply.
          if (ev.message.stopReason === 'error') {
            turnError = ev.message.errorMessage || 'the model request failed';
          } else {
            turnError = undefined;
            assistantTexts.push(assistantText(ev.message));
          }
          emit({ type: 'activity' });
        } else if (ev.type === 'auto_retry_start') {
          log(
            `pi: backend error, retry ${ev.attempt ?? '?'}/${ev.maxAttempts ?? '?'} in ${ev.delayMs ?? '?'}ms: ${ev.errorMessage ?? ''}`,
          );
          emit({ type: 'activity' });
        } else if (ev.type === 'auto_retry_end') {
          if (ev.success === false) turnError = ev.finalError || turnError || 'the model request failed';
          emit({ type: 'activity' });
        } else {
          emit({ type: 'activity' });
        }
      };
      const stdout = new JsonLineSplitter();
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        for (const line of stdout.push(chunk)) onLine(line);
      });
      // pi's stderr is its only diagnostic channel; keep it in the runner log.
      const stderrLines = new JsonLineSplitter();
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
        for (const line of stderrLines.push(chunk)) if (line.trim()) console.error(`[pi] ${line}`);
      });
      child.on('error', (err) => {
        clearInterval(idle);
        reject(err);
      });
      // Settle on 'close', after stdout has drained: on 'exit' the last lines
      // — the final message_end among them — may still be in the pipe.
      let settled = false;
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearInterval(idle);
        this.stopActive = null;
        for (const line of stdout.flush()) onLine(line);
        for (const line of stderrLines.flush()) if (line.trim()) console.error(`[pi] ${line}`);
        const text = composeTurnText(assistantTexts, sentThisTurn);
        // We stopped it on purpose, so a nonzero code here is expected and
        // must not surface as a turn error. Hand back whatever text exists
        // (usually none) plus the flag the caller retries on.
        if (idleTimedOut) return reject(idleError());
        if (killedForTurnBudget) return resolve({ text, sawReasoning, deliveredViaMessageTool });
        if (killedForLoop) return resolve({ text, sawReasoning, loopedToolCall: true, deliveredViaMessageTool });
        if (code === 0) resolve({ text, sawReasoning, deliveredViaMessageTool, error: turnError });
        else reject(new Error(`pi exited ${code}${stderrTail ? `: ${stderrTail.slice(-400)}` : ''}`));
      };
      child.on('close', (code) => settle(code));
      // A grandchild holding the pipe open must not hold the turn open.
      child.on('exit', (code) => {
        setTimeout(() => settle(code), 2000).unref?.();
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
        // The host found the agent assigned a model pi cannot serve. Say so
        // instead of running against whatever the install-wide fallback is.
        const unservable = process.env.PI_UNSERVABLE_MODEL;
        if (unservable) {
          log(`pi: assigned model ${unservable} is not servable by pi — failing the turn`);
          yield { type: 'result', text: null, isError: true, error: unservableModelMessage(unservable) };
          continue;
        }
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
        const deliverable = redundantConfirmation ? null : result.text || null;

        // A failed backend request ends the turn as a failure. It must never
        // reach the retries below: an errored turn has no text, and the stall
        // branch would read that as a reasoning-only turn and run it again.
        if (result.error) {
          log(`pi: turn failed: ${result.error}`);
          const classification = classifyBackendError(result.error);
          yield {
            type: 'error',
            message: result.error,
            retryable: false,
            ...(classification ? { classification } : {}),
          };
          yield { type: 'result', text: deliverable, isError: true };
          continue;
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

        // Thinking-stall recovery.
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
        yield { type: 'result', text: deliverable };
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
        this.stopActive?.();
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
