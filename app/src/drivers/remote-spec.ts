/**
 * Spec transit — what leaves central for a paired runner, and how it is
 * derived from the SessionSpec the host composed.
 *
 * The rule, stated once: central decides WHAT a session mounts and where; the
 * laptop decides WHICH local paths a slot may resolve to. Nothing that leaves
 * here names a central host path, and nothing that leaves here carries a
 * credential — the OneCLI proxy URL embeds the agent's token, so it is
 * replaced by a sentinel the runner substitutes with its relay address,
 * and the token stays on central, keyed by session.
 *
 * Mount classes cross as:
 *   install-surface            → content bundle (hash), always read-only
 *   group-state, read-only     → content bundle (composed files: container.json, CLAUDE.md, session context)
 *   group-state, read-write    → declared runner-owned directory (stateId) + first-run seed bundle
 *   allowlisted-extra, ro, central-owned → content bundle (gateway CA pems and
 *                                  data/user-skills — central's own content)
 *   allowlisted-extra, anything else → slot named by container path; the
 *                                  runner binds it to a local directory or refuses
 *   identity-material          → refused; never placed remotely
 *
 * Bundles are content-addressed: sha256 of the gzipped payload. The payload is
 * a JSON document (`BundleDoc`) — small trees only (the largest is
 * agent-runner/src at ~1.3 MB raw), so no tar dependency on either side.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';

import {
  deniedByPolicy,
  specInvalid,
  type ContainerSpec,
  type MountSpec,
  type SessionKey,
  type SessionResources,
  type SessionSpec,
} from './types.js';

export const REMOTE_SPEC_VERSION = 1;
/** The runner replaces this with its local relay address. Until then the container has no model access, by design. */
export const RELAY_SENTINEL = 'http://host.docker.internal:__NANOCLAW_RELAY_PORT__';

export type RemoteMount =
  | {
      kind: 'content';
      class: 'install-surface' | 'group-state' | 'allowlisted-extra';
      containerPath: string;
      bundle: string;
      file: boolean;
    }
  | { kind: 'state'; class: 'group-state'; containerPath: string; stateId: string; seed?: string }
  | {
      kind: 'slot';
      class: 'allowlisted-extra';
      containerPath: string;
      mode: 'rw' | 'ro';
      exclude?: string[];
      propose?: boolean;
    };

export interface RemoteSpec {
  v: typeof REMOTE_SPEC_VERSION;
  key: SessionKey;
  /** Container name central derived — both sides must agree for adoption. */
  name: string;
  labels: Record<string, string>;
  image: string;
  /** Build context bundle for `image` when the laptop does not have it. */
  /**
   * What the laptop may pull instead of building: the publisher/registry
   * reference central is pinned to (`versions.json` `agent-image`). The laptop
   * decides WHETHER to use it — it may build, pull this, or pull its own
   * mirror — but it never invents the identity the session runs under.
   */
  imageRef?: string;
  /**
   * Who decides how the image is obtained. 'machine' leaves it to the laptop;
   * 'pull'/'build' are the install's decision and override the laptop's own
   * setting — central governs the bytes its agents run.
   */
  imagePolicy?: 'machine' | 'pull' | 'build';
  build?: { bundle: string; args: Record<string, string>; lockSha?: string };
  env: Record<string, string>;
  contributedEnv: Record<string, string>;
  command?: string[];
  args?: string[];
  containerLabels: Record<string, string>;
  mounts: RemoteMount[];
  resources: SessionResources;
  hardening: 'standard';
  runAs?: { uid: number; gid: number };
  stopGraceSeconds: number;
  network: 'default' | 'none';
}

export interface BundleDoc {
  v: 1;
  /** Directory entries (relative, posix). Present so empty dirs survive. */
  dirs: string[];
  files: Array<{ p: string; m: number; d: string }>;
  /** Symlinks are not shipped; listed so the runner can log what was skipped. */
  skipped: string[];
}

export interface Bundle {
  hash: string;
  /** gzip(JSON(BundleDoc)) */
  bytes: Buffer;
}

export interface TransitResult {
  spec: RemoteSpec;
  bundles: Map<string, Bundle>;
  /**
   * The gateway the container's proxy pointed at, lifted out of the spec so
   * the bytes never leave central: where to terminate the relayed tunnel, and
   * the agent credential to present there. Never logged, never serialized.
   */
  proxyTarget: ProxyTarget | null;
}

export interface TransitRoots {
  dataRoot: string;
  groupsRoot: string;
  /** Central's `container/` directory — the image build context. */
  buildContext: string;
  /** Files/dirs excluded from the build context (relative to buildContext). */
  buildExcludes?: string[];
  /** Registry reference for a prebuilt agent image, if this install pins one. */
  publisherImageRef?: string;
  /** Install-wide image-source decision; omitted or 'machine' leaves it to each runner. */
  imagePolicy?: 'machine' | 'pull' | 'build';
}

const PROXY_ENV = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']);

export interface ProxyTarget {
  host: string;
  port: number;
  username: string;
  password: string;
}

export function packTree(root: string, excludes: string[] = []): Bundle {
  const doc: BundleDoc = { v: 1, dirs: [], files: [], skipped: [] };
  const st = fs.lstatSync(root);
  if (st.isFile()) {
    doc.files.push({ p: path.basename(root), m: st.mode & 0o777, d: fs.readFileSync(root).toString('base64') });
  } else if (st.isDirectory()) {
    const ex = new Set(excludes.map((e) => e.replace(/\\/g, '/')));
    const walk = (dir: string, rel: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ex.has(r) || ent.name === 'node_modules') continue;
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) {
          doc.skipped.push(r);
          continue;
        }
        if (ent.isDirectory()) {
          doc.dirs.push(r);
          walk(full, r);
        } else if (ent.isFile()) {
          const fst = fs.statSync(full);
          doc.files.push({ p: r, m: fst.mode & 0o777, d: fs.readFileSync(full).toString('base64') });
        }
      }
    };
    walk(root, '');
  } else {
    throw specInvalid(`cannot bundle ${root}: not a file or directory`);
  }
  const bytes = gzipSync(Buffer.from(JSON.stringify(doc)), { level: 6 });
  return { hash: createHash('sha256').update(bytes).digest('hex'), bytes };
}

/** Is this path inside something central owns, rather than a path it merely points at? */
function isUnder(hostPath: string, parent: string): boolean {
  const rel = path.relative(parent, hostPath);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function centralOwns(hostPath: string, roots: TransitRoots): boolean {
  return (
    hostPath === roots.dataRoot ||
    isUnder(hostPath, roots.dataRoot) ||
    isUnder(hostPath, roots.groupsRoot) ||
    isUnder(hostPath, roots.buildContext)
  );
}

function stateIdFor(hostPath: string, roots: TransitRoots): string | null {
  const rel = (base: string, tag: string): string | null => {
    const r = path.relative(base, hostPath);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    return `${tag}/${r.split(path.sep).join('/')}`;
  };
  return rel(roots.dataRoot, 'data') ?? rel(roots.groupsRoot, 'groups');
}

function stripProxyCredential(env: Record<string, string>): {
  env: Record<string, string>;
  target: ProxyTarget | null;
} {
  let target: ProxyTarget | null = null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (PROXY_ENV.has(k)) {
      try {
        const u = new URL(v);
        if (!target && u.username) {
          target = {
            host: u.hostname,
            port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password),
          };
        }
      } catch {
        /* an unparsable proxy URL still gets blanked — the sentinel is the safe value */
      }
      out[k] = RELAY_SENTINEL;
      continue;
    }
    out[k] = v;
  }
  return { env: out, target };
}

/**
 * Rewrite a validated SessionSpec for transit. Throws the driver's own failure
 * errors (`spec-invalid`, `denied-by-policy`) so callers report them like any
 * other realization failure.
 */
export function toRemoteSpec(
  spec: SessionSpec,
  agent: ContainerSpec,
  name: string,
  roots: TransitRoots,
): TransitResult {
  const bundles = new Map<string, Bundle>();
  const add = (hostPath: string, excludes?: string[]): string => {
    const b = packTree(hostPath, excludes);
    bundles.set(b.hash, b);
    return b.hash;
  };
  const mounts: RemoteMount[] = [];
  for (const m of agent.mounts) mounts.push(rewriteMount(m, roots, add));

  const env1 = stripProxyCredential(agent.env);
  const env2 = stripProxyCredential(agent.contributedEnv ?? {});
  const lockPath = path.join(roots.buildContext, 'agent-runner', 'bun.lock');
  const lockSha = fs.existsSync(lockPath)
    ? createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex')
    : undefined;
  const build = fs.existsSync(path.join(roots.buildContext, 'Dockerfile'))
    ? {
        bundle: add(
          roots.buildContext,
          roots.buildExcludes ?? ['agent-runner/src', 'agent-runner/node_modules', 'skills'],
        ),
        args: { IMAGE_SOURCE: 'runner' },
        // The agent-runner dependency set baked into any image claiming to be
        // this one. A laptop that pulls rather than builds checks the pulled
        // image's `dev.nanoclaw.agent-runner-lock-sha256` label against this,
        // so a stale published image cannot quietly run a different runtime
        // than the source central bind-mounts over it.
        ...(lockSha ? { lockSha } : {}),
      }
    : undefined;

  const remote: RemoteSpec = {
    v: REMOTE_SPEC_VERSION,
    key: spec.key,
    name,
    labels: spec.labels,
    image: agent.image,
    ...(roots.publisherImageRef ? { imageRef: roots.publisherImageRef } : {}),
    ...(roots.imagePolicy && roots.imagePolicy !== 'machine' ? { imagePolicy: roots.imagePolicy } : {}),
    ...(build ? { build } : {}),
    env: env1.env,
    contributedEnv: env2.env,
    ...(agent.command ? { command: agent.command } : {}),
    ...(agent.args ? { args: agent.args } : {}),
    containerLabels: agent.labels ?? {},
    mounts,
    resources: spec.resources,
    hardening: spec.hardening,
    ...(spec.runAs ? { runAs: spec.runAs } : {}),
    stopGraceSeconds: spec.stopGraceSeconds,
    network: spec.network === 'none' ? 'none' : 'default',
  };
  return { spec: remote, bundles, proxyTarget: env1.target ?? env2.target };
}

function rewriteMount(
  m: MountSpec,
  roots: TransitRoots,
  add: (hostPath: string, excludes?: string[]) => string,
): RemoteMount {
  const exists = fs.existsSync(m.hostPath);
  const isFile = exists && fs.statSync(m.hostPath).isFile();
  switch (m.class) {
    case 'identity-material':
      throw deniedByPolicy(`identity material (${m.containerPath}) is never placed on a runner`);
    case 'install-surface':
      if (!exists) throw specInvalid(`mount source missing: ${m.hostPath}`);
      return {
        kind: 'content',
        class: 'install-surface',
        containerPath: m.containerPath,
        bundle: add(m.hostPath),
        file: isFile,
      };
    case 'group-state': {
      if (!exists) throw specInvalid(`mount source missing: ${m.hostPath}`);
      if (m.mode === 'ro')
        return {
          kind: 'content',
          class: 'group-state',
          containerPath: m.containerPath,
          bundle: add(m.hostPath),
          file: isFile,
        };
      const stateId = stateIdFor(m.hostPath, roots);
      if (!stateId)
        throw deniedByPolicy(
          `writable group state outside the data/groups roots cannot be declared remotely: ${m.containerPath}`,
        );
      return { kind: 'state', class: 'group-state', containerPath: m.containerPath, stateId, seed: add(m.hostPath) };
    }
    case 'allowlisted-extra':
      // Read-only content central owns travels as content: a file (the gateway
      // CA pems) or a directory under central's roots (data/user-skills, which
      // is classed 'extra' only because it sits outside the enumerated
      // install-surface roots). Everything else is a path central points AT
      // rather than owns, and the laptop must say which local directory it
      // means — split authority would be hollow if central could name a path
      // the machine never agreed to.
      if (m.mode === 'ro' && exists && (isFile || centralOwns(m.hostPath, roots)))
        return {
          kind: 'content',
          class: 'allowlisted-extra',
          containerPath: m.containerPath,
          bundle: add(m.hostPath),
          file: isFile,
        };
      return {
        kind: 'slot',
        class: 'allowlisted-extra',
        containerPath: m.containerPath,
        mode: m.mode,
        ...(m.exclude && m.exclude.length ? { exclude: [...m.exclude] } : {}),
        ...(m.propose ? { propose: true } : {}),
      };
    default:
      throw specInvalid(`unknown mount class ${String((m as MountSpec).class)}`);
  }
}

/** Frames carry at most this much base64 per chunk; the runner socket caps inbound frames at 256 KiB. */
export const BUNDLE_CHUNK_BYTES = 160 * 1024;

export function chunkBundle(b: Bundle): Array<{ hash: string; seq: number; total: number; data: string }> {
  const b64 = b.bytes.toString('base64');
  const total = Math.max(1, Math.ceil(b64.length / BUNDLE_CHUNK_BYTES));
  const out = [];
  for (let i = 0; i < total; i++)
    out.push({ hash: b.hash, seq: i, total, data: b64.slice(i * BUNDLE_CHUNK_BYTES, (i + 1) * BUNDLE_CHUNK_BYTES) });
  return out;
}
