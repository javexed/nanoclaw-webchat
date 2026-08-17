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
 * Failure posture: auditing must never take the app down. A write failure
 * degrades to a log.warn (throttled so a full disk doesn't melt the app log)
 * and the caller proceeds. That is a deliberate availability-over-audit
 * trade for this install class; a deployment that needs fail-closed auditing
 * should invert emitFailed's behavior, not bolt a wrapper on top.
 */
import fs from 'fs';
import path from 'path';

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
    fs.appendFileSync(file, line + '\n');
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
