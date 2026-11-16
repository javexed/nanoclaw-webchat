/**
 * Workloads run only when an owner turned them on (NANOCLAW_WORKLOADS=1, the
 * Workloads switch in Admin → Publishing) AND this host passes the preflight:
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
import { workloadEgressPort, workloadsSwitchedOn } from './settings.js';

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
  /** Runtime egress on its port, checked when NANOCLAW_WORKLOAD_EGRESS_PORT is set; absent otherwise. */
  egress?: { port: number; ok: boolean; reason: string };
}

/**
 * What a probe to the egress port on an address where nothing of NanoClaw's
 * listens got: refused (the rule lets it through and nothing else holds the
 * port: ready), dropped (nothing answered in time: the rule is missing), or
 * answered (a service on this host listens on that port on every address).
 */
export type EgressProbe = 'refused' | 'dropped' | 'answered';

let last: PreflightResult | null = null;
let running: Promise<PreflightResult> | null = null;

export const OFF_REASON = 'workloads are off on this host: an owner can turn them on in Admin → Publishing';

/** Throws unless workloads may start things right now. */
export function requireWorkloads(): void {
  if (!workloadsSwitchedOn()) throw new Error(OFF_REASON);
  if (!last) throw new Error('workloads are still being checked on this host: try again in a minute');
  if (!last.ok) throw new Error(last.reason);
}

export const lastPreflight = (): PreflightResult | null => last;

/** A preflight is under way (Admin → Publishing says Checking…). */
export const preflightRunning = (): boolean => running !== null;

export interface PreflightDeps {
  slice: typeof sliceStatus;
  tools: () => Promise<string | null>;
  isolation: () => Promise<Isolation>;
  egressProbe?: (port: number) => Promise<EgressProbe>;
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

/**
 * Runtime egress: the host rules accept new connections from workload
 * bridges to its port on any workload address, so nothing else on this host
 * may listen there on every address. A throwaway container on the probe
 * network asks the probe network's gateway, where NanoClaw never listens,
 * on that port: it must be refused outright.
 */
export async function probeEgressPort(port: number): Promise<EgressProbe> {
  await ensureHelperImage();
  const network = await ensureProbeNetwork(PROBE_INDEX);
  const { gateway } = subnetFor(PROBE_INDEX);
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
      `wget -q -T 4 -O- http://${gateway}:${port}/ 2>&1; echo " rc=$?"`,
    ],
    { env: dockerEnv(), timeout: 60_000 },
  );
  if (/refused/i.test(stdout)) return 'refused';
  if (/timed out|unreachable|no route/i.test(stdout)) return 'dropped';
  if (/ rc=\d+/.test(stdout)) return 'answered';
  throw new Error(`the egress port probe gave no answer: ${stdout.slice(0, 200)}`);
}

/** Whether runtime egress can run on its port, in words (preflight's check). */
async function checkEgress(deps: PreflightDeps, port: number): Promise<{ port: number; ok: boolean; reason: string }> {
  const rules = `sudo deploy/workloads-host-rules.sh --stack-egress-port ${port} --install-unit (with your other flags)`;
  let probe: EgressProbe;
  try {
    probe = await (deps.egressProbe ?? probeEgressPort)(port);
  } catch (err) {
    return {
      port,
      ok: false,
      reason: `the runtime egress check could not run: ${String((err as Error).message ?? err).slice(0, 300)}`,
    };
  }
  if (probe === 'refused') return { port, ok: true, reason: '' };
  if (probe === 'dropped')
    return {
      port,
      ok: false,
      reason: `runtime egress is not let through on port ${port}: the host rules lack it (${rules}), or something on this host holds that port open`,
    };
  return {
    port,
    ok: false,
    reason: `runtime egress is refused: a service on this host listens on port ${port} on every address, so workload containers would reach it; pick another NANOCLAW_WORKLOAD_EGRESS_PORT or bind that service elsewhere`,
  };
}

const defaults: PreflightDeps = {
  slice: sliceStatus,
  tools: toolsPresent,
  isolation: probeIsolation,
  egressProbe: probeEgressPort,
};

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
      'workload containers can reach this host: the host rules are missing (run deploy/workloads-host-rules.sh --install-unit as root)',
      true,
    );
  // Runtime egress is its own switch: a failure here refuses only stacks that call out.
  const port = workloadEgressPort();
  return {
    ok: true,
    reason: '',
    isolationOpen: false,
    at: now,
    ...(port !== null ? { egress: await checkEgress(deps, port) } : {}),
  };
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

/**
 * Why runtime egress cannot run on `port` now, or null. Not checked yet on
 * this port (it was just set): a check is started, and the caller hears to
 * try again shortly.
 */
export function egressRefusal(port: number): string | null {
  const e = last?.egress;
  if (last?.ok && e?.port === port) return e.ok ? null : e.reason;
  if (last && !last.ok) return last.reason;
  if (!running && workloadsSwitchedOn()) void runPreflight().catch(() => undefined);
  return 'runtime egress is still being checked on this host: try again in a minute';
}

export function __setPreflightForTest(r: PreflightResult | null): void {
  last = r;
}
