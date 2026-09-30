// ── Finding the package manager from inside the service ─────────────────────
// systemd gives the unit a bare PATH, and version managers put pnpm elsewhere;
// with several node versions installed, pnpm need not sit next to the node
// running us, so a list of candidate directories is searched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** First candidate directory that holds an executable `bin`, or null. */
export function findBinDir(bin: string, candidates: string[], isExecutable: (p: string) => boolean): string | null {
  for (const dir of candidates) {
    if (!dir) continue;
    if (isExecutable(path.join(dir, bin))) return dir;
  }
  return null;
}

/**
 * Where to look, in order of how much they mean.
 *
 * Next to our own node first — when that IS the answer it is the right one,
 * matching the interpreter the install will use. Then the version managers'
 * shim directories, which is how a multi-version host exposes one stable path.
 * Then the ordinary places. PNPM_HOME is pnpm's own documented install dir.
 */
export function packageManagerCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const npmExec = env.npm_execpath ? path.dirname(env.npm_execpath) : '';
  return [
    path.dirname(process.execPath),
    env.PNPM_HOME ?? '',
    npmExec,
    path.join(home, '.local/share/mise/shims'),
    path.join(home, '.asdf/shims'),
    path.join(home, '.volta/bin'),
    path.join(home, '.local/bin'),
    '/usr/local/bin',
    '/usr/bin',
  ];
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The directory holding `pnpm`, or null when this host has none we can reach. */
export function pnpmDir(): string | null {
  return findBinDir('pnpm', packageManagerCandidates(), executable);
}
