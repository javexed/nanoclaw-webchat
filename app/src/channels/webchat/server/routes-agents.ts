// ── Agent routes ─────────────────────────────────────────────────────────────
// Everything addressed at an agent group: create, update, delete, status, the
// model assigned to it, its MCP servers and skills, the scoped-skill import and
// delete, drafts, and agent import (upload, then apply).
//
// The last cluster out of server.ts, and the only one that needed no shared
// layer of its own — agent-lookup, agent-wiring, model-wiring, archive and
// skills-store had already absorbed everything it shares with the rest.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { GROUPS_DIR } from '../../../config.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';
import {
  createAgentGroup,
  deleteAgentGroup,
  getAgentGroup,
  setAgentStatus,
  updateAgentGroup,
} from '../../../db/agent-groups.js';
import { getDb, hasTable } from '../../../db/connection.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../../db/container-configs.js';
import { getSessionsByAgentGroup } from '../../../db/sessions.js';
import { listSkillDrafts } from '../../../db/skill-drafts.js';
import { initGroupFilesystem } from '../../../group-init.js';
import { log } from '../../../log.js';
import {
  deleteAgentEnv,
  isValidEnvName,
  listAgentEnvNames,
  setAgentEnv,
  validateEnvValue,
} from '../../../modules/agent-env/store.js';
import { listArchivedSkills } from '../../../modules/learning/curator.js';
import { grantRole as permsGrantRole } from '../../../modules/permissions/db/user-roles.js';
import { inspectSkillFiles } from '../../../modules/skills/inspect.js';
import {
  applyImport,
  exportTarArgs,
  extractBundle,
  previewImport,
  stageAgentExport,
} from '../../../modules/transfer/agent-transfer.js';
import { deleteSessionDbState, findSessionsByAgentGroup, teardownSessionResources } from '../../../session-teardown.js';
import type { AgentGroup } from '../../../types.js';
import {
  assignModelToAgent,
  deleteWebchatRoom,
  getAssignedModelForAgent,
  getWebchatModel,
  getWebchatRoomsForAgent,
  setPrimeAgentForWebchatRoom,
  unassignModelFromAgent,
} from '../db.js';
import { DraftError, draftAgent } from '../drafter.js';
import {
  assignMcpServerToAgent,
  getMcpServersForAgent,
  getWebchatMcpServer,
  getWebchatMcpServerByName,
  syncAgentMcpConfig,
  unassignMcpServerFromAgent,
} from '../mcp-registry.js';
import {
  isPlausibleAnthropicModelId,
  syncAgentProviderForAssignedModel,
  writeAgentSettingsForAssignedModel,
  writeOpencodeModelForAgent,
} from '../models.js';
import { probeContainerReachability } from '../reachability.js';
import { hasAdminPrivilege, isAnyAdmin, isGlobalAdmin, isOwner } from '../roles.js';
import { listAgentsForUser, resolveAgent, toAgentForUI } from './agent-lookup.js';
import {
  createBareAgentGroup,
  nameToFolder,
  newAgentGroupId,
  parseAgentLearning,
  wireAgentToWebchatRoom,
} from './agent-wiring.js';
import { pendingAgentImports, spawnTar, spoolUploadToTmp, sweepPendingImports } from './archive.js';
import { mcpServerForUI, reloadAgentMcpServers } from './mcp-registry.js';
import { reloadAgentModelEnv } from './model-wiring.js';
import { codexAvailable, opencodeAvailable, piAvailable } from './providers.js';
import { fetchGithubDir, latestCommitSha, resolveDiscoveredSkillUrl, resolveSourceUrl } from './skill-sources.js';
import {
  SkillOrigin,
  USER_SKILLS_DIR,
  listAvailableSkills,
  listScopedSkills,
  sanitizeOrigin,
  sanitizeSkillName,
  scopedSkillsDir,
} from './skills-store.js';
import { broadcastRooms } from '../state.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { RouteCtx } from '../server.js';

// ── Agents (= agent groups) ─────────────────────────────────────────────
export async function rAgentsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  const includeArchived = url.searchParams.get('includeArchived') === '1';
  return json(res, 200, listAgentsForUser(userId, includeArchived));
}

// POST /api/agents/draft must come BEFORE the /api/agents/:id pattern
// (which would otherwise match 'draft' as an id) AND before the bare
// /api/agents POST so the literal-path handlers stay distinct.
export async function rAgentsDraftPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin only' });
  if (req.headers['x-webchat-csrf'] !== '1') {
    return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  }
  return draftAgentHandler(req, res);
}

export async function rAgentsPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin only' });
  return createAgentHandler(req, res, userId);
}

export async function rAgentPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  return updateAgentHandler(req, res, group.id);
}

export async function rAgentDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  return deleteAgentHandler(res, group.id);
}

// GET the rooms an agent is wired to (agent-centric mirror of
// GET /api/rooms/:id/agents). Read-only; writes go through the existing
// owner-only POST/DELETE /api/rooms/:roomId/agents endpoints.
export async function rAgentRoomsGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  return json(res, 200, getWebchatRoomsForAgent(group.id));
}

// ── Per-agent model assignment ─────────────────────────────────────────
export async function rAgentModelPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  return assignAgentModelHandler(req, res, group.id);
}

// PUT /api/agents/:id/provider — set the agent HARNESS ('claude' built-in or
// 'opencode'). Stored in container_configs.provider (claude = null default);
// restarts the group so the new harness takes effect. 'opencode' is gated on the
// stack being installed. An explicit choice survives model (re)assignment (see
// syncAgentProviderForAssignedModel).
export async function rAgentProviderPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { provider?: unknown };
  try {
    body = JSON.parse(raw) as { provider?: unknown };
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const provider = String(body.provider ?? 'claude');
  const allowed = new Set(['claude']);
  if (opencodeAvailable()) allowed.add('opencode');
  if (piAvailable()) allowed.add('pi');
  if (codexAvailable()) allowed.add('codex');
  if (!allowed.has(provider)) {
    return json(res, 400, {
      error:
        provider === 'opencode'
          ? 'OpenCode harness is not installed — install the OpenCode stack first.'
          : `Unknown harness: ${provider}`,
    });
  }
  ensureContainerConfig(group.id);
  updateContainerConfigScalars(group.id, { provider: provider === 'claude' ? null : provider });
  // (Re)write the local-model wiring for the NEW harness before the respawn —
  // opencode/pi read it at spawn; without this the switch only takes effect
  // after the next boot convergence or model change.
  try {
    writeOpencodeModelForAgent(group.id);
  } catch (err) {
    log.warn('Webchat: wiring write after harness switch failed', { agentGroupId: group.id, err });
  }
  const restarted = restartAgentGroupContainers(group.id, 'Harness changed');
  return json(res, 200, { ok: true, provider, restarted });
}

/**
 * PUT /api/agents/:id/config-model — pin the Anthropic model this agent runs on.
 *
 * Writes `container_configs.model`, which the container runner materializes into
 * `container.json` and the agent-runner passes to the Claude Agent SDK as its
 * `model` option. This is the SAME lever as
 * `ncl groups config update --model <id>`, and it is the ONLY one the runner
 * actually reads for the built-in Claude harness — which is why webchat needed
 * it: before this route there was no UI path to it at all, and an agent pinned
 * by ncl still rendered as "Default / Built-in Anthropic".
 *
 * Empty body value clears the pin (back to the SDK's own default).
 *
 * Refuses when an `anthropic`-kind webchat model is assigned to the group. That
 * assignment sets ANTHROPIC_MODEL in the group's settings.json env, and the SDK's
 * explicit `model` option overrides the env var — so having both would silently
 * ignore the assignment. Better to make the operator pick one lever.
 */
export async function rAgentConfigModelPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { model?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (model && !isPlausibleAnthropicModelId(model)) {
    return json(res, 400, { error: 'That does not look like a model id (letters, digits, . _ - only).' });
  }
  const assigned = getAssignedModelForAgent(group.id);
  if (model && assigned && assigned.kind === 'anthropic') {
    return json(res, 409, {
      error: `This agent is assigned the webchat model "${assigned.name}", which already sets its Anthropic model. Unassign it first, or change the model there instead.`,
    });
  }
  ensureContainerConfig(group.id);
  updateContainerConfigScalars(group.id, { model: model || null });
  const restarted = restartAgentGroupContainers(group.id, 'Model changed');
  return json(res, 200, { ok: true, model: model || null, restarted });
}

/**
 * Per-agent network egress.
 *
 * `open` — normal: the agent reaches the network directly.
 * `host-only` — the agent runs on an internal docker network with only the
 *   OneCLI gateway attached, so the credential proxy is the sole hop out.
 *
 * `none` (no network at all) is intentionally NOT settable here. It leaves the
 * agent unable to reach ANY model API — Anthropic, or a host-local LiteLLM or
 * Ollama — so it cannot run at all. `ncl groups config update --egress none`
 * remains for a genuinely air-gapped container.
 *
 * Takes effect on the agent's next spawn; running containers keep the network
 * they started with.
 */
export async function rAgentEgressPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { egress?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (body.egress !== 'open' && body.egress !== 'host-only')
    return json(res, 400, { error: "egress must be 'open' or 'host-only'" });
  // A group that has never spawned has no container_configs row, and the scalar
  // update is an UPDATE — it would match nothing and still report success.
  ensureContainerConfig(group.id);
  // 'open' is stored as NULL — the column's absent state IS open, and writing
  // the string would make "never set" and "explicitly open" look different to
  // every reader of the row for no gain.
  updateContainerConfigScalars(group.id, { egress: body.egress === 'open' ? null : 'host-only' });
  log.info('Agent egress changed', { agentGroupId: group.id, egress: body.egress, by: userId });
  return json(res, 200, { ok: true, egress: body.egress });
}

/**
 * Per-agent environment variables.
 *
 * GET returns NAMES ONLY — never values. That asymmetry is the feature: the agent
 * (and this panel) needs to know `$SABNZBD_API_KEY` exists, and neither needs to
 * see it. A value that can be read back has gained nothing over a workspace file.
 *
 * For anything the container must never see at all, use a vault tool-secret
 * instead — there the gateway injects a header and the value never enters the
 * container. This tier is for what the gateway cannot inject: query-parameter
 * API keys, SSH passwords.
 *
 * Applies at the agent's next spawn; env is fixed at container start.
 */
export async function rAgentEnv(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, url, method, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (method === 'GET') return json(res, 200, { names: listAgentEnvNames(group.id) });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (method === 'DELETE') {
    const name = url.searchParams.get('name') ?? '';
    return deleteAgentEnv(group.id, name)
      ? json(res, 200, { ok: true, names: listAgentEnvNames(group.id) })
      : json(res, 404, { error: 'No such variable' });
  }
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; value?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (!isValidEnvName(body.name))
    return json(res, 400, { error: 'name must be UPPER_SNAKE_CASE, starting with a letter or underscore' });
  const bad = validateEnvValue(body.value);
  if (bad) return json(res, 400, { error: bad.error });
  setAgentEnv(group.id, body.name, body.value as string);
  // Name only — the value must not reach the log.
  log.info('Agent env var set', { agentGroupId: group.id, name: body.name, by: userId });
  return json(res, 200, { ok: true, names: listAgentEnvNames(group.id) });
}

export async function rAgentMcp(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (method === 'GET') return listAgentMcpHandler(res, group.id);
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return setAgentMcpHandler(req, res, group.id);
}

export async function rAgentSkills(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (method === 'GET') {
    const available = listAvailableSkills();
    // getContainerConfig returns the raw row — skills is a JSON string ("all"
    // or a name array), so parse it (configFromDb does the same).
    let sel: string[] | 'all' = 'all';
    try {
      const rawSkills = getContainerConfig(group.id)?.skills;
      if (rawSkills != null) sel = JSON.parse(rawSkills) as string[] | 'all';
    } catch {
      sel = 'all';
    }
    const enabled = sel === 'all' ? available.map((s) => s.name) : sel;
    // Also surface skills wired to THIS agent only (real dirs in its own
    // .claude-shared/skills), which the shared pool doesn't include.
    return json(res, 200, {
      available,
      enabled,
      scoped: listScopedSkills(group.id),
      // Curator output: scoped skills archived for disuse. Restorable, never deleted.
      archived: listArchivedSkills(group.id),
    });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return setAgentSkillsHandler(req, res, group.id);
}

// Import a skill wired to ONE agent (its own .claude-shared/skills), so it
// reaches only that group — never the shared pool / other 'all' agents.
// Per-group admin is sufficient: it can't affect any other group.
export async function rAgentSkillImportPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importScopedSkillHandler(req, res, group.id);
}

// ── Agent export/import (backup Phase 1) ──────────────────────────────
export async function rAgentExportGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const withConvos = url.searchParams.get('conversations') === '1';
  // Session DBs are DELETE-mode journals — only safe to copy with the
  // agent's containers stopped. They respawn on the next message.
  if (withConvos) restartAgentGroupContainers(group.id, 'Export with conversations');
  let stage: string;
  try {
    stage = stageAgentExport(group.id, withConvos);
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  const fname = `nanoclaw-agent-${group.folder}-${new Date().toISOString().slice(0, 10)}.tgz`;
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${fname}"`,
  });
  const tar = spawnTar(exportTarArgs(stage, group, withConvos));
  tar.stdout?.pipe(res);
  let tarErr = '';
  tar.stderr?.on('data', (d: Buffer) => (tarErr += d));
  tar.on('close', (code: number) => {
    fs.rmSync(stage, { recursive: true, force: true });
    if (code !== 0) {
      log.error('Agent export tar failed', { agent: group.id, code, err: tarErr.slice(0, 300) });
      res.destroy();
    } else {
      res.end();
    }
  });
  res.on('close', () => tar.kill('SIGTERM'));
  return;
}

export async function rAgentsImportPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importAgentUploadHandler(req, res);
}

export async function rAgentsImportApplyPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importAgentApplyHandler(req, res);
}

export async function rAgentLearning(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  const current = parseAgentLearning(group.id);
  // Auto-keep is admin-tier like the manual Keep it automates: a scoped admin
  // can already keep any draft for their agent with a tap, so gating the
  // toggle higher only added friction, not protection. The blast radius is
  // unchanged — a kept skill is scoped to the one agent they administer.
  const canAutoKeep = hasAdminPrivilege(userId, group.id);
  if (method === 'GET') {
    return json(res, 200, {
      autoTrigger: current.autoTrigger !== false, // absent = on
      autoKeep: current.autoKeep === true, // absent = off
      reviewModel: current.reviewModel ?? null, // absent = the agent's own model
      replayReview: current.replayReview === true, // absent = digest
      chargeInvoker: current.chargeInvoker ?? 'auto', // absent = auto (guarded)
      canAutoKeep,
    });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: {
    autoTrigger?: unknown;
    autoKeep?: unknown;
    reviewModel?: unknown;
    replayReview?: unknown;
    chargeInvoker?: unknown;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const next = { ...current };
  if (typeof body.autoTrigger === 'boolean') next.autoTrigger = body.autoTrigger;
  if (typeof body.autoKeep === 'boolean') {
    if (!canAutoKeep) return json(res, 403, { error: 'Admin privilege required for auto-keep' });
    next.autoKeep = body.autoKeep;
  }
  // Review-model / review-input keys ride the same learning JSON. On this
  // branch they round-trip dormant — the container-side digest review
  // (PR #353) is what consumes them; until it merges nothing reads them.
  if ('chargeInvoker' in body) {
    const ci = body.chargeInvoker;
    if (ci !== 'off' && ci !== 'auto' && ci !== 'require') {
      return json(res, 400, { error: 'chargeInvoker must be one of: auto, require, off' });
    }
    // 'off' re-opens workspace-credential spend to every member — a strictly
    // wider blast radius than the default, so it needs more than scoped admin.
    if (ci === 'off' && !(isOwner(userId) || isGlobalAdmin(userId))) {
      return json(res, 403, { error: "Only an owner or global admin can set chargeInvoker to 'off'" });
    }
    if (ci === 'auto') delete next.chargeInvoker;
    else next.chargeInvoker = ci;
  }
  if ('reviewModel' in body) {
    const rm = body.reviewModel;
    if (rm !== null && (typeof rm !== 'string' || !rm.trim() || rm.length > 200)) {
      return json(res, 400, { error: 'reviewModel must be a model id or null' });
    }
    if (rm === null) delete next.reviewModel;
    else next.reviewModel = (rm as string).trim();
  }
  if (typeof body.replayReview === 'boolean') {
    if (body.replayReview) next.replayReview = true;
    else delete next.replayReview; // absent = digest, the default
  }
  updateContainerConfigJson(group.id, 'learning', next);
  // Config materializes at spawn — restart so the container sees it now.
  const restarted = restartAgentGroupContainers(group.id, 'Learning settings changed');
  return json(res, 200, {
    ok: true,
    autoTrigger: next.autoTrigger !== false,
    autoKeep: next.autoKeep === true,
    reviewModel: next.reviewModel ?? null,
    replayReview: next.replayReview === true,
    canAutoKeep,
    restarted,
  });
}

export async function rAgentScopedSkillDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return deleteScopedSkillHandler(res, group.id, decodeURIComponent(m[2]));
}

// ── Lifecycle status (active | paused | archived) ──────────────────────
export async function rAgentStatusPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  return setAgentStatusHandler(req, res, group.id);
}

// ── Sessions (list + reset) ────────────────────────────────────────────
// Lets an admin reach an agent's sessions — including background a2a
// sessions no room-typed /clear can target — and reset one (inject /clear).
export async function rAgentSessionsGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  const sessions = getSessionsByAgentGroup(group.id)
    .filter((s) => s.status === 'active')
    .map((s) => ({
      id: s.id,
      thread_id: s.thread_id,
      container_status: s.container_status,
      last_active: s.last_active,
    }));
  return json(res, 200, { sessions });
}

/**
 * Provision an agent + its webchat room together. Used by both POST /api/agents
 * (agent-first) and POST /api/rooms (room-first) so they end up in the same
 * shape regardless of which entry point the caller used.
 */
export function provisionWebchatAgentWithRoom(
  name: string,
  opts: { folder?: string; instructions?: string } = {},
): { group: AgentGroup } | { error: string; status: number } {
  const folder = opts.folder && /^[a-z0-9_-]+$/i.test(opts.folder) ? opts.folder : nameToFolder(name);
  if (!folder) return { error: 'Could not derive folder from name', status: 400 };
  const group: AgentGroup = {
    id: newAgentGroupId(),
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
    status: 'active',
  };

  // The three steps (DB row, on-disk folder, wiring) need to land together
  // or roll back together. Without the transaction, an exception in
  // initGroupFilesystem / wireAgentToWebchatRoom leaves an orphan agent_group
  // row + (possibly) a half-initialized folder, and the next retry hits a
  // UNIQUE-violation on agent_groups.folder for a row the operator didn't
  // intend to keep.
  const groupDir = path.resolve(GROUPS_DIR, folder);
  const dirExisted = fs.existsSync(groupDir);
  try {
    getDb().transaction(() => {
      createAgentGroup(group);
      initGroupFilesystem(group, { instructions: opts.instructions });
      wireAgentToWebchatRoom(name, folder, group.id);
      // Auto-prime the agent on its own 1:1 room. With a single wired
      // agent the prime designation is a no-op for routing (engage_pattern
      // stays '.'), but pre-priming means that when the operator wires a
      // second agent later, the original keeps responding by default —
      // matching the user-visible expectation "the first agent answers
      // until I say otherwise."
      setPrimeAgentForWebchatRoom(folder, group.id);
    })();
  } catch (err) {
    // SQLite error messages can leak schema details ("UNIQUE constraint
    // failed: agent_groups.folder"). Return a stable string and log the
    // detail for the operator.
    log.warn('Webchat: provisionWebchatAgentWithRoom failed', { folder, err });
    // Roll back the on-disk side ourselves — the DB transaction already
    // rolled back its rows, but initGroupFilesystem may have created the
    // directory before the failing step.
    if (!dirExisted) {
      try {
        fs.rmSync(groupDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    const conflict =
      err instanceof Error && /UNIQUE|already exists/i.test(err.message)
        ? { error: 'Agent group already exists', status: 409 as const }
        : { error: 'Could not create agent group', status: 500 as const };
    return conflict;
  }
  return { group };
}

export async function createAgentHandler(
  req: IncomingMessage,
  res: ServerResponse,
  creatorUserId: string,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: {
    name?: unknown;
    folder?: unknown;
    instructions?: unknown;
    withRoom?: unknown;
    roomName?: unknown;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return json(res, 400, { error: 'name required' });
  }
  const name = body.name.trim();

  // `withRoom` defaults to false: agents are entities, rooms are conversation
  // spaces. Creating an agent does not implicitly publish it to a chat
  // surface — wire it into a room afterwards (`POST /api/rooms` or the
  // PWA's "+ Add agent" inside an existing room). Pass `withRoom: true`
  // explicitly to opt into the legacy 1:1 agent-and-room provisioning.
  if (body.withRoom !== true) {
    const result = createBareAgentGroup(name, {
      folder: typeof body.folder === 'string' ? body.folder : undefined,
      instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    });
    if ('error' in result) return json(res, result.status, { error: result.error });
    grantCreatorAdmin(creatorUserId, result.group.id);
    return json(res, 200, { ok: true, agentGroup: result.group, roomId: null });
  }

  const roomName = typeof body.roomName === 'string' && body.roomName.trim() ? body.roomName.trim() : name;
  const provisioned = provisionWebchatAgentWithRoom(roomName, {
    folder: typeof body.folder === 'string' ? body.folder : undefined,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
  });
  if ('error' in provisioned) return json(res, provisioned.status, { error: provisioned.error });
  grantCreatorAdmin(creatorUserId, provisioned.group.id);
  broadcastRooms();
  return json(res, 200, {
    ok: true,
    agentGroup: provisioned.group,
    roomId: provisioned.group.folder,
  });
}

/**
 * Auto-grant the creator scoped admin on the agent they just created.
 *
 * Agent creation is gated on `isAnyAdmin` (owner, global admin, or scoped
 * admin of *some* group). A scoped admin creating a new agent would otherwise
 * immediately lose access to it — `listAgentsForUser` and the per-agent admin
 * checks filter to owner / `hasAdminPrivilege(group)`, and the new group isn't
 * one they administer. Granting them scoped admin on the new group closes
 * that gap so "you can create it" implies "you can manage it".
 *
 * Skipped for owners and global admins — they already have authority over
 * every group, so a scoped row would be redundant noise in `user_roles`.
 * No-op if the permissions module isn't installed.
 */
export function grantCreatorAdmin(creatorUserId: string, agentGroupId: string): void {
  if (isOwner(creatorUserId) || isGlobalAdmin(creatorUserId)) return;
  try {
    permsGrantRole({
      user_id: creatorUserId,
      role: 'admin',
      agent_group_id: agentGroupId,
      granted_by: creatorUserId,
      granted_at: new Date().toISOString(),
    });
  } catch (err) {
    log.warn('Failed to auto-grant creator admin on new agent', {
      creatorUserId,
      agentGroupId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function updateAgentHandler(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const existing = getAgentGroup(id);
  if (!existing) return json(res, 404, { error: 'Agent not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; agent_provider?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const updates: { name?: string; agent_provider?: string | null } = {};
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
  if (typeof body.agent_provider === 'string') updates.agent_provider = body.agent_provider;
  if (body.agent_provider === null) updates.agent_provider = null;
  updateAgentGroup(id, updates);
  return json(res, 200, { ok: true });
}

export async function draftAgentHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { prompt?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.prompt !== 'string') {
    return json(res, 400, { error: 'prompt required' });
  }
  try {
    const drafted = await draftAgent(body.prompt);
    return json(res, 200, { ok: true, ...drafted });
  } catch (err) {
    if (err instanceof DraftError) return json(res, err.status, { error: err.message });
    log.warn('Webchat: draftAgentHandler failed', { err });
    return json(res, 500, { error: 'Drafter failed' });
  }
}

export async function importAgentUploadHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  sweepPendingImports();
  let tmpFile: string | null = null;
  try {
    tmpFile = await spoolUploadToTmp(req);
    const dir = await extractBundle(tmpFile);
    const preview = previewImport(dir);
    const token = randomUUID();
    pendingAgentImports.set(token, { dir, at: Date.now() });
    return json(res, 200, { token, preview });
  } catch (err) {
    return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (tmpFile) fs.rmSync(tmpFile, { force: true });
  }
}

export async function importAgentApplyHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { token?: unknown; name?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const staged = pendingAgentImports.get(String(body.token || ''));
  if (!staged) return json(res, 410, { error: 'Import expired — upload the bundle again' });
  try {
    const result = applyImport(staged.dir, { name: typeof body.name === 'string' ? body.name : undefined });
    // Post-link derived state: MCP config re-sync + model env materialization —
    // the same helpers the interactive flows use, so nothing drifts.
    for (const mcpName of result.attachedMcp) {
      const server = getWebchatMcpServerByName(mcpName);
      if (server) syncAgentMcpConfig(result.id, server, true);
    }
    if (result.modelAssigned) {
      writeAgentSettingsForAssignedModel(result.id);
      syncAgentProviderForAssignedModel(result.id);
    }
    pendingAgentImports.delete(String(body.token));
    fs.rmSync(staged.dir, { recursive: true, force: true });
    broadcastRooms();
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    log.error('Agent import apply failed', { err });
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export function deleteAgentHandler(res: ServerResponse, id: string): void {
  const group = getAgentGroup(id);
  if (!group) return json(res, 404, { error: 'Agent not found' });

  // Snapshot every session this agent owns — home-room and any other rooms
  // it's wired to. All of them FK to `agent_groups.id`, so all must be torn
  // down before deleteAgentGroup. Captured before the tx so post-commit
  // resource cleanup can find them.
  const sessions = findSessionsByAgentGroup(id);
  // Draft BODY dirs live on disk keyed by draft id — capture before the tx
  // deletes the rows, remove after commit.
  const draftIds = listSkillDrafts()
    .filter((d) => d.agent_group_id === id)
    .map((d) => d.id);

  try {
    getDb().transaction(() => {
      const db = getDb();
      for (const s of sessions) deleteSessionDbState(s.sessionId);
      db.prepare(`DELETE FROM messaging_group_agents WHERE agent_group_id = ?`).run(id);
      // Drop the model assignment too — the agent is going away, no point
      // keeping a row pointing at a dead agent_group_id.
      unassignModelFromAgent(id);
      // Drop EVERY row that FK-references agent_groups.id — any one of them
      // aborts deleteAgentGroup with "FOREIGN KEY constraint failed". This
      // list mirrors the schema's referencing tables (guarded per table:
      // module tables may be absent on a given install). container_configs
      // is the one every modern agent has (learning/model writes ensure it),
      // which is how a "clean-looking" unwired agent still refused deletion.
      for (const table of [
        'agent_destinations',
        'container_configs',
        'user_roles', // scoped roles die with the agent; global roles have NULL agent_group_id and don't match
        'agent_group_members',
        'pending_approvals',
        'pending_sender_approvals',
        'pending_channel_approvals',
        'skill_drafts',
        'webchat_agent_mcp_servers',
      ]) {
        if (hasTable(db, table)) {
          db.prepare(`DELETE FROM ${table} WHERE agent_group_id = ?`).run(id);
        }
      }
      // a2a policies key by from/to, not agent_group_id — either side dying
      // kills the policy.
      if (hasTable(db, 'agent_message_policies')) {
        db.prepare(`DELETE FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?`).run(
          id,
          id,
        );
      }
      // Delete the home room (its own session rows are already gone above).
      deleteWebchatRoom(group.folder);
      deleteAgentGroup(id);
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Webchat: deleteAgentHandler failed', { id, err });
    return json(res, 500, { error: 'Failed to delete agent', message });
  }

  void teardownSessionResources(sessions, `webchat agent ${id} deleted`);

  for (const draftId of draftIds) {
    try {
      fs.rmSync(path.join(process.cwd(), 'data', 'skill-drafts', draftId), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  const dir = path.resolve(GROUPS_DIR, group.folder);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Webchat: failed to remove group folder', { folder: group.folder, err });
  }

  broadcastRooms();
  return json(res, 200, { ok: true });
}

export async function setAgentStatusHandler(
  req: IncomingMessage,
  res: ServerResponse,
  agentGroupId: string,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { status?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const status = body.status;
  if (status !== 'active' && status !== 'paused' && status !== 'archived') {
    return json(res, 400, { error: "status must be 'active', 'paused', or 'archived'" });
  }
  setAgentStatus(agentGroupId, status);
  const group = getAgentGroup(agentGroupId);
  return json(res, 200, group ? toAgentForUI(group) : { status });
}

export async function assignAgentModelHandler(
  req: IncomingMessage,
  res: ServerResponse,
  agentGroupId: string,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { modelId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  // null = unassign (back to default Anthropic credential + default model)
  if (body.modelId === null) {
    unassignModelFromAgent(agentGroupId);
  } else {
    if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
      return json(res, 400, { error: 'modelId must be a string or null' });
    }
    const model = getWebchatModel(body.modelId.trim());
    if (!model) return json(res, 404, { error: 'Model not found' });
    assignModelToAgent(agentGroupId, body.modelId.trim());
  }
  reloadAgentModelEnv(agentGroupId, 'Webchat model reassigned');
  const current = getAssignedModelForAgent(agentGroupId);
  // Preflight the newly-assigned model from a container's vantage point so the
  // operator learns NOW (not via silent "API retry") if the agent can't reach it.
  const reachability = current ? await probeContainerReachability(current.endpoint) : undefined;
  return json(res, 200, { ok: true, model: current, reachability });
}

export async function setAgentSkillsHandler(
  req: IncomingMessage,
  res: ServerResponse,
  agentGroupId: string,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { skills?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (!Array.isArray(body.skills)) return json(res, 400, { error: 'skills array required' });
  const available = new Set(listAvailableSkills().map((s) => s.name));
  const skills = [...new Set(body.skills.map(String).filter((s) => available.has(s)))];
  // Persist the explicit selection (switches the agent off the 'all' default) and
  // respawn so syncSkillSymlinks re-points .claude/skills before the next turn.
  updateContainerConfigJson(agentGroupId, 'skills', skills);
  const restarted = restartAgentGroupContainers(agentGroupId, 'Webchat skills changed');
  return json(res, 200, { ok: true, skills, restarted });
}

// Import a GitHub skill wired to ONE agent group: staged into that group's own
// .claude-shared/skills/<name> (a real dir), so only that group loads it. Accepts
// a repo/folder URL (incl. a bare repo root for a one-skill repo).
export async function importScopedSkillHandler(
  req: IncomingMessage,
  res: ServerResponse,
  agentGroupId: string,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown; repo?: unknown; name?: unknown; origin?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let url = String(body.url || '').trim();
  // Marketplace items arrive as {repo, name} — resolve to a folder URL first.
  if (!url && body.repo) {
    try {
      url = await resolveDiscoveredSkillUrl(String(body.repo), String(body.name || ''));
    } catch (err) {
      return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const resolved = await resolveSourceUrl(url);
  if (!resolved) {
    return json(res, 400, { error: 'Expected a GitHub repo or folder URL, e.g. https://github.com/owner/repo' });
  }
  const { owner, repo, branch, dir } = resolved;
  const origin: SkillOrigin = sanitizeOrigin(body.origin) ?? {
    label: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
    official: false,
  };
  const skillName = sanitizeSkillName((dir ? dir.split('/').pop() : repo) || repo);
  if (!skillName) return json(res, 400, { error: 'Could not derive a skill name from the URL' });
  // A pooled skill of this name would collide with the 'all' symlink in the same
  // dir — steer the user to plain assignment instead of a scoped copy.
  if (
    fs.existsSync(path.join(process.cwd(), 'container', 'skills', skillName)) ||
    fs.existsSync(path.join(USER_SKILLS_DIR, skillName))
  ) {
    return json(res, 409, { error: `A shared skill named "${skillName}" already exists — assign it below instead` });
  }
  let files: Array<{ rel: string; content: Buffer }>;
  try {
    files = await fetchGithubDir(owner, repo, branch, dir);
  } catch (err) {
    return json(res, 502, { error: 'Fetch failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  if (!files.some((f) => f.rel === 'SKILL.md')) {
    return json(res, 422, { error: 'That folder has no SKILL.md — not an Agent Skill' });
  }
  origin.ref = { owner, repo, branch, dir };
  origin.sha = (await latestCommitSha(origin.ref, 0)) ?? undefined;
  const dir0 = scopedSkillsDir(agentGroupId);
  const dest = path.join(dir0, skillName);
  const staging = `${dest}.importing`;
  try {
    fs.mkdirSync(dir0, { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true });
    for (const f of files) {
      const target = path.join(staging, f.rel);
      if (target !== staging && !target.startsWith(staging + path.sep)) continue; // no traversal
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    fs.writeFileSync(path.join(staging, '.origin.json'), JSON.stringify(origin));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return json(res, 500, { error: 'Write failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  const restarted = restartAgentGroupContainers(agentGroupId, 'Webchat scoped skill added');
  const inspection = inspectSkillFiles(skillName, files, { official: origin.official });
  return json(res, 200, { ok: true, name: skillName, files: files.length, restarted, warnings: inspection.warnings });
}

// Remove a scoped skill (a real dir) from a group's .claude-shared/skills. Only
// touches real directories — never a pooled-skill symlink.
export function deleteScopedSkillHandler(res: ServerResponse, agentGroupId: string, name: string): void {
  const clean = sanitizeSkillName(name);
  if (!clean) return json(res, 400, { error: 'Invalid skill name' });
  const dir = path.join(scopedSkillsDir(agentGroupId), clean);
  let isRealDir = false;
  try {
    isRealDir = fs.lstatSync(dir).isDirectory();
  } catch {
    return json(res, 404, { error: 'Skill not wired to this agent' });
  }
  if (!isRealDir) return json(res, 404, { error: 'Skill not wired to this agent' }); // a symlink = pooled, not scoped
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  const restarted = restartAgentGroupContainers(agentGroupId, 'Webchat scoped skill removed');
  return json(res, 200, { ok: true, restarted });
}

export function listAgentMcpHandler(res: ServerResponse, agentGroupId: string): void {
  const attached = getMcpServersForAgent(agentGroupId).map(mcpServerForUI);
  return json(res, 200, { servers: attached });
}

/** Attach/detach registry servers: body { add: [ids], remove: [ids] }. */
export async function setAgentMcpHandler(
  req: IncomingMessage,
  res: ServerResponse,
  agentGroupId: string,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { add?: unknown; remove?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const add = Array.isArray(body.add) ? body.add.map(String) : [];
  const remove = Array.isArray(body.remove) ? body.remove.map(String) : [];
  if (add.length === 0 && remove.length === 0) return json(res, 400, { error: 'add or remove required' });
  let changed = 0;
  for (const id of add) {
    const server = getWebchatMcpServer(id);
    if (!server) return json(res, 404, { error: `MCP server not found: ${id}` });
    assignMcpServerToAgent(agentGroupId, id);
    syncAgentMcpConfig(agentGroupId, server, true);
    changed++;
  }
  for (const id of remove) {
    const server = getWebchatMcpServer(id);
    if (!server) return json(res, 404, { error: `MCP server not found: ${id}` });
    unassignMcpServerFromAgent(agentGroupId, id);
    syncAgentMcpConfig(agentGroupId, server, false);
    changed++;
  }
  if (changed > 0) reloadAgentMcpServers(agentGroupId);
  return json(res, 200, { ok: true, servers: getMcpServersForAgent(agentGroupId).map(mcpServerForUI) });
}
