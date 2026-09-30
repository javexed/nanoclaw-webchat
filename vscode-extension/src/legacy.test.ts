import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { adoptLegacyStorage, legacyExtensionId, legacyStorageDir } from './legacy.js';

// A made-up predecessor: the real one is the install's business, never the repo's.
const OLD = 'acme.oldname';

const roots: string[] = [];
function globalStorage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-legacy-'));
  roots.push(root);
  return path.join(root, 'globalStorage', 'nanoclaw.vscode');
}
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function write(file: string, text: string, mtime: Date): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtime, mtime);
}

describe('legacyExtensionId', () => {
  it('reads the id the package step wrote, exactly', () => {
    expect(legacyExtensionId({ nanoclawLegacyId: OLD }, 'nanoclaw.vscode')).toBe(OLD);
    expect(legacyExtensionId({ nanoclawLegacyId: ' Acme.OldName ' }, 'nanoclaw.vscode')).toBe(OLD);
  });

  it('a build packaged without one has no predecessor', () => {
    expect(legacyExtensionId({}, 'nanoclaw.vscode')).toBeNull();
    expect(legacyExtensionId(undefined, 'nanoclaw.vscode')).toBeNull();
    expect(legacyExtensionId({ nanoclawLegacyId: 42 }, 'nanoclaw.vscode')).toBeNull();
  });

  it('never a pattern, never itself', () => {
    expect(legacyExtensionId({ nanoclawLegacyId: '*.nanoclaw' }, 'nanoclaw.vscode')).toBeNull();
    expect(legacyExtensionId({ nanoclawLegacyId: 'acme' }, 'nanoclaw.vscode')).toBeNull();
    expect(legacyExtensionId({ nanoclawLegacyId: '../acme.old' }, 'nanoclaw.vscode')).toBeNull();
    expect(legacyExtensionId({ nanoclawLegacyId: 'nanoclaw.vscode' }, 'NanoClaw.vscode')).toBeNull();
  });
});

describe('adoptLegacyStorage', () => {
  it("moves the old build's proposals and state across, once", () => {
    const mine = globalStorage();
    const old = path.join(legacyStorageDir(mine, OLD), 'runner', 'proposals', 'g1', 's1');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'a.txt'), 'unapplied');
    expect(legacyStorageDir(mine, OLD)).toBe(path.join(path.dirname(mine), OLD));
    expect(adoptLegacyStorage(mine, OLD)).toBe('moved');
    expect(fs.readFileSync(path.join(mine, 'runner', 'proposals', 'g1', 's1', 'a.txt'), 'utf8')).toBe('unapplied');
    expect(adoptLegacyStorage(mine, OLD)).toBe('none');
  });

  it('merges into storage this build already has: only what the old one has newer, never over newer here', () => {
    const mine = globalStorage();
    const theirs = path.join(legacyStorageDir(mine, OLD), 'runner');
    const ours = path.join(mine, 'runner');
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    write(path.join(theirs, 'state', 'kept.json'), 'old', older);
    write(path.join(ours, 'state', 'kept.json'), 'new', newer);
    write(path.join(theirs, 'state', 'updated.json'), 'newer there', newer);
    write(path.join(ours, 'state', 'updated.json'), 'older here', older);
    write(path.join(theirs, 'proposals', 'g1', 'a.txt'), 'only there', older);

    expect(adoptLegacyStorage(mine, OLD)).toBe('merged');
    expect(fs.readFileSync(path.join(ours, 'state', 'kept.json'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(ours, 'state', 'updated.json'), 'utf8')).toBe('newer there');
    expect(fs.readFileSync(path.join(ours, 'proposals', 'g1', 'a.txt'), 'utf8')).toBe('only there');
    // Set aside, not deleted, and not merged again.
    expect(fs.existsSync(theirs)).toBe(false);
    expect(fs.existsSync(`${theirs}.adopted`)).toBe(true);
    expect(adoptLegacyStorage(mine, OLD)).toBe('none');
  });

  it('does nothing on a machine that never had the old build', () => {
    expect(adoptLegacyStorage(globalStorage(), OLD)).toBe('none');
  });
});
