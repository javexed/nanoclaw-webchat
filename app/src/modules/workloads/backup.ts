/**
 * Volume backups: each named volume of a stack, as a gzipped tar streamed out
 * of a throwaway container (read-only mount, no network), so the files keep
 * their owners inside the archive and the host never needs root. The stack is
 * paused while it is copied, so a database's files are consistent. Nightly
 * from the reconcile loop; the newest KEEP are kept per workload.
 */
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';
import { compose, dockerEnv, projectName, sliceName } from './docker.js';
import { HELPER_IMAGE } from './images.js';
import type { Workload } from './store.js';

const run = promisify(execFile);
export const KEEP = 3;
/** Leave at least this much free on the backup disk. */
const MIN_FREE_BYTES = 5 * 1024 ** 3;

export const backupRoot = (id: string): string => path.join(DATA_DIR, 'workload-backups', id);
const STAMP_RE = /^\d{8}T\d{6}Z$/;
export const stampOf = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
export const stampTime = (s: string): number =>
  Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));

export interface Backup {
  stamp: string;
  at: string;
  volumes: Array<{ volume: string; bytes: number }>;
}

export function listBackups(id: string): Backup[] {
  const root = backupRoot(id);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((s) => STAMP_RE.test(s) && fs.existsSync(path.join(root, s, 'done')))
    .sort()
    .reverse()
    .map((stamp) => ({
      stamp,
      at: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)} UTC`,
      volumes: fs
        .readdirSync(path.join(root, stamp))
        .filter((f) => f.endsWith('.tar.gz'))
        .map((f) => ({ volume: f.slice(0, -'.tar.gz'.length), bytes: fs.statSync(path.join(root, stamp, f)).size })),
    }));
}

/** Which backups to drop: everything past the newest `keep`, and any unfinished one. Pure. */
export function prunable(stamps: string[], finished: Set<string>, keep = KEEP): string[] {
  const done = stamps
    .filter((s) => finished.has(s))
    .sort()
    .reverse();
  return [...stamps.filter((s) => !finished.has(s)), ...done.slice(keep)];
}

function prune(id: string, keep = KEEP): void {
  const root = backupRoot(id);
  if (!fs.existsSync(root)) return;
  const stamps = fs.readdirSync(root).filter((s) => STAMP_RE.test(s));
  const finished = new Set(stamps.filter((s) => fs.existsSync(path.join(root, s, 'done'))));
  for (const s of prunable(stamps, finished, keep)) fs.rmSync(path.join(root, s), { recursive: true, force: true });
}

/** The stack's named volumes: compose short name → docker volume name. */
export async function stackVolumes(w: Workload): Promise<Record<string, string>> {
  const { stdout } = await run(
    CONTAINER_RUNTIME_BIN,
    [
      'volume',
      'ls',
      '--filter',
      `label=com.docker.compose.project=${projectName(w)}`,
      '--format',
      '{{.Name}}\t{{.Label "com.docker.compose.volume"}}',
    ],
    { env: dockerEnv() },
  );
  const out: Record<string, string> = {};
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [name, short] = line.split('\t');
    if (short && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(short)) out[short] = name;
  }
  return out;
}

/** Run the helper with a volume mounted; stdout to `toFile`, or `fromFile` to stdin. */
function helper(args: string[], io: { toFile?: string; fromFile?: string }, timeoutMs = 3_600_000): Promise<void> {
  return new Promise((resolve, reject) => {
    // Root in the helper (a volume's files keep their owners), but no new privileges and no network.
    const p = spawn(
      CONTAINER_RUNTIME_BIN,
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--log-driver',
        'none',
        '--security-opt',
        'no-new-privileges:true',
        '--cgroup-parent',
        sliceName(),
        '--memory',
        '512m',
        '--pids-limit',
        '64',
        ...args,
      ],
      {
        stdio: [io.fromFile ? 'pipe' : 'ignore', io.toFile ? 'pipe' : 'ignore', 'pipe'],
        env: dockerEnv(),
      },
    );
    let err = '';
    p.stderr!.on('data', (d) => (err = (err + d.toString()).slice(-2000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    // The archive is complete only once the file has flushed, not when the process exits.
    const written = io.toFile
      ? new Promise<void>((res, rej) => {
          const out = fs.createWriteStream(io.toFile!, { mode: 0o600 });
          out.on('finish', res).on('error', rej);
          p.stdout!.pipe(out);
        })
      : Promise.resolve();
    if (io.fromFile) {
      const src = fs.createReadStream(io.fromFile);
      src.on('error', (e) => p.kill() && reject(e));
      p.stdin!.on('error', () => {});
      src.pipe(p.stdin!);
    }
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
      written.then(resolve, reject);
    });
  });
}

export async function ensureHelperImage(): Promise<void> {
  const image = HELPER_IMAGE();
  const have = await run(CONTAINER_RUNTIME_BIN, ['image', 'inspect', image], { env: dockerEnv() }).then(
    () => true,
    () => false,
  );
  if (!have) await run(CONTAINER_RUNTIME_BIN, ['pull', '--quiet', image], { timeout: 300_000, env: dockerEnv() });
}

export async function backupWorkload(w: Workload, now = new Date()): Promise<Backup | null> {
  const vols = await stackVolumes(w);
  if (!Object.keys(vols).length) return null;
  const root = backupRoot(w.id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const free = fs.statfsSync(root);
  if (free.bavail * free.bsize < MIN_FREE_BYTES) throw new Error('not enough free disk on this host for a backup');
  await ensureHelperImage();
  const dir = path.join(root, stampOf(now));
  fs.mkdirSync(dir, { mode: 0o700 });
  const paused =
    w.state === 'running' &&
    (await compose(w, ['pause'], 60_000).then(
      () => true,
      () => false,
    ));
  try {
    for (const [short, name] of Object.entries(vols)) {
      await helper(['-v', `${name}:/v:ro`, HELPER_IMAGE(), 'tar', 'czf', '-', '-C', '/v', '.'], {
        toFile: path.join(dir, `${short}.tar.gz`),
      });
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    if (paused)
      await compose(w, ['unpause'], 60_000).catch((e) =>
        log.warn('Workload unpause failed', { workloadId: w.id, err: String(e) }),
      );
  }
  fs.writeFileSync(path.join(dir, 'done'), '');
  prune(w.id);
  return listBackups(w.id).find((b) => b.stamp === stampOf(now)) ?? null;
}

/** Replace each backed-up volume's contents. The caller stops the stack first and starts it after. */
export async function restoreVolumes(w: Workload, stamp: string): Promise<string[]> {
  const b = listBackups(w.id).find((x) => x.stamp === stamp);
  if (!b) throw new Error(`no backup ${stamp}: see ncl workloads backups`);
  const vols = await stackVolumes(w);
  await ensureHelperImage();
  const done: string[] = [];
  for (const { volume } of b.volumes) {
    const name = vols[volume];
    if (!name) continue;
    await helper(['-v', `${name}:/v`, HELPER_IMAGE(), 'sh', '-c', 'find /v -mindepth 1 -delete && tar xzf - -C /v'], {
      fromFile: path.join(backupRoot(w.id), stamp, `${volume}.tar.gz`),
    });
    done.push(volume);
  }
  return done;
}

export function removeBackups(id: string): void {
  fs.rmSync(backupRoot(id), { recursive: true, force: true });
}
