/**
 * The credential note is a DISCOVERY aid: an agent that does not know a
 * credential exists concludes it has no access and stops. So the tests care
 * about two things — that the facts land somewhere the agent actually sees,
 * and that writing them never damages memory the agent owns.
 *
 * Placement rules being pinned:
 *   - detail  → memory/system/credential-access.md, OKF-typed
 *   - pointer → memory/index.md, whose CONTENT renderMemorySection embeds in
 *               every session prompt
 *   - index.md is NEVER created here: the container scaffolds with
 *     COPYFILE_EXCL, so a host-created index would permanently suppress the
 *     real template
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const GROUPS = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-'));
const FOLDER = 'g1';
const groupDir = path.join(GROUPS, FOLDER);

vi.mock('../../config.js', () => ({ GROUPS_DIR: GROUPS }));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: () => ({ id: 'ag-1', folder: 'g1', name: 'G1' }),
}));

const { syncCredentialNote } = await import('./memory-note.js');

const conceptFile = path.join(groupDir, 'memory', 'system', 'credential-access.md');
const indexFile = path.join(groupDir, 'memory', 'index.md');

beforeEach(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.mkdirSync(groupDir, { recursive: true });
});
afterEach(() => fs.rmSync(groupDir, { recursive: true, force: true }));
// The afterEach above removes the GROUP dir; GROUPS is its parent and outlived
// every run, leaking one dir per test file execution.
afterAll(() => fs.rmSync(GROUPS, { recursive: true, force: true }));

/** Stand in for what the container's scaffold would have laid down. */
function scaffoldIndex(extra = ''): void {
  fs.mkdirSync(path.join(groupDir, 'memory', 'system'), { recursive: true });
  fs.writeFileSync(
    indexFile,
    `---\nokf_version: "0.1"\n---\n\n# Memory Index\n\n## Core Memory\n\nThe user prefers metric.\n${extra}`,
  );
}

describe('credential note placement', () => {
  it('writes an OKF-typed concept file with the hosts, never the values', () => {
    scaffoldIndex();
    syncCredentialNote('ag-1', ['git.example.com'], []);
    const c = fs.readFileSync(conceptFile, 'utf-8');
    expect(c.startsWith('---\ntype: capability\n')).toBe(true);
    expect(c).toContain('git.example.com');
  });

  it('puts a pointer in index.md — the file the session prompt embeds', () => {
    scaffoldIndex();
    syncCredentialNote('ag-1', ['git.example.com'], []);
    const idx = fs.readFileSync(indexFile, 'utf-8');
    expect(idx, 'discovery depends on this being in the always-loaded file').toContain('git.example.com');
    expect(idx).toContain('system/credential-access.md');
    expect(idx, "the agent's own memory must survive").toContain('The user prefers metric.');
  });

  it('NEVER creates index.md — that would suppress the container scaffold', () => {
    syncCredentialNote('ag-1', ['git.example.com'], []);
    expect(fs.existsSync(indexFile), 'host-created index would win over COPYFILE_EXCL forever').toBe(false);
    // The concept file is still written; the pointer lands on the next sync.
    expect(fs.existsSync(conceptFile)).toBe(true);
  });

  it('is idempotent — a repeat sync changes nothing', () => {
    scaffoldIndex();
    syncCredentialNote('ag-1', ['a.example.com', 'b.example.com'], []);
    const first = fs.readFileSync(indexFile, 'utf-8');
    syncCredentialNote('ag-1', ['b.example.com', 'a.example.com'], []);
    expect(fs.readFileSync(indexFile, 'utf-8')).toBe(first);
  });

  it('revoking every credential removes both the block and the concept file', () => {
    scaffoldIndex();
    syncCredentialNote('ag-1', ['git.example.com'], []);
    syncCredentialNote('ag-1', [], []);
    expect(fs.existsSync(conceptFile), 'a stale file would assert access that is gone').toBe(false);
    const idx = fs.readFileSync(indexFile, 'utf-8');
    expect(idx).not.toContain('Credential access');
    expect(idx).toContain('The user prefers metric.');
  });

  it('caps the inline host list so the always-loaded index stays small', () => {
    scaffoldIndex();
    const many = Array.from({ length: 20 }, (_, i) => `h${i}.example.com`);
    syncCredentialNote('ag-1', many, []);
    const idx = fs.readFileSync(indexFile, 'utf-8');
    expect(idx).toContain('and 12 more');
    // ...while the concept file keeps the full list.
    expect(fs.readFileSync(conceptFile, 'utf-8')).toContain('h19.example.com');
  });

  it('retires a block left behind in the pre-cutover CLAUDE.local.md', () => {
    scaffoldIndex();
    const legacy = path.join(groupDir, 'CLAUDE.local.md');
    fs.writeFileSync(
      legacy,
      'operator notes\n\n<!-- nanoclaw:credentials:start -->\n## Credential access\n\n- `old.example.com`\n<!-- nanoclaw:credentials:end -->\n\ntrailing notes\n',
    );
    syncCredentialNote('ag-1', ['new.example.com'], []);
    const after = fs.readFileSync(legacy, 'utf-8');
    expect(after, 'the Claude harness still loads this file — a stale copy would lie').not.toContain('old.example.com');
    expect(after).toContain('operator notes');
    expect(after).toContain('trailing notes');
  });

  it('a missing group folder is a no-op, not a throw', () => {
    fs.rmSync(groupDir, { recursive: true, force: true });
    expect(() => syncCredentialNote('ag-1', ['x.example.com'], [])).not.toThrow();
  });
});
