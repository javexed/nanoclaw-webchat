import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changedFiles, parsePorcelain, resolveWorkspace } from './git-changes.js';

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
});

import {
  SAFE_GIT_CONFIG,
  applyProposal,
  ensureProposalClone,
  alignCase,
  gitArgv,
  mirrorInto,
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
      'core.longpaths=true',
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
    const ws = await resolveWorkspace(repo);
    expect((await changedFiles(repo, ws.repo!)).map((f) => f.path)).toEqual(['README.md']);
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(script, { force: true });
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
    // The base is a snapshot of the developer's working tree, on top of their commit.
    const devHead = sh(['rev-parse', 'HEAD']).toString().trim();
    expect(
      execFileSync('git', ['--git-dir', p.gitDir, 'rev-parse', `${p.base}^`])
        .toString()
        .trim(),
    ).toBe(devHead);
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
    const { applied, conflicted } = await applyProposal(p, ['src/app.ts', 'src/util.ts']);
    expect(applied.sort()).toEqual(['src/app.ts', 'src/util.ts']);
    expect(conflicted).toEqual([]);
    expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 2;\n');
    expect(fs.readFileSync(path.join(repo, 'src', 'util.ts'), 'utf8')).toBe('export const y = 1;\n');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# hi\n'); // not applied
    await rejectProposal(p, ['README.md']);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# hi\n');
    // Reject everything left: the clone is back at its base and, being clean, follows the developer's HEAD next time.
    await rejectProposal(p);
    expect(await proposalChanges(p)).toEqual([]);
    const fresh = await ensureProposalClone(repo, dir);
    expect(fresh.base).not.toBe(p.base); // a fresh snapshot of what the developer has now
    expect(fs.existsSync(path.join(dir, 'other.txt'))).toBe(true);
    expect(await proposalChanges(fresh)).toEqual([]);
    for (const x of siblings(dir)) fs.rmSync(x, { recursive: true, force: true });
  });

  it('a file the developer changed since merges three ways: clean where the edits are apart, conflict blocks where they meet', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-merge`);
    try {
      const lines = (n: number, f: (i: number) => string) =>
        Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';
      fs.writeFileSync(
        path.join(repo, 'doc.md'),
        lines(12, (i) => `line ${i}`),
      );
      sh(['add', 'doc.md']);
      sh(['commit', '-qm', 'doc']);
      const p = await ensureProposalClone(repo, dir);
      // The agent: fixes line 1 and line 10, and edits app.ts, which the developer leaves alone.
      fs.writeFileSync(
        path.join(dir, 'doc.md'),
        lines(12, (i) => (i === 1 || i === 10 ? `line ${i} (agent)` : `line ${i}`)),
      );
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 3;\n');
      // The developer meanwhile: adds a heading at the top, and changes line 10 their own way.
      fs.writeFileSync(
        path.join(repo, 'doc.md'),
        '# heading\n' + lines(12, (i) => (i === 10 ? `line ${i} (mine)` : `line ${i}`)),
      );
      const out = await applyProposal(p);
      expect(out).toEqual({ applied: ['doc.md', 'src/app.ts'], conflicted: ['doc.md'] });
      expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 3;\n');
      const doc = fs.readFileSync(path.join(repo, 'doc.md'), 'utf8');
      expect(doc.startsWith('# heading\nline 0\nline 1 (agent)\n')).toBe(true); // theirs and the agent's, apart: both in
      expect(doc).toContain('<<<<<<< yours\nline 10 (mine)\n=======\nline 10 (agent)\n>>>>>>> agent\n');
    } finally {
      for (const x of siblings(dir)) fs.rmSync(x, { recursive: true, force: true });
    }
  });

  it('never merges through a link: a file the developer turned into a link is refused, its target untouched', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-link`);
    const outside = path.join(path.dirname(repo), `${path.basename(repo)}-outside.txt`);
    try {
      fs.writeFileSync(outside, 'outside the repository\n');
      const p = await ensureProposalClone(repo, dir);
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 3;\n');
      fs.rmSync(path.join(repo, 'src', 'app.ts'));
      fs.symlinkSync(outside, path.join(repo, 'src', 'app.ts'));
      await expect(applyProposal(p)).rejects.toThrow(/git apply/);
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside the repository\n');
      expect(fs.lstatSync(path.join(repo, 'src', 'app.ts')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(path.join(repo, 'src', 'app.ts'), { force: true });
      execFileSync('git', ['checkout', '--', 'src/app.ts'], { cwd: repo });
      fs.rmSync(outside, { force: true });
      for (const x of siblings(dir)) fs.rmSync(x, { recursive: true, force: true });
    }
  });

  it('a change that can be neither applied nor merged refuses the whole apply, and no file is touched', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-refuse`);
    try {
      const p = await ensureProposalClone(repo, dir);
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 3;\n');
      fs.writeFileSync(path.join(dir, 'added.txt'), "the agent's\n");
      fs.writeFileSync(path.join(repo, 'added.txt'), 'the developer made one too\n'); // an added file cannot merge
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const x = 9;\n');
      await expect(applyProposal(p)).rejects.toThrow(/git apply/);
      expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 9;\n');
      expect(fs.readFileSync(path.join(repo, 'added.txt'), 'utf8')).toBe('the developer made one too\n');
    } finally {
      fs.rmSync(path.join(repo, 'added.txt'), { force: true });
      for (const x of siblings(dir)) fs.rmSync(x, { recursive: true, force: true });
    }
  });

  it("snapshots the working tree — uncommitted, untracked, ignored, a nested repo's files — but never dependencies, secrets or .git", async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-snapshot`);
    try {
      // What a real project looks like: most of it outside git.
      fs.writeFileSync(path.join(repo, '.gitignore'), 'web/\n.env\ncompose.yml\n');
      sh(['add', '.gitignore']);
      sh(['commit', '-qm', 'ignore the app']);
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const x = 5; // wip\n'); // uncommitted edit
      fs.writeFileSync(path.join(repo, 'start.sh'), 'docker compose up\n'); // untracked
      fs.writeFileSync(path.join(repo, 'compose.yml'), 'services: {}\n'); // ignored
      fs.mkdirSync(path.join(repo, 'web', 'modules'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'web', 'modules', 'core.php'), '<?php\n'); // ignored folder
      fs.writeFileSync(path.join(repo, '.env'), 'DB_PASSWORD=hunter2\n'); // ignored secret
      fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), '1'); // dependency
      const theme = path.join(repo, 'Theme');
      fs.mkdirSync(theme);
      execFileSync('git', ['init', '-q'], { cwd: theme, stdio: 'pipe' });
      fs.writeFileSync(path.join(theme, 'style.css'), 'a{}\n'); // a repo cloned beside the code

      fs.writeFileSync(path.join(repo, 'dump.sql'), 'INSERT INTO users …\n'); // untracked dump
      fs.writeFileSync(path.join(repo, 'fixture.db'), 'tracked test data\n');
      sh(['add', 'fixture.db']);
      sh(['commit', '-qm', 'fixture']);

      // By default gitignored files stay home.
      const plain = await ensureProposalClone(repo, dir, ['.env', '.env.*'], false);
      const has = (rel: string) => fs.existsSync(path.join(dir, rel));
      expect(has('start.sh')).toBe(true);
      for (const rel of ['compose.yml', 'web', '.env', 'dump.sql']) expect(has(rel)).toBe(false);
      expect(has('fixture.db')).toBe(true); // a dump name, but tracked: a real project file
      expect(await proposalChanges(plain)).toEqual([]);

      // Opted in, they come along — the clone is clean, so it refreshes.
      const p = await ensureProposalClone(repo, dir, ['.env', '.env.*'], true);
      expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const x = 5; // wip\n');
      for (const rel of ['start.sh', 'compose.yml', 'web/modules/core.php', 'Theme/style.css'])
        expect(has(rel)).toBe(true);
      for (const rel of ['.env', 'node_modules', 'Theme/.git', 'dump.sql']) expect(has(rel)).toBe(false);
      // The developer's own work in progress is the base, not part of the proposal.
      expect(await proposalChanges(p)).toEqual([]);

      // The agent edits files git does not track in the developer's repo; they apply back.
      fs.writeFileSync(path.join(dir, 'compose.yml'), 'services: { web: {} }\n');
      fs.writeFileSync(path.join(dir, 'web', 'modules', 'core.php'), '<?php // fixed\n');
      expect((await proposalChanges(p)).map((f) => f.path)).toEqual(['compose.yml', 'web/modules/core.php']);
      await applyProposal(p);
      expect(fs.readFileSync(path.join(repo, 'compose.yml'), 'utf8')).toBe('services: { web: {} }\n');
      expect(fs.readFileSync(path.join(repo, 'web', 'modules', 'core.php'), 'utf8')).toBe('<?php // fixed\n');
      expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 5; // wip\n');
    } finally {
      for (const x of siblings(dir)) fs.rmSync(x, { recursive: true, force: true });
    }
  });

  it('sets aside a clone made before snapshots (last commit only), keeping what the agent wrote there', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-old`);
    try {
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'the rest of the project\n');
      // An old-style clone: base = the developer's commit, an agent file pending.
      const gitDir = proposalGitDir(dir);
      execFileSync('git', ['clone', '-q', '--no-checkout', `--separate-git-dir=${gitDir}`, repo, dir]);
      fs.rmSync(path.join(dir, '.git'), { force: true });
      const head = sh(['rev-parse', 'HEAD']).toString().trim();
      execFileSync('git', ['--git-dir', gitDir, '--work-tree', dir, 'checkout', '-q', '-B', 'nanoclaw/proposal', head]);
      fs.writeFileSync(`${dir}.nanoclaw-base`, head);
      fs.writeFileSync(`${dir}.nanoclaw-root`, repo);
      fs.writeFileSync(path.join(dir, 'compose.yml'), 'made up by the agent\n');

      const p = await ensureProposalClone(repo, dir);
      expect(fs.existsSync(path.join(dir, 'untracked.txt'))).toBe(true); // a fresh working-tree snapshot
      expect(fs.existsSync(path.join(dir, 'compose.yml'))).toBe(false);
      expect(await proposalChanges(p)).toEqual([]);
      const aside = fs
        .readdirSync(path.dirname(dir))
        .find((f) => f.startsWith(`${path.basename(dir)}.aside-`) && !f.includes('.nanoclaw-'));
      expect(aside).toBeDefined();
      expect(fs.readFileSync(path.join(path.dirname(dir), aside!, 'compose.yml'), 'utf8')).toBe(
        'made up by the agent\n',
      );
    } finally {
      for (const f of fs.readdirSync(path.dirname(dir)))
        if (f.startsWith(path.basename(dir)))
          fs.rmSync(path.join(path.dirname(dir), f), { recursive: true, force: true });
    }
  });

  it('a clone left half moved by an earlier version (files gone, git dir kept) is rebuilt without deleting its git dir', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-half`);
    try {
      const first = await ensureProposalClone(repo, dir);
      const gitDirInode = fs.statSync(first.gitDir).ino;
      fs.renameSync(dir, `${dir}.gone`); // what 0.15.2 did before its rename of the git dir failed
      fs.writeFileSync(path.join(repo, 'later.txt'), 'new work\n');
      const p = await ensureProposalClone(repo, dir);
      expect(fs.statSync(p.gitDir).ino).toBe(gitDirInode); // reused, not deleted and remade
      expect(fs.readFileSync(path.join(dir, 'later.txt'), 'utf8')).toBe('new work\n');
      expect(await proposalChanges(p)).toEqual([]);
    } finally {
      for (const f of fs.readdirSync(path.dirname(dir)))
        if (f.startsWith(path.basename(dir)))
          fs.rmSync(path.join(path.dirname(dir), f), { recursive: true, force: true });
    }
  });

  it('a git dir partly deleted and held (neither usable nor removable) is left; a fresh one beside it takes over', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-held`);
    try {
      const first = await ensureProposalClone(repo, dir);
      fs.rmSync(path.join(first.gitDir, 'HEAD')); // what an interrupted delete left on her laptop
      const p = await ensureProposalClone(repo, dir);
      expect(p.gitDir).not.toBe(first.gitDir);
      expect(fs.existsSync(first.gitDir)).toBe(true); // left alone
      expect(path.dirname(p.gitDir)).toBe(path.dirname(dir));
      expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
      expect(await proposalChanges(p)).toEqual([]);
      // The agent's edit is a proposal against the new git dir, and survives a reload.
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 9;\n');
      expect((await proposalChanges(p)).map((f) => f.path)).toEqual(['src/app.ts']);
      expect(await recoverProposal(dir)).toMatchObject({ gitDir: p.gitDir, base: p.base });
    } finally {
      for (const f of fs.readdirSync(path.dirname(dir)))
        if (f.startsWith(path.basename(dir)))
          fs.rmSync(path.join(path.dirname(dir), f), { recursive: true, force: true });
    }
  });

  it('recovers the repository recorded beside the clone, never the one its git config names', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-recover`);
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-decoy-'));
    try {
      const p = await ensureProposalClone(repo, dir);
      // The agent cannot write the git dir, but even a rewritten origin must not steer where a proposal applies.
      execFileSync('git', ['--git-dir', p.gitDir, 'remote', 'add', 'origin', decoy]);
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

// Symlinks need a privilege on Windows that a test run may not have.
const canLink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-link-'));
  try {
    fs.symlinkSync(os.tmpdir(), path.join(d, 'l'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

const cleanClone = (dir: string) => {
  for (const f of fs.readdirSync(path.dirname(dir)))
    if (f.startsWith(path.basename(dir))) fs.rmSync(path.join(path.dirname(dir), f), { recursive: true, force: true });
};

describe('propose mode: an agent-planted link never carries a copy out of the clone', () => {
  let victim: string;
  beforeEach(() => {
    victim = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-victim-'));
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep me\n');
  });
  afterEach(() => fs.rmSync(victim, { recursive: true, force: true }));
  const victimHolds = () => fs.readdirSync(victim).sort();

  it.skipIf(!canLink)('a link in a parent folder is replaced by a real folder, its target untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-mirror-'));
    try {
      fs.mkdirSync(path.join(repo, 'dist', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'dist', 'deep', 'app.js'), 'x\n');
      fs.symlinkSync(victim, path.join(dir, 'dist'), 'junction');
      mirrorInto(repo, dir, ['dist/deep/app.js', 'README.md']);
      expect(victimHolds()).toEqual(['keep.txt']);
      expect(fs.lstatSync(path.join(dir, 'dist')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'dist', 'deep', 'app.js'), 'utf8')).toBe('x\n');
      // A link deeper down, and one where a file should go.
      fs.rmSync(path.join(dir, 'dist', 'deep'), { recursive: true });
      fs.symlinkSync(victim, path.join(dir, 'dist', 'deep'), 'junction');
      fs.rmSync(path.join(dir, 'README.md'));
      fs.symlinkSync(path.join(victim, 'keep.txt'), path.join(dir, 'README.md'));
      mirrorInto(repo, dir, ['dist/deep/app.js', 'README.md']);
      expect(victimHolds()).toEqual(['keep.txt']);
      expect(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8')).toBe('keep me\n');
      expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# hi\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!canLink)(
    'a link hidden in a gitignored path is shown as a proposal and holds the refresh back',
    async () => {
      const dir = path.join(path.dirname(repo), `${path.basename(repo)}-planted`);
      try {
        fs.writeFileSync(path.join(repo, '.gitignore'), 'dist\n');
        sh(['add', '.gitignore']);
        sh(['commit', '-qm', 'ignore dist']);
        const p = await ensureProposalClone(repo, dir, [], false);
        fs.symlinkSync(victim, path.join(dir, 'dist'), 'junction');
        expect(await proposalChanges(p)).toEqual([{ path: 'dist', status: 'A', risk: 'symbolic link' }]);
        // The developer's build lands in their ignored dist; the next start must not follow the link.
        fs.mkdirSync(path.join(repo, 'dist'));
        fs.writeFileSync(path.join(repo, 'dist', 'app.js'), 'built\n');
        const again = await ensureProposalClone(repo, dir, [], true);
        expect(again.base).toBe(p.base);
        expect(victimHolds()).toEqual(['keep.txt']);
        // Rejecting everything removes the link itself, never what it points at.
        await rejectProposal(p);
        expect(fs.lstatSync(path.join(dir, 'dist'), { throwIfNoEntry: false })).toBeUndefined();
        expect(victimHolds()).toEqual(['keep.txt']);
        const fresh = await ensureProposalClone(repo, dir, [], true);
        expect(fs.readFileSync(path.join(dir, 'dist', 'app.js'), 'utf8')).toBe('built\n');
        expect(await proposalChanges(fresh)).toEqual([]);
      } finally {
        cleanClone(dir);
      }
    },
  );
});

describe('propose mode: rebuilds and leftovers', () => {
  it('a clone whose git dir is gone is rebuilt in place: files set aside, never deleted, the .git mountpoint no obstacle', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-nogit`);
    try {
      const first = await ensureProposalClone(repo, dir);
      fs.writeFileSync(path.join(dir, 'agent-notes.md'), 'wanted\n');
      fs.rmSync(first.gitDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, '.git')); // what Docker leaves for the read-only git dir mount
      const p = await ensureProposalClone(repo, dir);
      expect(fs.existsSync(path.join(p.gitDir, 'HEAD'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
      expect(await proposalChanges(p)).toEqual([]);
      const devHead = sh(['rev-parse', 'HEAD']).toString().trim();
      expect(
        execFileSync('git', ['--git-dir', p.gitDir, 'rev-parse', `${p.base}^`])
          .toString()
          .trim(),
      ).toBe(devHead);
      const aside = fs.readdirSync(path.dirname(dir)).find((f) => f.startsWith(`${path.basename(dir)}.aside-`));
      expect(fs.readFileSync(path.join(path.dirname(dir), aside!, 'agent-notes.md'), 'utf8')).toBe('wanted\n');
    } finally {
      cleanClone(dir);
    }
  });

  it('keeps only the newest copy set aside', async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-asides`);
    const other = `${dir}x.aside-1`; // another clone's, whose name only starts the same
    try {
      const first = await ensureProposalClone(repo, dir);
      for (const n of [1, 2]) fs.mkdirSync(`${dir}.aside-${n}`);
      fs.mkdirSync(other);
      fs.rmSync(first.gitDir, { recursive: true, force: true });
      await ensureProposalClone(repo, dir);
      const asides = fs.readdirSync(path.dirname(dir)).filter((f) => f.startsWith(`${path.basename(dir)}.aside-`));
      expect(asides).toHaveLength(1);
      expect(Number(asides[0].split('-').pop())).toBeGreaterThan(2);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      cleanClone(dir);
    }
  });

  it('follows a git dir pointer only to a name this code makes, beside the clone', () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-ptr`);
    const pointer = `${dir}.nanoclaw-gitdir`;
    try {
      for (const bad of [
        dir,
        `${dir}-elsewhere`,
        path.join(os.tmpdir(), 'x', `${path.basename(dir)}.nanoclaw-git-1`),
        pointer,
      ]) {
        fs.writeFileSync(pointer, bad);
        expect(proposalGitDir(dir)).toBe(`${dir}.nanoclaw-git`);
      }
      fs.writeFileSync(pointer, `${dir}.nanoclaw-git-123`);
      expect(proposalGitDir(dir)).toBe(`${dir}.nanoclaw-git-123`);
    } finally {
      cleanClone(dir);
    }
  });

  it("marks proposed changes that could run something on the developer's machine", async () => {
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-risky`);
    try {
      fs.writeFileSync(path.join(repo, 'run.sh'), 'echo hi\n');
      sh(['add', 'run.sh']);
      sh(['commit', '-qm', 'script']);
      const p = await ensureProposalClone(repo, dir);
      fs.mkdirSync(path.join(dir, '.vscode'));
      fs.writeFileSync(path.join(dir, '.vscode', 'tasks.json'), '{}');
      fs.mkdirSync(path.join(dir, '.husky'));
      fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), 'curl example.invalid\n');
      fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 2;\n');
      if (process.platform !== 'win32') fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
      const risks = Object.fromEntries((await proposalChanges(p)).map((f) => [f.path, f.risk]));
      expect(risks['.vscode/tasks.json']).toBe('runs code in VS Code');
      expect(risks['.husky/pre-commit']).toBe('git hook');
      expect(risks['.gitattributes']).toBe('changes git attributes');
      expect(risks['src/app.ts']).toBeUndefined();
      if (process.platform !== 'win32') expect(risks['run.sh']).toBe('makes a file executable');
    } finally {
      cleanClone(dir);
    }
  });
});

describe('alignCase (Windows path spelling)', () => {
  it("takes the folder's spelling where git's differs only in case", () => {
    expect(alignCase('c:\\proj', 'C:\\proj', 'win32')).toBe('c:\\proj');
    expect(alignCase('c:\\proj\\pkg', 'C:\\Proj', 'win32')).toBe('c:\\proj');
    expect(alignCase('c:\\other', 'C:\\proj', 'win32')).toBe('C:\\proj');
  });
  it('leaves case alone where it matters', () => {
    expect(alignCase('/home/dev/proj', '/home/dev/Proj', 'linux')).toBe('/home/dev/Proj');
  });
});
