import { describe, expect, it, vi } from 'vitest';

import { json } from './http.js';

// The async-DB migration left seven handlers passing an un-awaited promise to
// json() — the `unknown` parameter means tsc never flags it, and the client
// receives `{}` for what should be an array (took every room in the live UI
// down via /api/agents). These tests pin the guard that makes that class
// impossible: json() resolves a thenable before serializing, and turns a
// rejection into the 500 it is instead of a silent empty object.

function fakeRes() {
  const chunks: string[] = [];
  let status = 0;
  return {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
    },
    end(body?: string) {
      if (body) chunks.push(body);
    },
    get status() {
      return status;
    },
    get body() {
      return chunks.join('');
    },
  };
}

describe('json()', () => {
  it('serializes a plain value directly', async () => {
    const res = fakeRes();
    json(res as never, 200, [{ id: 'a' }]);
    expect(res.status).toBe(200);
    expect(res.body).toBe('[{"id":"a"}]');
  });

  it('resolves a promise argument instead of serializing it as {}', async () => {
    // JSON.stringify(Promise.resolve(x)) === '{}' — the exact live failure.
    const res = fakeRes();
    json(res as never, 200, Promise.resolve([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 0));
    expect(res.status).toBe(200);
    expect(res.body).toBe('[1,2,3]');
  });

  it('turns a rejected promise into a 500, never an empty 200', async () => {
    const res = fakeRes();
    json(res as never, 200, Promise.reject(new Error('boom')));
    await new Promise((r) => setTimeout(r, 0));
    expect(res.status).toBe(500);
    expect(res.body).toContain('Internal error');
  });

  it('resolves a promise-valued field too, and warns so the caller gets fixed', async () => {
    // { handle: getHandle() } is the same slip one level down. tsc rejects it
    // at the call site; this is the net for one that arrives typed as any.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = fakeRes();
    const handle: any = Promise.resolve('ada'); // eslint-disable-line @typescript-eslint/no-explicit-any
    json(res as never, 200, { ok: true, handle });
    await new Promise((r) => setTimeout(r, 0));
    expect(res.body).toBe('{"ok":true,"handle":"ada"}');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unawaited Promise'), 'handle');
    warn.mockRestore();
  });
});
