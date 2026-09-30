// ── Runner routes ─────────────────────────────────────────────────────
// Manage → Runners and Manage → Network. Everything that changes state is
// owner / global-admin only (the 'globalAdmin' guard in server.ts), the same
// set that receives pairing cards; the extension package is served to any
// signed-in user because it is the client itself.
import { randomUUID } from 'crypto';
import fs, { createReadStream } from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream';

import { json, readJsonBody } from './http.js';
import { log } from '../../../log.js';
import {
  SignatureRefused,
  decodeSignatureHeader,
  encodeSignatureHeader,
  publishExtension,
  publishedExtensionPath,
  readExtensionManifest,
  signPublishedExtension,
  versionFromVsixName,
} from '../runner-extension.js';
import { completeApproval } from '../runner-pairing.js';
import { applyPlacementMode, releasePlacement } from '../runner-tools.js';
import {
  PlacementError,
  deletePlacement,
  getPlacement,
  getMachine,
  isSafeRunnerId,
  listMachines,
  listPlacements,
  revokeMachine,
  setPlacement,
} from '../runner-registry.js';
import { connectedRunnerFingerprints } from '../runner-transport.js';
import {
  derivedClientConfig,
  effectiveClientConfig,
  getClientOverrides,
  mergeOverrides,
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
    placements: (await listPlacements()).map(({ tools_token: _token, ...p }) => p),
    extension: readExtensionManifest(),
    client: { defaults: derivedClientConfig(), overrides: await getClientOverrides() },
  });
}

export async function rRunnerExtensionGet(ctx: RouteCtx): Promise<void> {
  const m = readExtensionManifest();
  if (!m) return json(ctx.res, 404, { error: 'no runner extension published' });
  return json(ctx.res, 200, {
    version: m.version,
    sha256: m.sha256,
    size: m.size,
    publishedAt: m.publishedAt,
    ...(m.id ? { id: m.id } : {}),
    ...(m.signature ? { signature: m.signature } : {}),
  });
}

/**
 * Send a file as the response body. The read stream is closed when the
 * client goes away mid-download and a read error ends the response, rather
 * than leaving an open descriptor on an archive that may already have been
 * replaced (hundreds of MB held on disk) or an unhandled stream error.
 */
function sendFile(ctx: RouteCtx, filePath: string): void {
  pipeline(createReadStream(filePath), ctx.res, (err) => {
    if (!err) return;
    const aborted = (err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE';
    if (aborted) log.debug('Runner download: client went away', { file: path.basename(filePath) });
    else log.warn('Runner download failed', { file: path.basename(filePath), err: err.message });
  });
}

/** The install's release key, when an owner named one: a signature by any other key is refused on upload. */
async function releaseKey(): Promise<string | null> {
  return (await getClientOverrides()).releaseKey ?? null;
}

/** Read a signature file sent as a JSON body; answers 400 itself and returns undefined when it is not JSON. */
async function readSignatureBody(ctx: RouteCtx): Promise<unknown> {
  const raw = await readJsonBody(ctx.req, ctx.res);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    json(ctx.res, 400, { error: 'Invalid JSON' });
    return undefined;
  }
}

/** Attach the operator's signature to the runner package central serves now. */
export async function rRunnerExtensionSignaturePut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readSignatureBody(ctx);
  if (body === undefined) return;
  try {
    const m = signPublishedExtension(body, await releaseKey());
    return json(ctx.res, 200, { version: m.version, sha256: m.sha256, signature: m.signature });
  } catch (err) {
    if (err instanceof SignatureRefused) return json(ctx.res, 409, { error: err.message });
    throw err;
  }
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
    // With the bytes, so the runner checks the signature of exactly what it downloaded.
    ...(served.manifest.signature ? { 'X-NanoClaw-Signature': encodeSignatureHeader(served.manifest.signature) } : {}),
    'Cache-Control': 'no-store',
  });
  sendFile(ctx, served.filePath);
}

/**
 * Publish a runner package. The body is the .vsix itself; the filename (and so
 * the version) comes from the X-NanoClaw-Filename header, and its signature
 * file, when there is one, from X-NanoClaw-Signature (base64 of the .sig).
 * Admin only: this is code that will run on every paired developer's machine.
 */
export async function rRunnerExtensionPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const name = String(ctx.req.headers['x-nanoclaw-filename'] ?? '').trim();
  const version = versionFromVsixName(name);
  if (!version)
    return json(ctx.res, 400, { error: 'send the package as nanoclaw-<version>.vsix (X-NanoClaw-Filename)' });
  const signature = decodeSignatureHeader(ctx.req.headers['x-nanoclaw-signature']);
  if (signature === null) return json(ctx.res, 400, { error: 'X-NanoClaw-Signature is not a base64 signature file' });
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
    const manifest = publishExtension(tmp, version, signature, await releaseKey());
    log.info('Runner extension published from the web UI', {
      version,
      size: bytes.length,
      signed: !!manifest.signature,
      by: ctx.userId,
    });
    return json(ctx.res, 200, {
      version: manifest.version,
      sha256: manifest.sha256,
      size: manifest.size,
      publishedAt: manifest.publishedAt,
      signed: !!manifest.signature,
    });
  } catch (err) {
    if (err instanceof SignatureRefused) return json(ctx.res, 409, { error: err.message });
    return json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
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
  // Revoking drops the machine's placements; each group gets its own configuration back.
  const placed = (await listPlacements()).filter((p) => p.fingerprint === fingerprint);
  const machine = await revokeMachine(fingerprint, ctx.userId);
  applyPairingChange(fingerprint, 'revoked');
  for (const p of placed) await releasePlacement(p.agent_group_id, p);
  return json(ctx.res, 200, { machine });
}

export async function rRunnerPlacementPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const agentGroupId = decodeURIComponent(m[1]);
  const raw = await readJsonBody(ctx.req, ctx.res);
  if (raw === null) return;
  let body: { fingerprint?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(ctx.res, 400, { error: 'Invalid JSON' });
  }
  if (!isSafeRunnerId(body.fingerprint)) return json(ctx.res, 400, { error: 'fingerprint required' });
  try {
    const placement = await setPlacement(agentGroupId, body.fingerprint, ctx.userId);
    await applyPlacementMode(agentGroupId, placement);
    // The token authenticates the agent's container; it is not for the browser.
    const { tools_token: _token, ...shown } = placement;
    return json(ctx.res, 200, { placement: shown });
  } catch (err) {
    if (err instanceof PlacementError) return json(ctx.res, 409, { error: err.message, code: err.code });
    throw err;
  }
}

export async function rRunnerPlacementDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const agentGroupId = decodeURIComponent(m[1]);
  const before = await getPlacement(agentGroupId);
  const removed = await deletePlacement(agentGroupId);
  if (removed && before) await releasePlacement(agentGroupId, before);
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
    // `runner`: the extension build it last connected with — the Connect link needs 0.13+ (the id changed).
    .map((m) => ({
      hostname: m.hostname,
      status: m.status,
      connected: connected.has(m.fingerprint),
      runner: m.runner_version,
    }));
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
  const overrides = mergeOverrides(await getClientOverrides(), body, parsed.overrides);
  await setClientOverrides(overrides);
  return json(ctx.res, 200, { defaults: derivedClientConfig(), overrides });
}
