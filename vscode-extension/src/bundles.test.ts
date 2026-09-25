import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { hostSafeRel, unpackDoc } from './bundles.js';

describe('bundle paths on the developer machine', () => {
  it('maps names Windows cannot hold the way WSL does, so the container reads the original back', () => {
    const rel = 'inbox/edf71a26-7fcb:a6a26505/table.csv';
    expect(hostSafeRel(rel, 'linux')).toBe(rel);
    const win = hostSafeRel(rel, 'win32');
    expect(win).toBe('inbox/edf71a26-7fcba6a26505/table.csv');
    expect(hostSafeRel('a<b>c"d|e?f*g', 'win32')).toBe('abcdefg');
  });

  it('unpacks such a document on Windows without failing, and still confines every entry', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-unpack-'));
    try {
      unpackDoc(
        {
          v: 1,
          dirs: ['inbox/m1:g1'],
          files: [{ p: 'inbox/m1:g1/t.csv', m: 0o644, d: Buffer.from('a,b').toString('base64') }],
          skipped: [],
        },
        dest,
        'win32',
      );
      expect(fs.readFileSync(path.join(dest, 'inbox', 'm1g1', 't.csv'), 'utf8')).toBe('a,b');
      expect(() =>
        unpackDoc({ v: 1, dirs: [], files: [{ p: '../escape', m: 0o644, d: '' }], skipped: [] }, dest, 'win32'),
      ).toThrow(/escapes/);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
