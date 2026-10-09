// ── HTTP + request-body helpers, shared by every route module ────────────────
// A leaf module so route modules never import server.ts (which imports them).
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * A top-level field holding a Promise serializes as {} — a missing await that
 * tsc can't see through an `unknown` parameter. Mapping such a field to `never`
 * makes it a compile error at the call site.
 */
type NoPromiseFields<T> = T & { [K in keyof T]: T[K] extends PromiseLike<unknown> ? never : unknown };

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  !!v && typeof (v as { then?: unknown }).then === 'function';

export function json<T>(res: ServerResponse, status: number, data: NoPromiseFields<T>): void {
  sendJson(res, status, data);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  // A Promise handed here would serialize as {} (tsc can't flag a missing await
  // through `unknown`): send the awaited value, and a rejection as a 500. The
  // same slip one level down ({ handle: getHandle() }) can still arrive typed
  // as `any`: resolve those fields too, and log it so it gets fixed.
  if (data && typeof data === 'object' && !Array.isArray(data) && !isThenable(data)) {
    const pending = Object.entries(data).filter(([, v]) => isThenable(v));
    if (pending.length > 0) {
      console.warn('[webchat] json(): unawaited Promise in response field(s)', pending.map(([k]) => k).join(', '));
      data = Promise.all(Object.entries(data).map(async ([k, v]) => [k, await v] as const)).then(Object.fromEntries);
    }
  }
  if (isThenable(data)) {
    data.then(
      (v) => {
        // The continuation runs OUTSIDE the request's catch chain — a throw
        // here (headers already sent, unserializable value) would otherwise
        // become an unhandled rejection and a response that hangs to timeout.
        try {
          sendJson(res, status, v);
        } catch (err) {
          console.error('[webchat] json(): serialization failed after resolve', err);
          if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
          else res.end();
        }
      },
      (err) => {
        console.error('[webchat] json(): promise argument rejected', err);
        if (!res.headersSent) json(res, 500, { error: 'Internal error' });
        else res.end();
      },
    );
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Cap JSON request bodies at 1 MB. Larger payloads use the chunked upload
// endpoint, which has its own (higher) cap in files.ts.
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
  }
}

/**
 * The request body as UTF-8, refused past `maxBytes`. Decoded once, whole: a
 * multi-byte character split across two network chunks would turn into
 * replacement characters if each chunk were decoded on its own.
 */
export function readBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

export async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  try {
    return await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: 'Request body too large' });
      return null;
    }
    throw err;
  }
}

/**
 * readJsonBody + JSON.parse. `undefined` means the error response (413, or 400
 * 'Invalid JSON') is already sent. A body of `null` is returned as-is.
 */
export async function readJsonObject<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return undefined;
  }
}
