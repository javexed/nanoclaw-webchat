/**
 * One agent turn's record, built from the same status events the thinking
 * bubble shows (turn-traces.ts captures and stores it). Pure: no DB, no clock
 * beyond the timestamps it is handed, so capture and the size cap test alone.
 */

/** Stored size cap for one trace; reasoning is cut first, with TRUNCATED_MARK. */
export const TRACE_MAX_BYTES = 256 * 1024;
export const TRUNCATED_MARK = '… [truncated]';
const TARGET_MAX = 300;
const NOTE_MAX = 2000;
const TOOLS_MAX = 300;
const NOTES_MAX = 100;
// Raw reasoning held in memory before the cap is applied; past it a turn stops collecting.
const REASONING_HOLD_MAX = 2 * TRACE_MAX_BYTES;

export type TraceOutcome = 'done' | 'error' | 'stalled' | 'open';

export interface TraceTool {
  name: string;
  target: string | null;
  at: number;
  /** Until the next event; null while it is the latest one. */
  ms: number | null;
  /** The feed does not report tool results, so this is null unless a provider says. */
  ok: boolean | null;
}

export interface TraceNote {
  kind: 'progress' | 'error' | 'stalled';
  text: string;
  at: number;
}

export interface TraceMeta {
  agent: string | null;
  harness: string | null;
  model: string | null;
  host: string | null;
}

export interface TurnTrace extends TraceMeta {
  v: 1;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  outcome: TraceOutcome;
  tools: TraceTool[];
  notes: TraceNote[];
  /** Full reasoning blocks when the provider sent them, else its feed lines. */
  reasoning: string[];
  truncated: boolean;
}

export interface TraceEvent {
  kind: string;
  text: string | null;
  detail: string | null;
  at: number;
}

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);

export class TraceBuilder {
  private readonly tools: TraceTool[] = [];
  private readonly notes: TraceNote[] = [];
  private readonly blocks: string[] = [];
  private readonly lines: string[] = [];
  private held = 0;
  private truncated = false;
  private toolOpen = false;
  private endedAt: number | null = null;
  private outcome: TraceOutcome = 'open';

  constructor(
    private readonly meta: TraceMeta,
    readonly startedAt: number,
  ) {}

  get isOpen(): boolean {
    return this.endedAt === null;
  }

  private closeTool(at: number): void {
    if (!this.toolOpen) return;
    const t = this.tools[this.tools.length - 1]!;
    t.ms = Math.max(0, at - t.at);
    this.toolOpen = false;
  }

  private hold(s: string, into: string[]): void {
    if (this.held + s.length > REASONING_HOLD_MAX) {
      this.truncated = true;
      return;
    }
    this.held += s.length;
    into.push(s);
  }

  private note(kind: TraceNote['kind'], text: string, at: number): void {
    if (this.notes.length >= NOTES_MAX) {
      this.truncated = true;
      return;
    }
    this.notes.push({ kind, text: clip(text, NOTE_MAX), at });
  }

  add(ev: TraceEvent): void {
    this.closeTool(ev.at);
    switch (ev.kind) {
      case 'tool':
        if (this.tools.length >= TOOLS_MAX) {
          this.truncated = true;
          return;
        }
        this.tools.push({
          name: ev.text || 'tool',
          target: ev.detail ? clip(ev.detail, TARGET_MAX) : null,
          at: ev.at,
          ms: null,
          ok: null,
        });
        this.toolOpen = true;
        return;
      case 'progress':
        if (ev.text) this.note('progress', ev.text, ev.at);
        return;
      case 'reasoning':
        // Same choice the live bubble makes: the untruncated block rides `detail`
        // on a block's first line; providers without it only send the lines.
        if (ev.detail) this.hold(ev.detail, this.blocks);
        if (ev.text) this.hold(ev.text, this.lines);
        return;
    }
  }

  /** The turn's reply was a failure notice: keep its text and mark the turn. */
  error(text: string, at: number): void {
    this.note('error', text, at);
    this.outcome = 'error';
  }

  end(kind: 'done' | 'stalled', at: number): void {
    this.closeTool(at);
    if (kind === 'stalled') {
      this.note('stalled', 'The agent stopped responding.', at);
      if (this.outcome !== 'error') this.outcome = 'stalled';
    } else if (this.outcome === 'open') this.outcome = 'done';
    this.endedAt = at;
  }

  build(): TurnTrace {
    return {
      v: 1,
      ...this.meta,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.endedAt === null ? null : Math.max(0, this.endedAt - this.startedAt),
      outcome: this.outcome,
      tools: this.tools.map((t) => ({ ...t })),
      notes: this.notes.map((n) => ({ ...n })),
      reasoning: (this.blocks.length ? this.blocks : this.lines).slice(),
      truncated: this.truncated,
    };
  }
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Serialize within `max` bytes. Reasoning goes first, from the end, and the
 * last kept entry is marked; tools and notes are halved only once no reasoning
 * is left to cut. Every pass removes at least the overshoot, so it terminates.
 */
export function fitTrace(trace: TurnTrace, max = TRACE_MAX_BYTES): string {
  let json = JSON.stringify(trace);
  while (bytes(json) > max) {
    trace.truncated = true;
    const over = bytes(json) - max + bytes(TRUNCATED_MARK) + 16;
    const r = trace.reasoning;
    if (r.length) {
      const last = r.length - 1;
      const s = r[last]!.endsWith(TRUNCATED_MARK) ? r[last]!.slice(0, -TRUNCATED_MARK.length) : r[last]!;
      if (s.length <= over) {
        r.pop();
        if (r.length && !r[r.length - 1]!.endsWith(TRUNCATED_MARK)) r[r.length - 1] += TRUNCATED_MARK;
      } else {
        r[last] = s.slice(0, s.length - over) + TRUNCATED_MARK;
      }
    } else if (trace.tools.length > 1) {
      trace.tools = trace.tools.slice(0, Math.floor(trace.tools.length / 2));
    } else if (trace.notes.length) {
      trace.notes = trace.notes.slice(0, Math.floor(trace.notes.length / 2));
    } else if (trace.tools.length) {
      trace.tools = [];
    } else {
      break; // only scalar metadata left — nothing more to cut
    }
    json = JSON.stringify(trace);
  }
  return json;
}

/** `host[:port]` of a model endpoint, or null. Never the userinfo or path. */
export function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host || null;
  } catch {
    return null;
  }
}
