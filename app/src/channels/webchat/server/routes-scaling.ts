/**
 * Admin → Scaling → Machines (owners and global admins; the routes are
 * guarded `globalAdmin`, writes also `csrf`, and audited by the route table).
 * Machines join through the machine listener (modules/machines/listener.ts);
 * these routes create join tokens and drain, revoke, remove or cap machines.
 */
import { audit, auditActor } from '../../../audit.js';
import {
  installCommand,
  workerHostRulesCommand,
  workerUpgradeCommand,
} from '../../../modules/machines/agent-scripts.js';
import { listenerInfo } from '../../../modules/machines/listener.js';
import {
  createJoinToken,
  getMember,
  listMembers,
  publicView,
  removeMember,
  revokeMember,
  ROLES,
  setCap,
  setMemberState,
  setWorkloadsOn,
  type Role,
} from '../../../modules/machines/members.js';
import { dropLink, isLinked } from '../../../modules/machines/links.js';
import { listWorkloads } from '../../../modules/workloads/store.js';
import { joinHost, probeHost, type JoinEvent } from '../../../modules/machines/ssh-join.js';
import type { RouteCtx } from '../server.js';
import { userCredsRateLimited } from './rate-limit.js';
import { json, readJsonObject } from './http.js';

export async function rScalingMachinesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const info = listenerInfo();
  const now = Date.now();
  const placed = await listWorkloads().catch(() => []);
  return json(ctx.res, 200, {
    listener: info ? { address: info.address, port: info.port } : null,
    // For a machine that joined before the worker service existed: run once on it.
    workerCommand: workerUpgradeCommand(),
    // For a worker whose isolation check got through: puts the host rules back.
    hostRulesCommand: workerHostRulesCommand(),
    machines: (await listMembers()).map((m) => ({
      ...publicView(m, now),
      linked: isLinked(m.id),
      placed: placed
        .filter((w) => w.node === m.id)
        .map((w) => ({
          name: w.name,
          state: shownState(w),
          memoryMb: w.approvedMemoryMb,
          reason: w.placementReason,
          error: w.lastError,
        })),
    })),
  });
}

export async function rScalingJoinPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<{ role?: string }>(ctx.req, ctx.res);
  if (body === undefined) return;
  const role = (body.role ?? 'worker') as Role;
  if (!ROLES.includes(role)) return json(ctx.res, 400, { error: 'Unknown role' });
  const info = listenerInfo();
  if (!info) return json(ctx.res, 409, { error: 'Set NANOCLAW_MACHINE_PORT and restart' });
  const { token, expiresAt } = await createJoinToken(role, ctx.userId);
  return json(ctx.res, 200, { command: installCommand(info.address, info.port, info.pin, token), expiresAt });
}

/** A sleeping stack (workloads/sleep.ts) reads as asleep, not stopped. */
const shownState = (w: { state: string; asleepAt: number | null }): string =>
  w.state === 'stopped' && w.asleepAt !== null ? 'asleep' : w.state;

const RE_ID = /^m-[0-9a-f]{8}$/;

async function target(ctx: RouteCtx, m: RegExpMatchArray): Promise<string | null> {
  const id = decodeURIComponent(m[1] ?? '');
  if (!RE_ID.test(id) || !(await getMember(id))) {
    json(ctx.res, 404, { error: 'No such machine' });
    return null;
  }
  return id;
}

export async function rScalingDrainPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = await target(ctx, m);
  if (!id) return;
  const body = await readJsonObject<{ on?: boolean }>(ctx.req, ctx.res);
  if (body === undefined) return;
  const cur = await getMember(id);
  if (cur?.state === 'revoked') return json(ctx.res, 409, { error: 'Revoked' });
  await setMemberState(id, body.on === false ? 'ready' : 'draining');
  return json(ctx.res, 200, { ok: true });
}

/** "Run workloads here" on or off: whether placement may put new stacks on this worker. */
export async function rScalingWorkloadsPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = await target(ctx, m);
  if (!id) return;
  const body = await readJsonObject<{ on?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  if (typeof body.on !== 'boolean') return json(ctx.res, 400, { error: 'on: true or false' });
  const cur = await getMember(id);
  if (cur?.state === 'revoked') return json(ctx.res, 409, { error: 'Revoked' });
  await setWorkloadsOn(id, body.on);
  return json(ctx.res, 200, publicView((await getMember(id))!));
}

export async function rScalingRevokePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = await target(ctx, m);
  if (!id) return;
  await revokeMember(id);
  dropLink(id);
  return json(ctx.res, 200, { ok: true });
}

export async function rScalingMachineDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = await target(ctx, m);
  if (!id) return;
  if (!(await removeMember(id))) return json(ctx.res, 409, { error: 'Revoke it first' });
  return json(ctx.res, 200, { ok: true });
}

const capValue = (v: unknown, max: number): number | null | undefined => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
};

export async function rScalingCapPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = await target(ctx, m);
  if (!id) return;
  const body = await readJsonObject<{ memGb?: unknown; cpus?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  const memGb = capValue(body.memGb, 4096);
  const cpus = capValue(body.cpus, 1024);
  if (memGb === undefined || cpus === undefined) return json(ctx.res, 400, { error: 'Numbers, or empty for none' });
  await setCap(id, { memMb: memGb === null ? null : Math.round(memGb * 1024), cpus });
  return json(ctx.res, 200, publicView((await getMember(id))!));
}

// ── Join over SSH (modules/machines/ssh-join.ts) ─────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Step 1: read the host key of a private host; nothing is authenticated. */
export async function rScalingSshProbePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  if (userCredsRateLimited(ctx.userId, 'machine-ssh-probe')) return json(ctx.res, 429, { error: 'Wait a moment' });
  const body = await readJsonObject<{ host?: unknown; port?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  if (!listenerInfo()) return json(ctx.res, 409, { error: 'Set NANOCLAW_MACHINE_PORT and restart' });
  const r = await probeHost({
    userId: ctx.userId,
    host: str(body.host),
    port: body.port === undefined ? 22 : Number(body.port),
  });
  return r.ok
    ? json(ctx.res, 200, { probeId: r.probeId, fingerprint: r.fingerprint, address: r.address })
    : json(ctx.res, 400, { error: r.error });
}

/**
 * Step 2: sign in and run the installer, streaming its output (server-sent
 * events: {t:'out',s} … {t:'done',ok,error?}). Closing the request cancels.
 * The password, key and passphrase are used here and dropped: never stored,
 * logged or audited (the audit line names who, host, username, role, result).
 */
export async function rScalingSshJoinPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  if (userCredsRateLimited(ctx.userId, 'machine-ssh-join')) return json(ctx.res, 429, { error: 'Wait a moment' });
  const body = await readJsonObject<Record<string, unknown>>(ctx.req, ctx.res);
  if (body === undefined) return;
  const role = (str(body.role) || 'worker') as Role;
  if (!ROLES.includes(role)) return json(ctx.res, 400, { error: 'Unknown role' });
  const info = listenerInfo();
  if (!info) return json(ctx.res, 409, { error: 'Set NANOCLAW_MACHINE_PORT and restart' });
  const secrets = {
    password: str(body.password) || undefined,
    privateKey: str(body.privateKey) || undefined,
    passphrase: str(body.passphrase) || undefined,
  };
  delete body.password;
  delete body.privateKey;
  delete body.passphrase;
  const username = str(body.username);

  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const ac = new AbortController();
  ctx.res.on('close', () => {
    if (!ctx.res.writableEnded) ac.abort();
  });
  const emit = (e: JoinEvent): void => {
    if (!ctx.res.writableEnded) ctx.res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const r = await joinHost(
    { userId: ctx.userId, probeId: str(body.probeId), confirmed: str(body.fingerprint), username, secrets },
    async () => ({
      host: info.address,
      port: info.port,
      pin: info.pin,
      token: (await createJoinToken(role, ctx.userId)).token,
    }),
    emit,
    { signal: ac.signal },
  );
  secrets.password = secrets.privateKey = secrets.passphrase = undefined;
  audit({
    type: 'machine.ssh-join',
    actor: auditActor({ kind: 'human', userId: ctx.userId }),
    action: 'POST /api/scaling/machines/ssh/join',
    effect: r.ok ? 'ok' : 'failed',
    detail: { host: r.host ?? null, port: r.port ?? null, username, role, result: r.ok ? 'installed' : r.error },
  });
  if (!ctx.res.writableEnded) ctx.res.end();
}
