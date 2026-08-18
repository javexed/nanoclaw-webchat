// ── Export an agent as a template ───────────────────────────────────────────
//
// The inverse of stamping: take a live agent's blueprint — persona, extra
// context, skills, MCP servers, recurring tasks — and write it out as an Agent
// Plugins 1.0.0 directory that can be stamped elsewhere.
//
// A template is a BLUEPRINT, not a backup. Agent export (the .tgz) already
// exists for moving an agent between installs, memory and conversations
// included. This deliberately carries none of that: no memory, no chats, no
// provider or model, no credentials. What it produces is shareable.
//
// Everything NOT carried is REPORTED rather than silently dropped, because the
// gap between "my agent works" and "the template reproduces it" is exactly
// where someone loses an afternoon. The sharpest case is packages: the spec
// has no slot for them, so an agent that depends on `install_packages` state
// will not come back from its own template, and the report says so by name.
import fs from 'fs';
import path from 'path';

import { getContainerConfig } from '../../../db/container-configs.js';
import { findTaskSessions } from '../../../db/sessions.js';
import { parseTaskContent } from '../../../modules/scheduling/db.js';
import { withInboundDb, inboundDbPath } from '../../../session-manager.js';
import { groupSkillsOverlayDir } from '../../../templates/create-agent.js';
import { parseTemplate } from '../../../templates/parse.js';
import { resolveGroupFolderPath } from '../../../group-folder.js';
import { TEMPLATES_DIR } from '../../../config.js';
import { log } from '../../../log.js';
import type { AgentGroup } from '../../../types.js';

export interface ExportTemplateOptions {
  /** Machine name for the plugin — also the folder it is stamped under. */
  name: string;
  /** Library ref to write to, e.g. "mine/analyst". Defaults to `mine/<name>`. */
  ref?: string;
  version?: string;
  description?: string;
  /** Display name for agents stamped from it; defaults to the source agent's name. */
  agentName?: string;
}

export interface ExportTemplateResult {
  ref: string;
  name: string;
  /** Everything the template carries, for the confirmation. */
  included: { skills: string[]; tasks: string[]; mcpServers: string[]; contextFiles: string[]; persona: boolean };
  /** Everything deliberately left behind, in the operator's words. */
  omitted: string[];
}

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const EXT = 'ai.nanoco.nanoclaw';

/** Plugin names are constrained by the spec; fail early rather than at parse. */
const VALID_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Strip every credential-shaped value from a server's env/headers.
 *
 * The credentials proxy owns secrets and injects them per request, so a real
 * value here would be both wrong and rejected: upstream's secret lint refuses
 * a template whose env matches a known key format. `"placeholder"` is the one
 * value that lint always accepts, and it is what a server needing an env var
 * merely to BOOT should carry.
 */
function scrubSecrets(server: Record<string, unknown>): { server: Record<string, unknown>; scrubbed: string[] } {
  const out = { ...server };
  const scrubbed: string[] = [];
  for (const field of ['env', 'headers'] as const) {
    const bag = out[field];
    if (!bag || typeof bag !== 'object') continue;
    const copy: Record<string, string> = {};
    for (const [k] of Object.entries(bag as Record<string, unknown>)) {
      copy[k] = 'placeholder';
      scrubbed.push(`${field}.${k}`);
    }
    out[field] = copy;
  }
  return { server: out, scrubbed };
}

/** Recurring tasks only — a one-shot is an errand, not part of a blueprint. */
function collectTasks(agentGroupId: string): { name: string; schedule: string; prompt: string; script?: string }[] {
  const out: { name: string; schedule: string; prompt: string; script?: string }[] = [];
  for (const session of findTaskSessions(agentGroupId)) {
    if (!fs.existsSync(inboundDbPath(agentGroupId, session.id))) continue;
    try {
      const rows = withInboundDb(
        agentGroupId,
        session.id,
        (db) =>
          db
            .prepare(
              `SELECT series_id, id AS row_id, recurrence, content, MAX(seq) AS seq
               FROM messages_in
              WHERE kind = 'task' AND status IN ('pending', 'paused') AND recurrence IS NOT NULL
              GROUP BY series_id`,
            )
            .all() as { series_id: string | null; row_id: string; recurrence: string; content: string }[],
      );
      for (const row of rows) {
        const content = parseTaskContent(row.content);
        // Task ids embed a truncated name slug; the series id is the stable
        // handle, and its slug is what the stamped copy will key on.
        const seriesId = row.series_id ?? row.row_id;
        const name = seriesId.replace(/-[a-z0-9]{4,}$/i, '') || seriesId;
        out.push({
          name,
          schedule: row.recurrence,
          prompt: content.prompt,
          ...(content.script ? { script: content.script } : {}),
        });
      }
    } catch (err) {
      log.warn('Template export: could not read a task session', { agentGroupId, session: session.id, err });
    }
  }
  return out;
}

/**
 * Write an agent out as a template, staged and validated before it lands.
 *
 * Staging matters for the same reason it does on fetch: an invalid or
 * half-written template must never become the thing sitting in the library.
 * The validator is upstream's own reader, so anything this produces is
 * something `--template` can consume.
 */
export function exportAgentAsTemplate(group: AgentGroup, opts: ExportTemplateOptions): ExportTemplateResult {
  const name = opts.name.trim().toLowerCase();
  if (!VALID_NAME.test(name)) {
    throw new Error('Template name must be lowercase letters, digits and dashes');
  }
  const ref = (opts.ref?.trim() || `mine/${name}`).replace(/^\/+|\/+$/g, '');
  const dest = path.resolve(TEMPLATES_DIR, ref);
  const rel = path.relative(TEMPLATES_DIR, dest);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Template ref escapes the library: "${ref}"`);

  const groupDir = resolveGroupFolderPath(group.folder);
  const staging = `${dest}.exporting-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  const omitted: string[] = [];

  try {
    fs.mkdirSync(path.join(staging, EXT, 'context'), { recursive: true });

    // ── manifest
    fs.writeFileSync(
      path.join(staging, 'plugin.json'),
      JSON.stringify(
        {
          $schema: PLUGIN_SCHEMA,
          name,
          version: opts.version?.trim() || '1.0.0',
          ...(opts.description?.trim() ? { description: opts.description.trim() } : {}),
          extensions: { [EXT]: { agentName: opts.agentName?.trim() || group.name } },
        },
        null,
        2,
      ) + '\n',
    );

    // ── persona + extra context
    const personaSrc = path.join(groupDir, 'instructions.prepend.md');
    const persona = fs.existsSync(personaSrc);
    if (persona) fs.copyFileSync(personaSrc, path.join(staging, EXT, 'context', 'instructions.md'));

    const contextFiles: string[] = [];
    const ctxSrc = path.join(groupDir, 'additional_context');
    if (fs.existsSync(ctxSrc)) {
      const ctxDst = path.join(staging, EXT, 'context', 'additional_context');
      fs.mkdirSync(ctxDst, { recursive: true });
      for (const entry of fs.readdirSync(ctxSrc, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        fs.copyFileSync(path.join(ctxSrc, entry.name), path.join(ctxDst, entry.name));
        contextFiles.push(entry.name);
      }
    }

    // ── skills (including ones the agent wrote itself — that is the point)
    const skills: string[] = [];
    const skillsSrc = groupSkillsOverlayDir(group.id);
    if (fs.existsSync(skillsSrc)) {
      for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
        // A symlink here is how shared skills are wired in; copying the LINK
        // would produce a template upstream's reader rejects outright.
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const from = path.join(skillsSrc, entry.name);
        if (!fs.existsSync(path.join(from, 'SKILL.md'))) continue;
        fs.cpSync(from, path.join(staging, 'skills', entry.name), { recursive: true, dereference: true });
        skills.push(entry.name);
      }
    }

    // ── MCP servers, secrets replaced by the literal placeholder
    const cfg = getContainerConfig(group.id);
    const servers: Record<string, unknown> = {};
    const mcpNames: string[] = [];
    if (cfg?.mcp_servers) {
      const parsed = JSON.parse(cfg.mcp_servers || '{}') as Record<string, Record<string, unknown>>;
      for (const [serverName, server] of Object.entries(parsed)) {
        const { server: clean, scrubbed } = scrubSecrets(server);
        // Ownership and container-path markers are stamp-time state, not
        // template content — they are re-derived on the next stamp.
        delete clean.plugin;
        delete clean.pluginRoot;
        servers[serverName] = clean;
        mcpNames.push(serverName);
        if (scrubbed.length) {
          omitted.push(
            `${serverName}: ${scrubbed.join(', ')} replaced with "placeholder" — the proxy holds the real value`,
          );
        }
      }
    }
    if (mcpNames.length) {
      fs.writeFileSync(
        path.join(staging, 'mcp.json'),
        JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: servers }, null, 2) + '\n',
      );
    }

    // ── recurring tasks
    const tasks = collectTasks(group.id);
    if (tasks.length) {
      const tasksDir = path.join(staging, EXT, 'tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      for (const task of tasks) {
        const body = `---\nschedule: "${task.schedule.replace(/"/g, '\\"')}"\n---\n${task.prompt.trim()}\n`;
        fs.writeFileSync(path.join(tasksDir, `${task.name}.md`), body);
      }
    }

    // ── what a template cannot carry, said out loud
    if (cfg?.packages_apt || cfg?.packages_npm) {
      const apt = JSON.parse(cfg.packages_apt || '[]') as string[];
      const npm = JSON.parse(cfg.packages_npm || '[]') as string[];
      const all = [...apt, ...npm];
      if (all.length) {
        omitted.push(
          `packages (${all.join(', ')}) — the plugin format has no slot for them, so an agent stamped from this template will NOT have them installed`,
        );
      }
    }
    if (cfg?.provider || cfg?.model) omitted.push('provider and model — a template is runtime-neutral by design');
    if (cfg?.timezone) omitted.push(`timezone (${cfg.timezone}) — set per agent at stamp time`);
    if (cfg?.additional_mounts && cfg.additional_mounts !== '[]') omitted.push('host mounts — install-specific');
    omitted.push('memory and conversations — a template is a blueprint, not a backup');

    // Upstream's reader is the gate: containment, symlinks, caps, secret lint,
    // manifest validity. Anything it refuses never reaches the library.
    const parsed = parseTemplate(staging);

    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(staging, dest);
    return {
      ref,
      name: parsed.name,
      included: { skills, tasks: tasks.map((t) => t.name), mcpServers: mcpNames, contextFiles, persona },
      omitted: [...omitted, ...parsed.report],
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
