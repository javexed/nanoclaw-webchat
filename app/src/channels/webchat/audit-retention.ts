/**
 * Audit log retention as set in Admin → Audit log. src/audit.ts owns the files
 * and the rule; it is a leaf and cannot read settings, so this pushes the
 * stored values in (setAuditRetention) at boot and on every change.
 *
 * Stored as {days, maxMb}; NULL means the environment's starting values.
 */
import { envAuditRetention, setAuditRetention, type AuditRetention } from '../../audit.js';
import { log } from '../../log.js';

import { getAuditRetentionRaw } from './db.js';

const MB = 1024 * 1024;
export const MAX_DAYS = 3650;
export const MIN_MB = 10;
export const MAX_MB = 1_000_000;

export interface RetentionSetting {
  days: number;
  maxMb: number;
}

export function toRetention(s: RetentionSetting): AuditRetention {
  return { days: s.days, maxBytes: s.maxMb * MB };
}

export function fromRetention(r: AuditRetention): RetentionSetting {
  return { days: r.days, maxMb: Math.round(r.maxBytes / MB) };
}

/** Validate what the page sent: whole days 0 (forever) … 3650, a cap of 10 MB or more. */
export function parseRetention(raw: unknown): { ok: true; value: RetentionSetting } | { ok: false; error: string } {
  const b = (raw ?? {}) as { days?: unknown; maxMb?: unknown };
  const days = b.days;
  const maxMb = b.maxMb;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_DAYS)
    return { ok: false, error: `days must be a whole number from 0 (forever) to ${MAX_DAYS}` };
  if (typeof maxMb !== 'number' || !Number.isInteger(maxMb) || maxMb < MIN_MB || maxMb > MAX_MB)
    return { ok: false, error: `maxMb must be a whole number from ${MIN_MB} to ${MAX_MB}` };
  return { ok: true, value: { days, maxMb } };
}

/** The stored setting, or null when none is (or it is unreadable: the environment's then apply). */
export async function readRetentionSetting(): Promise<RetentionSetting | null> {
  try {
    const raw = await getAuditRetentionRaw();
    if (!raw) return null;
    const parsed = parseRetention(JSON.parse(raw));
    if (parsed.ok) return parsed.value;
    log.warn('Audit retention in the database is invalid — using the environment defaults', { error: parsed.error });
  } catch (err) {
    log.warn('Audit retention unreadable — using the environment defaults', { err: String(err) });
  }
  return null;
}

/** Boot: apply what is stored (and prune to it). */
export async function applyStoredRetention(): Promise<void> {
  const s = await readRetentionSetting();
  setAuditRetention(s ? toRetention(s) : null);
}

export const defaultRetention = (): RetentionSetting => fromRetention(envAuditRetention());
