/**
 * The node side of workloads: the systemd slice, per-agent internal networks,
 * the files Compose runs from, and `docker compose` itself. A workload's node
 * is central ('local') or a worker machine; on a worker every step runs there
 * over its link (dockerOn: the worker allows a fixed set, worker-main.ts),
 * with images pulled or built here and sent (shipImage).
 *
 * Every Docker call made for a workload runs with NanoClaw's own Docker
 * config folder (dockerEnv): no registry logins, no credential helpers, no
 * contexts from the operator's ~/.docker. A stack pulls public images only,
 * and nothing it builds can be handed the host's registry credentials.
 */
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { parse, stringify } from 'yaml';

import { DATA_DIR, INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';
import { buildRefusalsSince } from '../../channels/webchat/build-refusals.js';
import { callWorker, openWorkerStream } from '../machines/links.js';
import { HELPER_IMAGE } from './images.js';
import { buildOverride, overlappingIndexes, subnetFor } from './override.js';
import { workloadSetting } from './settings.js';
import type { Workload } from './store.js';
import { ALIASES_KEY } from './translate.js';

const run = promisify(execFile);
const MAX_OUTPUT = 20_000;

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

/** Central itself, as a workload's node. */
export const LOCAL_NODE = 'local';

/**
 * `docker <args>` on a node: here (with NanoClaw's own Docker config,
 * dockerEnv), or on a worker over its link (worker-main.ts runs it from its
 * allowlist, in its own folder `dir`, with the Compose files given). Rejects
 * like execFile does, with stdout/stderr on the error.
 */
export async function dockerOn(
  node: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    maxBuffer?: number;
    files?: Record<string, string>;
    dir?: string;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (node === LOCAL_NODE)
    return run(CONTAINER_RUNTIME_BIN, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      env: dockerEnv(),
    });
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const r = (await callWorker(
    node,
    'docker',
    { args, ...(opts.dir ? { dir: opts.dir, files: opts.files ?? {} } : {}), timeoutMs },
    timeoutMs + 30_000,
  )) as { code: number; stdout: string; stderr: string };
  if (r.code !== 0)
    throw Object.assign(new Error((r.stderr || r.stdout || `docker exited ${r.code}`).trim()), {
      stdout: r.stdout,
      stderr: r.stderr,
    });
  return { stdout: r.stdout, stderr: r.stderr };
}

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

/**
 * Network indexes this install must not use: their subnet is already held by a
 * Docker network that isn't one of ours (another install's workloads, or
 * anything else on the host). A failed listing returns none — the create then
 * fails loudly as before, rather than guessing.
 */
export async function foreignIndexes(node = LOCAL_NODE): Promise<Set<number>> {
  try {
    const { stdout: names } = await dockerOn(node, ['network', 'ls', '--format', '{{.Name}}']);
    const others = names
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith(`nc-wl-${INSTALL_SLUG}-`));
    if (!others.length) return new Set();
    const { stdout } = await dockerOn(node, [
      'network',
      'inspect',
      '--format',
      '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
      ...others,
    ]);
    return overlappingIndexes(stdout.split(/\s+/).filter(Boolean));
  } catch (err) {
    log.warn('Workload networks: could not list host networks', { err: String(err) });
    return new Set();
  }
}

/** The tag a built service's image is loaded under: nothing else is ever loaded from a build. */
export const builtImageName = (w: Pick<Workload, 'agentGroupId' | 'name'>, service: string): string =>
  `${projectName(w)}-${service}:built`;

async function createInternalNetwork(name: string, idx: number, bridge: string, node = LOCAL_NODE): Promise<void> {
  const { subnet, ipRange, gateway } = subnetFor(idx);
  await dockerOn(node, [
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
  ]);
}

/** The bridge and host address a network actually uses, or null when it does not exist. */
export async function networkInfo(
  name: string,
  node = LOCAL_NODE,
): Promise<{ bridge: string; gateway: string; internal: boolean } | null> {
  return dockerOn(node, [
    'network',
    'inspect',
    name,
    '--format',
    '{{index .Options "com.docker.network.bridge.name"}} {{range .IPAM.Config}}{{.Gateway}}{{end}} {{.Internal}}',
  ]).then(
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

export async function ensureNetwork(idx: number, node = LOCAL_NODE): Promise<string> {
  const name = networkName(idx);
  const info = await networkInfo(name, node);
  if (info === null) {
    await createInternalNetwork(name, idx, bridgeName(idx), node);
    log.info('Workload network created', { network: name, subnet: subnetFor(idx).subnet, node });
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
  const aliases: Record<string, string[]> = {};
  for (const [name, svc] of Object.entries(w.stack.compose.services)) {
    // Extra names (translate.ts) go on the stack network in the override, not in the stack file.
    const { build: _b, image: _i, [ALIASES_KEY]: names, ...rest } = svc;
    if (!images[name]) throw new Error(`${name}: no image to run`);
    services[name] = { ...escapeInterpolation(rest), image: images[name] };
    if (Array.isArray(names) && names.length) aliases[name] = names.map(String);
  }
  const stackFile = path.join(dir, 'stack.yml');
  const overrideFile = path.join(dir, 'override.yml');
  const volumes = w.stack.compose.volumes;
  // Inline-content configs (translate.ts): escaped like the services, so a `$host` in an nginx config survives.
  const configs = w.stack.compose.configs;
  fs.writeFileSync(
    stackFile,
    stringify({
      services,
      ...(volumes && Object.keys(volumes).length ? { volumes: escapeInterpolation(volumes) } : {}),
      ...(configs && Object.keys(configs).length ? { configs: escapeInterpolation(configs) } : {}),
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
        aliases,
      }),
    ),
    { mode: 0o600 },
  );
  return { stack: stackFile, override: overrideFile };
}

const clip = (s: string): string => (s.length > MAX_OUTPUT ? `…${s.slice(-MAX_OUTPUT)}` : s);

/**
 * A Compose file as JSON, for a worker: Compose reads JSON as YAML, and the
 * worker checks the files again with built-ins only (worker-main.ts).
 */
export const asJson = (file: string): string => JSON.stringify(parse(fs.readFileSync(file, 'utf8')), null, 2);

/**
 * A failed build or pull, with what the egress filter refused it meanwhile
 * first: BuildKit reports those only as "Forbidden" or "Bad Gateway".
 */
export function withRefusals(agentGroupId: string, since: number, text: string): string {
  const refused = buildRefusalsSince(agentGroupId, since - 1_000);
  return refused.length ? `Blocked during the build:\n${refused.map((r) => `- ${r}`).join('\n')}\n\n${text}` : text;
}

/**
 * Where a build stood when it was stopped, from BuildKit's plain progress
 * (`#<n> <name>`, then `#<n> DONE 12.3s` or `CACHED`): the steps still
 * running, and the slowest finished ones, so a timeout says what took the time.
 */
export function buildProgress(text: string): string | null {
  const name = new Map<string, string>();
  const took = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^#(\d+) (.+)$/.exec(raw.trim());
    if (!m) continue;
    const [, id, rest] = m as unknown as [string, string, string];
    const done = /^DONE (\d+(?:\.\d+)?)s$/.exec(rest);
    if (done) took.set(id, Number(done[1]));
    else if (/^(CACHED|ERROR)\b/.test(rest)) took.set(id, took.get(id) ?? 0);
    else if (!name.has(id) && !/^(\d+(\.\d+)? |CANCELED|sha256:)/.test(rest)) name.set(id, rest.slice(0, 120));
  }
  const running = [...name].filter(([id]) => !took.has(id)).map(([, n]) => n);
  const slow = [...took]
    .filter(([, s]) => s >= 60)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, s]) => `${name.get(id) ?? `#${id}`} (${Math.round(s / 60)} min)`);
  const out: string[] = [];
  if (running.length) out.push(`Still running: ${running.join('; ')}`);
  if (slow.length) out.push(`Slowest steps: ${slow.join('; ')}`);
  return out.length ? out.join('\n') : null;
}

/**
 * A failed build's own words. BuildKit's plain progress prints each step's
 * output as `#<step> <time> <line>` and the failure as `#<step> ERROR: …`; the
 * end of stderr is mostly the Dockerfile echoed back, which says where but not
 * why. Returns the failing step's last output lines and its error, or null.
 */
export function buildFailure(text: string, maxLines = 40): string | null {
  const lines = text.split(/\r?\n/);
  const err = [...lines].reverse().find((l) => /^#\d+ ERROR:/.test(l));
  if (!err) return null;
  const step = err.slice(0, err.indexOf(' '));
  const out = lines.filter((l) => l.startsWith(`${step} `) && l !== err && !/^#\d+ \[/.test(l));
  const done = lines.find((l) => /^(ERROR: )?failed to solve:/.test(l.trim()));
  return [...out.slice(-maxLines), err, ...(done ? [done.trim()] : [])].join('\n');
}

/** `docker compose` for one workload. Output is clipped; errors carry the tail of stderr (for a build, its failing step). */
export async function compose(w: Workload, args: string[], timeoutMs = 600_000): Promise<string> {
  const dir = workDir(w.id);
  const argv = ['compose', '-p', projectName(w), '-f', 'stack.yml', '-f', 'override.yml', ...args];
  try {
    const { stdout, stderr } =
      w.node === LOCAL_NODE
        ? await dockerOn(LOCAL_NODE, argv, { cwd: dir, timeoutMs })
        : await dockerOn(w.node, argv, {
            timeoutMs,
            dir: w.id,
            files: {
              'stack.yml': asJson(path.join(dir, 'stack.yml')),
              'override.yml': asJson(path.join(dir, 'override.yml')),
            },
          });
    return clip(`${stdout}${stderr}`.trim());
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const text = `${e.stderr || e.stdout || e.message || String(err)}`.trim();
    throw new Error(clip(buildFailure(text) ?? text), { cause: err });
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
  await dockerOn(w.node, [
    'image',
    'prune',
    '-f',
    '--filter',
    `label=com.docker.compose.project=${projectName(w)}`,
  ]).catch(() => undefined);
}

export function removeFiles(id: string): void {
  fs.rmSync(workDir(id), { recursive: true, force: true });
}

/** A workload's files here and, on a worker, its folder there too. */
export async function removeWorkloadFiles(w: Pick<Workload, 'id' | 'node'>): Promise<void> {
  removeFiles(w.id);
  if (w.node !== LOCAL_NODE)
    await callWorker(w.node, 'rmdir', { dir: w.id }).catch((err) =>
      log.warn('Workload folder on worker not removed', { workloadId: w.id, node: w.node, err: String(err) }),
    );
}

/**
 * Size the workloads slice on a worker to NanoClaw's share of it (members.ts
 * availableOn), the slice every one of its containers runs under (override.yml).
 */
export async function sizeWorkerSlice(node: string, share: { memMb: number; cpus: number }): Promise<void> {
  await callWorker(node, 'slice', { name: sliceName(), memoryMb: share.memMb, cpus: share.cpus });
}

/** The tag a pulled service's image is sent to a worker under: `docker save` keeps tags, not digests. */
export const pulledImageName = (w: Pick<Workload, 'agentGroupId' | 'name'>, service: string): string =>
  `${projectName(w)}-${service}:pulled`;

/** Pull an image reference here (a digest-pinned one: what was approved). */
export async function pullHere(ref: string): Promise<void> {
  await dockerOn(LOCAL_NODE, ['pull', '--quiet', ref], { timeoutMs: 1_200_000 });
}

/** Tag an image here under another name (the name a worker gets it as). */
export async function tagHere(ref: string, as: string): Promise<void> {
  await dockerOn(LOCAL_NODE, ['tag', ref, as]);
}

/**
 * Give a worker an image from central's own copy (docker save → worker-main.ts
 * image-load), unless the tag there already holds the same image: the worker
 * never pulls from a registry, and never builds.
 */
export async function shipImage(node: string, image: string): Promise<void> {
  const here = (await dockerOn(LOCAL_NODE, ['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
  if (here && (await callWorker(node, 'hasImage', { image })) === here) return;
  await new Promise<void>((resolve, reject) => {
    const save = spawn(CONTAINER_RUNTIME_BIN, ['save', image], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: dockerEnv(),
    });
    const up = openWorkerStream(node, { kind: 'image-load', image });
    let err = '';
    save.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-500)));
    save.on('error', reject);
    save.on('close', (code) => code !== 0 && (up.destroy(), reject(new Error(`save ${image}: ${err.trim() || code}`))));
    up.on('error', (e: Error) => reject(new Error(`send ${image}: ${e.message}`)));
    // The worker ends its side once the load has finished.
    up.on('end', () => resolve());
    up.resume();
    save.stdout.pipe(up);
  });
  const there = await callWorker(node, 'hasImage', { image });
  if (there !== here) throw new Error(`${image} did not arrive intact on the worker`);
}
