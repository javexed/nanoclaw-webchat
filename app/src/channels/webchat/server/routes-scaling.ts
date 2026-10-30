/**
 * Admin → Scaling → Machines (owners and global admins; the routes are
 * guarded `globalAdmin`, writes also `csrf`, and audited by the route table).
 * Machines join through the machine listener (modules/machines/listener.ts);
 * these routes create join tokens and drain, revoke, remove or cap machines.
 */
import { installCommand } from '../../../modules/machines/agent-scripts.js';
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
  type Role,
} from '../../../modules/machines/members.js';
import type { RouteCtx } from '../server.js';
import { json, readJsonObject } from './http.js';

export async function rScalingMachinesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const info = listenerInfo();
  const now = Date.now();
  return json(ctx.res, 200, {
    listener: info ? { address: info.address, port: info.port } : null,
    machines: (await listMembers()).map((m) => publicView(m, now)),
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

export async function rScalingRevokePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = await target(ctx, m);
  if (!id) return;
  await revokeMember(id);
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
