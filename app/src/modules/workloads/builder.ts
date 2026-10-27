/**
 * Confined builds. A build runs the agent's own Dockerfile steps, so it gets
 * the agent's egress, not the host's: each agent builds in its own rootless
 * BuildKit container inside gVisor (runsc: build steps never reach the host
 * kernel directly), on the lockdown network behind the egress filter, under
 * the workload slice with memory/CPU/pid caps, its cache in a volume that
 * counts toward the agent's disk. The filter knows the builder by name, holds
 * it to the agent's policy plus the registries an owner opted the agent into,
 * and never routes it through the credential gateway (no secrets in builds).
 *
 * Off unless NANOCLAW_WORKLOAD_CONFINED_BUILDS=1; without it `build:` is
 * refused (policy.ts) and only published images run.
 *
 * The builder is the agent's to take over, so nothing it hands back is
 * trusted: the image comes out as a file, which is repacked in a helper
 * container to hold exactly one image named by NanoClaw (builtImageName), then
 * loaded; the images NanoClaw itself relies on are checked unchanged after.
 * Every Docker call here runs with NanoClaw's own empty Docker config
 * (docker.ts dockerEnv), so no registry login can reach a build.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CONTAINER_IMAGE_BASE, INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { BUILD_SESSION, registerFilteredContainer } from '../../channels/webchat/egress-filter.js';
import { log } from '../../log.js';
import { filterEndpointForBuilds } from '../container-egress/index.js';
import { dockerEnv, groupKey, runHelper, sliceName } from './docker.js';
import { BUILDKIT_IMAGE, HELPER_IMAGE } from './images.js';
import { workloadSetting } from './settings.js';
import { normalizeArgs } from './shape.js';

const run = promisify(execFile);

/** gVisor's runtime (runsc), registered with Docker once per host (deploy/install-gvisor.sh). */
export const builderRuntime = (): string => workloadSetting('NANOCLAW_WORKLOAD_BUILDER_RUNTIME') || 'runsc';
const BUILDER_MEMORY = '2g';
const BUILDER_CPUS = '2';
export const BUILDER_CACHE_MB = 3000;
/** Bumped when the builder's run arguments change, so an older builder is replaced. */
const BUILDER_SPEC = 'v3';
const BUILD_TIMEOUT_MS = 20 * 60_000;

/** The builder container and buildx builder name. Never ncl-… (agent containers) or nc-… (workloads). */
export const builderName = (agentGroupId: string): string => `ncb-${INSTALL_SLUG}-${groupKey(agentGroupId)}`;
export const builderCacheVolume = (agentGroupId: string): string => `${builderName(agentGroupId)}-cache`;

export interface Builder {
  /** buildx builder name. */
  name: string;
  /** Proxy URL the build steps use (HTTP(S)_PROXY build args). */
  proxy: string;
}

const docker = (args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) =>
  run(CONTAINER_RUNTIME_BIN, args, { env: dockerEnv(), maxBuffer: 4 * 1024 * 1024, ...opts });

const exists = (args: string[]): Promise<boolean> =>
  docker(args).then(
    () => true,
    () => false,
  );

/** Is gVisor registered with Docker here? */
export async function runtimeAvailable(name = builderRuntime()): Promise<boolean> {
  const { stdout } = await docker(['info', '--format', '{{json .Runtimes}}']).catch(() => ({ stdout: '{}' }));
  try {
    return Object.prototype.hasOwnProperty.call(JSON.parse(stdout.trim() || '{}'), name);
  } catch {
    return false;
  }
}

/** The agent's builder, started if needed. */
export async function ensureBuilder(agentGroupId: string): Promise<Builder> {
  if (!(await runtimeAvailable()))
    throw new Error(
      `confined builds need the ${builderRuntime()} runtime registered with Docker (deploy/install-gvisor.sh); ask an owner`,
    );
  let ep: ReturnType<typeof filterEndpointForBuilds>;
  try {
    ep = filterEndpointForBuilds();
  } catch (err) {
    throw new Error(`builds need the agent network filter, which is not available: ${String(err).slice(0, 200)}`, {
      cause: err,
    });
  }
  if (!ep)
    throw new Error(
      'builds need the agent network filter, which starts with a filtered agent: send the agent a message, then deploy again',
    );
  const name = builderName(agentGroupId);
  // Not a credential: the filter only needs one present, and a build's traffic never reaches the gateway.
  const proxy = `http://build:build@${ep.host}:${ep.port}`;
  const state = await docker([
    'inspect',
    '--format',
    '{{.State.Running}} {{index .Config.Labels "nanoclaw-builder-spec"}}',
    name,
  ]).then(
    (r) => r.stdout.trim().split(' '),
    () => null,
  );
  let running = state ? state[0] === 'true' && state[1] === BUILDER_SPEC : false;
  if (state && !running) {
    await docker(['buildx', 'rm', name]).catch(() => undefined);
    await docker(['rm', '-f', name]).catch(() => undefined);
  }
  if (!running) {
    const image = BUILDKIT_IMAGE();
    await docker(['image', 'inspect', image]).catch(() => docker(['pull', '--quiet', image], { timeout: 300_000 }));
    await docker([
      'run',
      '-d',
      '--name',
      name,
      '--network',
      ep.network,
      '--cgroup-parent',
      sliceName(),
      '--memory',
      BUILDER_MEMORY,
      '--cpus',
      BUILDER_CPUS,
      '--pids-limit',
      '4096',
      // Inside gVisor: build steps run against gVisor's own kernel, never the
      // host's, so BuildKit's user namespaces and mounts need no host
      // exception; Docker's default seccomp and AppArmor stay on.
      '--runtime',
      builderRuntime(),
      '--label',
      `nanoclaw-workload-builder=${INSTALL_SLUG}`,
      '--label',
      `nanoclaw-builder-spec=${BUILDER_SPEC}`,
      '-e',
      `HTTP_PROXY=${proxy}`,
      '-e',
      `HTTPS_PROXY=${proxy}`,
      '-e',
      `http_proxy=${proxy}`,
      '-e',
      `https_proxy=${proxy}`,
      '-v',
      `${builderCacheVolume(agentGroupId)}:/home/user/.local/share/buildkit`,
      image,
      '--oci-worker-no-process-sandbox',
      // Keep the build cache bounded (it counts toward the agent's disk quota).
      '--oci-worker-gc',
      '--oci-worker-gc-keepstorage',
      String(BUILDER_CACHE_MB),
    ]);
    running = true;
    log.info('Workload builder started', { agentGroupId, builder: name });
  }
  registerFilteredContainer(name, { agentGroupId, sessionId: BUILD_SESSION });
  if (!(await exists(['buildx', 'inspect', name])))
    await docker(['buildx', 'create', '--name', name, '--driver', 'remote', `docker-container://${name}`]);
  return { name, proxy };
}

/** Remove an agent's builder and its cache (no workloads left). */
export async function removeBuilder(agentGroupId: string): Promise<void> {
  const name = builderName(agentGroupId);
  await docker(['buildx', 'rm', name]).catch(() => undefined);
  await docker(['rm', '-f', name]).catch(() => undefined);
  await docker(['volume', 'rm', builderCacheVolume(agentGroupId)]).catch(() => undefined);
}

// ── the image file a build hands back ──────────────────────────────────────

const BLOB_RE = /^blobs\/sha256\/[a-f0-9]{64}$/;

/**
 * The one image in a build's Docker-format archive (its manifest.json), as
 * the members a clean archive needs and the manifest NanoClaw writes for it:
 * one image, tagged `name` and nothing else. Anything unexpected is refused.
 * Pure.
 */
export function cleanManifest(text: string, name: string): { manifest: string; members: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('the build produced an unreadable image (manifest.json)', { cause: err });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('the build must produce exactly one image');
  const m = parsed[0] as { Config?: unknown; Layers?: unknown };
  if (typeof m.Config !== 'string' || !BLOB_RE.test(m.Config))
    throw new Error('the built image has an unexpected config');
  if (!Array.isArray(m.Layers) || !m.Layers.every((l) => typeof l === 'string' && BLOB_RE.test(l)))
    throw new Error('the built image has unexpected layers');
  const layers = m.Layers as string[];
  const members = [...new Set([m.Config, ...layers])];
  return { manifest: JSON.stringify([{ Config: m.Config, RepoTags: [name], Layers: layers }]), members };
}

/**
 * Images NanoClaw relies on, with their IDs: every tag of the agent image,
 * the helper and BuildKit images. A load must leave all of them as they were.
 */
export async function protectedImageIds(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { stdout } = await docker([
    'images',
    '--no-trunc',
    '--filter',
    `reference=${CONTAINER_IMAGE_BASE}`,
    '--format',
    '{{.Repository}}:{{.Tag}} {{.ID}}',
  ]).catch(() => ({ stdout: '' }));
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [ref, id] = line.split(' ');
    if (ref && id) out.set(ref, id);
  }
  for (const ref of [HELPER_IMAGE(), BUILDKIT_IMAGE()]) {
    const id = await docker(['image', 'inspect', '--format', '{{.Id}}', ref]).then(
      (r) => r.stdout.trim(),
      () => '',
    );
    if (id) out.set(ref, id);
  }
  return out;
}

/** What changed between two protected-image snapshots. Pure. */
export function changedImages(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...before].filter(([ref, id]) => after.get(ref) !== id).map(([ref]) => ref);
}

export interface BuildSpec {
  /** The copied build context (docker.ts copyBuildContext), in NanoClaw's own folder. */
  context: string;
  /** The Dockerfile, relative to the context. */
  dockerfile: string;
  target?: string;
  args?: unknown;
}

/**
 * Build one service in the agent's builder and load the result under `name`
 * only. `work` is a scratch folder of NanoClaw's own (emptied first).
 */
export async function buildImage(b: Builder, spec: BuildSpec, name: string, work: string): Promise<void> {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'repack'), { recursive: true, mode: 0o700 });
  const archive = path.join(work, 'image.tar');
  const proxyArgs = [
    `HTTP_PROXY=${b.proxy}`,
    `HTTPS_PROXY=${b.proxy}`,
    `http_proxy=${b.proxy}`,
    `https_proxy=${b.proxy}`,
    'NO_PROXY=',
    'no_proxy=',
  ];
  const buildArgs = [...normalizeArgs(spec.args), ...proxyArgs].flatMap((a) => ['--build-arg', a]);
  try {
    await docker(
      [
        'buildx',
        'build',
        '--builder',
        b.name,
        '--pull',
        '--progress',
        'plain',
        '--file',
        path.join(spec.context, spec.dockerfile),
        ...(spec.target ? ['--target', spec.target] : []),
        ...buildArgs,
        '--output',
        `type=docker,dest=${archive}`,
        spec.context,
      ],
      { timeout: BUILD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`the build failed: ${String(e.stderr || e.message || err).slice(-1500)}`, { cause: err });
  }
  const before = await protectedImageIds();
  // Read the manifest in a helper: the archive is the builder's, never unpacked on this host.
  const manifestText = await runHelper(
    [`${archive}:/in/image.tar:ro`],
    ['tar', '-xOf', '/in/image.tar', 'manifest.json'],
    {
      timeoutMs: 120_000,
    },
  ).catch((err) => {
    throw new Error(
      `the built image has no manifest: ${String((err as { stderr?: string }).stderr || err).slice(-300)}`,
    );
  });
  const { manifest, members } = cleanManifest(manifestText, name);
  fs.writeFileSync(path.join(work, 'manifest.json'), manifest, { mode: 0o600 });
  await runHelper(
    [
      `${archive}:/in/image.tar:ro`,
      `${path.join(work, 'manifest.json')}:/m/manifest.json:ro`,
      `${path.join(work, 'repack')}:/w`,
    ],
    [
      'sh',
      '-ec',
      'cd /w; mkdir x; cd x; tar -xf /in/image.tar -- "$@"; ' +
        'for f in "$@"; do if [ ! -f "$f" ] || [ -L "$f" ]; then echo "not a plain file: $f" >&2; exit 3; fi; done; ' +
        'cp /m/manifest.json manifest.json; tar -cf /w/clean.tar manifest.json "$@"',
      'sh',
      ...members,
    ],
    { timeoutMs: 600_000, memory: '512m' },
  ).catch((err) => {
    throw new Error(
      `the built image could not be repacked: ${String((err as { stderr?: string }).stderr || err).slice(-300)}`,
    );
  });
  await docker(['load', '--quiet', '--input', path.join(work, 'repack', 'clean.tar')], { timeout: 600_000 });
  const changed = changedImages(before, await protectedImageIds());
  if (changed.length) {
    await docker(['image', 'rm', '-f', name]).catch(() => undefined);
    log.error('Workload build changed a protected image', { image: name, changed });
    throw new Error(`loading the build changed NanoClaw's own images (${changed.join(', ')}); refused`);
  }
  fs.rmSync(work, { recursive: true, force: true });
}
