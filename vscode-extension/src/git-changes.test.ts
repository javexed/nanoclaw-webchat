import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  changedFiles,
  headContent,
  keep,
  parsePorcelain,
  recordWorkspace,
  resolveWorkspace,
  revert,
  snapshot,
  touchedBetween,
  workspaceChanges,
  workspaceFor,
  type InRepo,
} from './git-changes.js';

// Every git argv the module runs, to check which repository each call names.
const gitCalls = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFile = ((file: string, args: string[], ...rest: unknown[]) => {
    if (file === 'git') gitCalls.push(args);
    return (real.execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
  }) as unknown as typeof real.execFile;
  return { ...real, execFile };
});

let repo: string;
const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-git-'));
  sh(['init', '-q']);
  sh(['config', 'user.email', 't@t']);
  sh(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('git-changes', () => {
  it('parses porcelain -z, including renames, with forward-slash paths', () => {
    const out = ' M src/app.ts\0?? notes/new.txt\0R  b.ts\0a.ts\0D  gone.md\0';
    expect(parsePorcelain(out)).toEqual([
      { path: 'src/app.ts', status: 'M', untracked: false },
      { path: 'notes/new.txt', status: '??', untracked: true },
      { path: 'b.ts', status: 'R', untracked: false },
      { path: 'gone.md', status: 'D', untracked: false },
    ]);
  });

  it("tells the agent's edits from the developer's by snapshot, then keeps or reverts them", async () => {
    const ws = (await resolveWorkspace(repo)) as InRepo;
    // The developer had already touched README before asking.
    fs.writeFileSync(path.join(repo, 'README.md'), '# hi there\n');
    const before = await snapshot(ws);
    // The agent's turn: edits app.ts and adds a file.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const x = 2;\n');
    fs.writeFileSync(path.join(repo, 'src', 'util.ts'), 'export const y = 1;\n');
    const after = await snapshot(ws);
    const touched = touchedBetween(before, after);
    expect([...touched].sort()).toEqual(['src/app.ts', 'src/util.ts']); // not README
    const files = await workspaceChanges(ws);
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'src/app.ts', 'src/util.ts']);

    expect(await headContent(ws, 'src/app.ts')).toBe('export const x = 1;\n');
    expect(await headContent(ws, 'src/util.ts')).toBeNull(); // new file: nothing in HEAD

    await keep(ws, files.find((f) => f.path === 'src/app.ts')!);
    expect(sh(['diff', '--cached', '--name-only']).toString().trim()).toBe('src/app.ts');
    await revert(ws, files.find((f) => f.path === 'src/util.ts')!);
    expect(fs.existsSync(path.join(repo, 'src', 'util.ts'))).toBe(false);
    // Reverting a tracked, unstaged change restores HEAD.
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed again\n');
    await revert(ws, { path: 'README.md', status: 'M', untracked: false });
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# hi\n');
  });
});

import {
  SAFE_GIT_CONFIG,
  applyProposal,
  ensureProposalClone,
  gitArgv,
  proposalBaseContent,
  proposalChanges,
  proposalGitDir,
  recoverProposal,
  rejectProposal,
} from './git-changes.js';

describe('host git hardening', () => {
  it('every call turns off config that could run a program, before the subcommand', () => {
    expect(SAFE_GIT_CONFIG).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'diff.external=',
      '-c',
      'core.pager=cat',
      '-c',
      'attr.tree=HEAD',
    ]);
    expect(gitArgv(['status'])).toEqual([...SAFE_GIT_CONFIG, 'status']);
    expect(gitArgv(['diff', 'HEAD'], { gitDir: '/s/p.git', workTree: '/s/p' })).toEqual([
      ...SAFE_GIT_CONFIG,
      '--git-dir=/s/p.git',
      '--work-tree=/s/p',
      'diff',
      'HEAD',
    ]);
  });

  it('a hook or fsmonitor planted in the repository config does not run', async () => {
    const marker = path.join(repo, '..', `${path.basename(repo)}-pwned`);
    const script = path.join(repo, '..', `${path.basename(repo)}-hook.sh`);
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    sh(['config', 'core.fsmonitor', script]);
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    const ws = (await resolveWorkspace(repo)) as InRepo;
    expect((await changedFiles(repo, ws.repo)).map((f) => f.path)).toEqual(['README.md']);
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(script, { force: true });
  });
});

describe('direct mode: a pinned repository', () => {
  const records = () => path.join(path.dirname(repo), `${path.basename(repo)}-records`);
  afterEach(() => fs.rmSync(records(), { recursive: true, force: true }));

  /** What an agent could do in a folder it can write: make a repository whose config runs a command. */
  function plantRepo(dir: string, marker: string): void {
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    g(['init', '-q']);
    g(['config', 'filter.x.clean', `touch '${marker}'; cat`]);
    g(['config', 'filter.x.smudge', `touch '${marker}'; cat`]);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
  }

  it('reviews a subfolder against the repository it is in, with folder-relative paths, naming the repository on every call', async () => {
    const folder = path.join(repo, 'src');
    const ws = (await resolveWorkspace(folder)) as InRepo;
    expect(ws.repo).toEqual({ gitDir: fs.realpathSync(path.join(repo, '.git')), workTree: fs.realpathSync(repo) });
    fs.writeFileSync(path.join(repo, 'README.md'), '# outside the folder\n');
    fs.writeFileSync(path.join(folder, 'app.ts'), 'export const x = 2;\n');
    fs.writeFileSync(path.join(folder, 'new.ts'), 'new\n');
    gitCalls.length = 0;
    const files = await workspaceChanges(ws);
    expect(files.map((f) => f.path).sort()).toEqual(['app.ts', 'new.ts']); // not README
    expect([...(await snapshot(ws)).keys()].sort()).toEqual(['app.ts', 'new.ts']);
    expect(await headContent(ws, 'app.ts')).toBe('export const x = 1;\n');
    await keep(ws, files.find((f) => f.path === 'new.ts')!);
    expect(sh(['diff', '--cached', '--name-only']).toString().trim()).toBe('src/new.ts');
    await revert(ws, files.find((f) => f.path === 'app.ts')!);
    expect(fs.readFileSync(path.join(folder, 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(gitCalls.length).toBeGreaterThanOrEqual(5);
    for (const argv of gitCalls) {
      expect(argv).toContain(`--git-dir=${ws.repo.gitDir}`);
      expect(argv).toContain(`--work-tree=${ws.repo.workTree}`);
    }
  });

  it('a folder the runner recorded keeps its repository, whatever .git appears in it later', async () => {
    const folder = path.join(repo, 'src');
    recordWorkspace(records(), await resolveWorkspace(folder));
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-loose-'));
    try {
      recordWorkspace(records(), await resolveWorkspace(loose));
      execFileSync('git', ['init', '-q'], { cwd: folder, stdio: 'pipe' });
      execFileSync('git', ['init', '-q'], { cwd: loose, stdio: 'pipe' });
      expect((await workspaceFor(records(), folder)).repo?.workTree).toBe(fs.realpathSync(repo));
      expect((await workspaceFor(records(), loose)).repo).toBeNull();
      // A folder inside a recorded one inherits its record.
      fs.mkdirSync(path.join(loose, 'sub'));
      execFileSync('git', ['init', '-q'], { cwd: path.join(loose, 'sub'), stdio: 'pipe' });
      expect((await workspaceFor(records(), path.join(loose, 'sub'))).repo).toBeNull();
    } finally {
      fs.rmSync(loose, { recursive: true, force: true });
    }
  });

  it("an agent-made .git with a filter driver never runs through the extension's status, add or checkout", async () => {
    const folder = path.join(repo, 'src');
    recordWorkspace(records(), await resolveWorkspace(folder));
    const marker = path.join(path.dirname(repo), `${path.basename(repo)}-filtered`);
    try {
      plantRepo(folder, marker);
      fs.writeFileSync(path.join(folder, 'app.ts'), 'export const x = 3;\n');
      fs.writeFileSync(path.join(folder, 'more.ts'), 'more\n');
      const ws = (await workspaceFor(records(), folder)) as InRepo;
      const files = await workspaceChanges(ws);
      await snapshot(ws);
      await headContent(ws, 'app.ts');
      for (const f of files) await keep(ws, f);
      sh(['reset', '-q']);
      await revert(ws, { path: 'app.ts', status: 'M', untracked: false });
      expect(fs.existsSync(marker)).toBe(false);
      // The same planted repository, found by discovery as before: its filter runs.
      execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'add', 'more.ts'], {
        cwd: folder,
        stdio: 'pipe',
      });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });
});

describe('propose mode', () => {
  const siblings = (dir: string) => [dir, proposalGitDir(dir), `${dir}.nanoclaw-base`, `${dir}.nanoclaw-root`];
  const agentGit = (dir: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['--git-dir', proposalGitDir(dir), '--work-tree', dir, '-c', 'user.email=a@a', '-c', 'user.name=a', ...args],
      { cwd: dir, stdio: 'pipe' },
    );

  it('clones at the developer commit, tracks the proposal, applies chosen files as a patch, rejects the rest', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-proposal`);
    const p = await ensureProposalClone(repo, dir);
    // The git dir is beside the clone, never in it: the clone is what the container mounts.
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(p.gitDir).toBe(proposalGitDir(dir));
    expect(path.relative(dir, p.gitDir).startsWith('..')).toBe(true);
    expect(fs.existsSync(path.join(p.gitDir, 'HEAD'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(p.base).toBe(sh(['rev-parse', 'HEAD']).toString().trim());
    expect(await proposalChanges(p)).toEqual([]);

    // The agent edits, adds, and commits one thing, leaves another uncommitted.
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 2;\n');
    fs.writeFileSync(path.join(dir, 'src', 'util.ts'), 'export const y = 1;\n');
    agentGit(dir, 'add', '-A');
    agentGit(dir, 'commit', '-qm', 'agent edit');
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi\nmore\n');
    const changes = await proposalChanges(p);
    expect(changes).toEqual([
      { path: 'README.md', status: 'M' },
      { path: 'src/app.ts', status: 'M' },
      { path: 'src/util.ts', status: 'A' },
    ]);
    expect(await proposalBaseContent(p, 'src/app.ts')).toBe('export const x = 1;\n');
    expect(await proposalBaseContent(p, 'src/util.ts')).toBeNull();

    // A clone with a pending proposal is left alone even though the developer moved on.
    fs.writeFileSync(path.join(repo, 'other.txt'), 'dev work\n');
    sh(['add', '-A']);
    sh(['commit', '-qm', 'dev moved on']);
    const again = await ensureProposalClone(repo, dir);
    expect(again.base).toBe(p.base);

    // Apply two files into the developer's tree (three-way against the moved tree), reject the third.
    const applied = await applyProposal(p, ['src/app.ts', 'src/util.ts']);
    expect(applied.sort()).toEqual(['src/app.ts', 'src/util.ts']);
    expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 2;\n');
    expect(fs.readFileSync(path.join(repo, 'src', 'util.ts'), 'utf8')).toBe('export const y = 1;\n');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# hi\n'); // not applied
    await rejectProposal(p, ['README.md']);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# hi\n');
    // Reject everything left: the clone is back at its base and, being clean, follows the developer's HEAD next time.
    await rejectProposal(p);
    expect(await proposalChanges(p)).toEqual([]);
    const fresh = await ensureProposalClone(repo, dir);
    expect(fresh.base).toBe(sh(['rev-parse', 'HEAD']).toString().trim());
    expect(fs.existsSync(path.join(dir, 'other.txt'))).toBe(true);
    for (const x of siblings(dir)) fs.rmSync(x, { recursive: true, force: true });
  });

  it('recovers the repository recorded beside the clone, never the one its git config names', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-recover`);
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-decoy-'));
    try {
      const p = await ensureProposalClone(repo, dir);
      // The agent cannot write the git dir, but even a rewritten origin must not steer where a proposal applies.
      execFileSync('git', ['--git-dir', p.gitDir, 'remote', 'set-url', 'origin', decoy]);
      expect(await recoverProposal(dir)).toEqual({ repoRoot: repo, dir, gitDir: p.gitDir, base: p.base });
      // Without the record there is nothing trustworthy to recover.
      fs.rmSync(`${dir}.nanoclaw-root`);
      expect(await recoverProposal(dir)).toBeNull();
    } finally {
      for (const x of [...siblings(dir), decoy]) fs.rmSync(x, { recursive: true, force: true });
    }
  });

  it('refuses to reject a path outside the clone', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-escape`);
    const victim = path.join(path.dirname(repo), `${path.basename(repo)}-victim.txt`);
    fs.writeFileSync(victim, 'keep me\n');
    try {
      const p = await ensureProposalClone(repo, dir);
      await expect(rejectProposal(p, [`../${path.basename(victim)}`])).rejects.toThrow(/outside the proposal/);
      fs.symlinkSync(path.dirname(repo), path.join(dir, 'out'));
      await expect(rejectProposal(p, [`out/${path.basename(victim)}`])).rejects.toThrow(/outside the proposal/);
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep me\n');
    } finally {
      for (const x of [...siblings(dir), victim]) fs.rmSync(x, { recursive: true, force: true });
    }
  });
});
