// The runner agent: serves central's requests (have / bundle / prepare / start /
// status / stop / list) against the laptop's Docker, and pushes session events
// and heartbeats back. No vscode imports — the extension wires settings and
// storage paths in; tests drive it with a fake Cli.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BundleStore } from './bundles.js';
import { classifyDockerError, type Cli } from './docker.js';
import { createArgs, hostPathFor, statePhase, type ResolvedMount, type Runtime } from './realize.js';
import { REQUEUE_SCRIPT, lastJsonLine } from './mailbox.js';
import {
  ensureProposalClone,
  recordWorkspace,
  recoverProposal,
  resolveWorkspace,
  workspaceRecords,
  type Proposal,
} from './git-changes.js';
import { DEFAULT_WORKSPACE_EXCLUDES, findExcluded } from './policy.js';
import { CONTAINER_RELAY_URL, RELAY_NO_DAEMON_EXIT, SessionRelay } from './relay.js';
import { LABELS, LOCK_LABEL, REMOTE_SPEC_VERSION, type RemoteSpec, type SessionKey } from './remote-spec.js';

export interface AgentPolicy {
  /** containerPath → local directory the developer bound to that slot. */
  slots: Record<string, string>;
  /** Slot targets must resolve (symlinks followed) under one of these. */
  allowlist: string[];
  /** Secret-like paths hidden inside every slot (this machine's list; central's per-slot list is added). */
  excludes?: readonly string[];
}
/**
 * Where the agent image comes from on THIS machine. Central names the image a
 * session runs under; this says how the machine obtains those bytes — build
 * locally from the context central ships, or pull a published/mirrored image
 * and retag it to that name. A pulled image is checked against the lock hash
 * central expects before it is used, so "pull" cannot silently substitute a
 * different runtime.
 */
export interface ImagePolicy {
  source: 'build' | 'pull';
  /** Overrides central's pin — a corporate mirror, or any ref this machine can pull. */
  ref: string;
  /** Accept an image with no lock label (a `save`/`load` or third-party image). */
  allowUnlabeled: boolean;
}

/**
 * Central governs the bytes its agents run. When the install states a policy,
 * it overrides this machine's preference AND its reference wins, so every
 * paired machine realizes the same image. With no policy stated, the machine
 * decides and its own reference wins, falling back to central's pin.
 */
export function effectiveImagePolicy(local: ImagePolicy, spec: RemoteSpec): ImagePolicy & { governed: boolean } {
  const central = spec.imagePolicy;
  if (central === 'pull' || central === 'build') {
    return { source: central, ref: spec.imageRef ?? local.ref, allowUnlabeled: local.allowUnlabeled, governed: true };
  }
  return { ...local, governed: false };
}

export interface AgentDeps {
  cli: Cli;
  /** docker or podman: same verbs, different user-namespace details. */
  runtime: Runtime;
  /** The laptop user the runtime runs as; undefined on Windows. */
  localUser?: { uid: number; gid: number };
  storageRoot: string; // <globalStorage>/runner
  policy: () => AgentPolicy;
  /** Defaults to building, which is what every machine can do without a registry. */
  imagePolicy?: () => ImagePolicy;
  /** Push a frame to central (events, heartbeats, relay traffic, log lines). */
  send: (frame: Record<string, unknown>) => void;
  log: (line: string) => void;
  platform?: NodeJS.Platform;
  heartbeatMs?: number;
  /** A proposal clone became known (prepared, or recovered after a reload): the chat panel should re-read it. */
  proposalChanged?: () => void;
}

export class RefusedError extends Error {
  constructor(
    readonly failure: { kind: string; retryable: boolean; detail?: string },
    message = `${failure.kind}: ${failure.detail ?? ''}`,
  ) {
    super(message);
    this.name = 'RefusedError';
  }
}

interface Live {
  key: SessionKey;
  name: string;
  workspaceDir: string | null;
  wait: { kill: () => void } | null;
  /** Supervision drops in quick succession while the container lived. */
  reattaches: number;
  /** When the current supervision channel was opened — a channel that held a while resets the count. */
  attachedAt?: number;
  /** Consecutive re-attach attempts the runtime did not answer; drives the backoff, never the verdict. */
  unreachable?: number;
  /** Stale 'processing' claims were re-queued for this container's life. */
  requeued?: boolean;
}

/**
 * States that mean "this container exists and is (about to be) running".
 * Podman passes through 'initialized' / 'configured' for a moment right after
 * a start; reading those as gone made the relay give up on a freshly created
 * container for good — the agent then had no route to a model or its mailbox.
 */
const ALIVE_STATES = new Set(['running', 'created', 'paused', 'configured', 'initialized', 'restarting']);

/** A container whose supervision keeps dropping is reported terminal rather than re-attached forever. */
const MAX_REATTACHES = 50;
/** A supervision channel that held this long was a normal drop, not part of a failing streak. */
const REATTACH_HEALTHY_MS = 60_000;
/** While the runtime is not answering, re-attach attempts back off to this. */
const UNREACHABLE_RETRY_MAX_MS = 60_000;
/** Editor config inside a directly mounted folder, kept read-only to the agent. */
const EDITOR_CONFIG_DIRS = ['.vscode', '.devcontainer'];

export class RunnerAgent {
  readonly bundles: BundleStore;
  private readonly live = new Map<string, Live>();
  /**
   * In-flight work keyed by what it produces. An image build takes minutes
   * while central retries a pending session every ~60s, and two sessions of
   * one group both need the same image — without this, concurrent builds race
   * on the same layer cache and image name, which destabilises the runtime
   * rather than just wasting a laptop's CPU.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** One relay per session, keyed by container name: a stream must be attributable to one agent. */
  private readonly relays = new Map<string, SessionRelay>();
  private ticker: NodeJS.Timeout | null = null;
  /** Last runtime reachability reported to central; true until something says otherwise. */
  private runtimeReachable = true;
  private runtimeDetail = '';
  /** Proposal clones bound for sessions in propose mode, by session key. */
  private readonly proposals = new Map<string, Proposal>();
  constructor(private readonly d: AgentDeps) {
    this.bundles = new BundleStore(path.join(d.storageRoot, 'bundles'));
  }

  proposalDir(key: SessionKey): string {
    const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.d.storageRoot, 'proposals', safe(key.agentGroupId), safe(key.sessionId));
  }

  /** The proposal a chat panel should review: the most recently bound one. */
  currentProposal(): Proposal | null {
    const all = [...this.proposals.values()];
    return all.length ? all[all.length - 1] : null;
  }

  stateDir(stateId: string): string {
    const rel = stateId.split('/').filter((p) => p && p !== '.' && p !== '..');
    if (rel.length === 0)
      throw new RefusedError({ kind: 'spec-invalid', retryable: false, detail: `bad stateId ${stateId}` });
    return path.join(this.d.storageRoot, 'state', ...rel);
  }

  /** A container's mounts as destination → host source. */
  private async inspectMounts(name: string): Promise<Map<string, string>> {
    const out = await this.d.cli.run([
      'inspect',
      '--format',
      '{{range .Mounts}}{{.Destination}}\t{{.Source}}{{"\\n"}}{{end}}',
      name,
    ]);
    const mounts = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const [dest, src] = line.split('\t');
      if (dest?.trim()) mounts.set(dest.trim(), (src ?? '').trim());
    }
    return mounts;
  }

  /** The host directory bound at /workspace, read back from a running container. */
  private async workspaceDirOf(name: string): Promise<string | null> {
    try {
      return (await this.inspectMounts(name)).get('/workspace') || null;
    } catch {
      /* the runtime may be unreachable; the heartbeat simply stays quiet until the next start */
      return null;
    }
  }

  /** Re-queue rows a dead container left claimed, using a throwaway container over the same state dir (no running agent to race). */
  private async requeueStaleClaims(name: string, workspaceDir: string): Promise<void> {
    try {
      const image = (await this.d.cli.run(['inspect', '--format', '{{.Config.Image}}', name])).trim();
      if (!image) return;
      const host = hostPathFor(workspaceDir, {
        runtime: this.d.runtime,
        platform: this.d.platform ?? process.platform,
      });
      const out = await this.d.cli.run(
        [
          'run',
          '--rm',
          '--network',
          'none',
          ...(this.d.runtime === 'podman' ? ['--userns', 'keep-id'] : []),
          '-v',
          `${host}:/workspace`,
          '--entrypoint',
          'bun',
          image,
          '-e',
          REQUEUE_SCRIPT,
        ],
        { timeoutMs: 60_000 },
      );
      const n = Number((JSON.parse(lastJsonLine(out)) as { requeued?: number }).requeued ?? 0);
      if (n > 0) this.d.log(`${name}: re-queued ${n} message(s) a previous container left in progress`);
    } catch (err) {
      // Not fatal: the agent still starts; the rows stay stuck until the next fresh start.
      this.d.log(`${name}: could not re-queue stale claims: ${String((err as Error).message).slice(0, 160)}`);
    }
  }

  /** An empty directory / empty file this runner owns, mounted read-only over paths the agent must not see. */
  private emptySource(kind: 'dir' | 'file'): string {
    const base = path.join(this.d.storageRoot, 'empty');
    fs.mkdirSync(base, { recursive: true });
    const p = path.join(base, kind === 'dir' ? 'dir' : 'file');
    if (kind === 'dir') fs.mkdirSync(p, { recursive: true });
    else if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    return p;
  }

  /**
   * An empty read-only source for `<dir>/<name>`. The mountpoint is made here,
   * as the developer, so the runtime does not leave a root-owned one behind.
   */
  private emptyMountpoint(dir: string, name: string): string {
    try {
      fs.mkdirSync(path.join(dir, name));
    } catch {
      /* the runtime makes it */
    }
    return this.emptySource('dir');
  }

  /**
   * `<real>/<name>` read-only in the container. `.vscode` is created when
   * missing so the agent cannot plant one; `.devcontainer` is covered only
   * when present. A symlink is refused: the editor would follow it to a path
   * the agent may be able to write.
   */
  private editorConfigMount(real: string, containerPath: string, name: string): ResolvedMount | null {
    const host = path.join(real, name);
    let st = lstatOrNull(host);
    if (!st && name === '.vscode') {
      const empty = this.emptyMountpoint(real, name);
      st = lstatOrNull(host);
      if (!st) return { hostPath: empty, containerPath: `${containerPath}/${name}`, mode: 'ro' };
    }
    if (!st) return null;
    if (st.isSymbolicLink())
      throw new RefusedError({
        kind: 'denied-by-policy',
        retryable: false,
        detail: `slot ${containerPath}: ${host} is a symbolic link; replace it with a directory`,
      });
    return { hostPath: host, containerPath: `${containerPath}/${name}`, mode: 'ro' };
  }

  /** Dispatch one request; returns the result fields or throws (RefusedError → structured failure). */
  async handle(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (op) {
      case 'have':
        return { missing: this.bundles.missing(Array.isArray(payload.hashes) ? (payload.hashes as string[]) : []) };
      case 'bundle': {
        const complete = this.bundles.accept(payload as { hash: string; seq: number; total: number; data: string });
        return { complete };
      }
      case 'prepare':
        return this.prepare(payload.spec as RemoteSpec);
      case 'start':
        return this.start(String(payload.name), payload.key as SessionKey | undefined, payload.resume === true);
      case 'status':
        return this.status(String(payload.name));
      case 'stop':
        return this.stop(String(payload.name), String(payload.reason ?? ''));
      case 'list':
        return this.list(String(payload.installSlug ?? ''));
      case 'logs':
        return this.logs(String(payload.name), Number(payload.tail) || 100);
      default:
        throw new RefusedError({ kind: 'unknown', retryable: false, detail: `unknown op ${op}` });
    }
  }

  /** Run `fn` once per key; concurrent callers join the first one's result. */
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      this.d.log(`${key} is already in progress; joining it instead of starting a second`);
      return existing;
    }
    const p = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async prepare(spec: RemoteSpec): Promise<Record<string, unknown>> {
    if (!spec || spec.v !== REMOTE_SPEC_VERSION)
      throw new RefusedError({
        kind: 'spec-invalid',
        retryable: false,
        detail: `remote spec v${spec?.v} not supported (runner speaks v${REMOTE_SPEC_VERSION})`,
      });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(spec.name))
      throw new RefusedError({ kind: 'spec-invalid', retryable: false, detail: 'bad container name' });
    // Resolve first: the adoption check needs to know what we WOULD bind, not
    // just which paths the container has. (Switching a slot to propose mode
    // changes the source from the developer's tree to a clone; a container
    // bound to the old source has to go, or the agent keeps editing the tree.)
    const mounts = await this.resolveMounts(spec);
    // Idempotent on key: an existing container for this session is the answer.
    const existing = await this.inspectLabels(spec.name);
    if (existing) {
      if (
        existing.install === spec.key.installSlug &&
        existing.group === spec.key.agentGroupId &&
        existing.session === spec.key.sessionId
      ) {
        // Adoption. The container's proxy points at the port chosen when it was
        // created, so the relay must come back on THAT port — a fresh one would
        // leave a running agent talking to nothing. If it cannot be rebound
        // (another process took it), the container is unreachable by
        // construction and is replaced rather than left mute.
        const match = await this.matchesThisRunner(spec.name, mounts);
        if (match.ok) {
          this.remember(spec);
          // The forwarder was OUR exec; a reload killed it while the container
          // kept running. Adoption must put it back or the agent is mute.
          if ((await this.liveness(spec.name)) === 'alive') void this.keepRelayAttached(spec.name, spec.key);
          return { name: spec.name, reused: true };
        }
        // Created by an older build (proxy on the host, or a network of its own).
        // Replace it rather than adopt it: the rules are the machine's to enforce.
        this.d.log(`${spec.name} ${match.why}; recreating it under this runner's rules`);
        this.relays.get(spec.name)?.close();
        this.relays.delete(spec.name);
        this.live.delete(spec.name);
        await this.d.cli.run(['rm', '--force', spec.name]).catch(() => {});
      } else {
        throw new RefusedError({
          kind: 'unknown',
          retryable: false,
          detail: `container name collision on ${spec.name}`,
        });
      }
    }
    await this.once(`image ${spec.image}`, () => this.ensureImage(spec));
    const args = createArgs(spec, mounts, {
      runtime: this.d.runtime,
      platform: this.d.platform ?? process.platform,
      relayUrl: CONTAINER_RELAY_URL,
      localUser: this.d.localUser,
    });
    try {
      await this.d.cli.run(args, { timeoutMs: 60_000 });
    } catch (err) {
      await this.d.cli.run(['rm', '--force', spec.name]).catch(() => {});
      throw new RefusedError(classifyDockerError((err as Error).message));
    }
    this.remember(spec);
    this.d.log(
      `prepared ${spec.name} for ${spec.key.agentGroupId}/${spec.key.sessionId} (${mounts.length} mounts, ${this.d.runtime})`,
    );
    return { name: spec.name };
  }

  /**
   * Is this container one THIS runner build would have made: proxy on the
   * in-container relay, and no network of its own? Anything else predates a
   * rule the machine now enforces and is replaced rather than adopted.
   */
  private async matchesThisRunner(
    name: string,
    want: readonly ResolvedMount[] = [],
  ): Promise<{ ok: true } | { ok: false; why: string }> {
    try {
      const out = await this.d.cli.run([
        'inspect',
        '--format',
        '{{json .Config.Env}}|{{.HostConfig.NetworkMode}}',
        name,
      ]);
      const sep = out.lastIndexOf('|');
      const env = JSON.parse(out.slice(0, sep).trim()) as string[];
      const network = out.slice(sep + 1).trim();
      const proxy = env.find((e) => /^HTTPS_PROXY=/i.test(e));
      if (!proxy || proxy.slice(proxy.indexOf('=') + 1) !== CONTAINER_RELAY_URL)
        return { ok: false, why: 'predates the in-container relay' };
      if (network !== 'none') return { ok: false, why: `still has a network (${network || 'default'})` };
      if (want.length > 0) {
        // A mount cannot be added to, or repointed on, a running container: if
        // what it has is not what we would bind now, it needs a fresh one.
        const have = await this.inspectMounts(name);
        const missing = want.filter((m) => !have.has(m.containerPath)).map((m) => m.containerPath);
        if (missing.length > 0) return { ok: false, why: `lacks a mount central now declares (${missing.join(', ')})` };
        const moved = want.filter((m) => {
          const src = have.get(m.containerPath)!;
          return (
            src &&
            hostPathFor(m.hostPath, { runtime: this.d.runtime, platform: this.d.platform ?? process.platform }) !== src
          );
        });
        if (moved.length > 0) {
          return {
            ok: false,
            why: `is bound to a different source for ${moved.map((m) => m.containerPath).join(', ')}`,
          };
        }
      }
      return { ok: true };
    } catch (err) {
      if (isNoSuchContainer(err)) return { ok: false, why: 'is gone' };
      throw cannotInspect(name, err);
    }
  }

  /** The session's relay, attached to its container once that container is running. */
  private relayFor(spec: { name: string; key: SessionKey }): SessionRelay {
    let relay = this.relays.get(spec.name);
    if (!relay) {
      relay = new SessionRelay(spec.key, { send: (frame) => this.d.send(frame), log: (l) => this.d.log(l) });
      this.relays.set(spec.name, relay);
    }
    return relay;
  }

  /** Frames central pushes for a relay stream. Returns true when one of ours took it. */
  handleFrame(frame: Record<string, unknown>): boolean {
    for (const relay of this.relays.values()) if (relay.handleFrame(frame)) return true;
    return false;
  }

  private remember(spec: RemoteSpec): void {
    const ws = spec.mounts.find((m) => m.kind === 'state' && m.containerPath === '/workspace');
    this.live.set(spec.name, {
      key: spec.key,
      name: spec.name,
      workspaceDir: ws && ws.kind === 'state' ? this.stateDir(ws.stateId) : null,
      wait: this.live.get(spec.name)?.wait ?? null,
      reattaches: this.live.get(spec.name)?.reattaches ?? 0,
    });
  }

  private async inspectLabels(name: string): Promise<{ install: string; group: string; session: string } | null> {
    try {
      const out = await this.d.cli.run([
        'inspect',
        '--format',
        `{{index .Config.Labels "${LABELS.install}"}}|{{index .Config.Labels "${LABELS.group}"}}|{{index .Config.Labels "${LABELS.session}"}}`,
        name,
      ]);
      const [install, group, session] = out.trim().split('|');
      return { install, group, session };
    } catch (err) {
      if (isNoSuchContainer(err)) return null;
      this.noteRuntime(false, String((err as Error)?.message ?? err));
      // The runtime itself did not answer. That says nothing about the
      // container — and acting as if it were absent led to removing a live
      // one. Central retries; the container keeps working meanwhile.
      throw cannotInspect(name, err);
    }
  }

  private async ensureImage(spec: RemoteSpec): Promise<void> {
    try {
      await this.d.cli.run(['image', 'inspect', '--format', '{{.Id}}', spec.image]);
      return;
    } catch {
      /* not present */
    }
    const local = this.d.imagePolicy?.() ?? { source: 'build' as const, ref: '', allowUnlabeled: false };
    const image = effectiveImagePolicy(local, spec);
    if (image.governed && image.source !== local.source) {
      this.d.log(
        `central requires the agent image to be ${image.source === 'pull' ? 'pulled' : 'built here'}; this machine's setting (${local.source}) is overridden`,
      );
    }
    if (image.source === 'pull') {
      // Deliberately no build fallback: an operator who chose a published image
      // would otherwise get locally built bytes while believing they run the
      // vendor's. Failing retryably keeps the session pending instead.
      await this.pullImage(spec, image);
      return;
    }
    if (!spec.build)
      throw new RefusedError({
        kind: 'image-unavailable',
        retryable: true,
        detail: `${spec.image} is not on this machine and central sent no build context`,
      });
    if (!this.bundles.has(spec.build.bundle))
      throw new RefusedError({ kind: 'image-unavailable', retryable: true, detail: 'build context bundle missing' });
    const ctx = this.bundles.treePath(spec.build.bundle, false);
    const args = ['build', '-t', spec.image];
    for (const [k, v] of Object.entries(spec.build.args ?? {})) args.push('--build-arg', `${k}=${v}`);
    args.push(ctx);
    this.d.log(
      `building ${spec.image} from central's build context (first use on this machine; this takes a few minutes)`,
    );
    const { code, tail } = await this.runStreaming(args, 'build', 30, 14 * 60 * 1000);
    if (code !== 0) {
      throw new RefusedError({
        kind: 'image-unavailable',
        retryable: true,
        detail: `${this.d.runtime} build exited ${code}: ${tail.slice(-8).join(' | ').slice(0, 700) || '(no output captured)'}`,
      });
    }
    this.d.log(`built ${spec.image}`);
  }

  /**
   * Run a long runtime command, logging each line under `label` and keeping a
   * bounded tail: a build or pull that fails on a laptop is invisible to
   * central otherwise, and "exited 1" is not a diagnosis.
   */
  private async runStreaming(
    args: string[],
    label: string,
    keep: number,
    timeoutMs: number,
  ): Promise<{ code: number | null; tail: string[] }> {
    const tail: string[] = [];
    const proc = this.d.cli.start(args, (line) => {
      this.d.log(`${label}: ${line.slice(0, 160)}`);
      tail.push(line.slice(0, 200));
      if (tail.length > keep) tail.shift();
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const code = await proc.done;
    clearTimeout(timer);
    return { code, tail };
  }

  /** Pull a published image and retag it to the name central named, after checking it is the right runtime. */
  private async pullImage(spec: RemoteSpec, image: ImagePolicy): Promise<void> {
    const ref = image.ref || spec.imageRef;
    if (!ref) {
      throw new RefusedError({
        kind: 'image-unavailable',
        retryable: true,
        detail: 'agent image source is "pull" but no reference is set (nanoclaw.agentImageRef) and central pins none',
      });
    }
    this.d.log(`pulling ${ref} with ${this.d.runtime} (first use on this machine is a large download)`);
    const { code, tail } = await this.runStreaming(['pull', ref], 'pull', 10, 30 * 60 * 1000);
    if (code !== 0) {
      throw new RefusedError({
        kind: 'image-unavailable',
        retryable: true,
        detail: `${this.d.runtime} pull exited ${code} for ${ref} (is this machine logged in to that registry?): ${tail.slice(-4).join(' | ').slice(0, 400)}`,
      });
    }
    const label = await this.imageLabel(ref, LOCK_LABEL);
    const expected = spec.build?.lockSha;
    if (!label && !image.allowUnlabeled) {
      throw new RefusedError({
        kind: 'denied-by-policy',
        retryable: false,
        detail: `${ref} carries no ${LOCK_LABEL} label, so the runtime it bakes cannot be checked (set nanoclaw.allowUnlabeledAgentImage to accept it anyway)`,
      });
    }
    if (label && expected && label !== expected) {
      throw new RefusedError({
        kind: 'denied-by-policy',
        retryable: false,
        detail: `${ref} bakes agent-runner ${label.slice(0, 12)}… but central expects ${expected.slice(0, 12)}… — the published image is for a different checkout`,
      });
    }
    if (!expected)
      this.d.log('central sent no expected agent-runner lock; the pulled image was not verified against it');
    await this.d.cli.run(['tag', ref, spec.image]);
    this.d.log(`pulled and tagged as ${spec.image}${label ? ` (agent-runner ${label.slice(0, 12)}…)` : ''}`);
  }

  private async imageLabel(ref: string, key: string): Promise<string> {
    try {
      const out = await this.d.cli.run(['image', 'inspect', '--format', `{{index .Config.Labels "${key}"}}`, ref]);
      const v = out.trim();
      // Both runtimes print a placeholder for a missing key rather than failing.
      return v === '<no value>' || v === 'null' ? '' : v;
    } catch {
      return '';
    }
  }

  async resolveMounts(spec: RemoteSpec): Promise<ResolvedMount[]> {
    const policy = this.d.policy();
    const out: ResolvedMount[] = [];
    for (const m of spec.mounts) {
      switch (m.kind) {
        case 'content': {
          if (!this.bundles.has(m.bundle))
            throw new RefusedError({
              kind: 'spec-invalid',
              retryable: false,
              detail: `bundle for ${m.containerPath} was not shipped`,
            });
          out.push({ hostPath: this.bundles.treePath(m.bundle, m.file), containerPath: m.containerPath, mode: 'ro' });
          break;
        }
        case 'state': {
          const dir = this.stateDir(m.stateId);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            if (m.seed && this.bundles.has(m.seed)) this.bundles.seedInto(m.seed, dir);
          }
          out.push({ hostPath: dir, containerPath: m.containerPath, mode: 'rw' });
          break;
        }
        case 'slot': {
          const bound = policy.slots[m.containerPath];
          if (!bound) {
            throw new RefusedError({
              kind: 'denied-by-policy',
              retryable: false,
              detail: `slot ${m.containerPath} is not bound on this machine (set nanoclaw.slots)`,
            });
          }
          const real = safeRealpath(bound);
          if (!real || !fs.statSync(real).isDirectory())
            throw new RefusedError({
              kind: 'denied-by-policy',
              retryable: false,
              detail: `slot ${m.containerPath}: ${bound} is not a directory`,
            });
          const allowed = policy.allowlist.map(safeRealpath).filter((x): x is string => !!x);
          if (!allowed.some((root) => real === root || real.startsWith(root + path.sep))) {
            throw new RefusedError({
              kind: 'denied-by-policy',
              retryable: false,
              detail: `slot ${m.containerPath}: ${real} is outside the mount allowlist`,
            });
          }
          let bindPath = real;
          // The git dir the host's git will read, mounted read-only over the
          // writable tree: an agent that could write it could name commands
          // for the developer's git to run. Where the folder has none, an empty
          // read-only one, so the agent cannot make one either.
          let gitDir: string | null = null;
          const editorMounts: ResolvedMount[] = [];
          if (m.propose) {
            // Propose mode: the agent edits a self-contained clone at the
            // developer's current commit; the developer applies from the editor.
            const dir = this.proposalDir(spec.key);
            try {
              const proposal = await ensureProposalClone(real, dir);
              this.proposals.set(keyOf(spec.key), proposal);
              this.d.proposalChanged?.();
              bindPath = dir;
              gitDir = proposal.gitDir;
              this.d.log(
                `slot ${m.containerPath} ← proposal copy of ${real} at ${proposal.base.slice(0, 10)} (${m.mode})`,
              );
            } catch (err) {
              throw new RefusedError({
                kind: 'denied-by-policy',
                retryable: false,
                detail: `slot ${m.containerPath}: propose mode needs a git repository at ${real}: ${String((err as Error).message).slice(0, 160)}`,
              });
            }
          } else {
            this.proposals.delete(keyOf(spec.key));
            // Settle which repository the folder is in now, before a container
            // can write it; the host's git calls for it use only this one.
            const ws = await resolveWorkspace(real);
            recordWorkspace(workspaceRecords(this.d.storageRoot), ws);
            gitDir =
              ws.repo?.workTree === real && fs.existsSync(path.join(real, '.git'))
                ? path.join(real, '.git')
                : this.emptyMountpoint(real, '.git');
            // VS Code applies what these hold (settings, tasks, dev container
            // commands) on the developer's machine: read-only to the agent.
            for (const name of EDITOR_CONFIG_DIRS) {
              const mount = this.editorConfigMount(real, m.containerPath, name);
              if (mount) editorMounts.push(mount);
            }
            this.d.log(`slot ${m.containerPath} ← ${real} (${m.mode})`);
          }
          out.push({ hostPath: bindPath, containerPath: m.containerPath, mode: m.mode });
          if (gitDir) out.push({ hostPath: gitDir, containerPath: `${m.containerPath}/.git`, mode: 'ro' });
          out.push(...editorMounts);
          // Hide secret-like paths: an empty read-only mount on top of each match.
          // The union of central's list and this machine's applies; neither side
          // can remove the other's. Only paths that exist now are covered — a
          // container gets its mounts at creation, so a secret created later is
          // hidden from the next spawn on.
          const patterns = [...new Set([...(policy.excludes ?? DEFAULT_WORKSPACE_EXCLUDES), ...(m.exclude ?? [])])];
          const { excluded, truncated } = findExcluded(bindPath, patterns, fs);
          if (truncated) {
            throw new RefusedError({
              kind: 'denied-by-policy',
              retryable: false,
              detail: `slot ${m.containerPath}: too many secret-like paths to hide (${excluded.length}+) — exclude a directory instead of many files, or narrow nanoclaw.workspaceExcludes`,
            });
          }
          // `-v host:ctr:ro` has no quoting: a ':' in the name would split the
          // argument and fail the create. Such a path cannot be overlaid.
          const hidden = excluded.filter((x) => !x.rel.includes(':'));
          if (hidden.length < excluded.length) {
            const skipped = excluded.filter((x) => x.rel.includes(':'));
            this.d.log(
              `cannot hide ${skipped.length} secret-like path(s) under ${m.containerPath} whose name contains ':' — rename them: ${skipped
                .slice(0, 6)
                .map((x) => x.rel)
                .join(', ')}`,
            );
          }
          for (const x of hidden) {
            out.push({ hostPath: this.emptySource(x.kind), containerPath: `${m.containerPath}/${x.rel}`, mode: 'ro' });
          }
          if (hidden.length > 0) {
            const shown = hidden
              .slice(0, 6)
              .map((x) => x.rel + (x.kind === 'dir' ? '/' : ''))
              .join(', ');
            this.d.log(
              `hiding ${hidden.length} secret-like path(s) under ${m.containerPath}: ${shown}${hidden.length > 6 ? ', …' : ''}`,
            );
          }
          break;
        }
        default:
          throw new RefusedError({
            kind: 'spec-invalid',
            retryable: false,
            detail: `unknown mount kind ${(m as { kind: string }).kind}`,
          });
      }
    }
    return out;
  }

  /**
   * `resume` is central re-asserting a session it already had running (the
   * machine came back, or the extension host restarted). It attaches to a
   * container that is still running and never revives one that is not: a
   * container that died while nobody watched is over, and central respawns a
   * fresh one rather than restarting a corpse whose mailbox token it revoked.
   */
  private async start(name: string, key?: SessionKey, resume = false): Promise<Record<string, unknown>> {
    let entry = this.live.get(name);
    if (entry?.wait) {
      // Already supervised; the relay is a separate concern and may still be missing.
      void this.keepRelayAttached(name, entry.key);
      return {};
    }
    if (resume) {
      const l = await this.liveness(name);
      if (l === 'unknown') {
        throw cannotInspect(name, this.runtimeDetail);
      }
      if (l === 'gone') {
        if (entry) this.ended(name, entry, 'it stopped while it was not supervised');
        await this.d.cli.run(['rm', '--force', name]).catch(() => {});
        throw new RefusedError({
          kind: 'unknown',
          retryable: false,
          detail: `no container ${name} (it stopped while the machine was away)`,
        });
      }
    }
    if (!entry) {
      const labels = await this.inspectLabels(name);
      if (!labels) throw new RefusedError({ kind: 'unknown', retryable: false, detail: `no container ${name}` });
      entry = {
        key: key ?? { installSlug: labels.install, agentGroupId: labels.group, sessionId: labels.session },
        name,
        // Recovered from the container itself: an extension host that restarted
        // has no memory of the spec, and without this the heartbeat mirror had
        // nothing to stat, so central saw a live agent as silent and reaped it
        // on the idle ceiling.
        workspaceDir: await this.workspaceDirOf(name),
        wait: null,
        reattaches: 0,
      };
      this.live.set(name, entry);
      // Re-attached without a prepare (a reload): the session's proposal clone,
      // if it has one, is only known from disk. Without this the panel showed
      // the developer's own tree and nothing the agent had proposed.
      if (!this.proposals.has(keyOf(entry.key))) {
        const proposal = await recoverProposal(this.proposalDir(entry.key));
        if (proposal) {
          this.proposals.set(keyOf(entry.key), proposal);
          this.d.log(`${name}: re-attached; proposal copy of ${proposal.repoRoot} at ${proposal.base.slice(0, 10)}`);
          this.d.proposalChanged?.();
        }
      }
    }
    // A container that died mid-turn leaves its claims in the laptop's mailbox
    // as 'processing'. Central's host sweep re-queues those for local sessions;
    // nothing does it here — so a fresh start does, before the agent runs and
    // could claim anything new (no race: the container is not running yet).
    if (entry.workspaceDir && !entry.requeued) {
      entry.requeued = true;
      await this.requeueStaleClaims(name, entry.workspaceDir);
    }
    this.attach(name, entry);
    this.d.send({ type: 'event', key: entry.key, kind: 'phase' });
    this.armTicker();
    void this.keepRelayAttached(name, entry.key);
    return {};
  }

  /**
   * `start --attach` is the supervision channel, exactly as the docker driver
   * uses it: it exits with the CONTAINER's exit code and streams the stderr
   * that explains a boot failure. `podman wait` cannot — the container is
   * created with --rm, so the corpse is gone before it can be asked, which is
   * why a crash at boot read as a bare 'wait rc 125'.
   */
  private attach(name: string, live: Live): void {
    const tail: string[] = [];
    const proc = this.d.cli.start(['start', '--attach', name], (line) => {
      tail.push(line.slice(0, 200));
      if (tail.length > 12) tail.shift();
    });
    live.wait = proc;
    live.attachedAt = Date.now();
    void proc.done.then((code) => {
      if (this.live.get(name)?.wait !== proc) return;
      live.wait = null;
      void this.afterDrop(name, live, code, tail);
    });
  }

  /**
   * The supervision channel dying is NOT proof the container died: podman's
   * client connection to its machine drops on its own, and treating that as
   * death told central the session was over while the agent was still
   * working — then stopped its heartbeats, so central killed it at the
   * 30-minute ceiling. Verify against the runtime before reporting, and
   * re-verify on every retry: re-attaching blindly with `start` would revive
   * a container that exited while the runtime was away.
   */
  private async afterDrop(name: string, live: Live, code: number | null, tail: string[]): Promise<void> {
    const l = await this.liveness(name);
    // Stopped, disposed, or re-attached by someone else (central's resume) meanwhile.
    if (this.live.get(name) !== live || live.wait) return;
    if (l === 'unknown') {
      // The runtime itself is not answering: the laptop slept and podman's
      // machine did not come back, or Docker Desktop is restarting. That is
      // no verdict on the container and no strike against it — central holds
      // the session meanwhile. Keep asking, backing off to one try a minute,
      // for as long as the session is wanted; say so once, not every try.
      live.unreachable = (live.unreachable ?? 0) + 1;
      if (live.unreachable === 1) {
        this.d.log(
          `${name}: supervision channel dropped (rc ${code}) and the container runtime is not answering — holding the session, re-attaching when it answers`,
        );
      }
      setTimeout(
        () => void this.afterDrop(name, live, code, tail),
        Math.min(5000 * 2 ** (live.unreachable - 1), UNREACHABLE_RETRY_MAX_MS),
      );
      return;
    }
    if (live.unreachable) {
      this.d.log(
        `${name}: the container runtime answers again after ${live.unreachable} attempt(s) — the container is ${l === 'alive' ? 'still running' : 'gone'}`,
      );
      live.unreachable = 0;
    }
    // Podman drops its client connection every few minutes on its own; only
    // drops in quick succession count toward giving up.
    if (live.attachedAt !== undefined && Date.now() - live.attachedAt >= REATTACH_HEALTHY_MS) live.reattaches = 0;
    if (l === 'alive' && live.reattaches < MAX_REATTACHES) {
      live.reattaches += 1;
      this.d.log(`${name}: supervision channel dropped (rc ${code}) but the container is still running — re-attaching`);
      this.attach(name, live);
      void this.keepRelayAttached(name, live.key);
      return;
    }
    const alive = l === 'alive';
    this.d.log(
      code === 0
        ? `${name} exited cleanly`
        : `${name} exited ${code ?? 'abnormally'}${tail.length ? `: ${tail.slice(-8).join(' | ')}` : ' with no output'}${alive ? ' (still running, but re-attached too many times)' : ''}`,
    );
    this.ended(name, live);
  }

  /** The container is over: forget it, tell central (terminal), and close its relay. */
  private ended(name: string, live: Live, why?: string): void {
    if (this.live.get(name) !== live) return;
    this.live.delete(name);
    if (why) this.d.log(`${name}: ${why}`);
    this.d.send({ type: 'event', key: live.key, kind: 'terminal' });
    this.relays.get(name)?.close();
    this.relays.delete(name);
  }

  /**
   * Runtime truth in three states. 'unknown' means the runtime itself could
   * not be reached (podman's connection to its machine is down) — which says
   * nothing about the container and must never be read as its death.
   */
  private async liveness(name: string): Promise<'alive' | 'gone' | 'unknown'> {
    try {
      const { state } = await this.inspectState(name);
      this.noteRuntime(true);
      return ALIVE_STATES.has(state) ? 'alive' : 'gone';
    } catch (err) {
      if (isNoSuchContainer(err)) {
        this.noteRuntime(true);
        return 'gone';
      }
      this.noteRuntime(false, String((err as Error)?.message ?? err));
      return 'unknown';
    }
  }

  /**
   * Tell central when the runtime stops or resumes answering, on the
   * transition only. A runtime that is down is the laptop's state, not any one
   * container's: central holds every session placed here until it answers
   * again. The "back" report is deferred a turn, so a terminal event for a
   * container found gone in the same breath reaches central first — and it
   * never re-asserts a session it has just been told is over.
   */
  private noteRuntime(reachable: boolean, detail = ''): void {
    if (reachable === this.runtimeReachable) return;
    this.runtimeReachable = reachable;
    this.runtimeDetail = reachable ? '' : detail.split(/\r?\n/)[0].slice(0, 200);
    this.d.log(
      reachable
        ? 'the container runtime answers again'
        : `the container runtime is not answering: ${this.runtimeDetail}`,
    );
    const frame = { type: 'runtime', reachable, ...(reachable ? {} : { detail: this.runtimeDetail }) };
    if (reachable) setTimeout(() => this.d.send(frame), 0);
    else this.d.send(frame);
  }

  /** Runtime truth, not inference: the container's state and exit code as the runtime reports them. */
  private async inspectState(name: string): Promise<{ state: string; exitCode: number }> {
    const out = await this.d.cli.run(['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', name]);
    const [state, exit] = out.trim().split('|');
    return { state, exitCode: Number(exit) || 0 };
  }

  private async status(name: string): Promise<Record<string, unknown>> {
    try {
      return await this.inspectState(name);
    } catch (err) {
      if (isNoSuchContainer(err)) return { state: 'absent' };
      // "absent" here read as stopped on central while podman's machine was
      // merely asleep. Say what is true: the runtime did not answer.
      throw cannotInspect(name, err);
    }
  }

  private async stop(name: string, reason: string): Promise<Record<string, unknown>> {
    this.d.log(`stop ${name} (${reason})`);
    try {
      await this.d.cli.run(['stop', '-t', '10', name], { timeoutMs: 60_000 });
    } catch (err) {
      const msg = (err as Error).message;
      if (!/No such container|is not running/i.test(msg)) throw new RefusedError(classifyDockerError(msg));
    }
    return {};
  }

  async list(installSlug: string): Promise<Record<string, unknown>> {
    const out = await this.d.cli.run([
      'ps',
      '-a',
      '--filter',
      `label=${LABELS.install}=${installSlug}`,
      '--filter',
      `label=${LABELS.role}=agent`,
      '--format',
      `{{.Names}}|{{.State}}|{{.Label "${LABELS.group}"}}|{{.Label "${LABELS.session}"}}`,
    ]);
    const sessions = out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, state, agentGroupId, sessionId] = line.split('|');
        return { name, state, phase: statePhase(state), key: { installSlug, agentGroupId, sessionId } };
      });
    return { sessions };
  }

  /**
   * The forwarder is an `exec` into the container, so it can only start once the
   * container is actually running — and `start --attach` returns before that.
   * Wait for the runtime to say so, then attach; if the forwarder dies while the
   * container lives, attach again (bounded), because without it the agent has
   * no route to a model and fails in silence.
   */
  private async keepRelayAttached(name: string, key: SessionKey): Promise<void> {
    // Wait for the container to reach running before attaching. A cold
    // podman/WSL start takes a while and each inspect is a slow round trip; a
    // runtime that cannot be reached at all ('unknown') is a pause, not a
    // verdict. Keep waiting while this session is still wanted, with a generous
    // ceiling for a genuine hang.
    const deadline = Date.now() + 5 * 60_000;
    let goneSeen = 0;
    for (;;) {
      if (!this.live.has(name)) return;
      const l = await this.liveness(name);
      if (l === 'alive') break;
      // One "gone" right after a start can be the runtime between states; a
      // container that is really gone is reported by supervision anyway.
      goneSeen = l === 'gone' ? goneSeen + 1 : 0;
      if (goneSeen >= 5 || Date.now() > deadline) {
        this.d.log(`${name} ${l === 'gone' ? 'is gone' : 'did not reach running within 5 min'}; relay not attached`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    const relay = this.relayFor({ name, key });
    // The pipe is expected to drop (podman's client connection does that on
    // its own); the daemon inside the container keeps the tunnels alive
    // meanwhile. So: re-attach for as long as the session is wanted, backing
    // off only when attaches fail in quick succession. A no-daemon answer
    // means start one and try again immediately.
    let failures = 0;
    let unreachable = 0;
    for (;;) {
      const exit = relay.attach(this.d.cli, name);
      if (!exit) return; // already attached elsewhere
      const code = await exit;
      if (!this.live.has(name)) return;
      const l = await this.liveness(name);
      if (l === 'gone') return; // container gone: nothing to serve
      if (code === RELAY_NO_DAEMON_EXIT) {
        try {
          await relay.startDaemon(this.d.cli, name);
          this.d.log(`started the relay daemon inside ${name}`);
          failures = 0;
          await new Promise((r) => setTimeout(r, 300));
          continue;
        } catch (err) {
          this.d.log(`${name}: could not start the relay daemon: ${String((err as Error).message).slice(0, 200)}`);
        }
      }
      // A pipe that held for a while was a normal drop; one that died at once is a failure.
      failures = relay.attachedForMs === 0 && code !== RELAY_NO_DAEMON_EXIT ? failures + 1 : 0;
      // A runtime that is not answering backs off to a try a minute, like supervision does.
      unreachable = l === 'unknown' ? unreachable + 1 : 0;
      const delay =
        l === 'unknown'
          ? Math.min(5000 * 2 ** (unreachable - 1), UNREACHABLE_RETRY_MAX_MS)
          : Math.min(1000 * 2 ** Math.min(failures, 4), 15_000);
      if (l !== 'unknown' && failures > 0 && failures % 10 === 0) {
        this.d.log(
          `${name}: relay attach has failed ${failures} times in a row — the agent cannot reach a model until it holds`,
        );
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /**
   * The container's own output. A container that is running but reporting no
   * liveness can only be explained from inside it, and an operator should not
   * have to ask the developer to run a command to see that.
   */
  private async logs(name: string, tail: number): Promise<Record<string, unknown>> {
    const n = Math.max(1, Math.min(tail, 500));
    try {
      const out = await this.d.cli.run(['logs', '--tail', String(n), name], { timeoutMs: 20_000 });
      return { lines: out.split(/\r?\n/).filter(Boolean).slice(-n) };
    } catch (err) {
      throw new RefusedError({
        kind: 'unknown',
        retryable: false,
        detail: `logs for ${name}: ${(err as Error).message.slice(0, 300)}`,
      });
    }
  }

  /** Mirror each running container's liveness file to central every heartbeatMs. */
  private armTicker(): void {
    if (this.ticker) return;
    const every = this.d.heartbeatMs ?? 20_000;
    this.ticker = setInterval(() => {
      if (this.live.size === 0) {
        clearInterval(this.ticker!);
        this.ticker = null;
        return;
      }
      for (const e of this.live.values()) {
        if (!e.workspaceDir) continue;
        // Report only what the agent actually demonstrated. Falling back to
        // "now" when the file is absent fabricates liveness the agent never
        // showed, and would stop central reaping an idle remote session on the
        // same rule it uses for a local one.
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(path.join(e.workspaceDir, '.heartbeat')).mtimeMs;
        } catch {
          continue;
        }
        this.d.send({ type: 'heartbeat', key: e.key, mtimeMs });
      }
    }, every);
    this.ticker.unref?.();
  }

  /** The link to central came (back) up: every tunnel central knew is gone; let each relay reset its daemon's. */
  centralReconnected(): void {
    for (const relay of this.relays.values()) relay.linkReconnected();
    // Central assumes a returning machine's runtime answers; correct it at once if not.
    if (!this.runtimeReachable) this.d.send({ type: 'runtime', reachable: false, detail: this.runtimeDetail });
  }

  dispose(): void {
    for (const relay of this.relays.values()) relay.close();
    this.relays.clear();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const e of this.live.values()) e.wait?.kill();
    // The re-attach loops key off `live`: clearing it is what ends them. Left
    // populated, a disposed agent kept re-attaching its relay — and fought the
    // next extension host for the daemon.
    this.live.clear();
  }
}

/** The runtime did not answer an inspect: says nothing about the container, and central retries. */
function cannotInspect(name: string, err: unknown): RefusedError {
  const detail = typeof err === 'string' ? err : String((err as Error)?.message ?? err).slice(0, 160);
  return new RefusedError({
    kind: 'runtime-unavailable',
    retryable: true,
    detail: `cannot inspect ${name}: ${detail}`,
  });
}

const keyOf = (k: SessionKey): string => `${k.installSlug}/${k.agentGroupId}/${k.sessionId}`;

/** Docker and podman phrase "that container does not exist" a few ways; everything else is the runtime failing to answer. */
export function isNoSuchContainer(err: unknown): boolean {
  return /No such (object|container)|no container with (name|ID)|no such container/i.test(
    String((err as Error)?.message ?? err),
  );
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
  } catch {
    return null;
  }
}
