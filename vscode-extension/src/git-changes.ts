// What the agent changed, as the developer's git sees it.
//
// The agent edits files in the mounted workspace directly, so its changes land
// on disk at once. Review therefore happens against git: the working tree
// versus HEAD, file by file. To tell the agent's edits from the developer's
// own, the panel snapshots the tree before a message goes out and compares
// after the reply — a file whose signature changed in between was touched by
// the agent this turn.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ChangedFile {
  /** Path relative to the reviewed folder (the repository root in propose mode), forward slashes. */
  path: string;
  /** Porcelain status: 'M', 'A', 'D', 'R', '??', … */
  status: string;
  untracked: boolean;
}

export type Snapshot = Map<string, string>; // path → signature

/**
 * Config that could run a program, forced off on every call. The agent can
 * write into the trees these calls read, so nothing git picks up from there
 * may name a command for the developer's machine to run.
 *
 * Filter drivers cannot be switched off from the command line: `.gitattributes`
 * in the work tree names them, config defines them. `attr.tree=HEAD` makes git
 * read attributes from the committed tree instead of the work tree (git 2.42+;
 * older git ignores it, and an unborn HEAD still falls back to the work tree).
 * The real protection is that the config is never one the agent could write:
 * every call names its repository explicitly and the git dir reaches the
 * container read-only.
 */
export const SAFE_GIT_CONFIG = [
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
];

/** A repository named explicitly, so git never discovers `.git` from a tree the agent can write. */
export interface GitRepo {
  gitDir: string;
  workTree: string;
}

export function gitArgv(args: string[], repo?: GitRepo): string[] {
  return [...SAFE_GIT_CONFIG, ...(repo ? [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`] : []), ...args];
}

export function git(cwd: string, args: string[], input?: string, repo?: GitRepo): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      gitArgv(args, repo),
      { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error(
              `git ${args[0]}: ${String(stderr || err.message)
                .trim()
                .slice(0, 300)}`,
            ),
          );
        else resolve(String(stdout));
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** `git status --porcelain=v1 -z` → changed files. Renames report the new path. */
export function parsePorcelain(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    let p = rec.slice(3);
    if (status[0] === 'R' || status[0] === 'C') {
      // "R  new\0old": the next NUL-separated entry is the ORIGINAL path.
      i++;
    }
    p = p.replace(/\\/g, '/');
    files.push({ path: p, status: status.trim() || status, untracked: status === '??' });
  }
  return files;
}

/**
 * Submodules are left out: a submodule's `.git` file sits in the working tree,
 * where the agent could point it at a git dir of its own making.
 */
export async function changedFiles(cwd: string, repo: GitRepo, pathspec: string[] = []): Promise<ChangedFile[]> {
  return parsePorcelain(
    await git(
      cwd,
      [
        '--literal-pathspecs',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=all',
        ...(pathspec.length ? ['--', ...pathspec] : []),
      ],
      undefined,
      repo,
    ),
  );
}

// ---- direct mode ----------------------------------------------------------------
//
// The agent edits the developer's folder in place. Which repository that folder
// belongs to is settled on the host before any container can write the folder,
// and recorded; every git call for it names that repository. Git never
// discovers one from the tree, so a `.git` the agent makes (with a config that
// names a filter or any other command) is never used.

/** A workspace folder and the repository it belongs to, as found before an agent could write it. */
export interface PinnedWorkspace {
  /** The folder (real path). */
  root: string;
  /** Its repository, or null when the folder is in none. */
  repo: GitRepo | null;
}
export type InRepo = PinnedWorkspace & { repo: GitRepo };

/** Where the runner records pinned workspaces, under its storage root. */
export const workspaceRecords = (storageRoot: string): string => path.join(storageRoot, 'workspaces');
const recordFile = (records: string, root: string): string =>
  path.join(records, `${createHash('sha256').update(root).digest('hex').slice(0, 32)}.json`);

const inOrUnder = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep);

/** Find the repository `dir` is in, now. Only safe while no agent can write `dir`. */
export async function resolveWorkspace(dir: string): Promise<PinnedWorkspace> {
  const root = fs.realpathSync(dir);
  try {
    const [gitDir, top] = (await git(root, ['rev-parse', '--absolute-git-dir', '--show-toplevel'])).trim().split('\n');
    const workTree = fs.realpathSync(top.trim());
    if (!gitDir || !inOrUnder(workTree, root)) return { root, repo: null };
    return { root, repo: { gitDir: fs.realpathSync(gitDir.trim()), workTree } };
  } catch {
    return { root, repo: null };
  }
}

export function recordWorkspace(records: string, ws: PinnedWorkspace): void {
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(recordFile(records, ws.root), JSON.stringify(ws));
}

function readRecord(records: string, root: string): PinnedWorkspace | null {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(records, root), 'utf8')) as PinnedWorkspace;
    if (r.root !== root) return null;
    if (r.repo === null) return { root, repo: null };
    if (typeof r.repo?.gitDir !== 'string' || typeof r.repo.workTree !== 'string') return null;
    return { root, repo: { gitDir: r.repo.gitDir, workTree: r.repo.workTree } };
  } catch {
    return null;
  }
}

/**
 * The repository to review `folder` against. A folder the runner mounted (or
 * one inside it) uses what was recorded before the mount; a folder no agent
 * was given is resolved now.
 */
export async function workspaceFor(records: string, folder: string): Promise<PinnedWorkspace> {
  const root = fs.realpathSync(folder);
  for (let dir = root; ; dir = path.dirname(dir)) {
    const r = readRecord(records, dir);
    if (r) return { root, repo: r.repo && inOrUnder(r.repo.workTree, root) ? r.repo : null };
    if (path.dirname(dir) === dir) break;
  }
  return resolveWorkspace(root);
}

/** The folder's path from the repository root, forward slashes ('' at the root). */
const prefixOf = (ws: InRepo): string => path.relative(ws.repo.workTree, ws.root).split(path.sep).join('/');
/** A folder-relative path as the repository names it. */
const inRepo = (ws: InRepo, rel: string): string => (prefixOf(ws) ? `${prefixOf(ws)}/${rel}` : rel);

/** Changed files inside the folder, with folder-relative paths. */
export async function workspaceChanges(ws: InRepo): Promise<ChangedFile[]> {
  const prefix = prefixOf(ws);
  const files = await changedFiles(ws.repo.workTree, ws.repo, prefix ? [prefix] : []);
  if (!prefix) return files;
  return files
    .filter((f) => f.path.startsWith(`${prefix}/`) && f.path.length > prefix.length + 1)
    .map((f) => ({ ...f, path: f.path.slice(prefix.length + 1) }));
}

/** Signature of every changed file: status plus size and mtime — cheap, and enough to notice an edit. */
export async function snapshot(ws: InRepo): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  for (const f of await workspaceChanges(ws)) {
    let sig = f.status;
    try {
      const st = fs.statSync(path.join(ws.root, f.path));
      sig += `:${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      sig += ':gone';
    }
    snap.set(f.path, sig);
  }
  return snap;
}

/** Paths that appeared or changed between two snapshots (the agent's work this turn). */
export function touchedBetween(before: Snapshot, after: Snapshot): Set<string> {
  const out = new Set<string>();
  for (const [p, sig] of after) if (before.get(p) !== sig) out.add(p);
  for (const p of before.keys()) if (!after.has(p)) out.add(p); // reverted or deleted meanwhile
  return out;
}

/** The committed version of a file, or null when HEAD has none (a new file). */
export async function headContent(ws: InRepo, relPath: string): Promise<string | null> {
  try {
    // cat-file prints the blob as stored: no textconv, no filters.
    return await git(ws.repo.workTree, ['cat-file', 'blob', `HEAD:${inRepo(ws, relPath)}`], undefined, ws.repo);
  } catch {
    return null;
  }
}

/** Throw the working-tree change away: tracked → checkout from HEAD; untracked → delete. */
export async function revert(ws: InRepo, file: ChangedFile): Promise<void> {
  if (file.untracked) {
    fs.rmSync(insideDir(ws.root, file.path), { force: true });
    return;
  }
  await git(ws.repo.workTree, ['--literal-pathspecs', 'checkout', '--', inRepo(ws, file.path)], undefined, ws.repo);
}

/** Accept the change by staging it: it stays in the tree and stands out from later edits. */
export async function keep(ws: InRepo, file: ChangedFile): Promise<void> {
  await git(ws.repo.workTree, ['--literal-pathspecs', 'add', '--', inRepo(ws, file.path)], undefined, ws.repo);
}

// ---- propose mode ------------------------------------------------------------
//
// The agent works in a self-contained local clone of the developer's
// repository (a worktree's `.git` file would point at a Windows path the
// container cannot follow). The clone sits on a branch of its own at the
// developer's current commit; its changes are the proposal. Applying moves
// them into the developer's working tree as a patch; rejecting resets the
// clone. Only committed files exist in the clone, so gitignored secrets never
// reach the agent at all.
//
// The clone's git dir lives beside it, not in it: the agent can write every
// file in the clone, and a git dir it could write is a config it could fill
// with commands for the developer's git to run. So the clone has no `.git`
// at all, every call names the git dir explicitly, and the repository a
// proposal applies to is recorded here rather than read from the clone.

export interface Proposal {
  /** The developer's repository (their working tree). */
  repoRoot: string;
  /** The clone the agent edits. */
  dir: string;
  /** The clone's git dir, outside the clone. */
  gitDir: string;
  /** Commit the clone was reset to; the proposal is the diff against it. */
  base: string;
}

export const PROPOSAL_BRANCH = 'nanoclaw/proposal';

const beside = (dir: string, suffix: string): string => path.join(path.dirname(dir), `${path.basename(dir)}${suffix}`);
/** Where the git dir of the clone at `dir` lives: next to it, never inside it. */
export const proposalGitDir = (dir: string): string => beside(dir, '.nanoclaw-git');
const baseFileOf = (dir: string): string => beside(dir, '.nanoclaw-base');
const rootFileOf = (dir: string): string => beside(dir, '.nanoclaw-root');

const readIf = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null);
const pgit = (p: Pick<Proposal, 'dir' | 'gitDir'>, args: string[]): Promise<string> =>
  git(p.dir, args, undefined, { gitDir: p.gitDir, workTree: p.dir });

async function headOf(cwd: string, repo?: GitRepo): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'], undefined, repo)).trim();
}

/**
 * Make (or refresh) the proposal clone for a repository. A clone that still
 * holds an unapplied proposal is left alone; a clean one is moved to the
 * developer's current commit so the agent works on what they see. A clone
 * without a git dir of its own, or made from another repository, is replaced.
 */
export async function ensureProposalClone(repoRoot: string, dir: string): Promise<Proposal> {
  const devHead = await headOf(repoRoot);
  const gitDir = proposalGitDir(dir);
  const baseFile = baseFileOf(dir);
  if (!fs.existsSync(gitDir) || readIf(rootFileOf(dir)) !== repoRoot) {
    for (const p of [dir, gitDir, baseFile, rootFileOf(dir)]) fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(path.dirname(dir), [
      'clone',
      '--quiet',
      '--no-hardlinks',
      '--no-checkout',
      `--separate-git-dir=${gitDir}`,
      repoRoot,
      dir,
    ]);
    // Clone leaves a `.git` file pointing at the git dir; nothing reads it, and the agent could rewrite it.
    fs.rmSync(path.join(dir, '.git'), { force: true });
    const p: Proposal = { repoRoot, dir, gitDir, base: devHead };
    await pgit(p, ['checkout', '--quiet', '-B', PROPOSAL_BRANCH, devHead]);
    fs.writeFileSync(baseFile, devHead);
    fs.writeFileSync(rootFileOf(dir), repoRoot);
    return p;
  }
  const p: Proposal = {
    repoRoot,
    dir,
    gitDir,
    base: readIf(baseFile) ?? (await headOf(dir, { gitDir, workTree: dir })),
  };
  const pending = (await proposalChanges(p)).length > 0;
  if (!pending && p.base !== devHead) {
    await pgit(p, ['fetch', '--quiet', repoRoot, devHead]);
    await pgit(p, ['checkout', '--quiet', '-B', PROPOSAL_BRANCH, devHead]);
    p.base = devHead;
    fs.writeFileSync(baseFile, p.base);
  }
  return p;
}

/**
 * Read back a proposal clone that already exists — after a window reload the
 * runner re-attaches to a running container without preparing it, and must
 * not move the clone (it may hold an unapplied proposal). The developer's
 * repository and the base are what was recorded beside the clone when it was
 * made; nothing is taken from the clone's own git config.
 */
export async function recoverProposal(dir: string): Promise<Proposal | null> {
  const gitDir = proposalGitDir(dir);
  const repoRoot = readIf(rootFileOf(dir));
  if (!repoRoot || !fs.existsSync(gitDir) || !fs.existsSync(repoRoot)) return null;
  try {
    const base = readIf(baseFileOf(dir)) ?? (await headOf(dir, { gitDir, workTree: dir }));
    return { repoRoot, dir, gitDir, base };
  } catch {
    return null;
  }
}

export interface ProposedFile {
  path: string;
  /** 'M' modified, 'A' added, 'D' deleted (relative to the base). */
  status: 'M' | 'A' | 'D';
}

/** Everything the clone differs from its base by: committed or not, tracked or new. */
export async function proposalChanges(p: Proposal): Promise<ProposedFile[]> {
  const out = new Map<string, ProposedFile>();
  const tracked = await pgit(p, ['diff', '--no-ext-diff', '--name-status', '-z', p.base]);
  const parts = tracked.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const st = parts[i];
    if (!st) continue;
    let file = parts[i + 1];
    if (st[0] === 'R' || st[0] === 'C') {
      file = parts[i + 2];
      i++;
    }
    const status: ProposedFile['status'] = st[0] === 'D' ? 'D' : st[0] === 'A' ? 'A' : 'M';
    out.set(file, { path: file.replace(/\\/g, '/'), status });
  }
  for (const f of await changedFiles(p.dir, { gitDir: p.gitDir, workTree: p.dir })) {
    if (f.untracked) out.set(f.path, { path: f.path, status: 'A' });
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The base version of a proposed file, or null when it did not exist. */
export async function proposalBaseContent(p: Proposal, relPath: string): Promise<string | null> {
  try {
    return await pgit(p, ['show', `${p.base}:${relPath}`]);
  } catch {
    return null;
  }
}

/**
 * Bring proposed files into the developer's working tree as a patch (three-way
 * when the developer's tree has moved on). Untracked files are made visible to
 * the diff first. Returns the paths applied; throws with git's words on conflict.
 */
export async function applyProposal(p: Proposal, paths?: string[]): Promise<string[]> {
  const files = await proposalChanges(p);
  const chosen = paths ? files.filter((f) => paths.includes(f.path)) : files;
  if (chosen.length === 0) return [];
  const untracked = (await changedFiles(p.dir, { gitDir: p.gitDir, workTree: p.dir }))
    .filter((f) => f.untracked && chosen.some((c) => c.path === f.path))
    .map((f) => f.path);
  if (untracked.length) await pgit(p, ['add', '--intent-to-add', '--', ...untracked]);
  const patch = await pgit(p, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    p.base,
    '--',
    ...chosen.map((c) => c.path),
  ]);
  if (patch.trim()) await git(p.repoRoot, ['apply', '--3way', '--whitespace=nowarn'], patch);
  return chosen.map((c) => c.path);
}

/**
 * Throw proposed files away: back to the base. All of them when no paths are
 * given. A path that resolves outside the clone is refused.
 */
export async function rejectProposal(p: Proposal, paths?: string[]): Promise<void> {
  if (!paths) {
    await pgit(p, ['reset', '--quiet', '--hard', p.base]);
    await pgit(p, ['clean', '--quiet', '-fd']);
    return;
  }
  const full = paths.map((rel) => insideDir(p.dir, rel, 'the proposal'));
  const untracked = new Set(
    (await changedFiles(p.dir, { gitDir: p.gitDir, workTree: p.dir })).filter((f) => f.untracked).map((f) => f.path),
  );
  for (const [i, rel] of paths.entries()) {
    if (untracked.has(rel)) fs.rmSync(full[i], { force: true });
    else {
      try {
        await pgit(p, ['checkout', '--quiet', p.base, '--', rel]);
      } catch {
        // Added in a commit the agent made: no base version exists; remove it.
        await pgit(p, ['rm', '--quiet', '--force', '--', rel]).catch(() => fs.rmSync(full[i], { force: true }));
      }
    }
  }
}

/** `dir/rel`, refused when `rel` leads out of `dir` — by `..`, or through a symlinked directory. */
export function insideDir(dir: string, rel: string, label = 'the folder'): string {
  const full = path.resolve(dir, rel);
  const within = (root: string, p: string) => p.startsWith(root + path.sep);
  let ok = within(path.resolve(dir), full);
  if (ok) {
    try {
      const parent = fs.realpathSync(path.dirname(full));
      const root = fs.realpathSync(dir);
      ok = parent === root || within(root, parent);
    } catch {
      /* the parent does not exist: there is nothing there to touch */
    }
  }
  if (!ok) throw new Error(`refusing a path outside ${label}: ${rel}`);
  return full;
}
