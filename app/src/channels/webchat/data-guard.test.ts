import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { missingDataDir } from './data-guard.js';

// A live install had `data` as a symlink to a data disk; a deploy that removed
// it would have booted on a fresh, empty database. An installed tree must not.

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-guard-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const installed = () => fs.writeFileSync(path.join(root, '.webchat-provenance.json'), '{}');

describe('boot data guard', () => {
  it('leaves a tree that is not an install alone, data or no data', () => {
    expect(missingDataDir(root)).toBeNull();
  });

  it('refuses an installed tree with no data dir', () => {
    installed();
    expect(missingDataDir(root)).toMatch(/data is missing/);
  });

  it('refuses a data symlink whose target is gone', () => {
    installed();
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'data'));
    expect(missingDataDir(root)).toMatch(/symlink to .*gone, which does not exist/);
  });

  it('starts on a real data dir, or a symlink to one', () => {
    installed();
    fs.mkdirSync(path.join(root, 'disk'));
    fs.symlinkSync(path.join(root, 'disk'), path.join(root, 'data'));
    expect(missingDataDir(root)).toBeNull();
    fs.unlinkSync(path.join(root, 'data'));
    fs.mkdirSync(path.join(root, 'data'));
    expect(missingDataDir(root)).toBeNull();
  });
});
