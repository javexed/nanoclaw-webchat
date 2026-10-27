/**
 * The node side of workloads on this host: the systemd slice, per-agent
 * internal networks, the files Compose runs from, and `docker compose` itself.
 *
 * Every Docker call made for a workload runs with NanoClaw's own Docker
 * config folder (dockerEnv): no registry logins, no credential helpers, no
 * contexts from the operator's ~/.docker. A stack pulls public images only,
 * and nothing it builds can be handed the host's registry credentials.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { stringify } from 'yaml';

import { DATA_DIR, INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';
import { HELPER_IMAGE } from './images.js';
import { buildOverride, subnetFor } from './override.js';
import { workloadSetting } from './settings.js';
import type { Workload } from './store.js';

const run = promisify(execFile);
const MAX_OUTPUT = 20_000;

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

export const sliceName = (): string =>
  workloadSetting('NANOCLAW_WORKLOAD_SLICE') || `nanoclaw-wl-${INSTALL_SLUG}.slice`;

/** The slice must exist (an operator creates it once, as root: deploy/workloads-slice.sh) and cap memory. */
export async function sliceStatus(): Promise<{ ok: true; memoryMaxMb: number } | { ok: false; reason: string }> {
  try {
    // key=value, not --value: systemctl prints properties in its own order, not the order asked for.
    const { stdout } = await run('systemctl', ['show', sliceName(), '-p', 'LoadState', '-p', 'MemoryMax']);
    const props = Object.fromEntries(
      stdout
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    if (props.LoadState !== 'loaded')
      return {
        ok: false,
        reason: `the workload slice ${sliceName()} does not exist: run deploy/workloads-slice.sh --name ${sliceName()} --memory <size> as root`,
      };
    const bytes = Number(props.MemoryMax);
    if (!Number.isFinite(bytes) || bytes <= 0)
      return { ok: false, reason: `${sliceName()} has no memory ceiling (MemoryMax)` };
    return { ok: true, memoryMaxMb: Math.floor(bytes / (1024 * 1024)) };
  } catch (err) {
    return { ok: false, reason: `cannot read ${sliceName()}: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Linux bridge names for workload networks all start with `ncw`, so one host
 * rule (`-i ncw+`) covers every install's workloads; then 6 hex of this
 * install, then the network index. At most 15 characters.
 */
export const BRIDGE_PREFIX = 'ncw';
export const bridgeName = (idx: number | 'p'): string => `${BRIDGE_PREFIX}${sha256(INSTALL_SLUG).slice(0, 6)}${idx}`;
export const networkName = (idx: number): string => `nc-wl-${INSTALL_SLUG}-${idx}`;
export const probeNetworkName = (): string => `nc-wl-${INSTALL_SLUG}-probe`;

/** A stable short key for an agent group: a hash of its whole id, never a slice of it. */
export const groupKey = (agentGroupId: string): string => sha256(agentGroupId).slice(0, 12);

/** Compose project names: lowercase letters, digits, - and _. */
export function projectName(w: Pick<Workload, 'agentGroupId' | 'name'>): string {
  return `nc-${INSTALL_SLUG}-${groupKey(w.agentGroupId)}-${w.name}`;
}

/** The tag a built service's image is loaded under: nothing else is ever loaded from a build. */
export const builtImageName = (w: Pick<Workload, 'agentGroupId' | 'name'>, service: string): string =>
  `${projectName(w)}-${service}:built`;

async function createInternalNetwork(name: string, idx: number, bridge: string): Promise<void> {
  const { subnet, ipRange, gateway } = subnetFor(idx);
  await run(
    CONTAINER_RUNTIME_BIN,
    [
      'network',
      'create',
      '--internal',
      '--subnet',
      subnet,
      // Explicit: Docker would otherwise give the host the first address of the ip-range.
      '--gateway',
      gateway,
      '--ip-range',
      ipRange,
      '-o',
      `com.docker.network.bridge.name=${bridge}`,
      '--label',
      `nanoclaw-workloads=${INSTALL_SLUG}`,
      name,
    ],
    { env: dockerEnv() },
  );
}

/** The bridge and host address a network actually uses, or null when it does not exist. */
export async function networkInfo(
  name: string,
): Promise<{ bridge: string; gateway: string; internal: boolean } | null> {
  return run(
    CONTAINER_RUNTIME_BIN,
    [
      'network',
      'inspect',
      name,
      '--format',
      '{{index .Options "com.docker.network.bridge.name"}} {{range .IPAM.Config}}{{.Gateway}}{{end}} {{.Internal}}',
    ],
    { env: dockerEnv() },
  ).then(
    (r) => {
      const [bridge = '', gateway = '', internal = ''] = r.stdout.trim().split(' ');
      return { bridge, gateway, internal: internal === 'true' };
    },
    () => null,
  );
}

/** Does an existing network have the shape the host rules and the preflight rely on? */
const shaped = (info: { bridge: string; gateway: string; internal: boolean }, idx: number, bridge: string): boolean =>
  info.bridge === bridge && info.gateway === subnetFor(idx).gateway && info.internal;

export async function ensureNetwork(idx: number): Promise<string> {
  const name = networkName(idx);
  const info = await networkInfo(name);
  if (info === null) {
    await createInternalNetwork(name, idx, bridgeName(idx));
    log.info('Workload network created', { network: name, subnet: subnetFor(idx).subnet });
  } else if (!shaped(info, idx, bridgeName(idx))) {
    // The host rules match the bridge name: a network under any other name, or not internal, is unprotected.
    throw new Error(
      `workload network ${name} is not the internal network on bridge ${bridgeName(idx)} NanoClaw expects: remove it so NanoClaw recreates it`,
    );
  }
  return name;
}

export async function ensureProbeNetwork(idx: number): Promise<string> {
  const name = probeNetworkName();
  const info = await networkInfo(name);
  if (info && shaped(info, idx, bridgeName('p'))) return name;
  if (info) await run(CONTAINER_RUNTIME_BIN, ['network', 'rm', name], { env: dockerEnv() }).catch(() => undefined);
  await createInternalNetwork(name, idx, bridgeName('p'));
  return name;
}

/** NanoClaw's session containers are named ncl-<install>-…; Compose names workloads <project>-<service>-<n> (nc-…). */
export const isAgentContainerName = (name: string): boolean => name.startsWith(`ncl-${INSTALL_SLUG}-`);

/** Join every running container of an agent to its workload network, so the agent reaches its own stacks. */
export async function joinAgentContainers(agentGroupId: string, network: string): Promise<number> {
  const { stdout } = await run(CONTAINER_RUNTIME_BIN, [
    'ps',
    '--filter',
    `label=nanoclaw-group=${agentGroupId}`,
    '--format',
    '{{.Names}} {{.Networks}}',
  ]);
  let joined = 0;
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [name, nets = ''] = line.split(' ');
    // Labels can be baked into any image, so a label alone does not make an
    // agent container: NanoClaw names its own, and no workload can take that name.
    if (!isAgentContainerName(name)) continue;
    if (nets.split(',').includes(network)) continue;
    await run(CONTAINER_RUNTIME_BIN, ['network', 'connect', network, name]).then(
      () => joined++,
      (err) => log.warn('Workload network join failed', { container: name, network, err: String(err).slice(0, 200) }),
    );
  }
  return joined;
}

export const workDir = (id: string): string => path.join(DATA_DIR, 'workloads', id);

/**
 * NanoClaw's own Docker config folder for workload calls: no `auths`, no
 * `credsStore`, no contexts. The CLI plugins (compose, buildx) are still
 * found: the system plugin folders always are, and the operator's own plugin
 * folder is named explicitly.
 */
export function dockerConfigDir(home = os.homedir()): string {
  const dir = path.join(DATA_DIR, 'workloads-docker');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = JSON.stringify({ cliPluginsExtraDirs: [path.join(home, '.docker', 'cli-plugins')] });
  const file = path.join(dir, 'config.json');
  if (fs.readFileSync(file, { encoding: 'utf-8', flag: 'a+' }) !== config)
    fs.writeFileSync(file, config, { mode: 0o600 });
  return dir;
}

/** What a workload's Docker calls see of the environment: enough to reach Docker, none of NanoClaw's settings or secrets. */
export function dockerEnv(env: NodeJS.ProcessEnv = process.env, configDir = dockerConfigDir()): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR', 'TMPDIR'];
  return {
    ...Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])),
    DOCKER_CONFIG: configDir,
  };
}

/** Every string in a Compose value, with `$` doubled: Compose then fills in nothing from the host's environment. Pure. */
export function escapeInterpolation<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/\$/g, '$$$$') as T;
  if (Array.isArray(v)) return v.map(escapeInterpolation) as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, escapeInterpolation(x)])) as T;
  return v;
}

/** Run a helper container (no network, NanoClaw's uid, under the slice). Resolves with stdout. */
export async function runHelper(
  mounts: string[],
  command: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; memory?: string } = {},
): Promise<string> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  const { stdout } = await run(
    CONTAINER_RUNTIME_BIN,
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--log-driver',
      'none',
      '--user',
      `${uid}:${gid}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--cgroup-parent',
      sliceName(),
      '--memory',
      opts.memory ?? '256m',
      '--pids-limit',
      '64',
      ...mounts.flatMap((m) => ['-v', m]),
      HELPER_IMAGE(),
      ...command,
    ],
    { timeout: opts.timeoutMs ?? 600_000, maxBuffer: opts.maxBuffer ?? 1024 * 1024, env: dockerEnv() },
  );
  return stdout;
}

/** Plain relative path segments, or an error: what a build context or Dockerfile may be named. */
export function plainSegments(rel: string, what: string): string[] {
  const clean = rel.split(/[/\\]/).filter((p) => p && p !== '.');
  if (clean.some((p) => p === '..' || !/^[A-Za-z0-9._@+-]+$/.test(p)))
    throw new Error(`${what} ${rel} must be a plain path in the workspace`);
  return clean;
}

/**
 * Copy a build context out of the agent's folder into NanoClaw's own, so what
 * is built is what was checked: the agent cannot swap the folder for a link
 * (to the install, to /) after the check, or while Docker reads it. The copy
 * runs in a throwaway container that sees ONLY the agent's folder, read-only:
 * a link swapped in at any moment resolves inside that container, never on
 * this host. Links are copied as links; the build context does not follow them out.
 */
export async function copyBuildContext(groupDir: string, rel: string, dest: string): Promise<string> {
  const clean = plainSegments(rel, 'build context');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  await runHelper(
    [`${fs.realpathSync(groupDir)}:/src:ro`, `${dest}:/dst`],
    ['cp', '-a', `/src/${clean.join('/')}/.`, '/dst/'],
  ).catch((err) => {
    throw new Error(
      `could not copy build context ${rel}: ${String((err as { stderr?: string }).stderr || err).slice(-300)}`,
    );
  });
  const top = fs.lstatSync(dest);
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Error(`build context ${rel} changed while it was copied`);
  return dest;
}

/**
 * Write what Compose runs from. Every service runs an image NanoClaw names:
 * a pulled image by its approved digest, a built one under builtImageName.
 * Every value has `$` escaped so the host's environment never fills anything in.
 */
export function writeFiles(
  w: Workload,
  network: string,
  images: Record<string, string>,
): { stack: string; override: string } {
  const dir = workDir(w.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const services: Record<string, Record<string, unknown>> = {};
  for (const [name, svc] of Object.entries(w.stack.compose.services)) {
    const { build: _b, image: _i, ...rest } = svc;
    if (!images[name]) throw new Error(`${name}: no image to run`);
    services[name] = { ...escapeInterpolation(rest), image: images[name] };
  }
  const stackFile = path.join(dir, 'stack.yml');
  const overrideFile = path.join(dir, 'override.yml');
  const volumes = w.stack.compose.volumes;
  fs.writeFileSync(
    stackFile,
    stringify({
      services,
      ...(volumes && Object.keys(volumes).length ? { volumes: escapeInterpolation(volumes) } : {}),
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    overrideFile,
    stringify(
      buildOverride(Object.keys(services), {
        project: projectName(w),
        network,
        slice: sliceName(),
        labels: {
          'nanoclaw.install': INSTALL_SLUG,
          'nanoclaw.agent': w.agentGroupId,
          'nanoclaw.workload': w.id,
        },
        addresses: w.addresses,
      }),
    ),
    { mode: 0o600 },
  );
  return { stack: stackFile, override: overrideFile };
}

const clip = (s: string): string => (s.length > MAX_OUTPUT ? `…${s.slice(-MAX_OUTPUT)}` : s);

/** `docker compose` for one workload. Output is clipped; errors carry the tail of stderr. */
export async function compose(w: Workload, args: string[], timeoutMs = 600_000): Promise<string> {
  const dir = workDir(w.id);
  try {
    const { stdout, stderr } = await run(
      CONTAINER_RUNTIME_BIN,
      [
        'compose',
        '-p',
        projectName(w),
        '-f',
        path.join(dir, 'stack.yml'),
        '-f',
        path.join(dir, 'override.yml'),
        ...args,
      ],
      { cwd: dir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: dockerEnv() },
    );
    return clip(`${stdout}${stderr}`.trim());
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new Error(clip(`${e.stderr || e.stdout || e.message || String(err)}`.trim()), { cause: err });
  }
}

/**
 * The digest an image reference points at right now (its index, for a
 * multi-platform image), from the registry, without pulling. A reference that
 * already names a digest is its own answer.
 */
export async function resolveDigest(ref: string): Promise<string> {
  const pinned = /@(sha256:[a-f0-9]{64})$/.exec(ref);
  if (pinned) return pinned[1];
  try {
    const { stdout } = await run(
      CONTAINER_RUNTIME_BIN,
      ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest.Digest}}'],
      { timeout: 90_000, maxBuffer: 1024 * 1024, env: dockerEnv() },
    );
    const digest = JSON.parse(stdout.trim()) as unknown;
    if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('no digest in the answer');
    return digest;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `cannot find image ${ref} in its registry (only public images can be used): ${String(e.stderr || e.message || err)
        .trim()
        .split('\n')
        .pop()
        ?.slice(0, 200)}`,
      { cause: err },
    );
  }
}

/** A reference pinned to a digest: `nginx:1.27` + digest → `nginx:1.27@sha256:…`. */
export const pinRef = (ref: string, digest: string): string => `${ref.replace(/@sha256:[a-f0-9]{64}$/, '')}@${digest}`;

/** Refuse images labelled as NanoClaw's (a forged nanoclaw-group would pass for an agent container elsewhere). */
export async function refuseReservedImageLabels(images: string[]): Promise<void> {
  for (const image of images) {
    const { stdout } = await run(
      CONTAINER_RUNTIME_BIN,
      ['image', 'inspect', '--format', '{{json .Config.Labels}}', image],
      { env: dockerEnv() },
    );
    const labels = (JSON.parse(stdout.trim() || 'null') ?? {}) as Record<string, string>;
    const bad = Object.keys(labels).filter((k) => /^(nanoclaw|dev\.nanoclaw)/i.test(k));
    if (bad.length)
      throw new Error(`image ${image} carries reserved labels (${bad.join(', ')}): remove them from its Dockerfile`);
  }
}

/** Drop this stack's replaced (untagged) images: they would only fill the disk. */
export async function pruneOldImages(w: Workload): Promise<void> {
  await run(
    CONTAINER_RUNTIME_BIN,
    ['image', 'prune', '-f', '--filter', `label=com.docker.compose.project=${projectName(w)}`],
    { env: dockerEnv() },
  ).catch(() => undefined);
}

export function removeFiles(id: string): void {
  fs.rmSync(workDir(id), { recursive: true, force: true });
}
