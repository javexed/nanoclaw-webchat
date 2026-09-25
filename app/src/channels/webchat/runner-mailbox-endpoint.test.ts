/**
 * The mailbox a placed agent calls for itself. What must hold: a token names
 * exactly one session and nothing else; messages central holds come back in
 * order from a watermark; answers land where central's delivery path reads
 * them, idempotently; and the first call tells central to stop reaching into
 * that machine.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get DATA_DIR() {
    return tmp;
  },
}));

const { __resetMailboxEndpointForTest, handleMailboxRequest, issueMailboxToken, revokeMailboxToken } =
  await import('./runner-mailbox-endpoint.js');
const { ensureSchema, openInboundDb, openOutboundDb } = await import('../../mailbox/sqlite/session-db.js');
const { RunnerSessionStore, __setRunnerSessionStoreForTest } = await import('./runner-sessions-store.js');
const { inboundDbPath, outboundDbPath } = await import('../../mailbox/sqlite/paths.js');

const key = { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' };
const other = { installSlug: 'spike', agentGroupId: 'g2', sessionId: 's2' };
const FP = 'a'.repeat(64);

/** Drive the handler over a real socket, the way the relay hop does. */
function serve(): {
  call: (method: string, urlPath: string, token: string, body?: unknown) => Promise<{ status: number; json: any }>;
  close: () => void;
} {
  const server = http.createServer((req, res) => void handleMailboxRequest(req, res));
  const ready = new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port)));
  return {
    async call(method, urlPath, token, body) {
      const port = await ready;
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method,
            path: urlPath,
            headers: { 'x-nanoclaw-mailbox': token, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
          },
          (res) => {
            let out = '';
            res.on('data', (d) => (out += d));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, json: out ? JSON.parse(out) : null }));
          },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
    close: () => server.close(),
  };
}

let api: ReturnType<typeof serve>;
const servers: http.Server[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-mbx-ep-'));
  for (const k of [key, other]) {
    fs.mkdirSync(path.join(tmp, `v2-sessions/${k.agentGroupId}/${k.sessionId}`), { recursive: true });
    ensureSchema(inboundDbPath(k.agentGroupId, k.sessionId), 'inbound');
    ensureSchema(outboundDbPath(k.agentGroupId, k.sessionId), 'outbound');
  }
  __setRunnerSessionStoreForTest(new RunnerSessionStore(null));
  api = serve();
});
afterEach(() => {
  api.close();
  for (const srv of servers.splice(0)) srv.close();
  __resetMailboxEndpointForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeInbound(k: typeof key, id: string, seq: number, text: string): void {
  const db = openInboundDb(inboundDbPath(k.agentGroupId, k.sessionId));
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, content, trigger, on_wake) VALUES (?, ?, 'chat', ?, ?, 1, 0)`,
  ).run(id, seq, new Date().toISOString(), JSON.stringify({ text }));
  db.close();
}

describe('runner mailbox endpoint', () => {
  it('hands this session its own messages from a watermark, and nobody else’s', async () => {
    writeInbound(key, 'm1', 2, 'first');
    writeInbound(key, 'm2', 4, 'second');
    writeInbound(other, 'x1', 2, 'not yours');
    const token = issueMailboxToken(key, FP);

    const all = await api.call('GET', '/mailbox/inbound?after=0', token);
    expect(all.status).toBe(200);
    expect(all.json.rows.map((r: any) => r.id)).toEqual(['m1', 'm2']);
    expect(JSON.parse(all.json.rows[0].content).text).toBe('first');

    const rest = await api.call('GET', '/mailbox/inbound?after=2', token);
    expect(rest.json.rows.map((r: any) => r.id)).toEqual(['m2']);

    // The other session's token sees only the other session.
    const otherToken = issueMailboxToken(other, FP);
    const mine = await api.call('GET', '/mailbox/inbound?after=0', otherToken);
    expect(mine.json.rows.map((r: any) => r.id)).toEqual(['x1']);
  });

  it("puts the agent's answers where central's delivery path reads them, and ignores a repeat", async () => {
    const token = issueMailboxToken(key, FP);
    const row = {
      id: 'o1',
      seq: 3,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: 'pong' }),
    };

    const first = await api.call('POST', '/mailbox/outbound', token, { rows: [row] });
    expect(first.json).toEqual({ inserted: 1 });
    const again = await api.call('POST', '/mailbox/outbound', token, { rows: [row] });
    expect(again.json).toEqual({ inserted: 0 }); // idempotent by row id: the agent never answers twice

    const db = openOutboundDb(outboundDbPath(key.agentGroupId, key.sessionId));
    const rows = db.prepare('SELECT id, content FROM messages_out').all() as Array<{ id: string; content: string }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toEqual({ text: 'pong' });
  });

  it('refuses an unknown or revoked token, and touches no mailbox for it', async () => {
    const token = issueMailboxToken(key, FP);
    expect((await api.call('GET', '/mailbox/inbound?after=0', 'made-up')).status).toBe(403);
    expect((await api.call('GET', '/mailbox/inbound?after=0', '')).status).toBe(403);
    revokeMailboxToken(key);
    const after = await api.call('GET', '/mailbox/inbound?after=0', token);
    expect(after.status).toBe(403);
    expect(after.json.error).toMatch(/revoked/);
  });

  it('re-issuing a token for a live session keeps the same one, so a re-prepare does not orphan the container', () => {
    const first = issueMailboxToken(key, FP);
    expect(issueMailboxToken(key, 'b'.repeat(64))).toBe(first);
    revokeMailboxToken(key);
    expect(issueMailboxToken(key, FP)).not.toBe(first);
  });

  it('serves inbox attachments and receives outbox files — only those, only for this session', async () => {
    const tok = issueMailboxToken(key, FP);
    const tokOther = issueMailboxToken(other, FP);
    const port = await new Promise<number>((r) => {
      const srv = http.createServer((req, res) => void handleMailboxRequest(req, res));
      srv.listen(0, '127.0.0.1', () => r((srv.address() as any).port));
      servers.push(srv);
    });
    const raw = (method: string, p: string, token: string, body?: Buffer) =>
      new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method,
            path: p,
            headers: { 'x-nanoclaw-mailbox': token, ...(body ? { 'Content-Length': body.length } : {}) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          },
        );
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    const sess = (k: typeof key) => path.join(tmp, `v2-sessions/${k.agentGroupId}/${k.sessionId}`);
    fs.mkdirSync(path.join(sess(key), 'inbox/m1'), { recursive: true });
    fs.writeFileSync(path.join(sess(key), 'inbox/m1/photo.png'), Buffer.from([1, 2, 3, 4]));

    const got = await raw('GET', '/mailbox/file?path=inbox/m1/photo.png', tok);
    expect(got.status).toBe(200);
    expect([...got.body]).toEqual([1, 2, 3, 4]);
    // Another session's token reads its own directory, where this file is not.
    expect((await raw('GET', '/mailbox/file?path=inbox/m1/photo.png', tokOther)).status).toBe(404);
    // Only inbox is readable; no traversal; no revoked token.
    expect((await raw('GET', '/mailbox/file?path=outbox/m1/photo.png', tok)).status).toBe(400);
    expect((await raw('GET', `/mailbox/file?path=${encodeURIComponent('inbox/../inbound.db')}`, tok)).status).toBe(400);
    expect(
      (await raw('GET', `/mailbox/file?path=${encodeURIComponent('inbox/m1/../../inbound.db')}`, tok)).status,
    ).toBe(400);
    expect((await raw('GET', '/mailbox/file?path=inbox/m1/photo.png', 'nope')).status).toBe(403);

    const pdf = Buffer.from('%PDF-1.4 hello');
    const put = await raw('PUT', '/mailbox/file?path=outbox/m9/report.pdf', tok, pdf);
    expect(put.status).toBe(200);
    expect(fs.readFileSync(path.join(sess(key), 'outbox/m9/report.pdf')).toString()).toBe('%PDF-1.4 hello');
    // A retry after a lost answer is harmless — and a retry that carries different bytes wins (no "same size, same file").
    expect(
      JSON.parse((await raw('PUT', '/mailbox/file?path=outbox/m9/report.pdf', tok, pdf)).body.toString()),
    ).toMatchObject({ stored: pdf.length });
    const pdf2 = Buffer.from('%PDF-1.4 HELLO');
    expect((await raw('PUT', '/mailbox/file?path=outbox/m9/report.pdf', tok, pdf2)).status).toBe(200);
    expect(fs.readFileSync(path.join(sess(key), 'outbox/m9/report.pdf')).toString()).toBe('%PDF-1.4 HELLO');
    // Writes land only in outbox.
    expect((await raw('PUT', '/mailbox/file?path=inbox/m9/x.txt', tok, pdf)).status).toBe(400);
    expect(fs.readdirSync(path.join(sess(key), 'outbox/m9'))).toEqual(['report.pdf']); // no .part leftovers
  });

  it("lands the agent's status events where central's thinking bubble reads them", async () => {
    const tok = issueMailboxToken(key, FP);
    const rows = [
      { seq: 7, kind: 'start', text: null, detail: null, created_at: 't1' },
      { seq: 8, kind: 'tool', text: 'Bash', detail: 'npm test', created_at: 't2' },
      { seq: 'x', kind: 'tool' }, // malformed: dropped
    ];
    const r = await api.call('POST', '/mailbox/status', tok, { rows });
    expect(r).toMatchObject({ status: 200, json: { inserted: 2 } });
    expect((await api.call('POST', '/mailbox/status', tok, { rows })).json).toEqual({ inserted: 0 }); // idempotent
    const { getStatusEventsSince, getMaxStatusEventSeq } = await import('../../modules/agent-status/index.js');
    const db = openOutboundDb(outboundDbPath(key.agentGroupId, key.sessionId));
    try {
      expect(getMaxStatusEventSeq(db)).toBe(8);
      expect(getStatusEventsSince(db, 7).map((e: any) => [e.kind, e.text, e.detail])).toEqual([
        ['tool', 'Bash', 'npm test'],
      ]);
    } finally {
      db.close();
    }
  });

  it("a container's token is still honoured after central restarts, and a re-prepare hands out the same one", async () => {
    const tok = issueMailboxToken(key, FP);
    __resetMailboxEndpointForTest(); // central restarts: memory gone, the store remains
    const r = await api.call('GET', '/mailbox/inbound?after=0', tok);
    expect(r.status).toBe(200);
    // The spec central builds on re-prepare carries the same token, so the runner adopts the running container.
    expect(issueMailboxToken(key, FP)).toBe(tok);
    revokeMailboxToken(key);
    __resetMailboxEndpointForTest();
    expect((await api.call('GET', '/mailbox/inbound?after=0', tok)).status).toBe(403);
  });

  it("the agent's verdicts land where central decides what is still due — in-progress ones do not", async () => {
    const tok = issueMailboxToken(key, FP);
    writeInbound(key, 'm-done', 1, 'finished');
    writeInbound(key, 'm-open', 2, 'in progress');
    const r = await api.call('POST', '/mailbox/acks', tok, {
      acks: [
        { message_id: 'm-done', status: 'completed', status_changed: '2026-09-23T18:00:00.000Z' },
        { message_id: 'm-open', status: 'processing', status_changed: '2026-09-23T18:00:01.000Z' },
      ],
    });
    expect(r).toMatchObject({ status: 200, json: { applied: 1 } });
    const db = openOutboundDb(outboundDbPath(key.agentGroupId, key.sessionId));
    try {
      const rows = db.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
      expect(rows).toEqual([{ message_id: 'm-done', status: 'completed' }]);
    } finally {
      db.close();
    }
  });
});
