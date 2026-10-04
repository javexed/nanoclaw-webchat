// ── Turn trace view ──────────────────────────────────────────────────────────
// One shape for "what the agent did this turn", whether it comes from the live
// bubble or from the stored trace a reply fetches on first open — so TraceView
// renders both the same way.
import { reactive } from 'vue';
import { apiJson } from '../core/api.js';
import type { ThinkingTurn } from './transcript-state.js';

export interface TraceViewTool {
  name: string;
  target: string | null;
  ms: number | null;
  /** null = the feed did not say. */
  ok: boolean | null;
}

export interface TraceViewNote {
  kind: string;
  text: string;
}

export interface TraceMeta {
  harness: string | null;
  model: string | null;
  host: string | null;
}

export interface TraceView extends TraceMeta {
  durationMs: number | null;
  tools: TraceViewTool[];
  notes: TraceViewNote[];
  reasoning: string[];
  truncated: boolean;
}

export const traceHasContent = (v: TraceView | null | undefined): boolean =>
  !!v && (v.tools.length > 0 || v.notes.length > 0 || v.reasoning.length > 0);

/** 850ms · 4.2s · 2m 05s */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** harness · model · host · duration — whichever parts are known. */
export function metaLine(v: TraceView): string {
  return [v.harness, v.model, v.host, formatMs(v.durationMs)].filter(Boolean).join(' · ');
}

/** The live turn as a view. `now` closes a tool still running when the reply lands. */
export function traceViewFromTurn(turn: ThinkingTurn, now?: number): TraceView {
  return {
    harness: turn.meta?.harness ?? null,
    model: turn.meta?.model ?? null,
    host: turn.meta?.host ?? null,
    durationMs: now === undefined ? null : Math.max(0, now - turn.startedAt),
    tools: turn.tools.map((t) => ({
      name: t.name,
      target: t.target,
      ms: t.ms ?? (now === undefined ? null : Math.max(0, now - t.at)),
      ok: null,
    })),
    notes: turn.notes.map((n) => ({ ...n })),
    // Same preference the expanded bubble has always had: full blocks over feed lines.
    reasoning: (turn.fullTrace.length ? turn.fullTrace : turn.reasoningLog).slice(),
    truncated: false,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A stored trace (GET /api/messages/:id/trace → .trace) as a view. Tolerates missing fields. */
export function traceViewFromStored(t: any): TraceView {
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  return {
    harness: str(t?.harness),
    model: str(t?.model),
    host: str(t?.host),
    durationMs: num(t?.durationMs),
    tools: arr(t?.tools).map((x) => ({
      name: str(x?.name) ?? 'tool',
      target: str(x?.target),
      ms: num(x?.ms),
      ok: typeof x?.ok === 'boolean' ? x.ok : null,
    })),
    notes: arr(t?.notes)
      .filter((n) => str(n?.text))
      .map((n) => ({ kind: str(n?.kind) ?? 'progress', text: n.text })),
    reasoning: arr(t?.reasoning).filter((r): r is string => typeof r === 'string'),
    truncated: t?.truncated === true,
  };
}

export type TraceLoad =
  | { status: 'loading' }
  | { status: 'ok'; view: TraceView }
  | { status: 'none' }
  | { status: 'error' };

/** Stored traces fetched this session, by message id. Never filled eagerly. */
export const traceLoads = reactive(new Map<string, TraceLoad>());

/** Fetch a reply's stored trace once (a failure may be retried on the next open). */
export async function loadTrace(messageId: string): Promise<void> {
  const cur = traceLoads.get(messageId);
  if (cur && cur.status !== 'error') return;
  traceLoads.set(messageId, { status: 'loading' });
  try {
    const data = await apiJson(`/api/messages/${encodeURIComponent(messageId)}/trace`);
    traceLoads.set(messageId, { status: 'ok', view: traceViewFromStored(data?.trace) });
  } catch (err: any) {
    traceLoads.set(messageId, { status: err?.status === 404 ? 'none' : 'error' });
  }
}

/** A trace was (re)stored for this message: drop what was cached so the next open refetches. */
export function forgetTrace(messageId: string): void {
  traceLoads.delete(messageId);
}
