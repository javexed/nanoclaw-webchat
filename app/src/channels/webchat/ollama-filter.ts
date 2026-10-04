/**
 * Ollama, for an agent: inference only.
 *
 * An agent's connection to an Ollama server (its model, host-local or on
 * another machine) passed the per-caller check and was then piped as raw
 * bytes. Ollama's API has no authentication, so the agent could send any
 * request on it: pull a model of tens of gigabytes (a full disk), delete the
 * models other agents use, create, copy or push them. Here each request on
 * the connection, keep-alive ones included, is read by Node's own HTTP parser
 * and forwarded only when it is inference or a read-only lookup a harness
 * makes; anything else gets a 403. Responses, streamed ones too, pass through
 * untouched.
 */
import http from 'http';
import type { Duplex } from 'stream';

/**
 * What an agent may ask of Ollama. Native API, the OpenAI-compatible one
 * OpenCode and pi use, and the Anthropic-compatible one Claude Code uses
 * (ANTHROPIC_BASE_URL at the Ollama root: models.ts envForModel).
 */
const ALLOWED: Record<string, ReadonlySet<string>> = {
  POST: new Set([
    '/api/chat',
    '/api/generate',
    '/api/embed',
    '/api/embeddings',
    '/api/show',
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/embeddings',
    '/v1/messages',
    '/v1/messages/count_tokens',
  ]),
  GET: new Set(['/', '/api/tags', '/api/ps', '/api/version', '/v1/models']),
  HEAD: new Set(['/', '/api/version']),
};

/** Whether an agent's request may reach Ollama: inference, or a read-only lookup. */
export function ollamaRequestAllowed(method: string | undefined, url: string | undefined): boolean {
  const m = (method ?? '').toUpperCase();
  let path: string;
  try {
    path = new URL(url ?? '', 'http://ollama').pathname;
  } catch {
    return false;
  }
  if (path.includes('..') || path.includes('//')) return false;
  if (m === 'GET' && path.startsWith('/v1/models/') && path.length > '/v1/models/'.length) return true;
  return ALLOWED[m]?.has(path) ?? false;
}

interface Upstream {
  target: { host: string; port: number };
  onRefused: (method: string, path: string) => void;
}

/** Which Ollama each connection handed to the parser goes to. */
const upstreams = new WeakMap<object, Upstream>();

/** HTTP parsing only: never listens; connections are handed to it. */
const parser = http.createServer((req, res) => {
  const up = upstreams.get(req.socket);
  if (!up) {
    res.writeHead(500).end();
    return;
  }
  if (!ollamaRequestAllowed(req.method, req.url)) {
    const path = (req.url ?? '').split('?')[0];
    up.onRefused(req.method ?? '', path);
    const body = JSON.stringify({
      error: `${req.method} ${path} is not available to agents: only inference and read-only lookups reach Ollama`,
    });
    // The request's body read first, then the answer: answered with it unread,
    // the server closes the connection, and a kept-alive client's next request
    // finds it gone.
    req.on('end', () => {
      res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    req.resume();
    return;
  }
  const forward = http.request(
    {
      host: up.target.host,
      port: up.target.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
      agent: false,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.headers);
      upRes.pipe(res);
    },
  );
  forward.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Ollama did not answer: ${err.message}` }));
  });
  res.on('close', () => forward.destroy());
  req.pipe(forward);
});
// A long generation streams for minutes; the server must not time the connection out.
parser.requestTimeout = 0;
parser.headersTimeout = 60_000;
parser.timeout = 0;
// No upgrades (Ollama uses none): an Upgrade request's connection is closed.
parser.on('upgrade', (_req, socket: Duplex) => socket.destroy());
// A request the parser cannot read: say so, then close.
parser.on('clientError', (_err, socket: Duplex) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  else socket.destroy();
});

/**
 * Serve an agent's connection to Ollama through the filter. `client` is a
 * socket (the lockdown network) or a relayed stream (the exec relay); the
 * latter lacks a socket's tuning methods, which the HTTP server calls, so
 * those are filled in as no-ops.
 */
export function serveOllamaFiltered(
  client: Duplex,
  target: { host: string; port: number },
  onRefused: (method: string, path: string) => void,
): void {
  const sock = client as Duplex & Record<string, unknown>;
  for (const name of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref']) {
    if (typeof sock[name] !== 'function') sock[name] = () => sock;
  }
  upstreams.set(client, { target, onRefused });
  parser.emit('connection', client);
}
