/**
 * audit() — the contract is durability-shaped, so that is what gets tested:
 * one parseable line per event, the directory springs into being, and a
 * broken destination degrades to a warning instead of taking the caller down.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { audit, auditActor, auditFilePath, readAuditEvents } from './audit.js';

/** Scratch dirs this file makes, removed when it finishes. */
const SCRATCH: string[] = [];
function scratchDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  SCRATCH.push(d);
  return d;
}
afterAll(() => {
  for (const d of SCRATCH) fs.rmSync(d, { recursive: true, force: true });
  SCRATCH.length = 0;
});

let file: string;
beforeEach(() => {
  file = path.join(scratchDir(), 'audit.jsonl');
  vi.stubEnv('NANOCLAW_AUDIT_FILE', file);
});
afterEach(() => vi.unstubAllEnvs());

const lines = () =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('audit', () => {
  it('appends one parseable JSON line per event, with ts/pid/seq stamped', () => {
    audit({ type: 'auth.session', actor: 'human:webchat:alice', detail: { source: 'tailscale' } });
    audit({ type: 'guard.decision', action: 'a2a.send', effect: 'deny', reason: 'no policy' });

    const rows = lines();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: 'auth.session', actor: 'human:webchat:alice' });
    expect(rows[1]).toMatchObject({ type: 'guard.decision', effect: 'deny' });
    for (const r of rows) {
      expect(typeof r.ts).toBe('string');
      expect(Number.isNaN(Date.parse(r.ts as string))).toBe(false);
      expect(typeof r.pid).toBe('number');
    }
    // seq strictly increases — the tiebreaker when two events share a ms.
    expect((rows[1].seq as number) > (rows[0].seq as number)).toBe(true);
  });

  it('creates the destination directory if it is missing', () => {
    const nested = path.join(scratchDir(), 'a', 'b', 'audit.jsonl');
    vi.stubEnv('NANOCLAW_AUDIT_FILE', nested);
    audit({ type: 'auth.session' });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('never throws when the destination is unwritable', () => {
    // A DIRECTORY at the file's path — appendFileSync will refuse.
    const dirAsFile = scratchDir();
    vi.stubEnv('NANOCLAW_AUDIT_FILE', dirAsFile);
    expect(() => audit({ type: 'auth.session' })).not.toThrow();
  });

  it('honors the env override, resolved per call', () => {
    expect(auditFilePath()).toBe(file);
    vi.stubEnv('NANOCLAW_AUDIT_FILE', '/elsewhere/audit.jsonl');
    expect(auditFilePath()).toBe('/elsewhere/audit.jsonl');
  });
});

describe('auditActor', () => {
  it('normalizes every actor kind', () => {
    expect(auditActor({ kind: 'human', userId: 'webchat:alice' })).toBe('human:webchat:alice');
    expect(auditActor({ kind: 'agent', agentGroupId: 'g1' })).toBe('agent:g1');
    expect(auditActor({ kind: 'host' })).toBe('host');
    expect(auditActor({ kind: 'system' })).toBe('system');
    expect(auditActor(null)).toBe('(none)');
    expect(auditActor({ kind: 'human' })).toBe('human:(unknown)');
  });
});

describe('readAuditEvents', () => {
  const write = (rows: Array<Record<string, unknown>>) =>
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const ev = (n: number, over: Record<string, unknown> = {}) => ({
    ts: `2026-08-1${n}T00:00:00.000Z`,
    pid: 1,
    seq: n,
    type: 'auth.session',
    actor: 'human:webchat:alice',
    effect: 'allow',
    ...over,
  });

  it('returns newest first and respects the limit', () => {
    write([ev(1), ev(2), ev(3)]);
    const page = readAuditEvents({ limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([3, 2]);
    // A third match exists, so the page says so rather than counting the rest.
    expect(page.hasMore).toBe(true);
    expect(page.truncated).toBe(false);
  });

  it('filters by type, effect and actor substring', () => {
    write([
      ev(1, { type: 'guard.decision', effect: 'deny', actor: 'agent:g1' }),
      ev(2, { type: 'auth.session', effect: 'allow', actor: 'human:webchat:bob' }),
      ev(3, { type: 'guard.decision', effect: 'allow', actor: 'agent:g2' }),
    ]);
    expect(readAuditEvents({ type: 'guard.decision' }).events.map((e) => e.seq)).toEqual([3, 1]);
    expect(readAuditEvents({ effect: 'deny' }).events.map((e) => e.seq)).toEqual([1]);
    // Substring, so a bare name finds the namespaced identity.
    expect(readAuditEvents({ actor: 'bob' }).events.map((e) => e.seq)).toEqual([2]);
  });

  it('pages older with the beforeTs cursor', () => {
    write([ev(1), ev(2), ev(3)]);
    const first = readAuditEvents({ limit: 2 });
    const older = readAuditEvents({ limit: 2, beforeTs: first.events[first.events.length - 1].ts });
    expect(older.events.map((e) => e.seq)).toEqual([1]);
    expect(older.hasMore).toBe(false);
  });

  it('skips a torn line instead of failing the page', () => {
    // A half-written record is what a crash mid-append leaves behind. The
    // viewer must still render everything around it.
    fs.writeFileSync(file, `${JSON.stringify(ev(1))}\n{"ts":"2026-08-12T00:00:00.0\n${JSON.stringify(ev(3))}\n`);
    expect(readAuditEvents().events.map((e) => e.seq)).toEqual([3, 1]);
  });

  it('is an empty page when the file does not exist', () => {
    vi.stubEnv('NANOCLAW_AUDIT_FILE', path.join(scratchDir(), 'nope', 'audit.jsonl'));
    expect(readAuditEvents()).toEqual({ events: [], hasMore: false, truncated: false });
  });
});
