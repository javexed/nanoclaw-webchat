// ── Agent apps and publishing routes ────────────────────────────────────────
// Agent → Apps (/api/agents/:id/apps, /api/agents/:id/workloads/:name/…): an
// agent's apps for the people who administer it (owners, global admins and
// its scoped admins; members get 403, and the tab hides). Narrowing applies
// at once; widening raises an approval card (modules/workloads/gui.ts).
//
// Admin → Publishing (/api/publishing…): owner only. The routes' switches and
// settings are their .env keys; Connect hands a credential to the OneCLI vault
// and never returns it (modules/workloads/publishing-settings.ts).
//
// Writes carry the CSRF header (the 'csrf' guard in server.ts).
import { log } from '../../../log.js';
import {
  backupsOf,
  deleteWorkload,
  logsWorkload,
  restoreWorkload,
  startWorkload,
  stopWorkload,
} from '../../../modules/workloads/control.js';
import { appsOf, ChangeRefused, changeApp, setPublishDeps } from '../../../modules/workloads/gui.js';
import {
  applyCloudflare,
  applyTailnet,
  connectCloudflare,
  connectTailnet,
  publishingView,
  SettingRefused,
} from '../../../modules/workloads/publishing-settings.js';
import { hasAdminPrivilege } from '../roles.js';
import type { RouteCtx } from '../server.js';
import { json, readJsonObject } from './http.js';
import { requireAgentAdmin } from './route-guards.js';

setPublishDeps({ isAdmin: hasAdminPrivilege });

export const RE_AGENT_APPS = /^\/api\/agents\/([^/]+)\/apps$/;
export const RE_AGENT_WORKLOAD = /^\/api\/agents\/([^/]+)\/workloads\/([a-z][a-z0-9-]{0,29})$/;
export const RE_AGENT_WORKLOAD_ACTION =
  /^\/api\/agents\/([^/]+)\/workloads\/([a-z][a-z0-9-]{0,29})\/(start|stop|logs|backups|restore)$/;

/**
 * A refusal from the workloads modules. They throw sentences meant for the
 * person or agent asking (the same ones `ncl workloads` prints), so they are
 * shown as they are, capped.
 */
function fail(ctx: RouteCtx, err: unknown): void {
  if (err instanceof ChangeRefused) return json(ctx.res, err.status, { error: err.message });
  const message = String((err as Error)?.message ?? err).slice(0, 300);
  log.info('Apps: request refused', { path: ctx.url.pathname, err: message });
  return json(ctx.res, 400, { error: message.charAt(0).toUpperCase() + message.slice(1) });
}

export async function rAgentAppsGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const group = await requireAgentAdmin(ctx, m);
  if (!group) return;
  try {
    return json(ctx.res, 200, await appsOf(group.id));
  } catch (err) {
    return fail(ctx, err);
  }
}

/** Change an app's route or who can open it. Body: { workload, app?, route, who?, emails?, service? }. */
export async function rAgentAppsPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const group = await requireAgentAdmin(ctx, m);
  if (!group) return;
  const body = await readJsonObject<Record<string, unknown>>(ctx.req, ctx.res);
  if (body === undefined) return;
  try {
    const r = await changeApp(group.id, ctx.userId, {
      workload: body.workload,
      app: body.app,
      route: body.route,
      who: body.who,
      emails: body.emails,
      service: body.service,
    });
    return json(ctx.res, r.pending ? 202 : 200, r);
  } catch (err) {
    return fail(ctx, err);
  }
}

export async function rAgentWorkloadDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const group = await requireAgentAdmin(ctx, m);
  if (!group) return;
  try {
    await deleteWorkload(group.id, m[2]);
    return json(ctx.res, 200, { deleted: m[2] });
  } catch (err) {
    return fail(ctx, err);
  }
}

export async function rAgentWorkloadAction(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const group = await requireAgentAdmin(ctx, m);
  if (!group) return;
  const name = m[2];
  const verb = m[3];
  const reads = verb === 'logs' || verb === 'backups';
  if (reads !== (ctx.method === 'GET')) return json(ctx.res, 405, { error: 'Method not allowed' });
  try {
    if (verb === 'logs') {
      const service = ctx.url.searchParams.get('service') || undefined;
      return json(ctx.res, 200, { logs: await logsWorkload(group.id, name, service, 300) });
    }
    if (verb === 'backups') return json(ctx.res, 200, { backups: await backupsOf(group.id, name) });
    if (verb === 'start') return json(ctx.res, 200, { state: (await startWorkload(group.id, name)).state });
    if (verb === 'stop') return json(ctx.res, 200, { state: (await stopWorkload(group.id, name)).state });
    const body = await readJsonObject<{ backup?: unknown }>(ctx.req, ctx.res);
    if (body === undefined) return;
    if (typeof body.backup !== 'string' || !body.backup) return json(ctx.res, 400, { error: 'Pick a backup' });
    await restoreWorkload(group.id, name, body.backup);
    return json(ctx.res, 200, { restored: body.backup });
  } catch (err) {
    return fail(ctx, err);
  }
}

// ── Admin → Publishing ──────────────────────────────────────────────────────

function settingFail(ctx: RouteCtx, err: unknown): void {
  if (err instanceof SettingRefused) return json(ctx.res, 400, { error: err.message, field: err.field });
  log.warn('Publishing: change failed', { path: ctx.url.pathname, err: String(err).slice(0, 300) });
  return json(ctx.res, 500, { error: 'That did not work' });
}

export async function rPublishingGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, publishingView());
}

export async function rPublishingTailnetPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<{ on?: unknown; domain?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  try {
    await applyTailnet(process.cwd(), { on: body.on, domain: body.domain });
    return json(ctx.res, 200, publishingView());
  } catch (err) {
    return settingFail(ctx, err);
  }
}

export async function rPublishingCloudflarePut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<Record<string, unknown>>(ctx.req, ctx.res);
  if (body === undefined) return;
  try {
    await applyCloudflare(process.cwd(), {
      on: body.on,
      domain: body.domain,
      accountId: body.accountId,
      zoneId: body.zoneId,
      teamDomain: body.teamDomain,
    });
    return json(ctx.res, 200, publishingView());
  } catch (err) {
    return settingFail(ctx, err);
  }
}

export async function rPublishingTailnetConnect(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<{ clientId?: unknown; clientSecret?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  try {
    await connectTailnet({ clientId: body.clientId, clientSecret: body.clientSecret });
    return json(ctx.res, 200, publishingView());
  } catch (err) {
    return settingFail(ctx, err);
  }
}

export async function rPublishingCloudflareConnect(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<{ token?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  try {
    await connectCloudflare({ token: body.token });
    return json(ctx.res, 200, publishingView());
  } catch (err) {
    return settingFail(ctx, err);
  }
}
