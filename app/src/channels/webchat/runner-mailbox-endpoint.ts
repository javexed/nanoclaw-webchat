/**
 * The mailbox a placed agent talks to. The container calls out over the
 * relay it already uses for the model and for MCP, and central answers from
 * the session's own mailbox; central never reaches into the machine.
 *
 * Trust model: one token per placed session, minted at prepare, carried in the
 * spec and revoked when the session stops. It is kept in the runner session
 * store, because the container outlives a central restart with the token in
 * its environment: a restart must neither strand it nor, by minting a new one,
 * make the runner see a different spec. It names exactly one session — it
 * cannot read another's mail — and it reaches central only through that
 * machine's authenticated socket. The listener binds loopback: the only
 * legitimate caller is central's own relay hop.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { log } from '../../log.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { openInboundDb, openOutboundDbRw } from '../../mailbox/sqlite/session-db.js';
import type { SessionKey } from '../../drivers/types.js';

import { runnerSessionStore } from './runner-sessions-store.js';
import { BodyTooLargeError, json, readBody } from './server/http.js';

/** Loopback: central's relay hop is the only caller, and it runs in this process's host. */
export const MAILBOX_ENDPOINT_PORT = Number(process.env.WEBCHAT_RUNNER_MAILBOX_PORT || 3103);
/** The name a container uses for it, resolved by the relay exactly as the MCP relay's is. */
export const MAILBOX_ENDPOINT_HOST = 'host.docker.internal';

/** Columns carried in each direction; mirrored by the container's syncer. */
const IN_COLUMNS = [
  'id',
  'seq',
  'kind',
  'timestamp',
  'status',
  'process_after',
  'recurrence',
  'series_id',
  'tries',
  'trigger',
  'platform_id',
  'channel_type',
  'thread_id',
  'content',
  'source_session_id',
  'on_wake',
] as const;
const OUT_COLUMNS = [
  'id',
  'seq',
  'in_reply_to',
  'timestamp',
  'deliver_after',
  'recurrence',
  'kind',
  'platform_id',
  'channel_type',
  'thread_id',
  'content',
] as const;

const MAX_BODY = 8 * 1024 * 1024;
const TERMINAL_ACKS = new Set(['completed', 'failed', 'script-skip:error']);

/** The container's status_events table (agent-runner status-feed.ts), created here on first push. */
const STATUS_DDL = `CREATE TABLE IF NOT EXISTS status_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  text       TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
)`;
/** A file the agent sends back (send_file). Generous: it streams to disk, never held in memory. */
const MAX_FILE = 512 * 1024 * 1024;
const BATCH = 200;

interface Session {
  key: SessionKey;
  fingerprint: string;
}

const sessions = new Map<string, Session>(); // token → session
const byKey = new Map<string, string>(); // keyId → token
const keyId = (k: SessionKey): string => `${k.installSlug} ${k.agentGroupId} ${k.sessionId}`;

/** Mint (or reuse) this session's mailbox token. Carried in the spec; revoked when the session stops. */
export function issueMailboxToken(key: SessionKey, fingerprint: string): string {
  const existing = byKey.get(keyId(key));
  if (existing) {
    const s = sessions.get(existing);
    if (s) {
      s.fingerprint = fingerprint;
      runnerSessionStore().update(key, { fingerprint });
      return existing;
    }
  }
  // Remembered from before a restart: the running container still carries it.
  const kept = runnerSessionStore().get(key);
  const token = kept?.token ?? crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { key, fingerprint });
  byKey.set(keyId(key), token);
  if (kept) runnerSessionStore().update(key, { fingerprint });
  else runnerSessionStore().put({ key, fingerprint, token });
  return token;
}

export function revokeMailboxToken(key: SessionKey): void {
  runnerSessionStore().delete(key);
  const token = byKey.get(keyId(key));
  if (!token) return;
  byKey.delete(keyId(key));
  sessions.delete(token);
}

/** A token issued before this process started, still held by a running container. */
function rememberedSession(token: string): Session | undefined {
  const rec = runnerSessionStore().byToken(token);
  if (!rec) return undefined;
  const s: Session = { key: rec.key, fingerprint: rec.fingerprint };
  sessions.set(token, s);
  byKey.set(keyId(rec.key), token);
  return s;
}

export function __resetMailboxEndpointForTest(): void {
  sessions.clear();
  byKey.clear();
}

/** A JSON body as an object, or null once a 400/413 has been sent. */
async function readJson(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse((await readBody(req, MAX_BODY)) || '{}') as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: 'body too large' });
      return null;
    }
  }
  json(res, 400, { error: 'invalid JSON' });
  return null;
}

const records = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, key: SessionKey) => Promise<void>;

async function getInbound(_req: http.IncomingMessage, res: http.ServerResponse, url: URL, key: SessionKey) {
  const after = Number(url.searchParams.get('after') || 0);
  const db = openInboundDb(inboundDbPath(key.agentGroupId, key.sessionId));
  try {
    const rows = db
      .prepare(`SELECT ${IN_COLUMNS.join(',')} FROM messages_in WHERE seq > ? ORDER BY seq LIMIT ?`)
      .all(Number.isFinite(after) ? after : 0, BATCH);
    json(res, 200, { rows });
  } finally {
    db.close();
  }
}

/**
 * Write a batch into the session's outbound.db. Safe to open read-write: for
 * a placed session no local container owns this file — the only writer is
 * this endpoint.
 */
function intoOutbound(key: SessionKey, write: (db: ReturnType<typeof openOutboundDbRw>) => number): number {
  const db = openOutboundDbRw(outboundDbPath(key.agentGroupId, key.sessionId));
  try {
    return db.transaction(() => write(db))();
  } finally {
    db.close();
  }
}

async function postOutbound(req: http.IncomingMessage, res: http.ServerResponse, _url: URL, key: SessionKey) {
  const body = await readJson(req, res);
  if (!body) return;
  const rows = records(body.rows);
  const inserted = rows.length
    ? intoOutbound(key, (db) => {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO messages_out (${OUT_COLUMNS.join(',')}) VALUES (${OUT_COLUMNS.map((c) => `@${c}`).join(',')})`,
        );
        let n = 0;
        for (const r of rows) n += stmt.run(Object.fromEntries(OUT_COLUMNS.map((c) => [c, r[c] ?? null]))).changes;
        return n;
      })
    : 0;
  if (inserted > 0) log.info('Mailbox: collected answers from a placed agent', { ...key, count: inserted });
  json(res, 200, { inserted });
}

async function postAcks(req: http.IncomingMessage, res: http.ServerResponse, _url: URL, key: SessionKey) {
  const body = await readJson(req, res);
  if (!body) return;
  // Only verdicts: central marks a message done from these exactly as for a
  // local container. In-progress acks are left out on purpose: central's
  // stuck-claim rule reads those, and must not act on a laptop's clock.
  const acks = records(body.acks).filter(
    (a) => typeof a.message_id === 'string' && TERMINAL_ACKS.has(String(a.status)),
  );
  if (acks.length)
    intoOutbound(key, (db) => {
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (@id, @status, @changed)',
      );
      for (const a of acks)
        stmt.run({
          id: a.message_id,
          status: a.status,
          changed: typeof a.status_changed === 'string' ? a.status_changed : new Date().toISOString(),
        });
      return acks.length;
    });
  json(res, 200, { applied: acks.length });
}

async function postStatus(req: http.IncomingMessage, res: http.ServerResponse, _url: URL, key: SessionKey) {
  const body = await readJson(req, res);
  if (!body) return;
  const rows = records(body.rows).filter((r) => Number.isInteger(r.seq) && typeof r.kind === 'string');
  // The agent-status module tails this table exactly as it does for a local
  // container; the container's own seq is kept so its order and the module's
  // watermark mean the same thing.
  const inserted = rows.length
    ? intoOutbound(key, (db) => {
        db.exec(STATUS_DDL);
        const stmt = db.prepare(
          'INSERT OR IGNORE INTO status_events (seq, kind, text, detail, created_at) VALUES (@seq, @kind, @text, @detail, @created_at)',
        );
        let n = 0;
        for (const r of rows)
          n += stmt.run({
            seq: r.seq,
            kind: String(r.kind).slice(0, 32),
            text: typeof r.text === 'string' ? r.text.slice(0, 2000) : null,
            detail: typeof r.detail === 'string' ? r.detail.slice(0, 4000) : null,
            created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
          }).changes;
        return n;
      })
    : 0;
  json(res, 200, { inserted });
}

async function fileRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, key: SessionKey) {
  const reading = req.method === 'GET';
  const target = sessionFile(
    key.agentGroupId,
    key.sessionId,
    url.searchParams.get('path') || '',
    reading ? 'inbox' : 'outbox',
  );
  if (!target) return json(res, 400, { error: 'bad file path' });
  if (reading) await serveFile(res, target);
  else await receiveFile(req, res, target, key);
}

const ROUTES: Record<string, Handler> = {
  'GET /mailbox/inbound': getInbound,
  'POST /mailbox/outbound': postOutbound,
  'POST /mailbox/acks': postAcks,
  'POST /mailbox/status': postStatus,
  'GET /mailbox/file': fileRoute,
  'PUT /mailbox/file': fileRoute,
};

/**
 * Rows in and out, plus the files rows name:
 *   GET  /mailbox/inbound?after=<seq>        → messages central holds for this agent
 *   POST /mailbox/outbound                   → { rows, acks } the agent produced
 *   GET  /mailbox/file?path=inbox/<id>/<f>   → an attachment central saved for a message
 *   PUT  /mailbox/file?path=outbox/<id>/<f>  → a file the agent sent (send_file)
 *   POST /mailbox/status                     → { rows } of the agent's status_events
 *                                              (what the thinking bubble tails)
 *   POST /mailbox/acks                       → { acks } terminal processing_ack rows
 *                                              (which messages the agent finished)
 *
 * Files live in the session directory exactly where a local container would
 * have read or written them, so everything downstream (the formatter's
 * `/workspace/inbox/…` lines, delivery reading `outbox/<id>/`) is unchanged.
 */
export async function handleMailboxRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://mailbox');
  const token = String(req.headers['x-nanoclaw-mailbox'] || '');
  const session = token ? (sessions.get(token) ?? rememberedSession(token)) : undefined;
  if (!session) return json(res, 403, { error: 'unknown or revoked mailbox token' });
  const route = ROUTES[`${req.method} ${url.pathname}`];
  if (!route) return json(res, 404, { error: 'no such mailbox operation' });
  await route(req, res, url, session.key);
}

/**
 * `inbox/<messageId>/<name>` or `outbox/<messageId>/<name>` inside this
 * session's directory — nothing else. Reads come only from inbox (what central
 * saved for the agent), writes land only in outbox (what the agent sends): a
 * token cannot read what the agent itself produced elsewhere, nor plant a file
 * where central would treat it as the developer's.
 */
export function sessionFile(
  agentGroupId: string,
  sessionId: string,
  rel: string,
  allowed: 'inbox' | 'outbox',
): string | null {
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[0] !== allowed) return null;
  if (!isSafeAttachmentName(parts[1]) || !isSafeAttachmentName(parts[2])) return null;
  const root = path.dirname(inboundDbPath(agentGroupId, sessionId));
  return path.join(root, parts[0], parts[1], parts[2]);
}

async function serveFile(res: http.ServerResponse, file: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    json(res, 404, { error: 'no such file' });
    return;
  }
  // Central wrote these with exclusive-create; a symlink here was planted.
  if (!st.isFile()) {
    json(res, 404, { error: 'no such file' });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
  await new Promise<void>((resolve) => {
    const rs = fs.createReadStream(file);
    rs.on('error', () => {
      res.destroy();
      resolve();
    });
    rs.on('end', () => resolve());
    rs.pipe(res);
  });
}

async function receiveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  where: SessionKey,
): Promise<void> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_FILE) {
    json(res, 413, { error: 'file too large' });
    req.resume();
    return;
  }
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('outbox dir is a symlink');
  } catch (err) {
    json(res, 500, { error: String((err as Error).message) });
    req.resume();
    return;
  }
  // A retry of an upload that already landed is written again and renamed
  // over the first copy: "same size" was taken as "same file", and a different
  // file of equal length on a retry would have kept the wrong bytes.
  const tmp = `${file}.part-${crypto.randomBytes(4).toString('hex')}`;
  let size = 0;
  const ok = await new Promise<boolean>((resolve) => {
    const ws = fs.createWriteStream(tmp, { flags: 'wx' });
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_FILE) {
        req.destroy();
        ws.destroy();
        resolve(false);
      }
    });
    req.on('error', () => resolve(false));
    ws.on('error', () => resolve(false));
    ws.on('finish', () => resolve(true));
    req.pipe(ws);
  });
  if (!ok || (Number.isFinite(declared) && size !== declared)) {
    fs.rmSync(tmp, { force: true });
    if (!res.headersSent) json(res, size > MAX_FILE ? 413 : 400, { error: 'upload incomplete' });
    return;
  }
  fs.renameSync(tmp, file);
  log.info('Mailbox: received a file from a placed agent', { ...where, file: path.basename(file), size });
  json(res, 200, { stored: size });
}

let server: http.Server | null = null;

export function startMailboxEndpoint(): void {
  if (server) return;
  server = http.createServer((req, res) => {
    void handleMailboxRequest(req, res).catch((err) => {
      log.error('Mailbox endpoint threw', { err });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('error', (err) => log.error('Mailbox endpoint listener error', { err: String(err) }));
  server.listen(MAILBOX_ENDPOINT_PORT, '127.0.0.1', () => {
    log.info('Runner mailbox endpoint listening', { port: MAILBOX_ENDPOINT_PORT });
  });
}

/** Where central's own relay hop should connect to reach this endpoint. */
export function mailboxEndpointTarget(): { host: string; port: number } {
  return { host: '127.0.0.1', port: MAILBOX_ENDPOINT_PORT };
}
