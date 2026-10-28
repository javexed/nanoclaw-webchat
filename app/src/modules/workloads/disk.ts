/**
 * Disk use per workload: its named volumes, its containers' writable layers,
 * its images (the part no other image shares) and its backups; plus, per
 * agent, its builder's cache. Docker's local volumes have no size cap, so the
 * quota is measured (every ten minutes) and acted on: a warning at 90%, and
 * over 100% the agent's stacks are stopped and nothing new may start until it
 * frees space.
 *
 * Sizes come from `docker system df -v`, keyed by volume name and container
 * id only. Who owns what comes from `docker inspect`, whose labels are a JSON
 * map: `system df` joins labels into one comma-separated string, where a value
 * containing `,nanoclaw.workload=<id>` would bill another workload.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { backupRoot } from './backup.js';
import { builderCacheVolume } from './builder.js';
import { dockerEnv, projectName } from './docker.js';
import type { Workload } from './store.js';

const run = promisify(execFile);
const GB = 1024 ** 3;

/** Docker's human sizes ("40.4MB", "28.7kB", "970B"; decimal units). */
export function parseDockerSize(s: string): number {
  const m = /^([\d.]+)\s*([kKMGTP]?)B$/.exec(String(s).trim());
  if (!m) return 0;
  const mult = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[m[2]] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

export interface DfJson {
  Volumes?: Array<{ Name: string; Size: string }>;
  Containers?: Array<{ ID: string; Size: string }>;
  Images?: Array<{ Repository: string; Tag: string; Digest?: string; UniqueSize?: string; Size: string }>;
}

export interface VolumeInspect {
  Name: string;
  Labels?: Record<string, string> | null;
}
export interface ContainerInspect {
  Id: string;
  Config?: { Labels?: Record<string, string> | null };
}

export interface Owners {
  /** Docker volume name → workload id. */
  volumes: Map<string, string>;
  /** Container id → workload id. */
  containers: Map<string, string>;
}

/** Which volumes and containers belong to which workload, from `docker inspect` JSON. Pure. */
export function ownersFromInspect(
  volumes: VolumeInspect[],
  containers: ContainerInspect[],
  workloads: Workload[],
): Owners {
  const byProject = new Map(workloads.map((w) => [projectName(w), w.id]));
  const ids = new Set(workloads.map((w) => w.id));
  const out: Owners = { volumes: new Map(), containers: new Map() };
  for (const v of volumes) {
    const id = byProject.get(v.Labels?.['com.docker.compose.project'] ?? '');
    if (id) out.volumes.set(v.Name, id);
  }
  for (const c of containers) {
    const labels = c.Config?.Labels ?? {};
    const id = labels['nanoclaw.workload'];
    // Both labels must agree: the workload id is NanoClaw's, the project is Compose's.
    if (id && ids.has(id) && byProject.get(labels['com.docker.compose.project'] ?? '') === id)
      out.containers.set(c.Id, id);
  }
  return out;
}

/** Bytes per workload id. Pure: tested on its own. */
export function usageFromDf(
  df: DfJson,
  workloads: Workload[],
  owners: Owners,
  extra: { images?: (w: Workload) => string[]; builderVolume?: (agentGroupId: string) => string } = {},
): Map<string, number> {
  const out = new Map<string, number>(workloads.map((w) => [w.id, 0]));
  const add = (id: string, bytes: number): void => {
    if (out.has(id)) out.set(id, out.get(id)! + bytes);
  };
  for (const v of df.Volumes ?? []) {
    const id = owners.volumes.get(v.Name);
    if (id) add(id, parseDockerSize(v.Size));
  }
  for (const c of df.Containers ?? []) {
    const id = owners.containers.get(c.ID);
    // "28.7kB (virtual 50MB)": the writable layer is the first figure.
    if (id) add(id, parseDockerSize(String(c.Size).split(' ')[0]));
  }
  if (extra.images) {
    // An image pulled by digest is listed by repository and digest, a built one by its tag.
    const bySize = new Map<string, number>();
    for (const i of df.Images ?? []) {
      const size = parseDockerSize(i.UniqueSize ?? i.Size);
      if (i.Tag && i.Tag !== '<none>') bySize.set(`${i.Repository}:${i.Tag}`, size);
      if (i.Digest) bySize.set(`${i.Repository}@${i.Digest}`, size);
    }
    for (const w of workloads)
      for (const ref of new Set(extra.images(w))) {
        const digest = /@(sha256:[a-f0-9]{64})$/.exec(ref)?.[1];
        const bare = ref.replace(/@sha256:[a-f0-9]{64}$/, '');
        const repo = bare.replace(/:[^/:]+$/, '');
        const key = digest ? `${repo}@${digest}` : /:[^/]+$/.test(bare) ? bare : `${bare}:latest`;
        add(w.id, bySize.get(key) ?? 0);
      }
  }
  if (extra.builderVolume) {
    // Per agent: charged to the agent's first workload, so the per-agent sum is right.
    const vols = new Map((df.Volumes ?? []).map((v) => [v.Name, parseDockerSize(v.Size)]));
    const seen = new Set<string>();
    for (const w of workloads) {
      if (seen.has(w.agentGroupId)) continue;
      seen.add(w.agentGroupId);
      add(w.id, vols.get(extra.builderVolume(w.agentGroupId)) ?? 0);
    }
  }
  return out;
}

/** Bytes under a folder (backups), not following links. */
export function folderBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += folderBytes(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

const docker = async (args: string[]): Promise<string> =>
  (
    await run(CONTAINER_RUNTIME_BIN, args, {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: dockerEnv(),
    })
  ).stdout;

async function inspectAll<T>(listArgs: string[], inspect: string[]): Promise<T[]> {
  const names = (await docker(listArgs))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return [];
  return JSON.parse(await docker([...inspect, ...names])) as T[];
}

export async function measureDisk(
  workloads: Workload[],
  images: (w: Workload) => string[],
): Promise<Map<string, number>> {
  const df = JSON.parse(await docker(['system', 'df', '-v', '--format', 'json'])) as DfJson;
  const volumes = await inspectAll<VolumeInspect>(
    ['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project'],
    ['volume', 'inspect'],
  );
  const containers = await inspectAll<ContainerInspect>(
    ['ps', '-aq', '--no-trunc', '--filter', 'label=nanoclaw.workload'],
    ['inspect'],
  );
  const out = usageFromDf(df, workloads, ownersFromInspect(volumes, containers, workloads), {
    images,
    builderVolume: builderCacheVolume,
  });
  for (const w of workloads) out.set(w.id, out.get(w.id)! + folderBytes(backupRoot(w.id)));
  return out;
}

// The last measurement, per agent: what `quota` reports and what a start checks.
const lastByAgent = new Map<string, { bytes: number; at: number }>();

export function recordUsage(
  workloads: Workload[],
  byWorkload: Map<string, number>,
  now = Date.now(),
): Map<string, number> {
  const byAgent = new Map<string, number>();
  for (const w of workloads)
    byAgent.set(w.agentGroupId, (byAgent.get(w.agentGroupId) ?? 0) + (byWorkload.get(w.id) ?? 0));
  for (const [a, bytes] of byAgent) lastByAgent.set(a, { bytes, at: now });
  return byAgent;
}

export const diskUsed = (agentGroupId: string): { bytes: number; at: number } | null =>
  lastByAgent.get(agentGroupId) ?? null;

export const gb = (bytes: number): number => Math.round((bytes / GB) * 100) / 100;

/** Refuse to start or grow while the last measurement was over quota. */
export function assertDiskRoom(agentGroupId: string, diskGb: number): void {
  const u = lastByAgent.get(agentGroupId);
  if (u && u.bytes > diskGb * GB)
    throw new Error(
      `your workloads use ${gb(u.bytes)} GB of disk; your quota is ${diskGb} GB. Free space (ncl workloads exec, or delete a stack) or ask an owner`,
    );
}

export type DiskLevel = 'ok' | 'warn' | 'over';
export function diskLevel(bytes: number, diskGb: number): DiskLevel {
  if (bytes > diskGb * GB) return 'over';
  if (bytes >= 0.9 * diskGb * GB) return 'warn';
  return 'ok';
}

export function __resetDiskForTest(): void {
  lastByAgent.clear();
}
