/**
 * Export tar layout, run through real GNU tar. Every --transform applies to
 * every member, so a rename for the workspace folder must not touch the staged
 * `db/` tree even when the folder name is a prefix of it (a folder named `d`).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const fsh = require('fs') as typeof import('fs');
  const osh = require('os') as typeof import('os');
  const ph = require('path') as typeof import('path');
  const root = fsh.mkdtempSync(ph.join(osh.tmpdir(), 'export-tar-'));
  return { root, groups: ph.join(root, 'groups'), data: ph.join(root, 'data') };
});
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  GROUPS_DIR: dirs.groups,
  DATA_DIR: dirs.data,
}));

import { exportTarArgs } from './agent-transfer.js';
import { systemTarArgs } from './system-transfer.js';

afterAll(() => fs.rmSync(dirs.root, { recursive: true, force: true }));

function put(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
}

function list(args: string[]): string[] {
  const out = path.join(dirs.root, `out-${Math.random().toString(36).slice(2)}.tgz`);
  execFileSync('tar', [...args, '-f', out]);
  return execFileSync('tar', ['-tzf', out]).toString().trim().split('\n').sort();
}

describe('export tar transforms', () => {
  it('renames only the workspace folder, not staged db/ (folder named d)', () => {
    const stage = path.join(dirs.root, 'stage');
    put(path.join(stage, 'manifest.json'));
    put(path.join(stage, 'db', 'agent_group.json'));
    put(path.join(dirs.groups, 'd', 'CLAUDE.md'));
    put(path.join(dirs.groups, 'd', 'db', 'notes.md'));
    const sess = path.join(dirs.data, 'v2-sessions', 'ag-d');
    put(path.join(sess, '.claude-shared', 'skills', 'a.md'));
    put(path.join(sess, 'sess-1', 'inbound.db'));
    put(path.join(sess, 'sess-10', 'inbound.db'));

    const names = list(exportTarArgs(stage, { id: 'ag-d', folder: 'd' }, true));
    expect(names).toContain('db/agent_group.json');
    expect(names).toContain('manifest.json');
    expect(names).toContain('files/workspace/CLAUDE.md');
    expect(names).toContain('files/workspace/db/notes.md');
    expect(names).toContain('files/claude-shared/skills/a.md');
    expect(names).toContain('files/session-dbs/sess-1/inbound.db');
    expect(names).toContain('files/session-dbs/sess-10/inbound.db');
    expect(names.every((n) => n === 'manifest.json' || n.startsWith('db/') || n.startsWith('files/'))).toBe(true);
  });

  it('escapes regex metacharacters in the folder name', () => {
    const stage = path.join(dirs.root, 'stage2');
    put(path.join(stage, 'manifest.json'));
    put(path.join(stage, 'db', 'agent_group.json'));
    put(path.join(dirs.groups, 'a.b', 'CLAUDE.md'));
    put(path.join(dirs.groups, 'aXb', 'CLAUDE.md'));
    const args = exportTarArgs(stage, { id: 'ag-ab', folder: 'a.b' }, false);
    // Add a sibling the `.` would match if unescaped.
    const names = list([...args, 'aXb']);
    expect(names).toContain('files/workspace/CLAUDE.md');
    expect(names).toContain('aXb/CLAUDE.md');
  });

  it('system bundle keeps db/ intact next to the renamed trees', () => {
    const stage = path.join(dirs.root, 'stage3');
    put(path.join(stage, 'manifest.json'));
    put(path.join(stage, 'db', 'v2.db'));
    put(path.join(dirs.data, 'webchat', 'x'));
    const names = list(systemTarArgs(stage, false));
    expect(names).toContain('db/v2.db');
    expect(names).toContain('files/data/webchat/x');
    expect(names).toContain('files/groups/d/CLAUDE.md');
  });
});
