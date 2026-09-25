// Turn a RemoteSpec plus locally resolved mounts into the exact `create` argv
// the central docker driver would have produced. Argument ORDER matches
// drivers/docker-driver.ts on purpose: the conformance bar for the runner is
// "same container as central would run", and the argv is how that is checked.
//
// Two things ARE the laptop's to decide, and are decided here explicitly:
//   - the container runtime (docker or podman; the verbs and flags are shared,
//     the user-namespace details are not), and
//   - the uid the container runs as. Central's `runAs` is central's host uid;
//     the files a laptop creates belong to the laptop's user, so a mismatched
//     uid could not write its own workspace. The runner keeps the POSTURE
//     (non-root, fixed uid) and substitutes its own uid/gid.
import { LABELS, RELAY_SENTINEL, type RemoteSpec, type SessionKey } from './remote-spec.js';

export type Runtime = 'docker' | 'podman';
export interface ResolvedMount {
  hostPath: string;
  containerPath: string;
  mode: 'rw' | 'ro';
}
export interface RealizeOptions {
  runtime: Runtime;
  platform: NodeJS.Platform;
  relayUrl: string;
  /** The laptop user the runtime runs as (undefined on Windows: no POSIX ids). */
  localUser?: { uid: number; gid: number };
}

export function labelsForKey(
  key: SessionKey,
  role: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [LABELS.install]: key.installSlug,
    [LABELS.group]: key.agentGroupId,
    [LABELS.session]: key.sessionId,
    [LABELS.role]: role,
    ...extra,
  };
}
export const labelArgs = (labels: Record<string, string>): string[] =>
  Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
export const envArgs = (env: Record<string, string>): string[] =>
  Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

/** Podman's Windows client reaches the machine's view of the drives: C:\a\b -> /mnt/c/a/b. */
export function hostPathFor(p: string, opts: Pick<RealizeOptions, 'runtime' | 'platform'>): string {
  if (opts.platform !== 'win32' || opts.runtime !== 'podman') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}
export const mountArgs = (
  mounts: readonly ResolvedMount[],
  opts: Pick<RealizeOptions, 'runtime' | 'platform'>,
): string[] =>
  mounts.flatMap((m) => {
    const host = hostPathFor(m.hostPath, opts);
    return ['-v', m.mode === 'ro' ? `${host}:${m.containerPath}:ro` : `${host}:${m.containerPath}`];
  });

export function hardeningArgs(spec: RemoteSpec): string[] {
  const args = ['--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--init'];
  const pids = spec.resources.pidsLimit;
  if (typeof pids === 'number' && Number.isFinite(pids) && pids > 0)
    args.push('--pids-limit', String(Math.floor(pids)));
  return args;
}
export function resourceArgs(spec: RemoteSpec): string[] {
  const args: string[] = [];
  if (spec.resources.cpus) args.push('--cpus', spec.resources.cpus);
  if (spec.resources.memoryMb) args.push('--memory', `${spec.resources.memoryMb}m`);
  if (spec.resources.shmSizeMb) args.push(`--shm-size=${spec.resources.shmSizeMb}m`);
  return args;
}

/**
 * The uid rule. No `runAs` in the spec -> none here either (the image default).
 * With one: the laptop's own uid/gid when known, else the spec's numbers
 * (Windows + docker: bind mounts are world-writable, the numbers only name the
 * in-container identity). Rootless podman additionally needs the user namespace
 * pinned so that uid IS the host user on the bind mounts (`--userns keep-id`).
 */
export function userArgs(spec: RemoteSpec, opts: RealizeOptions): string[] {
  if (!spec.runAs) return [];
  const uid = opts.localUser?.uid ?? spec.runAs.uid;
  const gid = opts.localUser?.gid ?? spec.runAs.gid;
  const args: string[] = [];
  if (opts.runtime === 'podman') args.push('--userns', `keep-id:uid=${uid},gid=${gid}`);
  args.push('--user', `${uid}:${gid}`);
  return args;
}

/**
 * An agent on a laptop gets no network, whatever central's spec says. The
 * forwarder (relay), the mailbox and supervision all ride the exec pipe, and
 * the agent's proxy is on its own loopback, so the tunnel through central is
 * the ONLY egress — enforced by the machine, not merely configured by env.
 */
export const NETWORK_ARGS: readonly string[] = ['--network', 'none'];

/** The runner owns the relay address: every proxy variable central blanked gets it. */
export function substituteRelay(env: Record<string, string>, relayUrl: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === RELAY_SENTINEL ? relayUrl : v]));
}

export function createArgs(spec: RemoteSpec, mounts: readonly ResolvedMount[], opts: RealizeOptions): string[] {
  const args = ['create', '--rm', '--name', spec.name];
  args.push(...labelArgs(labelsForKey(spec.key, 'agent', { ...spec.labels, ...spec.containerLabels })));
  args.push(...resourceArgs(spec));
  args.push(...hardeningArgs(spec));
  args.push(...userArgs(spec, opts));
  args.push(...envArgs(substituteRelay(spec.env, opts.relayUrl)));
  args.push(...envArgs(substituteRelay(spec.contributedEnv, opts.relayUrl)));
  args.push(...mountArgs(mounts, opts));
  args.push(...NETWORK_ARGS);
  if (spec.command && spec.command.length > 0) {
    args.push('--entrypoint', spec.command[0]);
    args.push(spec.image, ...spec.command.slice(1), ...(spec.args ?? []));
  } else {
    args.push(spec.image, ...(spec.args ?? []));
  }
  return args;
}

export function statePhase(state: string): 'starting' | 'running' | 'terminal' {
  if (state === 'running' || state === 'paused' || state === 'restarting') return 'running';
  if (state === 'created') return 'starting';
  return 'terminal';
}
