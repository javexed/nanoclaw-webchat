// The extension id changed in 0.13 (nanoclaw.vscode, unless an install
// packages it under an id of its own — scripts/package.mjs). An older build
// auto-updating installs the new id BESIDE itself: two extensions with the
// same commands, the same view and the same machine identity. The new one
// finishes the move — it offers to remove the old extension and, once that is
// gone, takes over its storage (proposal clones, agent state, bundles; VS Code
// keys storage by extension id).
//
// Which id is "the old one" is the install's business, never the repo's: the
// package step writes it into the packaged package.json as `nanoclawLegacyId`
// (NANOCLAW_LEGACY_EXTENSION_ID). A build packaged without it has no
// predecessor and skips all of this.
import fs from 'node:fs';
import path from 'node:path';

const EXTENSION_ID = /^[a-z0-9-]+\.[a-z0-9-]+$/;

/**
 * The old build's id, from this build's package.json, or null when it names
 * none (or names this build itself). Exact ids only: never a pattern, since
 * another publisher could ship an extension with a similar name.
 */
export function legacyExtensionId(packageJSON: unknown, ownId: string): string | null {
  const v = (packageJSON as { nanoclawLegacyId?: unknown } | undefined)?.nanoclawLegacyId;
  if (typeof v !== 'string') return null;
  const id = v.trim().toLowerCase();
  if (!EXTENSION_ID.test(id) || id === ownId.toLowerCase()) return null;
  return id;
}

/** The old build's global storage: a sibling of this one's, named by its id. */
export function legacyStorageDir(globalStorageDir: string, legacyId: string): string {
  return path.join(path.dirname(globalStorageDir), legacyId);
}

/**
 * Bring the old build's runner storage into this one's. Called only once the
 * old build is no longer installed, so nothing is writing to it: moving files
 * an active build holds open fails on Windows, and copying them snapshots
 * half-written state.
 *
 * With no storage of its own yet, this build takes the old one whole — a
 * rename where it can (same volume, so normally), otherwise a copy that lands
 * under its final name only when whole, so a failed copy is retried at the
 * next start rather than taken as done. Where this build already has storage,
 * only files the old one has newer (or this one lacks) are copied across;
 * nothing newer here is overwritten. The old tree is then set aside so the
 * merge is not repeated.
 */
export function adoptLegacyStorage(globalStorageDir: string, legacyId: string): 'moved' | 'copied' | 'merged' | 'none' {
  const from = path.join(legacyStorageDir(globalStorageDir, legacyId), 'runner');
  const to = path.join(globalStorageDir, 'runner');
  if (!fs.existsSync(from)) return 'none';
  fs.mkdirSync(globalStorageDir, { recursive: true });
  if (!fs.existsSync(to)) {
    try {
      fs.renameSync(from, to);
      return 'moved';
    } catch {
      const partial = `${to}.partial`;
      fs.rmSync(partial, { recursive: true, force: true });
      fs.cpSync(from, partial, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      fs.renameSync(partial, to);
      setAside(from);
      return 'copied';
    }
  }
  mergeNewer(from, to);
  setAside(from);
  return 'merged';
}

/** Keep the old tree (nothing is deleted unasked) but out of the way of the next start. */
function setAside(from: string): void {
  const aside = `${from}.adopted`;
  fs.rmSync(aside, { recursive: true, force: true });
  fs.renameSync(from, aside);
}

/** Copy into `to` each file of `from` that `to` lacks or has older; never the other way. */
function mergeNewer(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    const theirs = fs.lstatSync(src);
    const ours = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (theirs.isDirectory()) {
      if (!ours) fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      else if (ours.isDirectory()) mergeNewer(src, dst);
      continue;
    }
    if (ours && (ours.isDirectory() || ours.mtimeMs >= theirs.mtimeMs)) continue;
    if (ours) fs.rmSync(dst, { force: true });
    fs.cpSync(src, dst, { verbatimSymlinks: true, preserveTimestamps: true });
  }
}
