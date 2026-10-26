/**
 * Session retention: which sessions may go (the eligibility matrix), that the
 * delete never follows a symlink out of a session folder, and that a dry run
 * changes nothing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { DATA, running } = vi.hoisted(() => ({
  DATA: `/tmp/session-retention-test-${process.pid}`,
  running: new Set<string>(),
}));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: DATA,
}));
vi.mock('./container-runner.js', () => ({
  isContainerRunning: (id: string) => running.has(id),
}));

import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { createPendingQuestion, createSession, getSession } from './db/sessions.js';
import {
  initSessionFolder,
  sessionDir,
  withMailboxSession,
  writeOutboundDirect,
  writeSessionMessage,
} from './session-manager.js';
import { centralFreeRatio, pruneSessions, removeSessionFolder, retentionDays, summarize } from './session-retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = new Date(NOW - 200 * DAY).toISOString();
const OLDER = new Date(NOW - 300 * DAY).toISOString();
const RECENT = new Date(NOW - 5 * DAY).toISOString();

interface SessionSeed {
  id: string;
  mg?: string | null;
  thread?: string | null;
  status?: 'active' | 'closed';
  container?: 'running' | 'idle' | 'stopped';
  at?: string;
  agent?: string;
}

async function seedSession(s: SessionSeed): Promise<void> {
  const agent = s.agent ?? 'ag-1';
  const at = s.at ?? OLD;
  await createSession({
    id: s.id,
    agent_group_id: agent,
    messaging_group_id: s.mg === undefined ? 'mg-1' : s.mg,
    thread_id: s.thread ?? null,
    agent_provider: null,
    status: s.status ?? 'active',
    container_status: s.container ?? 'stopped',
    last_active: at,
    created_at: at,
  });
  initSessionFolder(agent, s.id);
  fs.writeFileSync(path.join(sessionDir(agent, s.id), '.heartbeat'), '');
  fs.mkdirSync(path.join(sessionDir(agent, s.id), 'outbox', 'm1'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir(agent, s.id), 'outbox', 'm1', 'report.txt'), 'x'.repeat(4096));
  ageFiles(agent, s.id, at);
}

/** Back-date every file in a session folder, as if nothing touched it since `iso`. */
function ageFiles(agent: string, id: string, iso: string): void {
  const t = new Date(iso);
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      fs.utimesSync(full, t, t);
    }
  };
  walk(sessionDir(agent, id));
}

async function chat(id: string, platformId: string): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: 'webchat',
    platform_id: platformId,
    name: platformId,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: OLDER,
  });
}

const ids = (r: { sessions: { sessionId: string }[] }) => r.sessions.map((s) => s.sessionId).sort();

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await db.exec(`CREATE TABLE IF NOT EXISTS webchat_room_pins (
    user_id TEXT NOT NULL, room_id TEXT NOT NULL, pinned_at INTEGER NOT NULL, PRIMARY KEY (user_id, room_id))`);
  for (const ag of ['ag-1', 'ag-2']) {
    await createAgentGroup({ id: ag, name: ag, folder: ag, agent_provider: null, created_at: OLDER });
  }
  await chat('mg-1', 'room-1');
  await chat('mg-pinned', 'room-pinned');
  running.clear();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.join(DATA, 'v2-sessions'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
});

describe('retentionDays', () => {
  const prior = process.env.NANOCLAW_SESSION_KEEP_DAYS;
  afterEach(() => {
    if (prior === undefined) delete process.env.NANOCLAW_SESSION_KEEP_DAYS;
    else process.env.NANOCLAW_SESSION_KEEP_DAYS = prior;
  });

  it('is off unless set to a whole number of days', () => {
    delete process.env.NANOCLAW_SESSION_KEEP_DAYS;
    expect(retentionDays()).toBe(0);
    process.env.NANOCLAW_SESSION_KEEP_DAYS = '90';
    expect(retentionDays()).toBe(90);
    for (const bad of ['-1', '1.5', 'ninety', '99999999']) {
      process.env.NANOCLAW_SESSION_KEEP_DAYS = bad;
      expect(retentionDays()).toBe(0);
    }
  });
});

describe('eligibility', () => {
  it('removes only sessions nothing can resume and nothing waits on', async () => {
    // A conversation whose newer session replaced an older one.
    await seedSession({ id: 'superseded', at: OLDER });
    await seedSession({ id: 'current' });
    // A spent task series, closed by the host sweep.
    await seedSession({ id: 'spent-task', mg: null, thread: 'system:tasks:s1', status: 'closed' });
    // Idle per-thread conversation: still its thread's continuation.
    await seedSession({ id: 'idle-thread', thread: 't-1' });
    // Closed, but not idle long enough.
    await seedSession({ id: 'closed-recent', mg: null, thread: 'system:tasks:s2', status: 'closed', at: RECENT });
    // Closed and idle, but a container is (or is about to be) live.
    await seedSession({
      id: 'closed-running',
      mg: null,
      thread: 'system:tasks:s3',
      status: 'closed',
      container: 'running',
    });
    await seedSession({ id: 'closed-live', mg: null, thread: 'system:tasks:s4', status: 'closed' });
    running.add('closed-live');
    await seedSession({ id: 'closed-claimed', mg: null, thread: 'system:tasks:s5', status: 'closed' });
    await getDb().run(
      `INSERT INTO session_claims (session_id, incarnation, claimed_by, updated_at) VALUES (?, 1, 'host-a', ?)`,
      'closed-claimed',
      OLD,
    );
    // Closed with an open question card.
    await seedSession({ id: 'closed-question', mg: null, thread: 'system:tasks:s6', status: 'closed' });
    await createPendingQuestion({
      question_id: 'q1',
      session_id: 'closed-question',
      message_out_id: 'o1',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      title: 'Pick',
      options: [],
      created_at: OLD,
    });
    // Superseded, but in a room someone pinned.
    await seedSession({ id: 'pinned-old', mg: 'mg-pinned', at: OLDER });
    await seedSession({ id: 'pinned-current', mg: 'mg-pinned' });
    await getDb().run(`INSERT INTO webchat_room_pins (user_id, room_id, pinned_at) VALUES ('u1', 'room-pinned', 1)`);
    // Closed, rows idle, but its heartbeat file is fresh.
    await seedSession({ id: 'closed-heartbeat', mg: null, thread: 'system:tasks:s7', status: 'closed' });
    const hb = path.join(sessionDir('ag-1', 'closed-heartbeat'), '.heartbeat');
    fs.utimesSync(hb, new Date(RECENT), new Date(RECENT));
    // Closed, but mail is still due.
    await seedSession({ id: 'closed-mail', mg: null, thread: 'system:tasks:s8', status: 'closed' });
    await writeSessionMessage('ag-1', 'closed-mail', {
      id: 'in-1',
      kind: 'chat',
      timestamp: OLD,
      content: JSON.stringify({ text: 'hi' }),
    });
    await getDb().run('UPDATE sessions SET last_active = ? WHERE id = ?', OLD, 'closed-mail');
    ageFiles('ag-1', 'closed-mail', OLD);
    // agent-shared / a2a: the agent group's newest active session is what a2a resumes.
    await seedSession({ id: 'a2a-old', agent: 'ag-2', mg: null, at: OLDER });
    await seedSession({ id: 'a2a-current', agent: 'ag-2', mg: null });

    const report = await pruneSessions({ days: 90, now: NOW, graceMs: 0 });

    expect(report.errors).toEqual([]);
    expect(ids(report)).toEqual(['a2a-old', 'spent-task', 'superseded']);
    for (const id of ['superseded', 'spent-task']) {
      expect(await getSession(id)).toBeUndefined();
      expect(fs.existsSync(sessionDir('ag-1', id))).toBe(false);
    }
    expect(fs.existsSync(path.join(DATA, 'v2-sessions', 'ag-1', '.context', 'superseded.json'))).toBe(false);
    for (const id of [
      'current',
      'idle-thread',
      'closed-recent',
      'closed-running',
      'closed-live',
      'closed-claimed',
      'closed-question',
      'pinned-old',
      'pinned-current',
      'closed-heartbeat',
      'closed-mail',
    ]) {
      expect(await getSession(id), id).toBeDefined();
      expect(fs.existsSync(sessionDir('ag-1', id)), id).toBe(true);
    }
    expect(await getSession('a2a-current')).toBeDefined();
    expect(report.kept).toMatchObject({
      continuation: 4, // current, idle-thread, pinned-current, a2a-current
      container: 2,
      claimed: 1,
      'open-question': 1,
      pinned: 1,
      'mailbox-pending': 1,
    });
    expect(report.bytes).toBeGreaterThan(3 * 4096);
    expect(summarize(report)).toMatch(/^removed 3 sessions idle over 90 days/);
  });

  it('keeps a session that receives work during the grace period', async () => {
    await seedSession({ id: 'superseded', at: OLDER });
    await seedSession({ id: 'current' });
    // A write that resolved the session just before it closed lands mid-grace.
    const landing = new Promise<void>((resolve) => {
      setTimeout(() => {
        void writeSessionMessage('ag-1', 'superseded', {
          id: 'late',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ text: 'late' }),
        }).then(resolve);
      }, 10);
    });
    const report = await pruneSessions({ days: 90, now: NOW, graceMs: 200 });
    await landing;
    expect(ids(report)).toEqual([]);
    // This run closed it; kept, it goes back to active rather than stranded closed.
    expect(await getSession('superseded')).toMatchObject({ status: 'active' });
    expect(fs.existsSync(sessionDir('ag-1', 'superseded'))).toBe(true);
  });

  it('leaves a session it did not close as it found it when kept', async () => {
    await seedSession({ id: 'spent', mg: null, thread: 'system:tasks:s1', status: 'closed' });
    const landing = new Promise<void>((resolve) => {
      setTimeout(() => {
        void writeSessionMessage('ag-1', 'spent', {
          id: 'late',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ text: 'late' }),
        }).then(resolve);
      }, 10);
    });
    // Nothing active was closed, so there is no grace sleep: wait for the write first.
    await landing;
    const report = await pruneSessions({ days: 90, now: NOW, graceMs: 0 });
    expect(ids(report)).toEqual([]);
    expect(await getSession('spent')).toMatchObject({ status: 'closed' });
  });

  it('counts only undelivered outbound mail as pending', async () => {
    for (const id of ['out-delivered', 'out-undelivered']) {
      await seedSession({ id, mg: null, thread: `system:tasks:${id}`, status: 'closed' });
      await writeOutboundDirect('ag-1', id, {
        id: `${id}-m`,
        kind: 'chat',
        platformId: null,
        channelType: null,
        threadId: null,
        content: JSON.stringify({ text: 'done' }),
      });
    }
    await withMailboxSession('ag-1', 'out-delivered', (m) => m.markDelivered('out-delivered-m', null));
    for (const id of ['out-delivered', 'out-undelivered']) {
      await getDb().run('UPDATE sessions SET last_active = ? WHERE id = ?', OLD, id);
      ageFiles('ag-1', id, OLD);
    }

    const report = await pruneSessions({ days: 90, now: NOW, graceMs: 0 });

    expect(report.errors).toEqual([]);
    expect(ids(report)).toEqual(['out-delivered']);
    expect(await getSession('out-undelivered')).toBeDefined();
    expect(report.kept).toMatchObject({ 'mailbox-pending': 1 });
  });

  it('refuses to run without a positive day count', async () => {
    await expect(pruneSessions({ days: 0 })).rejects.toThrow(/greater than 0/);
  });
});

describe('central VACUUM', () => {
  async function fragment(): Promise<void> {
    await getDb().exec(`CREATE TABLE filler (x BLOB);
      INSERT INTO filler SELECT randomblob(4096) FROM
        (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 2000) SELECT n FROM c);
      DROP TABLE filler;`);
  }

  it('runs only when allowed, something was removed, and a quarter of the file is free', async () => {
    await fragment();
    await seedSession({ id: 'superseded', at: OLDER });
    await seedSession({ id: 'current' });
    const idle = await pruneSessions({ days: 90, now: NOW, graceMs: 0, allowVacuum: false });
    expect(idle.centralFreeRatio).toBeGreaterThanOrEqual(0.25);
    expect(idle.vacuumed).toBe(false);

    await seedSession({ id: 'spent-task', mg: null, thread: 'system:tasks:s1', status: 'closed' });
    const report = await pruneSessions({ days: 90, now: NOW, graceMs: 0, allowVacuum: true });
    expect(ids(report)).toEqual(['spent-task']);
    expect(report.vacuumed).toBe(true);
    expect(await centralFreeRatio()).toBeLessThan(0.25);
  });

  it('does not run when nothing was removed', async () => {
    await fragment();
    const report = await pruneSessions({ days: 90, now: NOW, graceMs: 0, allowVacuum: true });
    expect(report.vacuumed).toBe(false);
  });
});

describe('dry run', () => {
  it('lists what would go and its size, and changes nothing', async () => {
    await seedSession({ id: 'superseded', at: OLDER });
    await seedSession({ id: 'current' });
    await seedSession({ id: 'spent-task', mg: null, thread: 'system:tasks:s1', status: 'closed' });

    const report = await pruneSessions({ days: 90, now: NOW, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(ids(report)).toEqual(['spent-task', 'superseded']);
    expect(report.sessions.every((s) => s.bytes >= 4096)).toBe(true);
    expect(report.bytes).toBe(report.sessions.reduce((n, s) => n + s.bytes, 0));
    expect(summarize(report)).toMatch(/^would remove 2 sessions/);
    // Untouched: rows (still active), folders, mailboxes.
    expect(await getSession('superseded')).toMatchObject({ status: 'active' });
    expect(await getSession('spent-task')).toBeDefined();
    expect(fs.existsSync(path.join(sessionDir('ag-1', 'superseded'), 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir('ag-1', 'spent-task'), 'outbox', 'm1', 'report.txt'))).toBe(true);
  });
});

describe('symlink safety', () => {
  let outside: string;
  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-outside-'));
    fs.mkdirSync(path.join(outside, 'dir'));
    fs.writeFileSync(path.join(outside, 'dir', 'keep.txt'), 'precious');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'precious');
  });
  afterEach(() => fs.rmSync(outside, { recursive: true, force: true }));

  it('unlinks links planted in a session folder and never deletes through them', async () => {
    await seedSession({ id: 'spent-task', mg: null, thread: 'system:tasks:s1', status: 'closed' });
    const dir = sessionDir('ag-1', 'spent-task');
    fs.symlinkSync(path.join(outside, 'dir'), path.join(dir, 'linked-dir'));
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(dir, 'outbox', 'linked-file'));
    fs.symlinkSync(outside, path.join(dir, 'outbox', 'm1', 'escape'));

    const report = await pruneSessions({ days: 90, now: NOW, graceMs: 0 });

    expect(ids(report)).toEqual(['spent-task']);
    expect(report.errors).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'dir', 'keep.txt'), 'utf8')).toBe('precious');
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('removes a session folder that is itself a link as the link only', () => {
    const agentDir = path.join(DATA, 'v2-sessions', 'ag-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.symlinkSync(outside, path.join(agentDir, 'sess-link'));

    removeSessionFolder('ag-1', 'sess-link');

    expect(fs.existsSync(path.join(agentDir, 'sess-link'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'dir', 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('refuses ids that are not plain directory names', () => {
    expect(() => removeSessionFolder('ag-1', '../escape')).toThrow(/plain directory name/);
    expect(() => removeSessionFolder('..', 'sess')).toThrow(/plain directory name/);
  });
});
