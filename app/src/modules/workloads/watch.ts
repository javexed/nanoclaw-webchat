/**
 * Joins an agent's container to its workload network the moment it starts,
 * from `docker events`, instead of at the next sweep (which stays as the
 * fallback). Self-contained: no hook into the spawn path. Restarts the event
 * stream if it ends.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';

import { INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';
import { dockerEnv, isAgentContainerName } from './docker.js';
import { networkRow } from './store.js';

const run = promisify(execFile);
let child: ChildProcess | null = null;
let stopped = false;

/** The agent group and container of a `start` event line, or null. Pure. */
export function parseStart(line: string): { agentGroupId: string; container: string } | null {
  try {
    const e = JSON.parse(line) as { Action?: string; Actor?: { Attributes?: Record<string, string> } };
    const a = e.Actor?.Attributes ?? {};
    if (e.Action !== 'start' || a['nanoclaw-install'] !== INSTALL_SLUG || !a['nanoclaw-group'] || !a.name) return null;
    // Labels can be forged in an image; the name cannot (isAgentContainerName).
    if (!isAgentContainerName(a.name)) return null;
    return { agentGroupId: a['nanoclaw-group'], container: a.name };
  } catch {
    return null;
  }
}

/** Join a just-started agent container to its agent's workload network, if it has one. */
export async function onStart(
  agentGroupId: string,
  container: string,
  connect: (network: string, container: string) => Promise<unknown> = (network, c) =>
    run(CONTAINER_RUNTIME_BIN, ['network', 'connect', network, c], { env: dockerEnv() }),
): Promise<void> {
  const net = await networkRow(agentGroupId);
  if (!net) return;
  await connect(net.network, container).then(
    () => log.info('Workload network joined at start', { container, network: net.network }),
    (err) => {
      if (!/already exists|already attached/i.test(String(err)))
        log.warn('Workload network join failed', { container, err: String(err).slice(0, 200) });
    },
  );
}

export function ensureWatcher(): void {
  if (child || stopped) return;
  const p = spawn(
    CONTAINER_RUNTIME_BIN,
    [
      'events',
      '--format',
      '{{json .}}',
      '--filter',
      'type=container',
      '--filter',
      'event=start',
      '--filter',
      `label=nanoclaw-install=${INSTALL_SLUG}`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], env: dockerEnv() },
  );
  child = p;
  let buf = '';
  p.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = parseStart(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (ev) void onStart(ev.agentGroupId, ev.container).catch(() => undefined);
    }
  });
  const done = (): void => {
    if (child === p) child = null; // the next sweep starts a new one
  };
  p.on('error', done);
  p.on('close', done);
}

export function stopWatcher(): void {
  stopped = true;
  child?.kill();
  child = null;
}

export const watcherRunning = (): boolean => child !== null;
