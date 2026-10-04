// What the agent proposes, and how it reaches the developer's tree.
//
// The agent never edits the developer's working tree. It edits a copy (the
// proposal clone below); review is that copy against the snapshot it was
// made from, and applying moves the chosen files over as a patch.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { riskOf, type Risk } from './host-run-paths.js';
import { matchesExclude, UNTRACKED_SECRET_EXCLUDES } from './policy.js';
import { proposeIncludeIgnored, proposeIncludePaths, proposeSecretScanAllow } from './propose-settings.js';
import { leaveOutSecrets } from './secret-scan.js';

export interface ChangedFile {
  /** Path relative to the repository root, forward slashes. */
  path: string;
  /** Porcelain status: 'M', 'A', 'D', 'R', '??', … */
  status: string;
  untracked: boolean;
}

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
 * every call names its repository explicitly, and the git dir sits outside
 * the copy the agent's tools can reach.
 */
export const SAFE_GIT_CONFIG = [
  // Not a safety setting, but on every call too: Git for Windows refuses paths
  // past 260 characters without it, and a proposal copy sits deep in VS Code's
  // storage — a Drupal module path there failed `git add` ("Filename too long").
  // Ignored elsewhere.
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
];

/** A repository named explicitly, so git never discovers `.git` from a tree the agent can write. */
export interface GitRepo {
  gitDir: string;
  workTree: string;
}

export function gitArgv(args: string[], repo?: GitRepo): string[] {
  return [...SAFE_GIT_CONFIG, ...(repo ? [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`] : []), ...args];
}

export function git(
  cwd: string,
  args: string[],
  input?: string,
  repo?: GitRepo,
  /** Internal: argv prefix instead of SAFE_GIT_CONFIG (see applyToDeveloper). */
  safe: readonly string[] = SAFE_GIT_CONFIG,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...safe, ...gitArgv(args, repo).slice(SAFE_GIT_CONFIG.length)],
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

// ---- the developer's repository ---------------------------------------------
//
// The agent cannot write the developer's folder, so the repository it is in
// can be read from it directly.

/** A folder and the repository it belongs to. */
export interface PinnedWorkspace {
  /** The folder (real path). */
  root: string;
  /** Its repository, or null when the folder is in none. */
  repo: GitRepo | null;
}

// On Windows a path's case does not matter, and its spelling differs by
// source: VS Code hands over `c:\proj`, git answers `C:/proj`. Compared
// exactly, a repository at the folder's own root looked like no repository.
const fold = (p: string, platform: NodeJS.Platform): string => (platform === 'win32' ? p.toLowerCase() : p);
const inOrUnder = (root: string, p: string, platform = process.platform): boolean => {
  const sep = platform === 'win32' ? '\\' : '/';
  const [r, q] = [fold(root, platform), fold(p, platform)];
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep);
};

/**
 * The repository root git reported, spelled the way the folder is where the
 * two agree (Windows only): every later comparison of the two is exact.
 */
export function alignCase(root: string, workTree: string, platform = process.platform): string {
  if (platform !== 'win32' || workTree === root) return workTree;
  if (fold(root, platform) === fold(workTree, platform)) return root;
  if (inOrUnder(workTree, root, platform)) return root.slice(0, workTree.length);
  return workTree;
}

/**
 * Hooks directories the repository's own config points into `root` (husky's
 * `.husky/_`, a plain `.githooks`), resolved. husky's generated hooks run the
 * developer's scripts one level up, so for a directory named `_` its parent
 * counts too. Read from the config file itself: the safe-config overrides
 * above would otherwise mask the value.
 */
export async function hooksDirsInside(root: string, repo: GitRepo): Promise<string[]> {
  let configured = '';
  try {
    configured = (
      await git(root, ['config', '--file', path.join(repo.gitDir, 'config'), '--includes', '--get', 'core.hooksPath'])
    ).trim();
  } catch {
    return []; // unset (git exits 1) or unreadable
  }
  if (!configured) return [];
  const dir = path.resolve(
    repo.workTree,
    configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured,
  );
  const dirs = path.basename(dir) === '_' ? [dir, path.dirname(dir)] : [dir];
  return dirs.filter((d) => d !== root && inOrUnder(root, d));
}

/** Find the repository `dir` is in, now. Only safe on a folder no agent can write. */
export async function resolveWorkspace(dir: string): Promise<PinnedWorkspace> {
  const root = fs.realpathSync(dir);
  try {
    const [gitDir, top] = (await git(root, ['rev-parse', '--absolute-git-dir', '--show-toplevel'])).trim().split('\n');
    const workTree = alignCase(root, fs.realpathSync(top.trim()));
    if (!gitDir || !inOrUnder(workTree, root)) return { root, repo: null };
    return { root, repo: { gitDir: fs.realpathSync(gitDir.trim()), workTree } };
  } catch {
    return { root, repo: null };
  }
}

// ---- propose mode ------------------------------------------------------------
//
// The agent works in a self-contained local clone of the developer's
// repository (a worktree would share the developer's own git dir), holding a snapshot of their WORKING TREE, not just
// their last commit: uncommitted edits, untracked files, and — when the
// developer lists them (nanoclaw.agentCopy.includeIgnored) — gitignored ones (a
// Drupal codebase, a compose file, a theme cloned beside the repo): a project
// whose repository tracks three files is otherwise invisible to the agent.
// Dependency and cache folders are left out (SNAPSHOT_SKIP_DIRS), as is
// anything named like a secret or holding one (secret-scan.ts). The snapshot
// is committed in the clone and is the proposal's base, so the proposal is
// the agent's work only.
// Applying moves it into the developer's working tree as a patch; rejecting
// resets the clone to the snapshot.
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
  /** Set when this call took a snapshot: files the secret scan left out of it. */
  secretsLeftOut?: string[];
}

export const PROPOSAL_BRANCH = 'nanoclaw/proposal';

const beside = (dir: string, suffix: string): string => path.join(path.dirname(dir), `${path.basename(dir)}${suffix}`);
/**
 * Where the git dir of the clone at `dir` lives: next to it, never inside it.
 * Normally `<dir>.nanoclaw-git`; a pointer file names another when that one
 * became unusable and could not be removed (see ensureProposalClone).
 */
const gitDirPointerOf = (dir: string): string => beside(dir, '.nanoclaw-gitdir');
export const proposalGitDir = (dir: string): string => {
  const named = fs.existsSync(gitDirPointerOf(dir)) ? fs.readFileSync(gitDirPointerOf(dir), 'utf8').trim() : '';
  // Only a name this code makes: `<clone>.nanoclaw-git-<time>`, beside the clone.
  const ours = new RegExp(`^${path.basename(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.nanoclaw-git-\\d+$`);
  return named && path.dirname(named) === path.dirname(dir) && ours.test(path.basename(named)) && named !== dir
    ? named
    : beside(dir, '.nanoclaw-git');
};
const baseFileOf = (dir: string): string => beside(dir, '.nanoclaw-base');
const rootFileOf = (dir: string): string => beside(dir, '.nanoclaw-root');

const readIf = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null);
const pgit = (p: Pick<Proposal, 'dir' | 'gitDir'>, args: string[]): Promise<string> =>
  git(p.dir, args, undefined, { gitDir: p.gitDir, workTree: p.dir });

async function headOf(cwd: string, repo?: GitRepo): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'], undefined, repo)).trim();
}

/**
 * A cheap stamp of the developer's working tree: HEAD, and each path git
 * reports as changed or untracked, with its size and modification time. It
 * moves after a pull, a checkout, a commit or an edit, so the proposal copy
 * can tell it has fallen behind without a full snapshot. Reads only:
 * `--no-optional-locks` keeps git from refreshing the developer's index.
 * (Gitignored files and nested repositories are not in it; the next agent
 * start takes those in — except an include path that is a repository of its
 * own, stamped the same way.)
 */
export async function workingTreeStamp(
  repoRoot: string,
  includePaths: readonly string[] = proposeIncludePaths(),
): Promise<string> {
  const h = createHash('sha256');
  const stampRepo = async (root: string): Promise<void> => {
    h.update(await headOf(root).catch(() => '')).update('\0');
    const status = await git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const entries = status.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      h.update(entry).update('\0');
      // A rename or copy is `XY new\0old`: the old name follows as an entry of
      // its own, with no status in front of it — part of this record, not a path.
      if (/^[RC]|^.[RC]/.test(entry)) h.update(entries[++i] ?? '').update('\0');
      try {
        const st = fs.statSync(path.join(root, entry.slice(3)));
        h.update(`${st.size}:${st.mtimeMs}\0`);
      } catch {
        /* deleted */
      }
    }
  };
  await stampRepo(repoRoot);
  for (const rel of includePaths.map(projectRelative)) {
    if (!rel || !fs.existsSync(path.join(repoRoot, rel, '.git'))) continue;
    h.update(`\0${rel}\0`);
    await stampRepo(path.join(repoRoot, rel)).catch(() => {});
  }
  return h.digest('hex');
}

/** An include path as a path inside the project, or null: never absolute, never above the root. */
export function projectRelative(p: string): string | null {
  const rel = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split('/').some((s) => s === '..')) return null;
  return rel;
}

/** Folders a snapshot leaves out unless tracked: dependencies and caches — large, regenerated, not what the agent reads. */
export const SNAPSHOT_SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.gradle',
  '.terraform',
]);
/** Past these a snapshot is refused rather than filling the laptop's disk twice over (copy + its git objects). */
export const SNAPSHOT_LIMITS = { files: 150_000, bytes: 3 * 1024 ** 3 };

/**
 * The developer's working tree as a snapshot holds it: tracked files as they
 * are now, untracked ones and — with `includeIgnored` — gitignored ones
 * (walking into nested repositories, never their `.git`), minus skipped
 * folders, links, anything named like a secret, and untracked files named like
 * a dump or a credential (UNTRACKED_SECRET_EXCLUDES). `includePaths` names
 * gitignored folders or files taken in anyway, by the same rules. Relative
 * paths, forward slashes.
 */
export async function workingTreeFiles(
  repoRoot: string,
  excludes: readonly string[] = [],
  includeIgnored = false,
  includePaths: readonly string[] = [],
): Promise<string[]> {
  const out = new Set<string>();
  let bytes = 0;
  // `.GIT` is `.git` on Windows (and never legitimate elsewhere).
  const isGit = (seg: string) => seg.toLowerCase() === '.git';
  const skipped = (rel: string) => rel.split('/').some((seg) => SNAPSHOT_SKIP_DIRS.has(seg) || isGit(seg));
  // lstat sees only the last component: a folder on the way that is a link (an
  // include path through `theme -> ~/.ssh`, or a tracked folder since swapped
  // for one) would carry files from outside the project into the copy.
  const realRoot = fs.realpathSync(repoRoot);
  const folderInside = new Map<string, boolean>();
  const insideProject = (relDir: string): boolean => {
    if (relDir === '.' || relDir === '') return true;
    let ok = folderInside.get(relDir);
    if (ok === undefined) {
      let real: string | null = null;
      try {
        real = fs.realpathSync(path.join(repoRoot, relDir));
      } catch {
        /* gone */
      }
      ok =
        !!real && (real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep));
      folderInside.set(relDir, ok);
    }
    return ok;
  };
  const add = (rel: string, tracked: boolean): void => {
    rel = rel.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!rel || rel.split('/').some(isGit) || (!tracked && skipped(rel)) || matchesExclude(rel, excludes)) return;
    if (!tracked && matchesExclude(rel, UNTRACKED_SECRET_EXCLUDES)) return;
    if (!insideProject(path.posix.dirname(rel))) return;
    const st = fs.lstatSync(path.join(repoRoot, rel), { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(path.join(repoRoot, rel))) add(`${rel}/${e}`, tracked);
      return;
    }
    if (!st.isFile() || out.has(rel)) return;
    out.add(rel);
    bytes += st.size;
    if (out.size > SNAPSHOT_LIMITS.files || bytes > SNAPSHOT_LIMITS.bytes) {
      throw new Error(
        `the working tree is too large to snapshot for propose mode (over ${SNAPSHOT_LIMITS.files} files or ${SNAPSHOT_LIMITS.bytes / 1024 ** 3} GB outside dependency folders); exclude folders with nanoclaw.agentCopy.exclude`,
      );
    }
  };
  const list = async (args: string[]) => (await git(repoRoot, [...args, '-z'])).split('\0').filter(Boolean);
  for (const rel of await list(['ls-files', '--cached'])) add(rel, true);
  for (const rel of await list(['ls-files', '--others', '--exclude-standard', '--directory'])) add(rel, false);
  if (includeIgnored)
    for (const rel of await list(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']))
      add(rel, false);
  for (const rel of includePaths.map(projectRelative)) if (rel) add(rel, false);
  return [...out];
}

/**
 * Make `dir` hold exactly `files` from `from`: delete what is gone, then copy
 * what differs (size or time).
 *
 * The agent can write every entry in `dir`, so nothing there is followed: a
 * folder it swapped for a link (or a Windows junction) — `dist -> ~/.config/autostart`
 * — would otherwise carry the developer's files wherever it points. Deletion
 * goes first and never descends into a link; each destination's folders are
 * then checked one by one from `dir` down, anything there that is not a real
 * folder removed (the link itself, never its target) and a real folder made;
 * and before each write the destination's resolved folder must still be
 * inside `dir`.
 */
export function mirrorInto(from: string, dir: string, files: string[]): void {
  const want = new Set(files);
  const walk = (relDir: string): void => {
    for (const e of fs.readdirSync(path.join(dir, relDir), { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory() && !e.isSymbolicLink()) walk(rel);
      else if (!want.has(rel)) fs.rmSync(path.join(dir, rel), { force: true });
    }
  };
  walk('');
  const root = fs.realpathSync(dir);
  const within = (p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  for (const rel of files) {
    const segs = rel.split('/');
    let at = dir;
    for (const seg of segs.slice(0, -1)) {
      at = path.join(at, seg);
      const st = fs.lstatSync(at, { throwIfNoEntry: false });
      if (st?.isDirectory() && !st.isSymbolicLink()) continue;
      if (st) fs.rmSync(at, { force: true }); // a link, junction or file: the entry itself
      fs.mkdirSync(at);
    }
    const dst = path.join(dir, ...segs);
    if (!within(fs.realpathSync(path.dirname(dst))))
      throw new Error(`refusing to copy ${rel} into the proposal: its folder leads outside it`);
    const src = path.join(from, rel);
    const s = fs.statSync(src);
    const d = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (d?.isFile() && d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 1) continue;
    // Not a file: a link is removed as itself; a real folder (checked above to be inside `dir`) whole.
    if (d && !d.isFile()) fs.rmSync(dst, { recursive: d.isDirectory() && !d.isSymbolicLink(), force: true });
    fs.copyFileSync(src, dst);
    fs.utimesSync(dst, s.atime, s.mtime);
  }
}

/** The subject of a snapshot commit: how a clone made with snapshots is told from an older one. */
export const SNAPSHOT_SUBJECT = "developer's working tree";

/** Commit what the clone holds as the snapshot, and return it: the proposal's base. */
async function commitSnapshot(p: Proposal): Promise<string> {
  // -f: gitignored files are part of the snapshot too.
  await pgit(p, ['add', '-A', '-f', '--', '.']);
  await pgit(p, [
    '-c',
    'user.name=NanoClaw',
    '-c',
    'user.email=nanoclaw@localhost',
    'commit',
    '--quiet',
    '--allow-empty',
    '--no-verify',
    '-m',
    SNAPSHOT_SUBJECT,
  ]);
  return headOf(p.dir, { gitDir: p.gitDir, workTree: p.dir });
}

/**
 * Make (or refresh) the proposal clone for a repository. A clone that still
 * holds an unapplied proposal is left alone; a clean one takes a fresh
 * snapshot of the developer's working tree, so the agent works on what they
 * have now. A clone without a git dir of its own, or made from another
 * repository, is replaced. `excludes` names what never leaves the folder;
 * gitignored files go in only with `includeIgnored` (the developer's setting).
 * A file the secret scan finds a secret in stays out too, unless `secretAllow`
 * (the developer's globs) names it.
 */
export async function ensureProposalClone(
  repoRoot: string,
  dir: string,
  excludes: readonly string[] = [],
  includeIgnored = proposeIncludeIgnored(),
  secretAllow: readonly string[] = proposeSecretScanAllow(),
  includePaths: readonly string[] = proposeIncludePaths(),
): Promise<Proposal> {
  let gitDir = proposalGitDir(dir);
  if (fs.existsSync(gitDir) && !fs.existsSync(path.join(gitDir, 'HEAD'))) {
    // A git dir partly deleted and held (on Windows an antivirus scan or an
    // indexer can keep files in it open: EPERM on every remove) — it can be neither used
    // nor removed. Leave it; make a fresh one beside it and point to that.
    gitDir = beside(dir, `.nanoclaw-git-${Date.now()}`);
    await git(path.dirname(dir), ['init', '--quiet', '--bare', gitDir]);
    await git(path.dirname(dir), ['--git-dir', gitDir, 'config', 'core.bare', 'false']);
    fs.writeFileSync(gitDirPointerOf(dir), gitDir);
    fs.writeFileSync(rootFileOf(dir), repoRoot);
    fs.rmSync(baseFileOf(dir), { force: true });
  }
  const baseFile = baseFileOf(dir);
  const rootFile = rootFileOf(dir);
  const listed = await workingTreeFiles(repoRoot, excludes, includeIgnored, includePaths);
  // Scanned only when a snapshot is taken: a clone holding a proposal is left alone.
  const snapshotFiles = (): string[] => {
    const { files, leftOut } = leaveOutSecrets(repoRoot, listed, secretAllow);
    p.secretsLeftOut = leftOut;
    return files;
  };

  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    // No git dir: a first clone, or one whose git dir went missing. A fresh,
    // empty one, made beside the clone without touching it; the clone is then
    // rebuilt in place below. (Not `git clone`: it refuses a folder that is
    // not empty — files left behind by an earlier version.)
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(path.dirname(dir), ['init', '--quiet', '--bare', gitDir]);
    await git(path.dirname(dir), ['--git-dir', gitDir, 'config', 'core.bare', 'false']);
    await git(path.dirname(dir), ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', `refs/heads/${PROPOSAL_BRANCH}`]);
    fs.rmSync(baseFile, { force: true });
  }

  const p: Proposal = { repoRoot, dir, gitDir, base: readIf(baseFile) ?? '' };
  const sameRepo = readIf(rootFile) === repoRoot;
  const subject = p.base
    ? (
        await git(dir, ['log', '-1', '--format=%s', p.base], undefined, { gitDir, workTree: dir }).catch(() => '')
      ).trim()
    : '';
  if (sameRepo && subject === SNAPSHOT_SUBJECT && fs.existsSync(dir)) {
    // A snapshot clone: kept while it holds an unapplied proposal, refreshed
    // when clean. (proposalChanges counts a link the agent hid in a gitignored
    // path too: `dist -> ~/.config/autostart` holds the refresh back.)
    if ((await proposalChanges(p)).length === 0) {
      mirrorInto(repoRoot, dir, snapshotFiles());
      // Gitignored files count here: the snapshot takes them in with -f.
      const moved = await pgit(p, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching']);
      if (moved.length > 0) {
        p.base = await commitSnapshot(p);
        fs.writeFileSync(baseFile, p.base);
      }
    }
    return p;
  }

  // Anything else — a first clone, one whose git dir went missing, one from
  // before snapshots (last commit only), one half moved by an earlier
  // version, one of another repository — is rebuilt
  // IN PLACE: its files copied aside (they may hold something wanted), its git
  // dir reused. Never deleted or renamed: on Windows something else can hold
  // these folders open (EPERM), and that failed every start of the session.
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    fs.cpSync(dir, `${dir}.aside-${Date.now()}`, { recursive: true });
    pruneAsides(dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  await pgit(p, ['fetch', '--quiet', repoRoot, 'HEAD']);
  await pgit(p, ['reset', '--quiet', '--soft', 'FETCH_HEAD']);
  mirrorInto(repoRoot, dir, snapshotFiles());
  p.base = await commitSnapshot(p);
  fs.writeFileSync(baseFile, p.base);
  fs.writeFileSync(rootFile, repoRoot);
  return p;
}

/**
 * Keep only the newest copy set aside for the clone at `dir`: each can be as
 * large as the snapshot (gigabytes), and a rebuild on every start would
 * otherwise pile them up. The newest one is never removed.
 */
function pruneAsides(dir: string): void {
  const name = path.basename(dir);
  const asides = fs
    .readdirSync(path.dirname(dir))
    .map((f) => ({ f, at: /^\.aside-(\d+)$/.exec(f.slice(name.length)) }))
    .filter((x) => x.f.startsWith(name) && x.at)
    .sort((a, b) => Number(b.at![1]) - Number(a.at![1]));
  for (const { f } of asides.slice(1)) fs.rmSync(path.join(path.dirname(dir), f), { recursive: true, force: true });
}

/**
 * Read back a proposal clone that already exists — after a window reload the
 * runner picks up the proposal it had without preparing it again, and must
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
  /** Set when applying it could run something on the developer's machine: never applied without a yes. */
  risk?: Risk;
}

/**
 * Everything the clone differs from its base by: committed or not, tracked or
 * new — and any link the agent made in a gitignored path, which git would
 * otherwise not show at all. Each is marked with what applying it risks.
 */
export async function proposalChanges(p: Proposal): Promise<ProposedFile[]> {
  const out = new Map<string, ProposedFile>();
  const hooks = await developerHooksDirs(p);
  const put = (file: string, status: ProposedFile['status'], modes: { oldMode?: string; newMode?: string }) => {
    const rel = file.replace(/\\/g, '/');
    const risk = riskOf(rel, modes, hooks);
    out.set(rel, risk ? { path: rel, status, risk } : { path: rel, status });
  };
  // --raw: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0" (a rename or copy: two paths).
  const tracked = await pgit(p, ['diff', '--no-ext-diff', '--raw', '-z', p.base]);
  const parts = tracked.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta.startsWith(':')) continue;
    const [oldMode, newMode, , , st] = meta.slice(1).split(' ');
    let file = parts[i + 1];
    if (st[0] === 'R' || st[0] === 'C') {
      file = parts[i + 2];
      i++;
    }
    put(file, st[0] === 'D' ? 'D' : st[0] === 'A' ? 'A' : 'M', { oldMode, newMode });
  }
  const modeOf = (rel: string): string | undefined => {
    const st = fs.lstatSync(path.join(p.dir, rel), { throwIfNoEntry: false });
    if (!st) return undefined;
    if (st.isSymbolicLink()) return '120000';
    return process.platform !== 'win32' && st.mode & 0o111 ? '100755' : '100644';
  };
  for (const f of await changedFiles(p.dir, { gitDir: p.gitDir, workTree: p.dir })) {
    if (f.untracked) put(f.path, 'A', { newMode: modeOf(f.path) });
  }
  for (const rel of await ignoredLinks(p)) put(rel, 'A', { newMode: '120000' });
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Links in the clone's gitignored paths (as git lists them: a folder whole, a link as itself). */
async function ignoredLinks(p: Proposal): Promise<string[]> {
  const listed = await pgit(p, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  return listed
    .split('\0')
    .map((rel) => rel.replace(/\/+$/, ''))
    .filter((rel) => rel && fs.lstatSync(path.join(p.dir, rel), { throwIfNoEntry: false })?.isSymbolicLink());
}

/**
 * Hooks folders the developer's repository config points into their tree,
 * relative, forward slashes: a proposed change there runs at their next
 * commit. Their folder is not one the agent can write, so reading it is safe.
 */
async function developerHooksDirs(p: Proposal): Promise<string[]> {
  try {
    const ws = await resolveWorkspace(p.repoRoot);
    if (!ws.repo) return [];
    return (await hooksDirsInside(ws.root, ws.repo)).map((d) => path.relative(ws.root, d).split(path.sep).join('/'));
  } catch {
    return [];
  }
}

/** The base version of a proposed file, or null when it did not exist. */
export async function proposalBaseContent(p: Proposal, relPath: string): Promise<string | null> {
  try {
    return await pgit(p, ['show', `${p.base}:${relPath}`]);
  } catch {
    return null;
  }
}

export interface ApplyOutcome {
  /** Every file brought across. */
  applied: string[];
  /** Of those, the ones merged with conflict blocks left for the developer to resolve. */
  conflicted: string[];
}

/**
 * Bring proposed files into the developer's working tree as a patch. When the
 * developer has changed those files since, each is taken on its own: what
 * still applies, applies; a text file whose lines moved on is merged three
 * ways (base, theirs, the agent's), clashes left as conflict blocks — the
 * ones VS Code offers Accept Current / Incoming / Both on. Anything else that
 * does not fit refuses the whole apply before a file is touched. Untracked
 * files are made visible to the diff first.
 */
export async function applyProposal(p: Proposal, paths?: string[]): Promise<ApplyOutcome> {
  const files = await proposalChanges(p);
  const chosen = paths ? files.filter((f) => paths.includes(f.path)) : files;
  const none: ApplyOutcome = { applied: [], conflicted: [] };
  if (chosen.length === 0) return none;
  const untracked = [
    ...(await changedFiles(p.dir, { gitDir: p.gitDir, workTree: p.dir })).filter((f) => f.untracked).map((f) => f.path),
    ...(await ignoredLinks(p)),
  ].filter((f) => chosen.some((c) => c.path === f));
  // -f: a link in a gitignored path is shown, so it applies like any other file.
  if (untracked.length) await pgit(p, ['add', '-f', '--intent-to-add', '--', ...untracked]);
  const patch = await pgit(p, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    p.base,
    '--',
    ...chosen.map((c) => c.path),
  ]);
  if (patch.trim()) {
    // The base is the developer's working tree as it was, so the patch
    // normally applies to it as it stands — including to files git does not
    // track there, which a three-way apply cannot (it needs them in the index).
    // Three-way only when they have changed those files since.
    // Without attr.tree=HEAD: git 2.43's and 2.55's apply crash with it (a
    // segfault, no message). What that leaves open: `git apply` DOES run the
    // filter driver a `.gitattributes` in the developer's work tree names
    // (`filter=x` → their config's `filter.x.clean/smudge`), on every file it
    // writes. Only their own attributes and config can name one — the agent
    // cannot write their folder in propose mode — and a proposed change to
    // `.gitattributes` itself is marked (riskOf) and applied only after they
    // confirm it.
    const safe = SAFE_GIT_CONFIG.filter((a, i, all) => a !== 'attr.tree=HEAD' && all[i + 1] !== 'attr.tree=HEAD');
    const apply = (diff: string, check = false) =>
      git(p.repoRoot, ['apply', ...(check ? ['--check'] : []), '--whitespace=nowarn'], diff, undefined, safe);
    try {
      await apply(patch);
    } catch (plain) {
      // File by file: sorted into what still applies and what must merge —
      // all decided before anything is written.
      const direct: string[] = [];
      const merges: Array<{ rel: string; base: string; yours: string; agent: string }> = [];
      for (const c of chosen) {
        const one = await pgit(p, ['diff', '--no-ext-diff', '--no-textconv', '--binary', p.base, '--', c.path]);
        if (!one.trim()) continue;
        try {
          await apply(one, true);
          direct.push(one);
          continue;
        } catch {
          // does not fit as it stands: a merge, if it can be one
        }
        const merge = c.status === 'M' && !c.risk ? await mergeInputs(p, c.path) : null;
        if (!merge) throw plain;
        merges.push({ rel: c.path, ...merge });
      }
      if (direct.length) await apply(direct.join(''));
      const conflicted: string[] = [];
      for (const m of merges) if (await mergeInto(m)) conflicted.push(m.rel);
      return { applied: chosen.map((c) => c.path), conflicted };
    }
  }
  return { applied: chosen.map((c) => c.path), conflicted: [] };
}

/** The three sides of a text file to merge, or null when one is missing or binary. */
async function mergeInputs(p: Proposal, rel: string): Promise<{ base: string; yours: string; agent: string } | null> {
  const base = await proposalBaseContent(p, rel);
  let yours: string;
  let agent: string;
  try {
    yours = insideDir(p.repoRoot, rel, 'your repository');
    agent = insideDir(p.dir, rel, 'the proposal');
    // A link at either end would be followed: the merge would read, and write, whatever it points at.
    if ([yours, agent].some((f) => !fs.lstatSync(f).isFile())) return null;
    if ([fs.readFileSync(yours), fs.readFileSync(agent)].some((b) => b.includes(0))) return null;
  } catch {
    return null;
  }
  if (base === null || base.includes('\0')) return null;
  return { base, yours, agent };
}

/**
 * `git merge-file`: the developer's file, the base, the agent's version. The
 * developer's file takes the result; true when conflict blocks were left.
 */
async function mergeInto(m: { base: string; yours: string; agent: string }): Promise<boolean> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-merge-'));
  try {
    const baseFile = path.join(tmp, 'base');
    fs.writeFileSync(baseFile, m.base);
    const { out, conflicts } = await new Promise<{ out: string; conflicts: number }>((resolve, reject) => {
      execFile(
        'git',
        [
          ...SAFE_GIT_CONFIG,
          'merge-file',
          '-p',
          '-L',
          'yours',
          '-L',
          'base',
          '-L',
          'agent',
          m.yours,
          baseFile,
          m.agent,
        ],
        // Outside any repository: no repository config applies to the merge.
        { cwd: tmp, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          // The exit status is the number of conflicts; only a negative one (a signal, 255) is a failure.
          const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
          if (code < 0 || code > 127) reject(new Error(`git merge-file: ${String(stderr || err?.message).trim()}`));
          else resolve({ out: String(stdout), conflicts: code });
        },
      );
    });
    fs.writeFileSync(m.yours, out);
    return conflicts > 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Throw proposed files away: back to the base. All of them when no paths are
 * given. A path that resolves outside the clone is refused.
 */
export async function rejectProposal(p: Proposal, paths?: string[]): Promise<void> {
  if (!paths) {
    await pgit(p, ['reset', '--quiet', '--hard', p.base]);
    await pgit(p, ['clean', '--quiet', '-fd']);
    // clean leaves gitignored entries; a link there is part of the proposal (proposalChanges).
    for (const rel of await ignoredLinks(p)) fs.rmSync(insideDir(p.dir, rel, 'the proposal'), { force: true });
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
