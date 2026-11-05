import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import { afterAll, describe, expect, it } from 'vitest';

import { MAX_WORKER_ARCHIVE_BYTES, MIN_FREE_BYTES, prunable, receiveCapped, stampOf, stampTime } from './backup.js';

describe('backups', () => {
  it('keeps the newest three finished, drops unfinished ones', () => {
    const s = ['20261020T020000Z', '20261021T020000Z', '20261022T020000Z', '20261023T020000Z', '20261023T030000Z'];
    const done = new Set(s.slice(0, 4));
    expect(prunable(s, done).sort()).toEqual(['20261020T020000Z', '20261023T030000Z']);
    expect(prunable(s.slice(0, 2), new Set(s.slice(0, 2)))).toEqual([]);
  });

  it('round-trips stamps', () => {
    const d = new Date('2026-10-23T02:03:04.567Z');
    expect(stampOf(d)).toBe('20261023T020304Z');
    expect(stampTime(stampOf(d))).toBe(Date.parse('2026-10-23T02:03:04Z'));
  });
});

describe('archives from a worker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-recv-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const send = (chunks: Buffer[], fail?: Error): PassThrough => {
    const s = new PassThrough();
    setImmediate(() => {
      for (const c of chunks) s.write(c);
      if (fail) s.destroy(fail);
      else s.end();
    });
    return s;
  };
  const kb = (n: number) => Buffer.alloc(n * 1024, 7);
  const roomy = () => 1e15;

  it('writes a complete archive', async () => {
    const file = path.join(dir, 'ok.tar.gz');
    await receiveCapped(send([kb(4), kb(4)]), file, { maxBytes: 64 * 1024, minFreeBytes: 0 }, roomy);
    expect(fs.statSync(file).size).toBe(8 * 1024);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('cuts an archive over the size limit and removes what arrived', async () => {
    const file = path.join(dir, 'big.tar.gz');
    const s = send([kb(40), kb(40), kb(40)]);
    await expect(receiveCapped(s, file, { maxBytes: 64 * 1024, minFreeBytes: 0 }, roomy)).rejects.toThrow(
      /larger than/,
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(s.destroyed).toBe(true);
  });

  it('refuses when the disk drops below the floor', async () => {
    const file = path.join(dir, 'full.tar.gz');
    await expect(
      receiveCapped(send([kb(4)]), file, { maxBytes: 1e12, minFreeBytes: 5 * 1024 ** 3 }, () => 1024 ** 3),
    ).rejects.toThrow(/not enough free disk/);
    expect(fs.existsSync(file)).toBe(false);
    expect(MIN_FREE_BYTES).toBe(5 * 1024 ** 3);
    expect(MAX_WORKER_ARCHIVE_BYTES).toBeGreaterThan(MIN_FREE_BYTES);
  });

  it('removes the partial file when the worker aborts the stream', async () => {
    const file = path.join(dir, 'reset.tar.gz');
    await expect(
      receiveCapped(send([kb(8)], new Error('stream reset')), file, { maxBytes: 1e12, minFreeBytes: 0 }, roomy),
    ).rejects.toThrow(/stream reset/);
    expect(fs.existsSync(file)).toBe(false);
  });
});
