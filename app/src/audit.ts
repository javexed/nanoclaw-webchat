/**
 * Audit log — an append-only JSONL record of security-relevant events.
 *
 * WHAT GOES HERE. Events an operator needs after the fact: who authenticated
 * and how, which privileged actions were attempted and what the guard decided,
 * who gained a role. NOT application logging — log.ts is for that. The test
 * for inclusion is "would this line answer a 'who did what' question during an
 * incident?". The concrete incident that motivated this: a fresh install's
 * one-shot owner grant was consumed by an unnoticed loopback request, and
 * nothing on disk could say by whom.
 *
 * WHY A LEAF. guard.ts is constrained to leaf imports only (see
 * src/guard/types.ts) — it may import log and shared types, never
 * src/modules/*. Audit sits beside log.ts at the same tier so the guard seam
 * can emit without violating that boundary. This module imports fs, path and
 * log — nothing else. Keep it that way.
 *
 * WHY JSONL ON DISK, ALWAYS ON. Forwarders (syslog etc.) are configuration:
 * they go down, get repointed, or don't exist yet. The local file is the
 * floor — one line per event, greppable, no setup. A forwarding sink can be
 * layered on later; it must never replace this.
 *
 * WHAT IS DELIBERATELY NOT RECORDED: action payloads. They can carry message
 * text, env values and other secrets, and an audit log that hoards secrets
 * becomes the thing you leak. Events carry identifiers (actor, action,
 * resource ids, approval ids) — enough to reconstruct WHO did WHAT to WHICH,
 * never the contents.
 *
 * RETENTION. The live file rolls over daily (UTC) into
 * audit-YYYY-MM-DD.jsonl.gz beside it, and day files older than the retention
 * window are deleted (default 90 days; NANOCLAW_AUDIT_KEEP_DAYS, 0 = forever).
 * A size cap backs that up (NANOCLAW_AUDIT_MAX_MB, default 200): past it the
 * oldest day goes early, even under "forever", so a scanner or a runaway
 * client can never fill the disk. The live file also rolls early at a quarter
 * of the cap. Admin → Audit log sets both (webchat pushes them in with
 * setAuditRetention — this module is a leaf and cannot read settings), and
 * the change is itself audited before it takes effect.
 *
 * Failure posture: auditing must never take the app down. A write failure
 * degrades to a log.warn (throttled so a full disk doesn't melt the app log)
 * and the caller proceeds. That is a deliberate availability-over-audit
 * trade for this install class; a deployment that needs fail-closed auditing
 * should invert emitFailed's behavior, not bolt a wrapper on top.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import { log } from './log.js';

export interface AuditEvent {
  /** Dotted kind, e.g. 'guard.decision', 'auth.session', 'auth.denied', 'role.grant'. */
  type: string;
  /** Normalized actor string — use auditActor() for guard actors. */
  actor?: string;
  /** The action attempted, for guard events. */
  action?: string;
  /** Outcome: allow | hold | deny | granted | failed … */
  effect?: string;
  reason?: string;
  /** Identifiers only — never payload contents. */
  detail?: Record<string, unknown>;
}

/** Monotonic within a process; with pid, orders events across restarts. */
let seq = 0;

let warnedAt = 0;
function emitFailed(err: unknown): void {
  // One warning per minute, not one per event — a full disk otherwise turns
  // every audited request into an error line of its own.
  if (Date.now() - warnedAt < 60_000) return;
  warnedAt = Date.now();
  log.warn('audit: write failed — events are being DROPPED', { err, file: auditFilePath() });
}

/**
 * Resolved per call, not at module load: tests point it into a scratch dir via
 * the env override, and an operator can relocate it without a code change.
 */
export function auditFilePath(): string {
  return process.env.NANOCLAW_AUDIT_FILE || path.join(process.cwd(), 'logs', 'audit.jsonl');
}

const MB = 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;

export interface AuditRetention {
  /** Days of history kept; 0 = forever (the size cap still applies). */
  days: number;
  /** Cap on the live file plus its day files, in bytes. */
  maxBytes: number;
}

/** The starting values, from the environment: 90 days, 200 MB. */
export function envAuditRetention(): AuditRetention {
  const num = (k: string, dflt: number, ok: (n: number) => boolean) => {
    const raw = process.env[k]?.trim();
    const n = Number(raw);
    return raw && Number.isFinite(n) && ok(n) ? n : dflt;
  };
  return {
    days: Math.floor(num('NANOCLAW_AUDIT_KEEP_DAYS', 90, (n) => n >= 0)),
    maxBytes: num('NANOCLAW_AUDIT_MAX_MB', 200, (n) => n >= 1) * MB,
  };
}

let retention: AuditRetention | null = null;

export function auditRetention(): AuditRetention {
  return retention ?? envAuditRetention();
}

/** Apply retention from settings (null = back to the environment's) and prune at once. */
export function setAuditRetention(next: AuditRetention | null): void {
  retention = next;
  pruneAuditFiles();
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** audit.jsonl → "audit"; the day files are <stem>-YYYY-MM-DD[.N].jsonl[.gz]. */
function stemOf(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '');
}

interface DayFile {
  path: string;
  day: string;
  n: number;
  bytes: number;
}

/** The rolled-over day files beside `file`, oldest first. */
export function auditDayFiles(file: string = auditFilePath()): DayFile[] {
  const dir = path.dirname(file);
  const stem = stemOf(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${stem}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.jsonl(?:\\.gz)?$`);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: DayFile[] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const p = path.join(dir, name);
    let bytes = 0;
    try {
      bytes = fs.statSync(p).size;
    } catch {
      continue;
    }
    out.push({ path: p, day: m[1], n: Number(m[2] ?? 1), bytes });
  }
  return out.sort((x, y) => (x.day === y.day ? x.n - y.n : x.day < y.day ? -1 : 1));
}

/** Bytes in the live file, tracked per path so a write costs no stat. */
const liveBytes = new Map<string, number>();
/** The UTC day the live file's events belong to. */
const liveDay = new Map<string, string>();

/**
 * Move the live file aside as that day's file and compress it. Rename first,
 * so the next event starts a fresh file even if compression then fails (the
 * plain .jsonl day file stays, and still counts and ages out like the rest).
 */
export function rollAuditFile(file: string, day: string): void {
  liveBytes.set(file, 0);
  if (!fs.existsSync(file)) return;
  const base = path.join(path.dirname(file), `${stemOf(file)}-${day}`);
  let n = 1;
  const name = (i: number) => (i === 1 ? base : `${base}.${i}`);
  while (fs.existsSync(`${name(n)}.jsonl.gz`) || fs.existsSync(`${name(n)}.jsonl`)) n++;
  const plain = `${name(n)}.jsonl`;
  fs.renameSync(file, plain);
  fs.writeFileSync(`${plain}.gz.tmp`, zlib.gzipSync(fs.readFileSync(plain)));
  fs.renameSync(`${plain}.gz.tmp`, `${plain}.gz`);
  fs.rmSync(plain, { force: true });
}

/** Delete day files past the window, then the oldest while over the cap. Never throws. */
export function pruneAuditFiles(file: string = auditFilePath(), now: number = Date.now()): void {
  try {
    const { days, maxBytes } = auditRetention();
    let files = auditDayFiles(file);
    if (days > 0) {
      const cutoff = utcDay(now - days * DAY_MS);
      for (const f of files.filter((f) => f.day < cutoff)) fs.rmSync(f.path, { force: true });
      files = files.filter((f) => f.day >= cutoff);
    }
    let live = 0;
    try {
      live = fs.statSync(file).size;
    } catch {
      live = 0;
    }
    let total = live + files.reduce((t, f) => t + f.bytes, 0);
    while (total > maxBytes && files.length) {
      const f = files.shift()!;
      fs.rmSync(f.path, { force: true });
      total -= f.bytes;
    }
  } catch (err) {
    emitFailed(err);
  }
}

/** What the Admin page shows: bytes on disk, and the oldest day still held. */
export function auditUsage(file: string = auditFilePath()): { bytes: number; oldestDay: string | null } {
  const files = auditDayFiles(file);
  let live = 0;
  let liveFrom: string | null = null;
  try {
    const st = fs.statSync(file);
    live = st.size;
    liveFrom = liveDay.get(file) ?? utcDay(st.mtimeMs);
  } catch {
    live = 0;
  }
  return { bytes: live + files.reduce((t, f) => t + f.bytes, 0), oldestDay: files[0]?.day ?? liveFrom };
}

/** Roll the live file over when the day changed, or when it passes a quarter of the cap. */
function maybeRoll(file: string, now: number, adding: number): void {
  const today = utcDay(now);
  let day = liveDay.get(file);
  if (day === undefined) {
    // First write in this process: the file's last write says which day it holds.
    try {
      day = utcDay(fs.statSync(file).mtimeMs);
      liveBytes.set(file, fs.statSync(file).size);
    } catch {
      day = today;
      liveBytes.set(file, 0);
    }
  }
  const size = (liveBytes.get(file) ?? 0) + adding;
  if (day !== today) {
    rollAuditFile(file, day);
    liveDay.set(file, today);
    pruneAuditFiles(file, now);
  } else if (size >= auditRetention().maxBytes / 4) {
    rollAuditFile(file, today);
    pruneAuditFiles(file, now);
  }
  liveDay.set(file, today);
}

/**
 * Forwarding sinks — syslog and whatever comes later. Registered from
 * webchat-land rather than read from config HERE, because this module is a
 * leaf and must stay one: it cannot import the channel's settings layer, so
 * the channel pushes a closure in instead. Sinks receive the exact line the
 * file got (plus the event for severity mapping); a sink that throws is the
 * sink's bug and is contained here — forwarding must never break the floor.
 */
export type AuditSink = (line: string, event: AuditEvent) => void;
let sinks: AuditSink[] = [];
export function setAuditSinks(next: AuditSink[]): void {
  sinks = next;
}

/** Append one event. Never throws. */
export function audit(event: AuditEvent): void {
  let line: string;
  try {
    const file = auditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      seq: ++seq,
      ...event,
    });
    // Sync append: audit events are low-frequency (auth transitions and
    // privileged actions, not message traffic), and a synchronous write can't
    // be lost to an exit between the decision and the flush.
    const bytes = Buffer.byteLength(line) + 1;
    maybeRoll(file, Date.now(), bytes);
    fs.appendFileSync(file, line + '\n');
    liveBytes.set(file, (liveBytes.get(file) ?? 0) + bytes);
  } catch (err) {
    emitFailed(err);
    return;
  }
  for (const sink of sinks) {
    try {
      sink(line, event);
    } catch {
      /* the sink tracks its own failures; the floor does not care */
    }
  }
}

/**
 * Normalize a guard actor to one string. Structurally typed rather than
 * importing GuardActor: the leaf rule cuts both ways, and audit must not grow
 * a dependency on guard's types to stay importable from anywhere.
 */
export function auditActor(actor: { kind: string; userId?: string; agentGroupId?: string } | null | undefined): string {
  if (!actor) return '(none)';
  if (actor.kind === 'human') return `human:${actor.userId ?? '(unknown)'}`;
  if (actor.kind === 'agent') return `agent:${actor.agentGroupId ?? '(unknown)'}`;
  return actor.kind; // host | system
}

// ── Reading it back ─────────────────────────────────────────────────────────
// The write path above is the contract; this is the read path the Admin viewer
// uses. It lives here because the file format is this module's business and
// nothing else should be teaching itself to parse these lines. Still a leaf:
// fs and path, nothing more.

/** One stored event, as parsed back off disk. */
export interface StoredAuditEvent extends AuditEvent {
  ts: string;
  pid: number;
  seq: number;
}

export interface AuditQuery {
  limit?: number;
  /** Exact match on the dotted kind, e.g. 'guard.decision'. */
  type?: string;
  /** Exact match on the outcome, e.g. 'deny'. */
  effect?: string;
  /** Substring match, so 'alice' finds 'human:webchat:alice'. */
  actor?: string;
  /** Cursor: return only events strictly older than this ISO timestamp. */
  beforeTs?: string;
}

export interface AuditPage {
  events: StoredAuditEvent[];
  /** More matches exist older than the last one returned. */
  hasMore: boolean;
  /**
   * The scan hit its byte budget before reaching the start of the file, so
   * "no more matches" means "none in the window", not "none ever". Surfaced so
   * the UI can say so rather than implying it has shown everything.
   */
  truncated: boolean;
}

/**
 * How much of the tail to scan per request.
 *
 * The file is append-only and the viewer wants the NEWEST entries, so reading
 * the tail is both the cheap answer and the right one. A budget rather than
 * the whole file because this is a log that only grows, and an operator with a
 * year of history should not hand the event loop a 200MB parse to render fifty
 * rows.
 */
const READ_WINDOW_BYTES = 2 * 1024 * 1024;

/**
 * Read events newest-first. Never throws: a missing or unreadable file is an
 * empty page, because the viewer asking "what happened" must not itself become
 * the thing that breaks.
 */
export function readAuditEvents(query: AuditQuery = {}): AuditPage {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  let buf: string;
  let truncated = false;
  try {
    const file = auditFilePath();
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - READ_WINDOW_BYTES);
    // Older days rolled into audit-YYYY-MM-DD.jsonl.gz are history too: "no
    // more matches" then means none in the live file, not none ever.
    truncated = start > 0 || auditDayFiles(file).length > 0;
    const fd = fs.openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(size - start);
      fs.readSync(fd, bytes, 0, bytes.length, start);
      buf = bytes.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { events: [], hasMore: false, truncated: false };
  }

  const lines = buf.split('\n');
  // Starting mid-file almost always lands mid-line; that first fragment is not
  // a record and must not be parsed as one.
  if (truncated) lines.shift();

  const out: StoredAuditEvent[] = [];
  let hasMore = false;
  // Backwards: newest first, and it lets the scan stop at the limit instead of
  // parsing the whole window to then throw most of it away.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev: StoredAuditEvent;
    try {
      ev = JSON.parse(line) as StoredAuditEvent;
    } catch {
      continue; // a torn write, or the fragment above — skip, never fail the page
    }
    if (!ev || typeof ev.type !== 'string') continue;
    if (query.beforeTs && !(ev.ts < query.beforeTs)) continue;
    if (query.type && ev.type !== query.type) continue;
    if (query.effect && ev.effect !== query.effect) continue;
    if (query.actor && !(ev.actor ?? '').includes(query.actor)) continue;
    if (out.length === limit) {
      hasMore = true; // one match beyond the page — stop, don't count them all
      break;
    }
    out.push(ev);
  }
  return { events: out, hasMore, truncated };
}

/** The distinct types and effects present in the window, for the filter menus. */
export function readAuditFacets(): { types: string[]; effects: string[] } {
  const page = readAuditEvents({ limit: 500 });
  const types = new Set<string>();
  const effects = new Set<string>();
  for (const e of page.events) {
    if (e.type) types.add(e.type);
    if (e.effect) effects.add(e.effect);
  }
  return { types: [...types].sort(), effects: [...effects].sort() };
}
