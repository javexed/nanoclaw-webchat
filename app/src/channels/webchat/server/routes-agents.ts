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
  deleteTemplateSource,
  deleteWebchatRoom,
  getAssignedModelForAgent,
  getEffectiveModelForAgent,
  getTemplateSource,
  getWebchatModel,
  getWebchatRoomsForAgent,
  listTemplateSources,
  setPrimeAgentForWebchatRoom,
  unassignModelFromAgent,
  upsertTemplateSource,
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
  writeLocalModelForAgent,
} from '../models.js';
import { probeContainerReachability } from '../reachability.js';
import { hasAdminPrivilege, isAnyAdmin, isGlobalAdmin, isOwner } from '../roles.js';
import { resolveGroupFolderPath } from '../../../group-folder.js';
import { createAgentFromTemplate } from '../../../templates/create-agent.js';
import { listLocalTemplates, resolveLocalTemplate } from '../../../templates/local-dir.js';
import { browseTemplateSource, deleteLocalTemplate, fetchTemplateInto, templateDetail } from './template-library.js';
import { exportAgentAsTemplate } from './template-export.js';
import { groupsCarryingPlugin, restampAgentFromTemplate } from '../../../templates/restamp.js';
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
import { codexAvailable, grokAvailable, opencodeAvailable, piAvailable } from './providers.js';
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
  if (!(await isAnyAdmin(userId))) return json(res, 403, { error: 'Admin only' });
  if (req.headers['x-webchat-csrf'] !== '1') {
    return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  }
  return draftAgentHandler(req, res);
}

export async function rAgentsPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await isAnyAdmin(userId))) return json(res, 403, { error: 'Admin only' });
  return createAgentHandler(req, res, userId);
}

// ── Agent templates ─────────────────────────────────────────────────────────
//
// A template is an Agent Plugins 1.0.0 directory in the LOCAL library
// (TEMPLATES_DIR). Stamping copies its skills, MCP servers, persona, extra
// context and recurring tasks into a new agent group. There is no remote
// fetch here, deliberately: the ref is resolved against the local directory
// with containment checks, exactly as `ncl groups create --template` does.
//
// Gated on owner / global admin rather than isAnyAdmin, because stamping
// creates scheduled tasks and MCP servers — surfaces a scoped admin cannot
// otherwise touch. Same gate as agent import, which is the closest analogue.

export async function rTemplatesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Global admin required' });
  try {
    return json(res, 200, { templates: listLocalTemplates() });
  } catch (err) {
    // The pre-plugin layout throws with a re-fetch pointer. That is an
    // operator-fixable library problem, not a server fault, so it comes back
    // as an empty list WITH the reason — a bare 500 would render as "no
    // templates" and hide the one sentence that says how to fix it.
    log.warn('Webchat: listing templates failed', { err });
    return json(res, 200, { templates: [], error: err instanceof Error ? err.message : 'Could not read templates' });
  }
}

export async function rAgentsFromTemplatePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Global admin required' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { ref?: unknown; name?: unknown; timezone?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.ref !== 'string' || !body.ref.trim()) return json(res, 400, { error: 'ref required' });
  const ref = body.ref.trim();

  // Both calls below RESOLVE the ref, so both can throw on a bad one — the
  // carrier lookup included. It lives inside the try for that reason: outside
  // it, an escaping ref threw past the handler and surfaced as a 500 instead
  // of the 400 it is (caught by the containment tests).
  try {
    // Stamping a plugin a group already carries would silently create a second
    // agent from it. Updating in place is the right move instead — and it now
    // HAS a UI (agent detail → Template → "Check for updates", which shows the
    // dry-run plan before applying). This message used to say the update was
    // CLI-only, which shipped in the same change as that button and sent people
    // to a terminal for something already on screen.
    const carriers = await groupsCarryingPlugin(ref);
    if (carriers.length > 0) {
      return json(res, 409, {
        error: `Already stamped as "${carriers[0].name}". To update it, open that agent and use Template → "Check for updates".`,
      });
    }

    const { group, report } = await createAgentFromTemplate(ref, {
      ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
      ...(typeof body.timezone === 'string' && body.timezone.trim() ? { timezone: body.timezone.trim() } : {}),
    });
    grantCreatorAdmin(userId, group.id);
    // `report` names anything the reader skipped (a non-conforming skill, an
    // unsupported transport). Components are never silently stripped, so it
    // travels to the client even on success.
    return json(res, 200, { ok: true, agentGroup: group, report });
  } catch (err) {
    // Template failures are operator-facing and actionable (bad ref, invalid
    // manifest, symlink, size cap), and the caller is the owner, so the real
    // message is more useful than a generic one.
    log.warn('Webchat: stamping template failed', { ref, err });
    return json(res, 400, { error: err instanceof Error ? err.message : 'Could not stamp template' });
  }
}

// ── Template library management ─────────────────────────────────────────────
// Same owner/global-admin gate as stamping: everything here decides what CAN
// be stamped, so it is the same authority.

const ownerOnly = async (userId: string): Promise<boolean> => (await isOwner(userId)) || (await isGlobalAdmin(userId));

export async function rTemplateSourcesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  return json(res, 200, { sources: listTemplateSources() });
}

export async function rTemplateSourcePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { id?: unknown; label?: unknown; owner?: unknown; repo?: unknown; branch?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const owner = str(body.owner);
  const repo = str(body.repo);
  if (!owner || !repo) return json(res, 400, { error: 'owner and repo required' });
  // A GitHub owner/repo is a constrained token; anything else is a mistake or
  // an injection attempt into the API path we build from it.
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return json(res, 400, { error: 'owner and repo must be plain GitHub names' });
  }
  const branch = str(body.branch) || 'main';
  const id = str(body.id) || `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  upsertTemplateSource({ id, label: str(body.label) || `${owner}/${repo}`, owner, repo, branch });
  return json(res, 200, { ok: true, sources: listTemplateSources() });
}

export async function rTemplateSourceDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const id = decodeURIComponent(m[1]);
  // Official rows are code-seeded: deleting one would reappear on the next
  // migrate, so refusing is the honest answer rather than a no-op success.
  if (!(await deleteTemplateSource(id))) {
    return json(res, 400, { error: 'No such source, or it is a built-in that cannot be removed' });
  }
  return json(res, 200, { ok: true, sources: listTemplateSources() });
}

export async function rTemplateSourceBrowseGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const src = await getTemplateSource(decodeURIComponent(m[1]));
  if (!src) return json(res, 404, { error: 'Source not found' });
  try {
    return json(res, 200, { templates: await browseTemplateSource(src) });
  } catch (err) {
    // A rate limit or an unreachable repo is worth saying out loud — this is
    // the one call in the flow that depends on somebody else's server.
    log.warn('Webchat: browsing template source failed', { source: src.id, err });
    return json(res, 502, { error: err instanceof Error ? err.message : 'Could not reach the source' });
  }
}

export async function rTemplateFetchPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { source?: unknown; ref?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.source !== 'string' || typeof body.ref !== 'string' || !body.ref.trim()) {
    return json(res, 400, { error: 'source and ref required' });
  }
  const src = await getTemplateSource(body.source);
  if (!src) return json(res, 404, { error: 'Source not found' });
  try {
    const result = await fetchTemplateInto(src, body.ref.trim());
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    log.warn('Webchat: fetching template failed', { source: src.id, ref: body.ref, err });
    return json(res, 400, { error: err instanceof Error ? err.message : 'Could not fetch the template' });
  }
}

// ref carries slashes ("sales/sdr"), so it travels as a query parameter rather
// than a path segment — no double-encoding, no route pattern guessing.
export async function rTemplateDetailGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const ref = url.searchParams.get('ref');
  if (!ref) return json(res, 400, { error: 'ref required' });
  try {
    return json(res, 200, templateDetail(ref));
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : 'Could not read the template' });
  }
}

export async function rTemplateDelete(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const ref = url.searchParams.get('ref');
  if (!ref) return json(res, 400, { error: 'ref required' });
  try {
    if (!deleteLocalTemplate(ref)) return json(res, 404, { error: 'Template not found' });
    return json(res, 200, { ok: true, templates: listLocalTemplates() });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : 'Could not remove the template' });
  }
}

// ── Updating a stamped agent (restamp) ──────────────────────────────────────
//
// The plugin is the source of truth for what it stamped, so an update RESETS
// those surfaces and leaves everything else alone. The dry-run plan is the
// whole point of doing this in a UI: it names every surface that changes and
// flags the ones whose live copy was edited locally, which apply would discard.
// Upstream's own docs note that an agent-requested restamp shows the approver
// only a command line and tells them to run the dry run themselves — this is
// that dry run, rendered.

/** Which library template, if any, this agent was stamped from. */
function stampedRefFor(group: { folder: string }): string | null {
  for (const t of listLocalTemplates()) {
    try {
      const dir = resolveLocalTemplate(t.ref);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8')) as { name?: unknown };
      if (typeof manifest.name !== 'string') continue;
      const stamped = path.join(resolveGroupFolderPath(group.folder), 'plugins', manifest.name, 'plugin.json');
      if (fs.existsSync(stamped)) return t.ref;
    } catch {
      continue; // an unreadable library entry cannot be this agent's origin
    }
  }
  return null;
}

export async function rAgentTemplatePlanGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const ref = stampedRefFor(await group);
  // Not stamped, or stamped from a template no longer in the library: both are
  // "nothing to update", and the second is worth saying rather than implying
  // the agent has no plugin at all.
  if (!ref) return json(res, 200, { stamped: false });
  try {
    const plan = await restampAgentFromTemplate(ref, group.id, { apply: false });
    return json(res, 200, {
      stamped: true,
      ref,
      plugin: plan.plugin,
      changes: plan.changes,
      report: plan.report,
      note: plan.note,
    });
  } catch (err) {
    log.warn('Webchat: template update plan failed', { agent: group.id, ref, err });
    return json(res, 400, { error: err instanceof Error ? err.message : 'Could not plan the update' });
  }
}

export async function rAgentTemplateApplyPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const ref = stampedRefFor(await group);
  if (!ref) return json(res, 400, { error: 'This agent was not stamped from a template in the library' });
  try {
    const applied = await restampAgentFromTemplate(ref, group.id, { apply: true });
    // Skill and MCP changes only take effect in a fresh container, which is
    // what the CLI tells the operator to do by hand after an apply.
    restartAgentGroupContainers(group.id, 'Template update applied');
    return json(res, 200, { ok: true, ref, changes: applied.changes, report: applied.report });
  } catch (err) {
    log.warn('Webchat: template update failed', { agent: group.id, ref, err });
    return json(res, 400, { error: err instanceof Error ? err.message : 'Could not apply the update' });
  }
}

/**
 * Export an agent as a template — the inverse of stamping.
 *
 * Distinct from `GET /api/agents/:id/export`, which produces a migration
 * tarball (memory, chats, config) for moving ONE agent between installs. This
 * produces a shareable blueprint with none of that. Both exist because they
 * answer different questions.
 */
export async function rAgentExportTemplatePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await ownerOnly(userId))) return json(res, 403, { error: 'Global admin required' });
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; ref?: unknown; version?: unknown; description?: unknown; agentName?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const name = str(body.name);
  if (!name) return json(res, 400, { error: 'name required' });
  try {
    const result = exportAgentAsTemplate(await group, {
      name,
      ...(str(body.ref) ? { ref: str(body.ref)! } : {}),
      ...(str(body.version) ? { version: str(body.version)! } : {}),
      ...(str(body.description) ? { description: str(body.description)! } : {}),
      ...(str(body.agentName) ? { agentName: str(body.agentName)! } : {}),
    });
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    log.warn('Webchat: exporting agent as template failed', { agent: group.id, err });
    return json(res, 400, { error: err instanceof Error ? err.message : 'Could not export the template' });
  }
}

export async function rAgentPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  return updateAgentHandler(req, res, group.id);
}

export async function rAgentDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  return deleteAgentHandler(res, group.id);
}

// GET the rooms an agent is wired to (agent-centric mirror of
// GET /api/rooms/:id/agents). Read-only; writes go through the existing
// owner-only POST/DELETE /api/rooms/:roomId/agents endpoints.
export async function rAgentRoomsGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  return json(res, 200, getWebchatRoomsForAgent(group.id));
}

// ── Per-agent model assignment ─────────────────────────────────────────
export async function rAgentModelPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  return assignAgentModelHandler(req, res, group.id);
}

// PUT /api/agents/:id/provider — set the agent HARNESS ('claude' built-in or
// 'opencode'). Stored in container_configs.provider (claude = null default);
// restarts the group so the new harness takes effect. 'opencode' is gated on the
// stack being installed. An explicit choice survives model (re)assignment (see
// syncAgentProviderForAssignedModel).
export async function rAgentProviderPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
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
  if (grokAvailable()) allowed.add('grok');
  if (!allowed.has(provider)) {
    return json(res, 400, {
      error:
        provider === 'opencode'
          ? 'OpenCode harness is not installed — install the OpenCode stack first.'
          : provider === 'grok'
            ? 'Grok harness is not installed — run /add-grok, rebuild the image, then authenticate.'
            : `Unknown harness: ${provider}`,
    });
  }
  ensureContainerConfig(group.id);
  updateContainerConfigScalars(group.id, { provider: provider === 'claude' ? null : provider });
  // (Re)write the local-model wiring for the NEW harness before the respawn —
  // opencode/pi read it at spawn; without this the switch only takes effect
  // after the next boot convergence or model change.
  try {
    writeLocalModelForAgent(group.id);
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
 * Refuses when an `anthropic`-kind webchat model is EFFECTIVE for the group —
 * assigned to it, or inherited from the workspace default. Either way that model
 * sets ANTHROPIC_MODEL in the group's settings.json env, and the SDK's explicit
 * `model` option overrides the env var, so accepting a pin would silently ignore
 * the model the operator can see in the UI. Better to make them pick one lever.
 *
 * The inherited case was the gap (#112 follow-up): the check read the ASSIGNED
 * model only, so an UNASSIGNED agent running on an anthropic-kind workspace
 * default accepted a pin and then quietly ignored it. Same precedence bug, one
 * layer up — and the harder one to notice, because nothing on the agent names
 * the model it inherited.
 *
 * The two cases get different messages because the fix differs: an assignment is
 * unassigned on the agent, a default is changed for the whole workspace (or
 * overridden by assigning this agent its own model).
 */
export async function rAgentConfigModelPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
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
  const assigned = await getAssignedModelForAgent(group.id);
  if (model && assigned && assigned.kind === 'anthropic') {
    return json(res, 409, {
      error: `This agent is assigned the webchat model "${assigned.name}", which already sets its Anthropic model. Unassign it first, or change the model there instead.`,
    });
  }
  // Unassigned agents inherit the workspace default, which sets the same env
  // var and wins the same way. Only reachable when there is no assignment —
  // the branch above already covers that case with its own wording.
  if (model && !assigned) {
    const inherited = await getEffectiveModelForAgent(group.id);
    if (inherited && inherited.kind === 'anthropic') {
      return json(res, 409, {
        error: `This agent inherits the workspace default model "${inherited.name}", which already sets its Anthropic model. Assign this agent its own model, or change the workspace default instead.`,
      });
    }
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
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
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
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
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
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  if (method === 'GET') return listAgentMcpHandler(res, group.id);
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return setAgentMcpHandler(req, res, group.id);
}

export async function rAgentSkills(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  if (method === 'GET') {
    const available = listAvailableSkills();
    // getContainerConfig returns the raw row — skills is a JSON string ("all"
    // or a name array), so parse it (configFromDb does the same).
    let sel: string[] | 'all' = 'all';
    try {
      const rawSkills = (await getContainerConfig(group.id))?.skills;
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
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importScopedSkillHandler(req, res, group.id);
}

// ── Agent export/import (backup Phase 1) ──────────────────────────────
export async function rAgentExportGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Global admin required' });
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const withConvos = url.searchParams.get('conversations') === '1';
  // Session DBs are DELETE-mode journals — only safe to copy with the
  // agent's containers stopped. They respawn on the next message.
  if (withConvos) await restartAgentGroupContainers(group.id, 'Export with conversations');
  let stage: string;
  try {
    stage = await stageAgentExport(group.id, withConvos);
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  const fname = `nanoclaw-agent-${group.folder}-${new Date().toISOString().slice(0, 10)}.tgz`;
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${fname}"`,
  });
  const tar = spawnTar(exportTarArgs(stage, await group, withConvos));
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
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importAgentUploadHandler(req, res);
}

export async function rAgentsImportApplyPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importAgentApplyHandler(req, res);
}

export async function rAgentLearning(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  const current = await parseAgentLearning(group.id);
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
    if (ci === 'off' && !((await isOwner(userId)) || (await isGlobalAdmin(userId)))) {
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
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return deleteScopedSkillHandler(res, group.id, decodeURIComponent(m[2]));
}

// ── Lifecycle status (active | paused | archived) ──────────────────────
export async function rAgentStatusPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  return setAgentStatusHandler(req, res, group.id);
}

// ── Sessions (list + reset) ────────────────────────────────────────────
// Lets an admin reach an agent's sessions — including background a2a
// sessions no room-typed /clear can target — and reset one (inject /clear).
export async function rAgentSessionsGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(userId, group.id))) return json(res, 403, { error: 'Admin privilege required' });
  const sessions = (await getSessionsByAgentGroup(group.id))
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
export async function provisionWebchatAgentWithRoom(
  name: string,
  opts: { folder?: string; instructions?: string } = {},
): Promise<{ group: AgentGroup } | { error: string; status: number }> {
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
    await getDb().transaction(async () => {
      await createAgentGroup(group);
      await initGroupFilesystem(group, { instructions: opts.instructions });
      await wireAgentToWebchatRoom(name, folder, group.id);
      // Auto-prime the agent on its own 1:1 room. With a single wired
      // agent the prime designation is a no-op for routing (engage_pattern
      // stays '.'), but pre-priming means that when the operator wires a
      // second agent later, the original keeps responding by default —
      // matching the user-visible expectation "the first agent answers
      // until I say otherwise."
      await setPrimeAgentForWebchatRoom(folder, group.id);
    });
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
  const provisioned = await provisionWebchatAgentWithRoom(roomName, {
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
export async function grantCreatorAdmin(creatorUserId: string, agentGroupId: string): Promise<void> {
  if ((await isOwner(creatorUserId)) || (await isGlobalAdmin(creatorUserId))) return;
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
    const result = await applyImport(staged.dir, { name: typeof body.name === 'string' ? body.name : undefined });
    // Post-link derived state: MCP config re-sync + model env materialization —
    // the same helpers the interactive flows use, so nothing drifts.
    for (const mcpName of result.attachedMcp) {
      const server = await getWebchatMcpServerByName(mcpName);
      if (server) await syncAgentMcpConfig(result.id, server, true);
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

export async function deleteAgentHandler(res: ServerResponse, id: string): Promise<void> {
  const group = await getAgentGroup(id);
  if (!group) return json(res, 404, { error: 'Agent not found' });

  // Snapshot every session this agent owns — home-room and any other rooms
  // it's wired to. All of them FK to `agent_groups.id`, so all must be torn
  // down before deleteAgentGroup. Captured before the tx so post-commit
  // resource cleanup can find them.
  const sessions = findSessionsByAgentGroup(id);
  // Draft BODY dirs live on disk keyed by draft id — capture before the tx
  // deletes the rows, remove after commit.
  const draftIds = (await listSkillDrafts())
    .filter((d) => d.agent_group_id === id)
    .map((d) => d.id);

  try {
    await getDb().transaction(async () => {
      const db = getDb();
      for (const s of await sessions) await deleteSessionDbState(s.sessionId);
      await db.run(`DELETE FROM messaging_group_agents WHERE agent_group_id = ?`, id);
      // Drop the model assignment too — the agent is going away, no point
      // keeping a row pointing at a dead agent_group_id.
      await unassignModelFromAgent(id);
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
        if ((await hasTable(db, table))) {
          await db.run(`DELETE FROM ${table} WHERE agent_group_id = ?`, id);
        }
      }
      // a2a policies key by from/to, not agent_group_id — either side dying
      // kills the policy.
      if ((await hasTable(db, 'agent_message_policies'))) {
        await db.run(`DELETE FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?`, id, id);
      }
      // Delete the home room (its own session rows are already gone above).
      await deleteWebchatRoom(group.folder);
      await deleteAgentGroup(id);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Webchat: deleteAgentHandler failed', { id, err });
    return json(res, 500, { error: 'Failed to delete agent', message });
  }

  void teardownSessionResources(await sessions, `webchat agent ${id} deleted`);

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
  await setAgentStatus(agentGroupId, status);
  const group = await getAgentGroup(agentGroupId);
  return json(res, 200, group ? await toAgentForUI(group) : { status });
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
  const current = await getAssignedModelForAgent(agentGroupId);
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

export async function listAgentMcpHandler(res: ServerResponse, agentGroupId: string): Promise<void> {
  const attached = (await getMcpServersForAgent(agentGroupId)).map(mcpServerForUI);
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
    // Await BEFORE the guard: un-awaited, `server` was a promise — truthy — so
    // the 404 for an unknown id never fired and a bad id got "assigned".
    const server = await getWebchatMcpServer(id);
    if (!server) return json(res, 404, { error: `MCP server not found: ${id}` });
    await assignMcpServerToAgent(agentGroupId, id);
    await syncAgentMcpConfig(agentGroupId, server, true);
    changed++;
  }
  for (const id of remove) {
    const server = await getWebchatMcpServer(id);
    if (!server) return json(res, 404, { error: `MCP server not found: ${id}` });
    await unassignMcpServerFromAgent(agentGroupId, id);
    await syncAgentMcpConfig(agentGroupId, server, false);
    changed++;
  }
  if (changed > 0) reloadAgentMcpServers(agentGroupId);
  return json(res, 200, { ok: true, servers: (await getMcpServersForAgent(agentGroupId)).map(mcpServerForUI) });
}
