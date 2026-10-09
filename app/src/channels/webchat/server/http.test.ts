import { Readable } from 'stream';

import { describe, expect, it, vi } from 'vitest';

import { BodyTooLargeError, json, readBody } from './http.js';

// json()'s `unknown` parameter hides a missing await from tsc, so json()
// resolves a thenable before serializing and turns a rejection into a 500
// instead of a silent `{}`. These tests pin that guard.

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

describe('readBody()', () => {
  it('decodes a multi-byte character split across two chunks', async () => {
    const text = JSON.stringify({ text: 'naïve — 日本 😀' });
    const bytes = Buffer.from(text, 'utf8');
    // Cut inside the 4-byte emoji, and inside the 3-byte em dash.
    const emoji = bytes.indexOf(Buffer.from('😀', 'utf8'));
    const dash = bytes.indexOf(Buffer.from('—', 'utf8'));
    const parts = [bytes.subarray(0, dash + 1), bytes.subarray(dash + 1, emoji + 2), bytes.subarray(emoji + 2)];
    const got = await readBody(Readable.from(parts) as never);
    expect(got).toBe(text);
    expect(got).not.toContain('\ufffd');
  });

  it('still refuses a body over the limit', async () => {
    const parts = [Buffer.alloc(600), Buffer.alloc(600)];
    await expect(readBody(Readable.from(parts) as never, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
