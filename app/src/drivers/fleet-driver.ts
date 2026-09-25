/**
 * Fleet driver — kind `fleet`. Local sessions go to the docker driver
 * byte-for-byte; a session whose agent group is PLACED on a paired runner is
 * rewritten for transit (remote-spec.ts) and realized on that laptop over the
 * runner socket. Events the runner reports flow into the same
 * session-events hub as local docker events; heartbeats the runner mirrors
 * land in the session's central `.heartbeat` file so the host-sweep's
 * liveness rule needs no change.
 *
 * Suspension. A laptop that sleeps, or whose container runtime stops
 * answering, is not a broken session. While a session's runner is away or
 * reports its runtime unreachable, the driver HOLDS it: it keeps the mirrored
 * heartbeat fresh (so neither the idle ceiling nor the claim-stuck rule reaps
 * a session that simply cannot be seen), ignores the laptop's stale mirror,
 * and re-asserts the session when the machine returns — respawning only when
 * the runner answers that the container is genuinely gone. The hold is
 * bounded (a laptop off for a week is not holding a session); past it the
 * ordinary ceiling applies, and a stop issued while the machine is away is
 * delivered when it returns.
 *
 * Central's own restarts. The laptop's container outlives a central deploy.
 * The runner session store keeps what picking it back up needs (its mailbox
 * token, its container name, its hold, stops queued for its machine); when
 * that machine's runner reconnects, each remembered session is woken through
 * the ordinary spawn path, which re-prepares it — the runner adopts the
 * running container, since the spec (token included) is unchanged — and so
 * rejoins supervision, the relay and the mailbox without a restart of the
 * agent. A session whose hold ran out is stopped instead.
 *
 * Registered via `installed.ts` (append-only barrel). The docker factory is
 * resolved when the fleet factory RUNS — the barrel is imported before
 * index.ts registers docker.
 */
import fs from 'fs';
import path from 'path';

import { getRunnerImagePolicy, getRunnerImageRef, type RunnerImagePolicy } from '../channels/webchat/db.js';
import {
  MAILBOX_ENDPOINT_HOST,
  MAILBOX_ENDPOINT_PORT,
  issueMailboxToken,
  revokeMailboxToken,
} from '../channels/webchat/runner-mailbox-endpoint.js';
import { clearRelayTarget, registerRelayTarget } from '../channels/webchat/runner-relay.js';
import { runnerSessionStore, type RunnerSessionStore } from '../channels/webchat/runner-sessions-store.js';
import {
  WORKSPACE_SLOT,
  getMachine,
  getPlacement,
  placementSlots,
  type RunnerPlacementRow,
} from '../channels/webchat/runner-registry.js';
import {
  RunnerRequestError,
  connectedRunnerFingerprints,
  isRunnerConnected,
  onRunnerEvent,
  onRunnerAttached,
  onRunnerDetached,
  onRunnerHeartbeat,
  onRunnerRuntime,
  runnerRequest,
} from '../channels/webchat/runner-transport.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { log } from '../log.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../modules/permissions/db/user-roles.js';
import { heartbeatPath } from '../session-manager.js';

import { agentContainerName, dockerStatePhase } from './docker-driver.js';
import { getSessionDriverFactory, registerSessionDriver } from './driver-registry.js';
import { chunkBundle, toRemoteSpec, type ProxyTarget, type TransitRoots } from './remote-spec.js';
import {
  asFailureError,
  deniedByPolicy,
  specInvalid,
  validateSpec,
  type DriverCapabilities,
  type MountPolicy,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

export const FLEET_DRIVER_KIND = 'fleet';

export type PlacementLookup = (agentGroupId: string) => Promise<RunnerPlacementRow | undefined>;

/** What the remote path needs from the world — injectable so tests run without a socket or DB. */
export interface FleetRemotePort {
  request: typeof runnerRequest;
  isConnected: (fingerprint: string) => boolean;
  connected: () => string[];
  onEvent: typeof onRunnerEvent;
  onHeartbeat: typeof onRunnerHeartbeat;
  /** Optional: a runner (re)connected; the driver re-asserts the sessions it owns there. */
  onAttached?: typeof onRunnerAttached;
  /** Optional: a runner's socket closed; the driver holds the sessions it owns there. */
  onDetached?: typeof onRunnerDetached;
  /** Optional: a connected runner's container runtime went away or came back. */
  onRuntime?: typeof onRunnerRuntime;
  /** How long a suspended session is held before the ordinary ceiling applies again. */
  suspendHoldMs?: number;
  /** What survives central's restarts. */
  store?: RunnerSessionStore;
  /**
   * Wake a remembered session through central's spawn path after a restart:
   * 'ok' (it is supervised again), 'retry' (not now — e.g. the dead process's
   * claim has not lapsed), or 'gone' (the session is no longer active).
   */
  rewake?: (key: SessionKey) => Promise<'ok' | 'retry' | 'gone'>;
  /** May the machine's user run this group? (design: the bound user must be admitted to every placed group) */
  authorize: (fingerprint: string, agentGroupId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  roots: TransitRoots;
  /** Install-wide image source, read per prepare so an operator's change takes effect on the next spawn. */
  imageSource: () => Promise<{ ref?: string; policy: RunnerImagePolicy }>;
  touchHeartbeat: (key: SessionKey, mtimeMs: number) => void;
}

const PREPARE_TIMEOUT_MS = 15 * 60 * 1000; // the first prepare may build the agent image on the laptop
const RPC_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 8_000;
/** Overnight plus a margin: long enough for a closed lid, short enough that an abandoned laptop releases its sessions. */
export const DEFAULT_SUSPEND_HOLD_MS = 12 * 60 * 60 * 1000;
/** How often a held session's heartbeat is refreshed — well inside every reaping threshold. */
const HOLD_TICK_MS = 20_000;
const RESUME_RETRY_MIN_MS = 5_000;
const RESUME_RETRY_MAX_MS = 60_000;

function envHoldMs(): number {
  const n = Number(process.env.NANOCLAW_RUNNER_SUSPEND_HOLD_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SUSPEND_HOLD_MS;
}

/**
 * The prebuilt agent image this install is pinned to, if any (`versions.json`
 * `agent-image`). Central never pulls it — the flag that would make the HOST
 * pull is a separate, install-level decision — but it tells a runner what it
 * may pull, so a laptop does not have to be told the reference twice.
 */
export function publisherImageRef(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(path.dirname(DATA_DIR), 'versions.json'), 'utf8');
    const ref = (JSON.parse(raw) as Record<string, unknown>)['agent-image'];
    return typeof ref === 'string' && ref ? ref : undefined;
  } catch {
    return undefined;
  }
}

export function defaultRemotePort(): FleetRemotePort {
  return {
    request: runnerRequest,
    isConnected: isRunnerConnected,
    connected: connectedRunnerFingerprints,
    onEvent: onRunnerEvent,
    onAttached: onRunnerAttached,
    onDetached: onRunnerDetached,
    onRuntime: onRunnerRuntime,
    suspendHoldMs: envHoldMs(),
    store: runnerSessionStore(),
    async rewake(key) {
      // Imported when used: the driver is registered before the runner exists.
      const [{ getSession }, { wakeContainer }] = await Promise.all([
        import('../db/sessions.js'),
        import('../container-runner.js'),
      ]);
      const session = await getSession(key.sessionId);
      if (!session || session.status !== 'active') return 'gone';
      return (await wakeContainer(session)) ? 'ok' : 'retry';
    },
    onHeartbeat: onRunnerHeartbeat,
    async authorize(fingerprint, agentGroupId) {
      const machine = await getMachine(fingerprint);
      if (!machine) return { ok: false, reason: 'machine not found' };
      if (machine.status !== 'approved') return { ok: false, reason: `machine is ${machine.status}` };
      const u = machine.user_id;
      if ((await isOwner(u)) || (await isGlobalAdmin(u)) || (await hasAdminPrivilege(u, agentGroupId)))
        return { ok: true };
      return { ok: false, reason: `${u} is not admitted to agent group ${agentGroupId}` };
    },
    async imageSource() {
      const [ref, policy] = await Promise.all([getRunnerImageRef(), getRunnerImagePolicy()]);
      return { ...(ref ? { ref } : {}), policy };
    },
    roots: {
      dataRoot: DATA_DIR,
      groupsRoot: GROUPS_DIR,
      // DATA_DIR is <project root>/data; the build context is the sibling container/ dir.
      buildContext: path.join(path.dirname(DATA_DIR), 'container'),
      publisherImageRef: publisherImageRef(),
    },
    touchHeartbeat(key, mtimeMs) {
      const p = heartbeatPath(key.agentGroupId, key.sessionId);
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (!fs.existsSync(p)) fs.writeFileSync(p, '');
        const t = new Date(Math.min(mtimeMs, Date.now()));
        fs.utimesSync(p, t, t);
      } catch (err) {
        log.debug('Fleet driver: heartbeat mirror failed', { key, err });
      }
    },
  };
}

export class FleetSessionDriver implements SessionDriver {
  readonly kind = FLEET_DRIVER_KIND;
  readonly #subscribers = new Map<string, Set<(event: SessionEvent) => void>>();
  /** Keys this driver placed or listed on a runner — the allow-list for what a runner may report. */
  readonly #remoteKeys = new Map<string, string>();
  /** Live handles this driver realized remotely, by key — what a reconnecting runner is told to pick back up. */
  readonly #handles = new Map<string, RemoteHandle>();
  /** Machines whose runtime last reported unreachable. */
  readonly #runtimeDown = new Set<string>();
  /** Per machine: one re-assert pass at a time, a rerun flag, and the retry backoff while its runtime is down. */
  readonly #resuming = new Map<string, { running: Promise<void>; again: boolean }>();
  readonly #resumeRetry = new Map<string, { timer: NodeJS.Timeout | null; attempt: number }>();
  /** Remembered sessions being woken after a central restart, by key. */
  readonly #rejoining = new Set<string>();
  readonly #flushing = new Map<string, Promise<void>>();
  #holdTimer: NodeJS.Timeout | null = null;
  #wired = false;

  constructor(
    private readonly local: SessionDriver,
    private readonly placementFor: PlacementLookup,
    private readonly policy: MountPolicy,
    private readonly remote: FleetRemotePort = defaultRemotePort(),
  ) {}

  capabilities(): DriverCapabilities {
    return this.local.capabilities();
  }
  async ensureReady(): Promise<void> {
    await this.local.ensureReady?.();
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    const placement = await this.placementFor(spec.key.agentGroupId).catch((err: unknown) => {
      log.warn('Fleet driver: placement lookup failed - running locally', { agentGroupId: spec.key.agentGroupId, err });
      return undefined;
    });
    if (!placement) return this.local.prepare(spec);
    return this.prepareRemote(spec, placement);
  }

  async prepareRemote(spec: SessionSpec, placement: RunnerPlacementRow): Promise<SessionHandle> {
    const fp = placement.fingerprint;
    validateSpec(spec, this.policy, this.capabilities());
    const extra = spec.containers.filter((c) => c.role !== 'agent');
    if (extra.length > 0) throw specInvalid(`runners realize the agent container only; got role '${extra[0].role}'`);
    const agent = withDeclaredSlots(spec.containers.find((c) => c.role === 'agent')!, spec, placement);
    const auth = await this.remote.authorize(fp, spec.key.agentGroupId);
    if (!auth.ok) throw deniedByPolicy(`remote placement refused: ${auth.reason}`);
    if (!this.remote.isConnected(fp)) {
      throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
    }
    const name = agentContainerName(spec);
    // Read per prepare: an operator changing the install's image source must
    // take effect on the next spawn, not on the next restart of central.
    const image: { ref?: string; policy: RunnerImagePolicy } = await this.remote
      .imageSource()
      .catch(() => ({ policy: 'build' }));
    const roots: TransitRoots = {
      ...this.remote.roots,
      ...(image.ref ? { publisherImageRef: image.ref } : {}),
      imagePolicy: image.policy,
    };
    // The session's own mailbox: the container syncs itself over the relay
    // instead of central reaching in. The token names this session only and
    // dies with the placement.
    const mailboxToken = issueMailboxToken(spec.key, fp);
    const agentWithMailbox = {
      ...agent,
      env: {
        ...agent.env,
        NANOCLAW_MAILBOX_URL: `http://${MAILBOX_ENDPOINT_HOST}:${MAILBOX_ENDPOINT_PORT}`,
        NANOCLAW_MAILBOX_TOKEN: mailboxToken,
      },
    };
    const transit = toRemoteSpec(spec, agentWithMailbox, name, roots);
    this.#remoteKeys.set(keyId(spec.key), fp);
    // A container of this name that central stopped while the machine was
    // away is still running there with a revoked mailbox token. Stop it before
    // realizing again, or adoption would keep it.
    await this.#flushStops(fp);
    try {
      // 1. Which bundles does the laptop lack?
      const have = await this.remote.request(fp, 'have', { hashes: [...transit.bundles.keys()] }, RPC_TIMEOUT_MS);
      const missing = new Set(Array.isArray(have.missing) ? (have.missing as string[]) : []);
      // 2. Ship them, chunked under the socket's frame cap.
      for (const hash of missing) {
        const b = transit.bundles.get(hash);
        if (!b) continue;
        for (const chunk of chunkBundle(b)) await this.remote.request(fp, 'bundle', chunk, RPC_TIMEOUT_MS);
      }
      // 3. Realize. The runner builds the image on first use - allow for it.
      const res = await this.remote.request(fp, 'prepare', { spec: transit.spec }, PREPARE_TIMEOUT_MS);
      log.info('Fleet driver: session prepared on runner', {
        agentGroupId: spec.key.agentGroupId,
        sessionId: spec.key.sessionId,
        fingerprint: fp.slice(0, 12),
        name: String(res.name ?? name),
        bundlesShipped: missing.size,
      });
    } catch (err) {
      throw remoteFailure(err);
    }
    // The relay terminates here, as this session's agent. Registered only
    // after a successful realization, and only for the machine it was placed
    // on — the relay refuses a stream from anyone else naming this session.
    registerRelayTarget(spec.key, fp, transit.proxyTarget);
    this.#store.update(spec.key, { name, suspendedSince: undefined });
    this.#wireRemote();
    const handle = new RemoteHandle(
      spec.key,
      name,
      fp,
      this.remote,
      transit.proxyTarget,
      () => this.#handles.delete(keyId(spec.key)),
      (reason) => this.#deferStop(fp, name, reason),
    );
    this.#handles.set(keyId(spec.key), handle);
    return handle;
  }

  /**
   * The runner's side of a session is memory in an extension host: a window
   * reload or a restart loses it while the container keeps running. Central
   * still holds the handle, so re-issue `start` — idempotent on the runner —
   * and it re-attaches supervision and the relay to the running container.
   * One pass per machine at a time; a request for another while one runs
   * reruns it once afterwards.
   */
  #resumeOn(fingerprint: string): Promise<void> {
    const cur = this.#resuming.get(fingerprint);
    if (cur) {
      cur.again = true;
      return cur.running;
    }
    const entry = { running: Promise.resolve(), again: false };
    entry.running = (async () => {
      do {
        entry.again = false;
        await this.#resumePass(fingerprint);
      } while (entry.again && this.remote.isConnected(fingerprint));
      this.#resuming.delete(fingerprint);
    })();
    this.#resuming.set(fingerprint, entry);
    return entry.running;
  }

  async #resumePass(fingerprint: string): Promise<void> {
    await this.#flushStops(fingerprint);
    let retry = false;
    for (const h of [...this.#handles.values()]) {
      if (h.fingerprint !== fingerprint || !h.live) continue;
      try {
        await h.resume();
        if (h.suspendedSince !== null && !this.#runtimeDown.has(fingerprint)) this.#unsuspend(h);
      } catch (err) {
        // The runner answering "no container" is a verdict, not a hiccup: the
        // container died (or was removed) while nothing was attached to report
        // it, so no terminal event ever arrived. Treat the answer as that event
        // — otherwise central keeps the session as running forever, hands
        // messages into a void every two seconds, and never respawns.
        if (err instanceof RunnerRequestError && err.code === 'refused' && /no container/i.test(err.message)) {
          log.info(
            'Fleet driver: the runner no longer has this session’s container — ending the session so it respawns',
            {
              agentGroupId: h.key.agentGroupId,
              sessionId: h.key.sessionId,
              fingerprint: fingerprint.slice(0, 12),
              ...(h.suspendedSince !== null ? { suspendedForMs: Date.now() - h.suspendedSince } : {}),
            },
          );
          this.#ended(h);
          continue;
        }
        // The machine is back but its runtime is not (podman's machine did not
        // survive the sleep, Docker Desktop still starting): keep holding and
        // ask again, backing off, rather than warning once and forgetting.
        if (isRetryable(err)) {
          retry = true;
          this.#suspend(fingerprint, 'container runtime not answering', [h]);
          continue;
        }
        log.warn('Fleet driver: could not re-attach a session after the runner reconnected', {
          agentGroupId: h.key.agentGroupId,
          sessionId: h.key.sessionId,
          fingerprint: fingerprint.slice(0, 12),
          err,
        });
      }
    }
    if (retry) this.#scheduleResume(fingerprint);
    else this.#clearResumeRetry(fingerprint, true);
  }

  #scheduleResume(fingerprint: string): void {
    if (!this.remote.isConnected(fingerprint)) return;
    const r = this.#resumeRetry.get(fingerprint) ?? { timer: null, attempt: 0 };
    if (r.timer) return;
    const delay = Math.min(RESUME_RETRY_MIN_MS * 2 ** r.attempt, RESUME_RETRY_MAX_MS);
    r.attempt += 1;
    r.timer = setTimeout(() => {
      r.timer = null;
      void this.#resumeOn(fingerprint);
    }, delay);
    r.timer.unref?.();
    this.#resumeRetry.set(fingerprint, r);
  }

  #clearResumeRetry(fingerprint: string, resetBackoff: boolean): void {
    const r = this.#resumeRetry.get(fingerprint);
    if (!r) return;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    if (resetBackoff) this.#resumeRetry.delete(fingerprint);
  }

  /** The session's container is gone for certain: release it and tell the watchers, so it respawns on demand. */
  #ended(h: RemoteHandle): void {
    h.markGone();
    this.#handles.delete(keyId(h.key));
    for (const cb of this.#subscribers.get(h.key.installSlug) ?? []) cb({ key: h.key, kind: 'terminal' });
  }

  /**
   * Hold the live sessions on a machine that cannot be seen. Idempotent: a
   * session already held keeps its original start, so the bound measures the
   * whole absence, not the last blip of it.
   */
  #suspend(fingerprint: string, why: string, only?: RemoteHandle[]): void {
    const now = Date.now();
    const newly: RemoteHandle[] = [];
    for (const h of only ?? this.#handles.values()) {
      if (h.fingerprint !== fingerprint || !h.live || h.suspendedSince !== null) continue;
      h.suspendedSince = now;
      h.holdExpired = false;
      newly.push(h);
      this.#store.update(h.key, { suspendedSince: now });
    }
    if (newly.length === 0) return;
    log.info('Fleet driver: machine unavailable — holding its sessions until it returns', {
      fingerprint: fingerprint.slice(0, 12),
      why,
      sessions: newly.map((h) => h.key.sessionId),
      holdMs: this.#holdMs,
    });
    this.holdSuspended(now);
    this.#armHold();
  }

  #unsuspend(h: RemoteHandle): void {
    const since = h.suspendedSince;
    if (since === null) return;
    const now = Date.now();
    h.suspendedSince = null;
    this.#store.update(h.key, { suspendedSince: undefined });
    // The absence does not count as idleness: the ceiling measures from now.
    h.resumeFloorMs = now;
    this.remote.touchHeartbeat(h.key, now);
    log.info('Fleet driver: machine back — session resumed', {
      agentGroupId: h.key.agentGroupId,
      sessionId: h.key.sessionId,
      fingerprint: h.fingerprint.slice(0, 12),
      suspendedForMs: now - since,
    });
  }

  get #store(): RunnerSessionStore {
    return this.remote.store ?? runnerSessionStore();
  }

  get #holdMs(): number {
    return this.remote.suspendHoldMs ?? DEFAULT_SUSPEND_HOLD_MS;
  }

  /**
   * Refresh every held session's heartbeat. Past the bound, stop holding:
   * the ordinary ceiling then reaps it, and the stop waits for the machine.
   * Public for tests; the hold timer calls it.
   */
  holdSuspended(now = Date.now()): void {
    let held = 0;
    for (const h of this.#handles.values()) {
      if (h.suspendedSince === null) continue;
      if (now - h.suspendedSince <= this.#holdMs) {
        this.remote.touchHeartbeat(h.key, now);
        held += 1;
      } else if (!h.holdExpired) {
        h.holdExpired = true;
        log.warn('Fleet driver: machine away past the hold — releasing the session to the idle ceiling', {
          agentGroupId: h.key.agentGroupId,
          sessionId: h.key.sessionId,
          fingerprint: h.fingerprint.slice(0, 12),
          suspendedForMs: now - h.suspendedSince,
        });
      }
    }
    if (held === 0 && this.#holdTimer) {
      clearInterval(this.#holdTimer);
      this.#holdTimer = null;
    }
  }

  #armHold(): void {
    if (this.#holdTimer) return;
    this.#holdTimer = setInterval(() => this.holdSuspended(), HOLD_TICK_MS);
    this.#holdTimer.unref?.();
  }

  #deferStop(fingerprint: string, name: string, reason: string): void {
    this.#store.setStop(fingerprint, name, reason);
  }

  /**
   * Deliver stops issued while the machine was away (kept across central
   * restarts). A container already gone counts as delivered. One flush per
   * machine at a time: a reconnect runs the resume and rejoin passes together,
   * and each used to read the queue before the other cleared it.
   */
  #flushStops(fingerprint: string): Promise<void> {
    // Queue behind a flush in progress rather than joining it: it may have read
    // the queue before a stop was added.
    const prev = this.#flushing.get(fingerprint) ?? Promise.resolve();
    const p = prev.then(() => this.#flushStopsNow(fingerprint));
    this.#flushing.set(fingerprint, p);
    void p.finally(() => {
      if (this.#flushing.get(fingerprint) === p) this.#flushing.delete(fingerprint);
    });
    return p;
  }

  async #flushStopsNow(fingerprint: string): Promise<void> {
    const pending = this.#store.stops(fingerprint);
    if (Object.keys(pending).length === 0 || !this.remote.isConnected(fingerprint)) return;
    for (const [name, reason] of Object.entries(pending)) {
      try {
        await this.remote.request(
          fingerprint,
          'stop',
          { name, reason: `${reason} (deferred while the machine was away)` },
          RPC_TIMEOUT_MS + 60_000,
        );
        this.#store.clearStop(fingerprint, name);
        log.info('Fleet driver: delivered a stop issued while the machine was away', {
          name,
          reason,
          fingerprint: fingerprint.slice(0, 12),
        });
      } catch (err) {
        if (isRetryable(err)) return; // the runtime is still down; try again on the next return
        this.#store.clearStop(fingerprint, name);
        log.warn('Fleet driver: the runner refused a deferred stop', {
          name,
          fingerprint: fingerprint.slice(0, 12),
          err,
        });
      }
    }
  }

  /**
   * A runner reconnected: sessions remembered from before a central restart
   * that this process does not supervise are woken through the spawn path.
   * One whose hold ran out while the machine was away is stopped instead.
   */
  async #rejoin(fingerprint: string): Promise<void> {
    for (const rec of this.#store.byFingerprint(fingerprint)) {
      const id = keyId(rec.key);
      if (this.#handles.has(id) || this.#rejoining.has(id)) continue;
      if (rec.suspendedSince !== undefined && Date.now() - rec.suspendedSince > this.#holdMs) {
        log.info(
          'Fleet driver: machine back after the hold ran out — stopping its old session instead of resuming it',
          {
            sessionId: rec.key.sessionId,
            fingerprint: fingerprint.slice(0, 12),
            awayMs: Date.now() - rec.suspendedSince,
          },
        );
        if (rec.name) this.#deferStop(fingerprint, rec.name, 'hold expired');
        revokeMailboxToken(rec.key);
        continue;
      }
      if (!this.remote.rewake) continue;
      this.#rejoining.add(id);
      this.#remoteKeys.set(id, fingerprint);
      void this.#rewake(rec.key, fingerprint, 0);
    }
    await this.#flushStops(fingerprint);
  }

  async #rewake(key: SessionKey, fingerprint: string, attempt: number): Promise<void> {
    const id = keyId(key);
    let outcome: 'ok' | 'retry' | 'gone';
    try {
      outcome = await this.remote.rewake!(key);
    } catch (err) {
      log.warn('Fleet driver: waking a remembered session failed', { sessionId: key.sessionId, err });
      outcome = 'retry';
    }
    if (outcome === 'ok' || this.#handles.has(id)) {
      this.#rejoining.delete(id);
      log.info('Fleet driver: session picked back up after a central restart', {
        sessionId: key.sessionId,
        fingerprint: fingerprint.slice(0, 12),
        attempts: attempt + 1,
      });
      return;
    }
    if (outcome === 'gone') {
      this.#rejoining.delete(id);
      const rec = this.#store.get(key);
      if (rec?.name) this.#deferStop(fingerprint, rec.name, 'session no longer active');
      revokeMailboxToken(key);
      await this.#flushStops(fingerprint);
      return;
    }
    // Typically the dead process's session claim, which lapses within a minute or two.
    if (attempt >= 12 || !this.remote.isConnected(fingerprint) || !this.#store.get(key)) {
      this.#rejoining.delete(id);
      return;
    }
    const t = setTimeout(
      () => void this.#rewake(key, fingerprint, attempt + 1),
      Math.min(RESUME_RETRY_MIN_MS * 2 ** attempt, RESUME_RETRY_MAX_MS),
    );
    t.unref?.();
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    const local = await this.local.listSessions(installSlug);
    const remote: SessionSnapshot[] = [];
    await Promise.all(
      this.remote.connected().map(async (fp) => {
        try {
          const res = await this.remote.request(fp, 'list', { installSlug }, LIST_TIMEOUT_MS);
          const rows = Array.isArray(res.sessions)
            ? (res.sessions as Array<{ name: string; key: SessionKey; state: string }>)
            : [];
          for (const r of rows) {
            if (!r?.key || r.key.installSlug !== installSlug) continue;
            // A runner may only claim sessions that are already its own, or that
            // belong to an agent placed on it — never another machine's.
            const owner = this.#remoteKeys.get(keyId(r.key));
            if (owner && owner !== fp) continue;
            if (!owner && (await this.placementFor(r.key.agentGroupId).catch(() => undefined))?.fingerprint !== fp)
              continue;
            this.#remoteKeys.set(keyId(r.key), fp);
            remote.push({
              handle: new RemoteHandle(r.key, r.name, fp, this.remote, null),
              phase: dockerStatePhase(r.state),
            });
          }
        } catch (err) {
          log.debug('Fleet driver: runner did not list sessions', { fingerprint: fp.slice(0, 12), err });
        }
      }),
    );
    return [...local, ...remote];
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    this.#wireRemote();
    let subs = this.#subscribers.get(installSlug);
    if (!subs) {
      subs = new Set();
      this.#subscribers.set(installSlug, subs);
    }
    subs.add(onEvent);
    const localWatch = this.local.watchSessions(installSlug, onEvent);
    return {
      stop: () => {
        subs!.delete(onEvent);
        localWatch.stop();
      },
    };
  }

  async reapResidue(installSlug: string): Promise<void> {
    await this.local.reapResidue?.(installSlug);
  }

  /** A runner may only speak for sessions this driver placed or listed on THAT runner. */
  #allowed(fingerprint: string, key: SessionKey): boolean {
    return this.#remoteKeys.get(keyId(key)) === fingerprint;
  }

  #wireRemote(): void {
    if (this.#wired) return;
    this.#wired = true;
    this.remote.onEvent((fp, event) => {
      if (!this.#allowed(fp, event.key)) return;
      // The runner reports terminal only once it has verified the container
      // gone: release the handle now, so a later re-assert cannot restart a
      // container central has already written off.
      if (event.kind === 'terminal') {
        const h = this.#handles.get(keyId(event.key));
        if (h) {
          h.markGone();
          this.#handles.delete(keyId(event.key));
        }
      }
      for (const cb of this.#subscribers.get(event.key.installSlug) ?? []) cb(event);
    });
    this.remote.onHeartbeat((fp, key, mtimeMs) => {
      if (!this.#allowed(fp, key)) return;
      const h = this.#handles.get(keyId(key));
      // While held, the hold owns the clock: the laptop's mirror only reports
      // a file nobody is touching, and would age the session into a reap.
      if (h?.suspendedSince != null) return;
      this.remote.touchHeartbeat(key, Math.max(mtimeMs, h?.resumeFloorMs ?? 0));
    });
    this.remote.onAttached?.((fp) => {
      // Its runtime state is unknown until it says otherwise; it re-reports a down runtime on connect.
      this.#runtimeDown.delete(fp);
      this.#clearResumeRetry(fp, true);
      void this.#resumeOn(fp);
      void this.#rejoin(fp);
    });
    this.remote.onDetached?.((fp) => {
      this.#clearResumeRetry(fp, false);
      this.#suspend(fp, 'runner disconnected');
    });
    this.remote.onRuntime?.((fp, reachable, detail) => {
      if (!reachable) {
        this.#runtimeDown.add(fp);
        this.#suspend(fp, detail ? `container runtime unreachable: ${detail}` : 'container runtime unreachable');
        return;
      }
      if (!this.#runtimeDown.delete(fp)) return;
      log.info('Fleet driver: machine reports its container runtime is back', { fingerprint: fp.slice(0, 12) });
      this.#clearResumeRetry(fp, true);
      void this.#resumeOn(fp);
    });
  }
}

/**
 * Add the placement's declared slots to the agent container as mounts. They
 * are `allowlisted-extra` with a host path central does not own, so the
 * transit turns each into a slot the LAPTOP must bind — central names the
 * container path and mode, the machine names the directory (or refuses).
 * Local realization never sees these: they exist only in the remote spec.
 */
export const SLOT_HOST_PLACEHOLDER = '/nonexistent/runner-slot';
export function withDeclaredSlots(
  agent: SessionSpec['containers'][number],
  spec: SessionSpec,
  placement: Pick<RunnerPlacementRow, 'slots_json'>,
): SessionSpec['containers'][number] {
  const slots = placementSlots(placement);
  const declared = Object.entries(slots).filter(([cp]) => !agent.mounts.some((m) => m.containerPath === cp));
  if (declared.length === 0) return agent;
  const mounts = [
    ...agent.mounts,
    ...declared.map(([containerPath, decl]) => ({
      class: 'allowlisted-extra' as const,
      hostPath: `${SLOT_HOST_PLACEHOLDER}${containerPath}`,
      containerPath,
      mode: decl.mode,
      groupScope: spec.key.agentGroupId,
      ...(decl.exclude ? { exclude: decl.exclude } : {}),
      ...(decl.propose ? { propose: true } : {}),
    })),
  ];
  // Tell the agent where the developer's project is, when there is one.
  const ws = slots[WORKSPACE_SLOT];
  const env = ws
    ? { ...agent.env, NANOCLAW_PROJECT_DIR: WORKSPACE_SLOT, NANOCLAW_PROJECT_MODE: ws.propose ? 'propose' : 'direct' }
    : agent.env;
  return { ...agent, mounts, env };
}

/**
 * A session realized on a laptop. `execSpec` describes a command on THAT
 * machine - honest about the bin, but it cannot be run from central.
 */
export class RemoteHandle implements SessionHandle {
  #started = false;
  #lastPhase: SessionStatus = { phase: 'ready' };
  /** When the machine became unavailable; null while it is reachable. */
  suspendedSince: number | null = null;
  /** The last hold ran out; logged once, then the ordinary ceiling applies. */
  holdExpired = false;
  /** Heartbeats are floored here after a resume, so the absence is not read as idleness. */
  resumeFloorMs = 0;
  constructor(
    readonly key: SessionKey,
    readonly name: string,
    readonly fingerprint: string,
    private readonly remote: FleetRemotePort,
    /** Where a relayed tunnel terminates and as whom. Never serialized or logged. */
    readonly proxyTarget: ProxyTarget | null,
    private readonly onStopped: () => void = () => {},
    /** Records a stop that could not reach the machine, for delivery on its return. */
    private readonly deferStop: (reason: string) => void = () => {},
  ) {}
  /** Started and not yet stopped: the sessions a returning machine is asked to pick back up. */
  get live(): boolean {
    return this.#started && this.#lastPhase.phase !== 'stopped';
  }
  /** The runner reports the container gone: release everything this handle held and read as stopped from now on. */
  markGone(): void {
    this.#lastPhase = { phase: 'stopped' };
    revokeMailboxToken(this.key);
    clearRelayTarget(this.key);
    this.onStopped();
  }
  /** Re-assert a running session on a runner that forgot it (reload/restart). No-op unless started and not stopped. */
  async resume(): Promise<void> {
    if (!this.#started || this.#lastPhase.phase === 'stopped') return;
    // `resume`: attach to it if it still runs, never revive it if it does not
    // (runner 0.9+; older runners ignore the flag and behave as before).
    await this.remote.request(
      this.fingerprint,
      'start',
      { name: this.name, key: this.key, resume: true },
      RPC_TIMEOUT_MS,
    );
    log.info('Fleet driver: runner reconnected — session re-attached', {
      agentGroupId: this.key.agentGroupId,
      sessionId: this.key.sessionId,
      fingerprint: this.fingerprint.slice(0, 12),
    });
  }
  async start(): Promise<void> {
    if (this.#started) return;
    try {
      await this.remote.request(this.fingerprint, 'start', { name: this.name, key: this.key }, RPC_TIMEOUT_MS);
      this.#started = true;
      this.#lastPhase = { phase: 'running' };
    } catch (err) {
      throw remoteFailure(err);
    }
  }
  async status(): Promise<SessionStatus> {
    if (!this.remote.isConnected(this.fingerprint) || this.suspendedSince !== null) {
      // The laptop is away (lid closed, network) or its runtime is not
      // answering: the driver holds the session, and the last known phase stands.
      return this.#lastPhase;
    }
    try {
      const res = await this.remote.request(this.fingerprint, 'status', { name: this.name }, RPC_TIMEOUT_MS);
      const state = String(res.state ?? '');
      const phase = dockerStatePhase(state);
      if (phase === 'running') this.#lastPhase = { phase: 'running' };
      else if (phase === 'starting') this.#lastPhase = { phase: 'ready' };
      else if (typeof res.exitCode === 'number' && res.exitCode !== 0) {
        this.#lastPhase = {
          phase: 'failed',
          failure: { kind: 'started-then-died', retryable: false, exitCode: res.exitCode },
        };
      } else this.#lastPhase = { phase: 'stopped' };
      return this.#lastPhase;
    } catch (err) {
      // Away, or its runtime not answering: no verdict on the container.
      if (isRetryable(err)) return this.#lastPhase;
      return {
        phase: 'failed',
        failure: { kind: 'unknown', retryable: false, opaqueRef: `remote-status-${Date.now()}` },
      };
    }
  }
  async stop(reason: string): Promise<void> {
    try {
      await this.remote.request(this.fingerprint, 'stop', { name: this.name, reason }, RPC_TIMEOUT_MS + 60_000);
    } catch (err) {
      if (isRetryable(err)) {
        log.warn('Fleet driver: stop requested while the machine is away — delivered when it returns', {
          key: this.key,
          reason,
        });
        this.deferStop(reason);
        return;
      }
      throw remoteFailure(err);
    } finally {
      this.#lastPhase = { phase: 'stopped' };
      revokeMailboxToken(this.key);
      clearRelayTarget(this.key);
      this.onStopped();
    }
  }
  execSpec(command: string[]): SessionExecSpec {
    return {
      bin: 'docker',
      argsTty: ['exec', '-it', this.name, ...command],
      argsPlain: ['exec', '-i', this.name, ...command],
    };
  }
}

function remoteFailure(err: unknown): Error {
  // The failure taxonomy is deliberately opaque to callers; the operator's log
  // is where the real reason lives. Without this line a runner refusal reads
  // as "session realization failed: unknown" and nothing else.
  const e = err as Partial<RunnerRequestError> & { message?: string; kind?: string };
  log.warn('Fleet driver: remote realization failed', {
    code: e.code ?? null,
    kind: e.kind ?? e.failure?.kind ?? null,
    detail: (e.failure as { detail?: string } | undefined)?.detail ?? null,
    message: String(e.message ?? err).slice(0, 300),
  });
  if (err instanceof RunnerRequestError) {
    if (err.failure) return asFailureError(err.failure);
    if (err.code === 'not-connected' || err.code === 'disconnected' || err.code === 'timeout') {
      return asFailureError({ kind: 'runtime-unavailable', retryable: true });
    }
    return asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `runner-${err.code}-${Date.now()}` });
  }
  if (err && typeof err === 'object' && 'kind' in err) return err as unknown as Error; // already a SessionFailureError
  const failure: SessionFailure = { kind: 'unknown', retryable: false, opaqueRef: `runner-${Date.now()}` };
  return asFailureError(failure);
}

/** Failures that mean "not now" — the machine or its runtime is away — rather than a verdict on the container. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof RunnerRequestError)) return false;
  if (err.code === 'not-connected' || err.code === 'disconnected' || err.code === 'timeout') return true;
  return err.failure?.retryable === true;
}

function keyId(key: SessionKey): string {
  return `${key.installSlug} ${key.agentGroupId} ${key.sessionId}`;
}

registerSessionDriver(FLEET_DRIVER_KIND, (policy: MountPolicy) => {
  const docker = getSessionDriverFactory('docker');
  if (!docker) throw new Error("fleet driver wraps 'docker', which is not registered");
  return new FleetSessionDriver(docker(policy), getPlacement, policy);
});
