/**
 * The syncer that replaces central reaching into this container. What must
 * hold: only a placed session syncs at all; messages central holds land where
 * the agent's poll loop reads them, once; answers go the other way from a
 * watermark that survives a restart; and central being briefly away is not
 * fatal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Database } from 'bun:sqlite';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './sqlite/connection.js';
import { RelayMailboxSync, relaySyncConfig, __resetColumnCacheForTest } from './relay-sync.js';

// The test session's inbound db, handed over as a writable handle the syncer may close.
const openInbound = (): Database => {
  const db = getInboundDb();
  return {
    prepare: (sql: string) => db.prepare(sql),
    transaction: (fn: (...args: never[]) => unknown) => db.transaction(fn),
    close: () => {},
  } as unknown as Database;
};
const cfg = { url: 'http://host.docker.internal:3103', token: 'tok', openInbound };

interface Call { url: string; method: string; body?: any; headers: Record<string, string> }
function fakeFetch(handler: (c: Call) => { status?: number; json?: unknown; bytes?: Buffer }) {
  const calls: Call[] = [];
  const impl = (async (url: any, init: any = {}) => {
    let body: any;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body) body = Buffer.from(init.body);
    const c: Call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body };
    calls.push(c);
    const { status = 200, json = {}, bytes } = handler(c) as { status?: number; json?: unknown; bytes?: Buffer };
    return { ok: status >= 200 && status < 300, status, json: async () => json, arrayBuffer: async () => (bytes ?? Buffer.alloc(0)) } as any;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  initTestSessionDb();
  __resetColumnCacheForTest();
});
afterEach(() => closeSessionDb());

function writeOutbound(id: string, seq: number, text: string): void {
  getOutboundDb()
    .prepare(`INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', ?, ?)`)
    .run(id, seq, new Date().toISOString(), JSON.stringify({ text }));
}

describe('relay mailbox sync', () => {
  it('only runs for a placed session', () => {
    expect(relaySyncConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(relaySyncConfig({ NANOCLAW_MAILBOX_URL: 'http://x' } as NodeJS.ProcessEnv)).toBeNull();
    expect(relaySyncConfig({ NANOCLAW_MAILBOX_URL: 'http://x/', NANOCLAW_MAILBOX_TOKEN: 't' } as NodeJS.ProcessEnv)).toEqual({
      url: 'http://x',
      token: 't',
    });
  });

  it("writes central's messages where the poll loop reads them, once, and advances its watermark", async () => {
    const rows = [
      { id: 'm1', seq: 2, kind: 'chat', timestamp: 't1', content: '{"text":"one"}', trigger: 1, on_wake: 0 },
      { id: 'm2', seq: 4, kind: 'chat', timestamp: 't2', content: '{"text":"two"}', trigger: 1, on_wake: 0 },
    ];
    let served = rows;
    const { impl, calls } = fakeFetch((c) => (c.url.includes('/inbound') ? { json: { rows: served } } : { json: { inserted: 0 } }));
    const sync = new RelayMailboxSync(cfg, impl);
    sync.start();
    await sync.tick(); // joins the tick start() kicked off

    // This image's schema is narrower than central's payload; the rest still lands.
    const got = getInboundDb().prepare('SELECT id, seq FROM messages_in ORDER BY seq').all() as Array<{ id: string }>;
    expect(got.map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(calls.find((c) => c.url.includes('/inbound'))!.headers['X-NanoClaw-Mailbox']).toBe('tok');

    // Next pull asks from the watermark; a repeat of the same rows changes nothing.
    served = rows;
    await sync.tick();
    expect(calls.filter((c) => c.url.includes('/inbound')).pop()!.url).toContain('after=4');
    expect((getInboundDb().prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c).toBe(2);
  });

  it('hands answers to central from a watermark that survives a restart', async () => {
    writeOutbound('o1', 3, 'first');
    const { impl, calls } = fakeFetch(() => ({ json: { rows: [], inserted: 1 } }));
    const sync = new RelayMailboxSync(cfg, impl);
    sync.start();
    await sync.tick();
    const posted = calls.filter((c) => c.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0].body.rows.map((r: any) => r.id)).toEqual(['o1']);

    // Nothing new: no second post.
    await sync.tick();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    // A fresh syncer (a restarted container) resumes from the recorded mark.
    writeOutbound('o2', 5, 'second');
    const second = new RelayMailboxSync(cfg, impl);
    second.start();
    await second.tick();
    const all = calls.filter((c) => c.method === 'POST');
    expect(all).toHaveLength(2);
    expect(all[1].body.rows.map((r: any) => r.id)).toEqual(['o2']); // not o1 again
  });

  it('survives central being away and recovers on the next tick', async () => {
    writeOutbound('o1', 3, 'x');
    let down = true;
    const { impl, calls } = fakeFetch(() => (down ? { status: 503 } : { json: { rows: [], inserted: 1 } }));
    const sync = new RelayMailboxSync(cfg, impl);
    sync.start();
    await sync.tick(); // throws inside, swallowed
    expect(calls.length).toBeGreaterThan(0);
    down = false;
    await sync.tick();
    const posted = calls.filter((c) => c.method === 'POST' && c.body?.rows?.length);
    expect(posted[posted.length - 1].body.rows[0].id).toBe('o1'); // nothing was lost
  });

  it('a flush at shutdown is not skipped just because a sync was in flight', async () => {
    writeOutbound('o1', 3, 'late answer');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { impl, calls } = fakeFetch(() => ({ json: { rows: [], inserted: 1 } }));
    const slow = (async (url: any, init: any) => {
      if (first) {
        first = false;
        await gate;
      }
      return impl(url, init);
    }) as unknown as typeof fetch;
    const sync = new RelayMailboxSync(cfg, slow);
    sync.start(); // kicks a tick that is now blocked mid-flight
    const stopping = sync.stop();
    release();
    await stopping;
    expect(calls.some((c) => c.method === 'POST' && c.body?.rows?.[0]?.id === 'o1')).toBe(true);
  });

  it('files travel with their rows: attachments are fetched before the row lands, sent files uploaded before the row goes', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ws-'));
    try {
      // Outbound: send_file wrote the file, then the row naming it.
      fs.mkdirSync(path.join(ws, 'outbox/o7'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'outbox/o7/report.pdf'), '%PDF');
      getOutboundDb()
        .prepare(`INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES ('o7', 1, 'chat', 't', ?)`)
        .run(JSON.stringify({ text: 'here', files: ['report.pdf', '../escape', 'missing.txt'] }));
      const inbound = [
        { id: 'm1', seq: 1, kind: 'chat', timestamp: 't', trigger: 1, on_wake: 0, content: JSON.stringify({ text: 'look', attachments: [{ name: 'shot.png', localPath: 'inbox/m1/shot.png' }, { name: 'x', localPath: 'inbox/../../etc/passwd' }] }) },
      ];
      const order: string[] = [];
      const { impl, calls } = fakeFetch((c) => {
        order.push(`${c.method} ${c.url.replace(cfg.url, '')}`);
        if (c.url.includes('/mailbox/file') && c.method === 'GET') return { bytes: Buffer.from([9, 9]) };
        if (c.url.includes('/inbound')) return { json: { rows: inbound } };
        return { json: { inserted: 1 } };
      });
      const sync = new RelayMailboxSync({ ...cfg, workspaceDir: ws }, impl);
      await sync.tick();
      // Upload before the row; only the safe, present file.
      expect(order.slice(0, 2)).toEqual([`PUT /mailbox/file?path=${encodeURIComponent('outbox/o7/report.pdf')}`, 'POST /mailbox/outbound']);
      expect(calls[0].body.toString()).toBe('%PDF');
      // Download before the row is inserted; the traversal is ignored.
      expect([...fs.readFileSync(path.join(ws, 'inbox/m1/shot.png'))]).toEqual([9, 9]);
      expect(calls.filter((c) => c.url.includes('/mailbox/file') && c.method === 'GET')).toHaveLength(1);
      expect((getInboundDb().prepare('SELECT id FROM messages_in').all() as Array<{ id: string }>).map((r) => r.id)).toEqual(['m1']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a failed file transfer holds the row back for the next tick instead of losing the file', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ws-'));
    try {
      const inbound = [{ id: 'm2', seq: 5, kind: 'chat', timestamp: 't', trigger: 1, on_wake: 0, content: JSON.stringify({ attachments: [{ localPath: 'inbox/m2/a.txt' }] }) }];
      let fail = true;
      const { impl } = fakeFetch((c) => {
        if (c.url.includes('/mailbox/file')) return fail ? { status: 502 } : { bytes: Buffer.from('ok') };
        if (c.url.includes('/inbound')) return { json: { rows: inbound } };
        return { json: {} };
      });
      const sync = new RelayMailboxSync({ ...cfg, workspaceDir: ws }, impl);
      await sync.tick();
      expect((getInboundDb().prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c).toBe(0);
      fail = false;
      await sync.tick();
      expect(fs.readFileSync(path.join(ws, 'inbox/m2/a.txt'), 'utf8')).toBe('ok');
      expect((getInboundDb().prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c).toBe(1);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("carries the agent's status events to central from a watermark", async () => {
    const db = getOutboundDb();
    db.exec(`CREATE TABLE IF NOT EXISTS status_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT, detail TEXT, created_at TEXT NOT NULL)`);
    db.prepare(`INSERT INTO status_events (kind, text, detail, created_at) VALUES ('start', NULL, NULL, 't'), ('tool', 'Bash', 'npm test', 't')`).run();
    const { impl, calls } = fakeFetch((c) => (c.url.endsWith('/mailbox/status') ? { json: { inserted: 2 } } : { json: { rows: [] } }));
    const sync = new RelayMailboxSync(cfg, impl);
    await sync.tick();
    const posted = calls.filter((c) => c.url.endsWith('/mailbox/status'));
    expect(posted).toHaveLength(1);
    expect(posted[0].body.rows.map((r: any) => [r.seq, r.kind, r.text])).toEqual([[1, 'start', null], [2, 'tool', 'Bash']]);
    // Nothing new: nothing sent.
    await sync.tick();
    expect(calls.filter((c) => c.url.endsWith('/mailbox/status'))).toHaveLength(1);
  });

  it('hands central the verdicts on finished messages, once each, never the in-progress ones', async () => {
    const db = getOutboundDb();
    const ack = db.prepare('INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)');
    ack.run('m1', 'completed', '2026-09-23T18:00:00.000Z');
    ack.run('m2', 'processing', '2026-09-23T18:00:01.000Z');
    const { impl, calls } = fakeFetch((c) => (c.url.endsWith('/mailbox/acks') ? { json: { applied: 1 } } : { json: { rows: [] } }));
    const sync = new RelayMailboxSync(cfg, impl);
    await sync.tick();
    const sent = () => calls.filter((c) => c.url.endsWith('/mailbox/acks'));
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.acks.map((a: any) => [a.message_id, a.status])).toEqual([['m1', 'completed']]);
    await sync.tick();
    expect(sent()).toHaveLength(1); // nothing new
    ack.run('m2', 'completed', '2026-09-23T18:00:05.000Z'); // the turn finished
    await sync.tick();
    expect(sent()[1].body.acks.map((a: any) => a.message_id)).toEqual(['m2']);
  });
});
