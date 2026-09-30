/**
 * Host-side file access inside a tree an agent container can write
 * (groups/<folder>, a session's .claude-shared). The agent can plant a symlink
 * anywhere in such a tree, and plain fs calls follow it: a writeFileSync on
 * `memory/system/x.md` linked to the host `.env` overwrites the `.env`, a
 * chmod lands on whatever the link names, and a mkdir -p through a linked
 * directory writes outside the tree.
 *
 * Every helper here walks `rel` under `root` with lstat and refuses a link at
 * any step. Writes go to a fresh temp file and are renamed into place, so a
 * link at the final name is replaced, never written through; the replaced
 * file's owner and mode carry over, so a file the agent owns stays editable
 * by it.
 *
 * `root` itself is trusted: it is the mount point (or above it), which the
 * container cannot replace.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function parts(rel: string): string[] {
  const out = path
    .normalize(rel)
    .split(path.sep)
    .filter((p) => p && p !== '.');
  if (path.isAbsolute(rel) || out.includes('..')) throw new Error(`path leaves its root: ${rel}`);
  return out;
}

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Absolute path of `rel` under `root`; throws if any existing step is a link. */
export function resolveNoLinks(root: string, rel: string): string {
  let cur = root;
  for (const p of parts(rel)) {
    cur = path.join(cur, p);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (missing(err)) return path.join(root, ...parts(rel));
      throw err;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to follow a link: ${cur}`);
  }
  return cur;
}

/** mkdir -p that refuses to pass through a link. */
export function mkdirNoFollow(root: string, relDir: string): void {
  let cur = root;
  for (const p of parts(relDir)) {
    cur = path.join(cur, p);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (!missing(err)) throw err;
    }
    if (!st) fs.mkdirSync(cur);
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a plain directory: ${cur}`);
  }
}

/** A regular file's text, or null when it doesn't exist. Never reads through a link. */
export function readNoFollow(root: string, rel: string): string | null {
  const p = resolveNoLinks(root, rel);
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`not a regular file: ${p}`);
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/** True when `rel` is a regular file reached without any link. */
export function isPlainFile(root: string, rel: string): boolean {
  try {
    return fs.lstatSync(resolveNoLinks(root, rel)).isFile();
  } catch {
    return false;
  }
}

/** Write `data` at `rel`, replacing (never following) whatever is there. */
export function writeNoFollow(root: string, rel: string, data: string | Buffer, mode = 0o644): void {
  mkdirNoFollow(root, path.dirname(rel));
  // Parents must be plain; the final name may be a link, which the rename
  // below replaces rather than follows.
  const target = path.join(resolveNoLinks(root, path.dirname(rel)), path.basename(rel));
  let prior: fs.Stats | null = null;
  try {
    const st = fs.lstatSync(target);
    if (st.isFile()) prior = st;
  } catch (err) {
    if (!missing(err)) throw err;
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, prior ? prior.mode & 0o7777 : mode);
    if (prior && typeof process.getuid === 'function' && process.getuid() === 0) {
      fs.fchownSync(fd, prior.uid, prior.gid);
    }
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  // The parent could have been swapped for a link since the walk above.
  resolveNoLinks(root, path.dirname(rel));
  fs.renameSync(tmp, target);
}

/** Remove `rel` (a link is removed itself) without passing through a linked parent. */
export function removeNoFollow(root: string, rel: string): void {
  const dir = resolveNoLinks(root, path.dirname(rel));
  fs.rmSync(path.join(dir, path.basename(rel)), { force: true, recursive: true });
}

/** Throws unless `dir` is absent or a plain directory (not a link to one). */
export function assertPlainDir(dir: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (missing(err)) return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a plain directory: ${dir}`);
}

/** A `cpSync` filter that leaves links behind instead of copying them along. */
export const skipLinks = (src: string): boolean => !fs.lstatSync(src).isSymbolicLink();
