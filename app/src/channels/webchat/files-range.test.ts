/**
 * Byte-range serving for webchat attachments: the parser on its own, then the
 * status, headers and body handleFileServe sends for each kind of request.
 */
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import type { ServerResponse } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above the imports, so the temp dir must be too.
const { DATA } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('os') as typeof import('os');
  return { DATA: mkdtempSync(`${tmpdir()}/webchat-range-`) };
});
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: DATA };
});

import { handleFileServe, parseByteRange, uploadsDir } from './files.js';

const ROOM = 'range-room';
const FILE = '0f8fad5b-d9cb-469f-a165-70867728950e.mp4';
const BODY = Buffer.from('0123456789abcdefghij'); // 20 bytes

beforeAll(() => {
  fs.mkdirSync(uploadsDir(ROOM), { recursive: true });
  fs.writeFileSync(path.join(uploadsDir(ROOM), FILE), BODY);
});
afterAll(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
});

describe('parseByteRange', () => {
  it('ignores a missing or foreign header', () => {
    expect(parseByteRange(undefined, 20)).toBeNull();
    expect(parseByteRange('', 20)).toBeNull();
    expect(parseByteRange('items=0-1', 20)).toBeNull();
    expect(parseByteRange('bytes=-', 20)).toBeNull();
    expect(parseByteRange('bytes=abc', 20)).toBeNull();
  });

  it('ignores a request for several ranges (whole file instead)', () => {
    expect(parseByteRange('bytes=0-1,4-5', 20)).toBeNull();
  });

  it('reads a closed range', () => {
    expect(parseByteRange('bytes=0-1', 20)).toEqual({ start: 0, end: 1 });
    expect(parseByteRange('bytes=5-5', 20)).toEqual({ start: 5, end: 5 });
  });

  it('reads an open-ended range to the last byte', () => {
    expect(parseByteRange('bytes=10-', 20)).toEqual({ start: 10, end: 19 });
  });

  it('clamps an end past the file to the last byte', () => {
    expect(parseByteRange('bytes=15-999', 20)).toEqual({ start: 15, end: 19 });
  });

  it('reads a suffix range, clamped to the whole file', () => {
    expect(parseByteRange('bytes=-5', 20)).toEqual({ start: 15, end: 19 });
    expect(parseByteRange('bytes=-500', 20)).toEqual({ start: 0, end: 19 });
  });

  it('calls a start at or past the end unsatisfiable', () => {
    expect(parseByteRange('bytes=20-', 20)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=25-30', 20)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 20)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('ignores a range that ends before it starts', () => {
    expect(parseByteRange('bytes=9-3', 20)).toBeNull();
  });
});

interface Captured {
  status?: number;
  headers: Record<string, unknown>;
  body: Buffer;
  done: Promise<void>;
}

function capture(): { res: ServerResponse; out: Captured } {
  const chunks: Buffer[] = [];
  let finish!: () => void;
  const out: Captured = { headers: {}, body: Buffer.alloc(0), done: new Promise((r) => (finish = r)) };
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  w.on('finish', () => {
    out.body = Buffer.concat(chunks);
    finish();
  });
  const res = w as unknown as ServerResponse;
  res.writeHead = ((status: number, hdrs?: Record<string, unknown>) => {
    out.status = status;
    if (hdrs) Object.assign(out.headers, hdrs);
    return res;
  }) as ServerResponse['writeHead'];
  return { res, out };
}

async function serve(range?: string): Promise<Captured> {
  const { res, out } = capture();
  handleFileServe(res, ROOM, FILE, range);
  await out.done;
  return out;
}

describe('handleFileServe — byte ranges', () => {
  it('sends the whole file with 200 and advertises range support', async () => {
    const out = await serve();
    expect(out.status).toBe(200);
    expect(out.headers['Accept-Ranges']).toBe('bytes');
    expect(out.headers['Content-Length']).toBe(20);
    expect(out.body.equals(BODY)).toBe(true);
  });

  it('sends one range with 206 and Content-Range', async () => {
    const out = await serve('bytes=2-5');
    expect(out.status).toBe(206);
    expect(out.headers['Content-Range']).toBe('bytes 2-5/20');
    expect(out.headers['Content-Length']).toBe(4);
    expect(out.body.toString()).toBe('2345');
  });

  it('serves the probe iOS sends before playing (bytes=0-1)', async () => {
    const out = await serve('bytes=0-1');
    expect(out.status).toBe(206);
    expect(out.body.toString()).toBe('01');
  });

  it('serves a suffix range', async () => {
    const out = await serve('bytes=-3');
    expect(out.status).toBe(206);
    expect(out.headers['Content-Range']).toBe('bytes 17-19/20');
    expect(out.body.toString()).toBe('hij');
  });

  it('answers an unsatisfiable range with 416 and the size', async () => {
    const out = await serve('bytes=40-50');
    expect(out.status).toBe(416);
    expect(out.headers['Content-Range']).toBe('bytes */20');
    expect(out.body.length).toBe(0);
  });

  it('sends the whole file when several ranges are asked for', async () => {
    const out = await serve('bytes=0-1,4-5');
    expect(out.status).toBe(200);
    expect(out.body.equals(BODY)).toBe(true);
  });

  it('keeps the sandbox and nosniff headers on every status', async () => {
    for (const range of [undefined, 'bytes=0-1', 'bytes=99-']) {
      const out = await serve(range);
      expect(String(out.headers['Content-Security-Policy'])).toMatch(/^sandbox\b/);
      expect(String(out.headers['Content-Security-Policy'])).toContain("frame-ancestors 'self'");
      expect(out.headers['X-Frame-Options']).toBe('SAMEORIGIN');
      expect(out.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(out.headers['Content-Type']).toBe('video/mp4');
    }
  });
});
