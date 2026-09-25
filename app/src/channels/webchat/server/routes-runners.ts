// ── Runner fleet + egress routes ──────────────────────────────────────────
// Manage → Runners and Manage → Network. Everything that changes state is
// owner / global-admin only (the 'globalAdmin' guard in server.ts), the same
// set that receives pairing cards; the extension package is served to any
// signed-in user because it is the client itself.
import { randomUUID } from 'crypto';
import fs, { createReadStream } from 'fs';
import os from 'os';
import path from 'path';

import { json, readJsonBody } from './http.js';
import { INSTALL_SLUG } from '../../../config.js';
import { log } from '../../../log.js';
import { publisherImageRef } from '../../../drivers/fleet-driver.js';
import {
  getRunnerImagePolicy,
  getRunnerImageRef,
  setRunnerImagePolicy,
  setRunnerImageRef,
  type RunnerImagePolicy,
} from '../db.js';
import {
  ALWAYS_ALLOWED,
  defaultAllowlist,
  getRunnerEgressAllowlist,
  listBlocked,
  parseAllowlist,
  setRunnerEgressAllowlist,
} from '../egress-policy.js';
import {
  publishExtension,
  publishedExtensionPath,
  readExtensionManifest,
  versionFromVsixName,
} from '../runner-extension.js';
import { completeApproval } from '../runner-pairing.js';
import {
  PlacementError,
  deletePlacement,
  getMachine,
  isSafeRunnerId,
  listMachines,
  listPlacements,
  revokeMachine,
  setPlacement,
} from '../runner-registry.js';
import { connectedRunnerFingerprints, runnerRequest } from '../runner-transport.js';
import {
  derivedClientConfig,
  effectiveClientConfig,
  getClientOverrides,
  parseOverrides,
  setClientOverrides,
} from '../runner-client-config.js';
import { RUNNER_ENABLED, applyPairingChange, listRunners } from '../runner-ws.js';
import type { RouteCtx } from '../server.js';

export async function rRunnersGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, {
    enabled: RUNNER_ENABLED,
    runners: listRunners(),
    machines: await listMachines(),
    placements: await listPlacements(),
    // What each connected machine actually has running. An operator who cannot
    // see this can only infer a remote session's fate from central's own
    // bookkeeping, which is exactly what goes stale when a runner misreports.
    sessions: await remoteSessions(),
    imageSource: {
      policy: await getRunnerImagePolicy(),
      ref: await getRunnerImageRef(),
      // What an empty reference resolves to: this install's versions.json pin.
      pin: publisherImageRef() ?? null,
    },
    extension: readExtensionManifest(),
    client: { defaults: derivedClientConfig(), overrides: await getClientOverrides() },
  });
}

/** The install's egress policy for every agent (egress-policy.ts): allowlist, defaults, recently blocked. */
export async function rEgressGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, {
    allowlist: await getRunnerEgressAllowlist(),
    defaults: defaultAllowlist(),
    always: ALWAYS_ALLOWED,
    blocked: listBlocked(),
  });
}

export async function rEgressPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const raw = await readJsonBody(ctx.req, ctx.res);
  if (raw === null) return;
  let body: { allowlist?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(ctx.res, 400, { error: 'Invalid JSON' });
  }
  const parsed = parseAllowlist(body.allowlist);
  if (!parsed.ok) return json(ctx.res, 400, { error: parsed.error });
  await setRunnerEgressAllowlist(parsed.patterns);
  return json(ctx.res, 200, { allowlist: parsed.patterns, blocked: listBlocked() });
}

/** Ask every connected runner what it is running. Best effort: a silent runner reports as unreachable. */
export async function remoteSessions(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  await Promise.all(
    connectedRunnerFingerprints().map(async (fingerprint) => {
      try {
        const res = await runnerRequest(fingerprint, 'list', { installSlug: INSTALL_SLUG }, 8000);
        const rows = Array.isArray(res.sessions) ? (res.sessions as Array<Record<string, unknown>>) : [];
        for (const r of rows) out.push({ fingerprint, ...r });
      } catch (err) {
        out.push({ fingerprint, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  return out;
}

/** The container's own output, from the machine running it. */
export async function rRunnerLogsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const fingerprint = ctx.url.searchParams.get('fingerprint') ?? '';
  const name = ctx.url.searchParams.get('name') ?? '';
  const tail = Number(ctx.url.searchParams.get('tail') ?? '100');
  if (!/^[0-9a-f]{16,128}$/.test(fingerprint)) return json(ctx.res, 400, { error: 'fingerprint required' });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) return json(ctx.res, 400, { error: 'name required' });
  try {
    const res = await runnerRequest(fingerprint, 'logs', { name, tail: Number.isFinite(tail) ? tail : 100 }, 25_000);
    return json(ctx.res, 200, { lines: Array.isArray(res.lines) ? res.lines : [] });
  } catch (err) {
    return json(ctx.res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rRunnerExtensionGet(ctx: RouteCtx): Promise<void> {
  const m = readExtensionManifest();
  if (!m) return json(ctx.res, 404, { error: 'no runner extension published' });
  return json(ctx.res, 200, { version: m.version, sha256: m.sha256, size: m.size, publishedAt: m.publishedAt });
}

export async function rRunnerExtensionDownload(ctx: RouteCtx): Promise<void> {
  const served = publishedExtensionPath();
  if (!served) return json(ctx.res, 404, { error: 'no runner extension published' });
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(served.manifest.size),
    'Content-Disposition': `attachment; filename="${served.manifest.file}"`,
    'X-NanoClaw-Version': served.manifest.version,
    'X-NanoClaw-SHA256': served.manifest.sha256,
    'Cache-Control': 'no-store',
  });
  createReadStream(served.filePath).pipe(ctx.res);
}

/**
 * Publish a runner package. The body is the .vsix itself; the filename (and so
 * the version) comes from the X-NanoClaw-Filename header. Admin only: this is
 * code that will run on every paired developer's machine.
 */
export async function rRunnerExtensionPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const name = String(ctx.req.headers['x-nanoclaw-filename'] ?? '').trim();
  const version = versionFromVsixName(name);
  if (!version)
    return json(ctx.res, 400, { error: 'send the package as nanoclaw-<version>.vsix (X-NanoClaw-Filename)' });
  const MAX = 64 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of ctx.req) {
      size += (chunk as Buffer).length;
      if (size > MAX) {
        ctx.req.destroy();
        return json(ctx.res, 413, { error: 'package too large' });
      }
      chunks.push(chunk as Buffer);
    }
  } catch {
    return json(ctx.res, 400, { error: 'upload failed' });
  }
  const bytes = Buffer.concat(chunks);
  // A .vsix is a zip; refuse anything that plainly is not one rather than
  // serving it to every laptop.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return json(ctx.res, 400, { error: 'that does not look like a .vsix package' });
  }
  const tmp = path.join(os.tmpdir(), `ncl-upload-${randomUUID()}.vsix`);
  try {
    fs.writeFileSync(tmp, bytes);
    const manifest = publishExtension(tmp, version);
    log.info('Runner extension published from the web UI', { version, size: bytes.length, by: ctx.userId });
    return json(ctx.res, 200, {
      version: manifest.version,
      sha256: manifest.sha256,
      size: manifest.size,
      publishedAt: manifest.publishedAt,
    });
  } catch (err) {
    return json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Where paired machines get the agent image. Install-wide and binding: 'pull'
 * or 'build' overrides each laptop's own preference, 'machine' hands the
 * choice back. Takes effect on the next spawn — the fleet driver reads it per
 * prepare rather than caching it.
 */
export async function rRunnerImageSourcePut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const raw = await readJsonBody(ctx.req, ctx.res);
  if (raw === null) return;
  let body: { policy?: unknown; ref?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(ctx.res, 400, { error: 'Invalid JSON' });
  }
  const policy = body.policy;
  if (policy !== 'machine' && policy !== 'pull' && policy !== 'build') {
    return json(ctx.res, 400, { error: "policy must be 'machine', 'pull' or 'build'" });
  }
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (ref && /\s/.test(ref)) return json(ctx.res, 400, { error: 'Image reference cannot contain whitespace' });
  if (policy === 'pull' && !ref && !publisherImageRef()) {
    return json(ctx.res, 409, {
      error: 'Pulling needs a reference: this install pins none in versions.json, so enter one.',
    });
  }
  await setRunnerImagePolicy(policy as RunnerImagePolicy);
  await setRunnerImageRef(ref || null);
  return json(ctx.res, 200, { policy, ref: ref || null, pin: publisherImageRef() ?? null });
}

export async function rRunnerMachineApprovePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const fingerprint = m[1];
  if (!(await getMachine(fingerprint))) return json(ctx.res, 404, { error: 'Unknown machine' });
  // Same path as the approval card: approve, then (by default) a dedicated agent group placed on the machine.
  const outcome = await completeApproval(fingerprint, ctx.userId);
  return json(ctx.res, 200, outcome);
}

export async function rRunnerMachineRevokePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const fingerprint = m[1];
  if (!(await getMachine(fingerprint))) return json(ctx.res, 404, { error: 'Unknown machine' });
  const machine = await revokeMachine(fingerprint, ctx.userId);
  applyPairingChange(fingerprint, 'revoked');
  return json(ctx.res, 200, { machine });
}

export async function rRunnerPlacementPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const agentGroupId = decodeURIComponent(m[1]);
  const raw = await readJsonBody(ctx.req, ctx.res);
  if (raw === null) return;
  let body: { fingerprint?: unknown; slots?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(ctx.res, 400, { error: 'Invalid JSON' });
  }
  if (!isSafeRunnerId(body.fingerprint)) return json(ctx.res, 400, { error: 'fingerprint required' });
  const slots = body.slots && typeof body.slots === 'object' ? (body.slots as Record<string, unknown>) : {};
  try {
    const placement = await setPlacement(agentGroupId, body.fingerprint, ctx.userId, slots);
    return json(ctx.res, 200, { placement });
  } catch (err) {
    if (err instanceof PlacementError) return json(ctx.res, 409, { error: err.message, code: err.code });
    throw err;
  }
}

export async function rRunnerPlacementDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const removed = await deletePlacement(decodeURIComponent(m[1]));
  return removed
    ? json(ctx.res, 200, { ok: true })
    : json(ctx.res, 404, { error: 'No placement for that agent group' });
}

/**
 * The caller's own machines: whether the VS Code extension has connected from
 * them and whether an owner approved it yet. Any signed-in user, and only their
 * own — it drives the first-run VS Code card for someone with no rooms yet.
 */
export async function rRunnerMineGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const connected = new Set(connectedRunnerFingerprints());
  const mine = (await listMachines())
    .filter((m) => m.user_id === ctx.userId && m.status !== 'revoked')
    .sort((a, b) => b.last_seen - a.last_seen)
    .map((m) => ({ hostname: m.hostname, status: m.status, connected: connected.has(m.fingerprint) }));
  return json(ctx.res, 200, { machines: mine });
}

/** The extension's sign-in settings. Any signed-in user: the extension and the "Connect VS Code" link read them. */
export async function rRunnerClientConfigGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, effectiveClientConfig(await getClientOverrides()));
}

export async function rRunnerClientConfigPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const raw = await readJsonBody(ctx.req, ctx.res);
  if (raw === null) return;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(ctx.res, 400, { error: 'Invalid JSON' });
  }
  const parsed = parseOverrides(body);
  if (!parsed.ok) return json(ctx.res, 400, { error: parsed.error });
  await setClientOverrides(parsed.overrides);
  return json(ctx.res, 200, { defaults: derivedClientConfig(), overrides: parsed.overrides });
}
