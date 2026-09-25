/**
 * audit() — the contract is durability-shaped, so that is what gets tested:
 * one parseable line per event, the directory springs into being, and a
 * broken destination degrades to a warning instead of taking the caller down.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import zlib from 'zlib';

import {
  audit,
  auditActor,
  auditDayFiles,
  auditFilePath,
  auditUsage,
  envAuditRetention,
  pruneAuditFiles,
  readAuditEvents,
  rollAuditFile,
  setAuditRetention,
} from './audit.js';

/** Scratch dirs this file makes, removed when it finishes. */
const SCRATCH: string[] = [];
function scratchDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  SCRATCH.push(d);
  return d;
}
afterAll(async () => {
  for (const d of SCRATCH) fs.rmSync(d, { recursive: true, force: true });
  SCRATCH.length = 0;
});

let file: string;
beforeEach(async () => {
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
  it('appends one parseable JSON line per event, with ts/pid/seq stamped', async () => {
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

  it('creates the destination directory if it is missing', async () => {
    const nested = path.join(scratchDir(), 'a', 'b', 'audit.jsonl');
    vi.stubEnv('NANOCLAW_AUDIT_FILE', nested);
    audit({ type: 'auth.session' });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('never throws when the destination is unwritable', async () => {
    // A DIRECTORY at the file's path — appendFileSync will refuse.
    const dirAsFile = scratchDir();
    vi.stubEnv('NANOCLAW_AUDIT_FILE', dirAsFile);
    expect(() => audit({ type: 'auth.session' })).not.toThrow();
  });

  it('honors the env override, resolved per call', async () => {
    expect(auditFilePath()).toBe(file);
    vi.stubEnv('NANOCLAW_AUDIT_FILE', '/elsewhere/audit.jsonl');
    expect(auditFilePath()).toBe('/elsewhere/audit.jsonl');
  });
});

describe('auditActor', () => {
  it('normalizes every actor kind', async () => {
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

  it('returns newest first and respects the limit', async () => {
    write([ev(1), ev(2), ev(3)]);
    const page = readAuditEvents({ limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([3, 2]);
    // A third match exists, so the page says so rather than counting the rest.
    expect(page.hasMore).toBe(true);
    expect(page.truncated).toBe(false);
  });

  it('filters by type, effect and actor substring', async () => {
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

  it('pages older with the beforeTs cursor', async () => {
    write([ev(1), ev(2), ev(3)]);
    const first = readAuditEvents({ limit: 2 });
    const older = readAuditEvents({ limit: 2, beforeTs: first.events[first.events.length - 1].ts });
    expect(older.events.map((e) => e.seq)).toEqual([1]);
    expect(older.hasMore).toBe(false);
  });

  it('skips a torn line instead of failing the page', async () => {
    // A half-written record is what a crash mid-append leaves behind. The
    // viewer must still render everything around it.
    fs.writeFileSync(file, `${JSON.stringify(ev(1))}\n{"ts":"2026-08-12T00:00:00.0\n${JSON.stringify(ev(3))}\n`);
    expect(readAuditEvents().events.map((e) => e.seq)).toEqual([3, 1]);
  });

  it('is an empty page when the file does not exist', async () => {
    vi.stubEnv('NANOCLAW_AUDIT_FILE', path.join(scratchDir(), 'nope', 'audit.jsonl'));
    expect(readAuditEvents()).toEqual({ events: [], hasMore: false, truncated: false });
  });
});

describe('retention', () => {
  const MB = 1024 * 1024;
  const DAY = 24 * 3600 * 1000;
  const dir = () => path.dirname(file);
  const dayFile = (day: string) => path.join(dir(), `audit-${day}.jsonl.gz`);
  afterEach(() => setAuditRetention(null));

  it('starts from 90 days and 200 MB; the environment overrides; nonsense falls back', () => {
    expect(envAuditRetention()).toEqual({ days: 90, maxBytes: 200 * MB });
    vi.stubEnv('NANOCLAW_AUDIT_KEEP_DAYS', '0');
    vi.stubEnv('NANOCLAW_AUDIT_MAX_MB', '50');
    expect(envAuditRetention()).toEqual({ days: 0, maxBytes: 50 * MB });
    vi.stubEnv('NANOCLAW_AUDIT_KEEP_DAYS', '-3');
    vi.stubEnv('NANOCLAW_AUDIT_MAX_MB', 'lots');
    expect(envAuditRetention()).toEqual({ days: 90, maxBytes: 200 * MB });
  });

  it("a new day rolls yesterday's file into a compressed day file, nothing lost", () => {
    audit({ type: 'auth.session', detail: { n: 1 } });
    // Make the live file look like yesterday's, as after a restart the next morning.
    const y = new Date(Date.now() - DAY);
    fs.utimesSync(file, y, y);
    vi.resetModules(); // fresh module state: the first write learns the day from the file
    return import('./audit.js').then((m) => {
      m.audit({ type: 'auth.session', detail: { n: 2 } });
      const yday = y.toISOString().slice(0, 10);
      const rolled = zlib.gunzipSync(fs.readFileSync(dayFile(yday))).toString('utf8');
      expect(JSON.parse(rolled.trim()).detail.n).toBe(1);
      expect(JSON.parse(fs.readFileSync(file, 'utf8').trim()).detail.n).toBe(2);
      expect(m.readAuditEvents().truncated).toBe(true);
    });
  });

  it('deletes day files past the window, keeps the rest; forever keeps them all', () => {
    fs.mkdirSync(dir(), { recursive: true });
    const now = Date.parse('2026-09-24T12:00:00Z');
    // Set first: setAuditRetention prunes at once, against the real clock.
    setAuditRetention({ days: 0, maxBytes: 200 * MB });
    for (const d of ['2026-06-01', '2026-06-26', '2026-06-27', '2026-09-23']) fs.writeFileSync(dayFile(d), 'x');
    fs.writeFileSync(path.join(dir(), 'unrelated.jsonl.gz'), 'x');
    pruneAuditFiles(file, now);
    expect(auditDayFiles(file)).toHaveLength(4);
    vi.stubEnv('NANOCLAW_AUDIT_KEEP_DAYS', '90');
    setAuditRetention(null); // the environment's 90 days; re-seed after its real-clock prune
    for (const d of ['2026-06-01', '2026-06-26', '2026-06-27', '2026-09-23']) fs.writeFileSync(dayFile(d), 'x');
    pruneAuditFiles(file, now);
    // 90 days before 2026-09-24 is 2026-06-26: that day stays, earlier ones go.
    expect(auditDayFiles(file).map((f) => f.day)).toEqual(['2026-06-26', '2026-06-27', '2026-09-23']);
    expect(fs.existsSync(path.join(dir(), 'unrelated.jsonl.gz'))).toBe(true);
    expect(auditUsage(file).oldestDay).toBe('2026-06-26');
  });

  it('the cap deletes the oldest days early, even under forever', () => {
    fs.mkdirSync(dir(), { recursive: true });
    for (const d of ['2026-09-20', '2026-09-21', '2026-09-22']) fs.writeFileSync(dayFile(d), Buffer.alloc(400 * 1024));
    fs.writeFileSync(file, Buffer.alloc(100 * 1024));
    setAuditRetention({ days: 0, maxBytes: 1 * MB });
    // 3 × 400 KB + 100 KB live is over 1 MB: the oldest day goes, then it fits.
    expect(auditDayFiles(file).map((f) => f.day)).toEqual(['2026-09-21', '2026-09-22']);
  });

  it('a runaway day rolls early at a quarter of the cap, with numbered files for the same day', () => {
    setAuditRetention({ days: 90, maxBytes: 1 * MB });
    const big = 'x'.repeat(20 * 1024);
    for (let i = 0; i < 40; i++) audit({ type: 'auth.denied', detail: { big, i } });
    const files = auditDayFiles(file);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(new Set(files.map((f) => f.day)).size).toBe(1);
    expect(files.map((f) => f.n)).toEqual(files.map((_, i) => i + 1));
    expect(fs.statSync(file).size).toBeLessThan(MB / 4 + 30 * 1024);
  });

  it('a roll that is interrupted after the rename leaves a plain day file that still counts', () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file, 'line\n');
    rollAuditFile(file, '2026-09-23');
    expect(fs.existsSync(dayFile('2026-09-23'))).toBe(true);
    fs.writeFileSync(path.join(dir(), 'audit-2026-09-22.jsonl'), 'plain');
    expect(auditDayFiles(file).map((f) => f.day)).toEqual(['2026-09-22', '2026-09-23']);
  });
});
