/**
 * Workloads run only when the operator turned them on (NANOCLAW_WORKLOADS=1)
 * AND this host passes the preflight:
 *
 *   - the systemd slice exists and caps memory (deploy/workloads-slice.sh);
 *   - `docker compose` and `docker buildx` are there;
 *   - a workload container cannot reach this host. Docker's internal networks
 *     only filter forwarded traffic: a container still reaches every service
 *     on this host through its network's gateway address. The host rules
 *     (deploy/workloads-host-rules.sh) drop that. The preflight does not read
 *     the firewall (that needs root); it tries: a throwaway container on a
 *     probe network, shaped like a workload network, asks a listener bound to
 *     the gateway address. An answer means the rules are missing.
 *
 * Run at the first sweep and every half hour after. Until it passes, every
 * verb that starts something is refused with the reason; when the probe gets
 * through, running stacks are stopped (reconcile.ts).
 */
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { promisify } from 'util';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';
import { ensureHelperImage } from './backup.js';
import { dockerEnv, ensureProbeNetwork, sliceName, sliceStatus } from './docker.js';
import { HELPER_IMAGE } from './images.js';
import { PROBE_INDEX, subnetFor } from './override.js';
import { workloadsSwitchedOn } from './settings.js';

const run = promisify(execFile);
export const PREFLIGHT_EVERY_MS = 30 * 60_000;

export type Isolation = 'blocked' | 'open';

export interface PreflightResult {
  ok: boolean;
  /** Why not, in words an agent or operator can act on. */
  reason: string;
  /** The probe reached this host: the host rules are missing. */
  isolationOpen: boolean;
  at: number;
}

let last: PreflightResult | null = null;
let running: Promise<PreflightResult> | null = null;

export const OFF_REASON =
  'workloads are off on this host (an operator turns them on with NANOCLAW_WORKLOADS=1; see docs/webchat/workloads.md)';

/** Throws unless workloads may start things right now. */
export function requireWorkloads(): void {
  if (!workloadsSwitchedOn()) throw new Error(OFF_REASON);
  if (!last) throw new Error('workloads are still being checked on this host: try again in a minute');
  if (!last.ok) throw new Error(last.reason);
}

export const lastPreflight = (): PreflightResult | null => last;

export interface PreflightDeps {
  slice: typeof sliceStatus;
  tools: () => Promise<string | null>;
  isolation: () => Promise<Isolation>;
}

/** compose and buildx present (null), or what is missing. */
async function toolsPresent(): Promise<string | null> {
  for (const [args, what] of [
    [['compose', 'version'], 'docker compose'],
    [['buildx', 'version'], 'docker buildx'],
  ] as const) {
    const ok = await run(CONTAINER_RUNTIME_BIN, [...args], { env: dockerEnv(), timeout: 30_000 }).then(
      () => true,
      () => false,
    );
    if (!ok) return `${what} is not installed on this host`;
  }
  return null;
}

/**
 * Can a container on a workload-shaped network reach this host? A listener on
 * the probe network's gateway address answers a random token; a throwaway
 * helper container asks for it.
 */
export async function probeIsolation(): Promise<Isolation> {
  await ensureHelperImage();
  const network = await ensureProbeNetwork(PROBE_INDEX);
  const { gateway } = subnetFor(PROBE_INDEX);
  const token = randomBytes(12).toString('hex');
  const server = http.createServer((_req, res) => res.end(token));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, gateway, () => resolve());
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const { stdout } = await run(
      CONTAINER_RUNTIME_BIN,
      [
        'run',
        '--rm',
        '--network',
        network,
        '--log-driver',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--cgroup-parent',
        sliceName(),
        '--memory',
        '64m',
        '--pids-limit',
        '16',
        HELPER_IMAGE(),
        'sh',
        '-c',
        `wget -q -T 4 -O- http://${gateway}:${port}/ 2>/dev/null; echo " rc=$?"`,
      ],
      { env: dockerEnv(), timeout: 60_000 },
    );
    if (stdout.includes(token)) return 'open';
    if (/ rc=\d+/.test(stdout)) return 'blocked';
    throw new Error(`the isolation probe gave no answer: ${stdout.slice(0, 200)}`);
  } finally {
    server.close();
  }
}

const defaults: PreflightDeps = { slice: sliceStatus, tools: toolsPresent, isolation: probeIsolation };

async function check(deps: PreflightDeps, now: number): Promise<PreflightResult> {
  const fail = (reason: string, isolationOpen = false): PreflightResult => ({
    ok: false,
    reason,
    isolationOpen,
    at: now,
  });
  if (!workloadsSwitchedOn()) return fail(OFF_REASON);
  const slice = await deps.slice();
  if (!slice.ok) return fail(slice.reason);
  const missing = await deps.tools();
  if (missing) return fail(missing);
  let isolation: Isolation;
  try {
    isolation = await deps.isolation();
  } catch (err) {
    return fail(`the workload isolation check could not run: ${String((err as Error).message ?? err).slice(0, 300)}`);
  }
  if (isolation === 'open')
    return fail(
      'workload containers can reach this host: the host rules are missing (an operator runs deploy/workloads-host-rules.sh as root)',
      true,
    );
  return { ok: true, reason: '', isolationOpen: false, at: now };
}

/** Run the preflight (one at a time) and remember the result. */
export async function runPreflight(deps: PreflightDeps = defaults, now = Date.now()): Promise<PreflightResult> {
  if (running) return running;
  running = check(deps, now)
    .then((r) => {
      if (!r.ok && workloadsSwitchedOn() && r.reason !== last?.reason)
        log.error('Workloads refused on this host', { reason: r.reason });
      else if (r.ok && !last?.ok) log.info('Workloads preflight passed');
      last = r;
      return r;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Is the last result older than the interval (or missing)? */
export const preflightDue = (now = Date.now()): boolean => !last || now - last.at >= PREFLIGHT_EVERY_MS;

export function __setPreflightForTest(r: PreflightResult | null): void {
  last = r;
}
