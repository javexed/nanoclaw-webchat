// ── Skill storage ────────────────────────────────────────────────────────────
// Where skills live on disk and how they are named, listed and written: the
// name sanitiser, the per-agent scoped directory, the two listings, the room a
// draft came from, and the write path for a user skill.
//
// Shared rather than moved. The skill routes are the main caller, but the agent
// routes list an agent's scoped skills and its available ones, and the draft and
// learning paths reach the same storage — none of them in the skill cluster.
// listAvailableSkills is used by both clusters and nothing else, which is
// exactly the case a third module exists for.

// Available skills = folders containing a SKILL.md across BOTH mounts: the
// shipped container/skills and the runtime data/user-skills (imported/uploaded).
// The dir name is the id used in the config + symlinks; the front-matter
// `description` is shown in the picker. Shipped wins on a name collision.
import { DATA_DIR } from '../../../config.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import { getSession } from '../../../db/sessions.js';
import { listRevisions } from '../../../modules/learning/apply.js';
import { getWebchatRoomsForAgent } from '../db.js';
import { listAgentsForUser } from './agent-lookup.js';
import { json, readJsonBody } from './http.js';
import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

export const USER_SKILLS_DIR = path.join(process.cwd(), 'data', 'user-skills');

// Provenance recorded at import time in a `.origin.json` sidecar inside the
// skill folder, so the installed list can show where each skill came from
// ("Anthropic", "obra/superpowers", "awesomeskill.ai", …) long after import.
// A sidecar (not front-matter) keeps it out of the agent-facing SKILL.md and
// self-cleans when the skill folder is deleted.
export type SkillOriginRef = { owner: string; repo: string; branch: string; dir: string };

export type SkillOrigin = {
  label: string;
  url?: string;
  official?: boolean;
  /** Commit SHA the import was taken at — the pin that makes updates checkable. */
  sha?: string;
  /** Where to re-fetch from for update checks / re-imports. */
  ref?: SkillOriginRef;
};

export function sanitizeOrigin(input: unknown): SkillOrigin | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const label = String(o.label ?? '')
    .trim()
    .slice(0, 60);
  if (!label) return null;
  const u = String(o.url ?? '').trim();
  const url = /^https:\/\/\S+$/i.test(u) && u.length <= 300 ? u : undefined;
  const out: SkillOrigin = { label, url, official: !!o.official };
  if (typeof o.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(o.sha)) out.sha = o.sha;
  const r = o.ref as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    const part = (v: unknown) => String(v ?? '').slice(0, 200);
    const ref = { owner: part(r.owner), repo: part(r.repo), branch: part(r.branch), dir: part(r.dir) };
    if (ref.owner && ref.repo && ref.branch && /^[\w.-]+$/.test(ref.owner) && /^[\w.-]+$/.test(ref.repo)) {
      out.ref = ref;
    }
  }
  return out;
}

/** Resolve a draft's source session to its webchat room, when there is one. */
export async function draftSourceRoom(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const sess = await getSession(sessionId);
    if (!sess?.messaging_group_id) return null;
    const mg = await getMessagingGroup(sess.messaging_group_id);
    return mg && mg.channel_type === 'webchat' ? mg.platform_id : null;
  } catch {
    return null;
  }
}

export function readSkillOrigin(skillDir: string): SkillOrigin | null {
  try {
    return sanitizeOrigin(JSON.parse(fs.readFileSync(path.join(skillDir, '.origin.json'), 'utf8')));
  } catch {
    return null;
  }
}

export type AvailableSkill = {
  name: string;
  description: string;
  source: 'shipped' | 'user';
  origin?: SkillOrigin | null;
};

export function listAvailableSkills(): AvailableSkill[] {
  const roots: Array<{ dir: string; source: 'shipped' | 'user' }> = [
    { dir: path.join(process.cwd(), 'container', 'skills'), source: 'shipped' },
    { dir: USER_SKILLS_DIR, source: 'user' },
  ];
  const out: AvailableSkill[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen.has(entry)) continue; // shipped already claimed this name
      try {
        const skillDir = path.join(dir, entry);
        if (!fs.statSync(skillDir).isDirectory()) continue;
        const text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
        const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
        out.push({
          name: entry,
          description: fm ? frontMatterDescription(fm[1]) : '',
          source,
          origin: source === 'user' ? readSkillOrigin(skillDir) : null,
        });
        seen.add(entry);
      } catch {
        continue; // no SKILL.md → not a skill
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Per-agent (scoped) skills ───────────────────────────────────────────────
// A skill wired to ONE agent group, not the shared pool: it lives as a real
// directory in that group's own `.claude-shared/skills/` (mounted at
// ~/.claude/skills), so only that group loads it and `'all'` never fans it out.
// (Pooled skills show up in the same dir as symlinks into /app/user-skills —
// those aren't scoped; we only count real directories.)
export function scopedSkillsDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
}

export function listScopedSkills(
  agentGroupId: string,
): Array<{ name: string; description: string; origin: SkillOrigin | null; invocations: number; hasHistory: boolean }> {
  const dir = scopedSkillsDir(agentGroupId);
  const out: Array<{
    name: string;
    description: string;
    origin: SkillOrigin | null;
    invocations: number;
    hasHistory: boolean;
  }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    try {
      const p = path.join(dir, entry);
      if (!fs.lstatSync(p).isDirectory()) continue; // lstat: skip pooled symlinks, keep real dirs
      const text = fs.readFileSync(path.join(p, 'SKILL.md'), 'utf8');
      const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
      let invocations = 0;
      try {
        invocations = parseInt(fs.readFileSync(path.join(p, '.invocations'), 'utf8'), 10) || 0;
      } catch {
        /* never invoked */
      }
      out.push({
        name: entry,
        description: fm ? frontMatterDescription(fm[1]) : '',
        origin: readSkillOrigin(p),
        invocations,
        hasHistory: listRevisions(dir, entry).length > 0,
      });
    } catch {
      continue; // symlink (isDirectory false via lstat) or no SKILL.md
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Scoped skills flattened for the registry list (/api/skills), each carrying
// where it lives: its agent + the webchat rooms that agent is wired to.
// Visibility mirrors the topology + skill-drafts rule: aggregate over
// listAgentsForUser (owner → all agents, otherwise hasAdminPrivilege per
// group), so an admin never sees a skill on an agent they can't reach.
// A scoped skill whose name is already in the shared pool is skipped — the
// pool row is the source of truth there (post-promotion scoped dirs are
// symlinks and already excluded, but a same-named real dir must not
// double-list either).
export type ScopedSkillForList = {
  name: string;
  description: string;
  source: 'scoped';
  origin: SkillOrigin | null;
  agentGroupId: string;
  agentName: string;
  rooms: Array<{ id: string; name: string }>;
};

export async function listScopedSkillsForUser(userId: string, pool: AvailableSkill[]): Promise<ScopedSkillForList[]> {
  const poolNames = new Set(pool.map((s) => s.name));
  const out: ScopedSkillForList[] = [];
  for (const a of await listAgentsForUser(userId)) {
    const scoped = listScopedSkills(a.id).filter((sk) => !poolNames.has(sk.name));
    if (!scoped.length) continue;
    const rooms = (await getWebchatRoomsForAgent(a.id)).map((r) => ({ id: r.id, name: r.name }));
    for (const sk of scoped) {
      out.push({
        name: sk.name,
        description: sk.description,
        source: 'scoped',
        origin: sk.origin,
        agentGroupId: a.id,
        agentName: a.name,
        rooms,
      });
    }
  }
  return out;
}

export function sanitizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Create or edit a USER skill's SKILL.md — the upload/manual-edit path. Only
// the SKILL.md is writable here; extra files come via GitHub import (or the
// host filesystem at data/user-skills/<name>/). Requires front-matter with a
// description so the picker isn't full of blanks.
export async function putUserSkillHandler(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  const clean = sanitizeSkillName(name);
  if (!clean) return json(res, 400, { error: 'Invalid skill name (a-z, 0-9, hyphens)' });
  if (fs.existsSync(path.join(process.cwd(), 'container', 'skills', clean))) {
    return json(res, 403, { error: 'Built-in skills are read-only — create one under a different name' });
  }
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let content = '';
  try {
    content = String((JSON.parse(raw) as { content?: unknown }).content || '');
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (content.length > 512 * 1024) return json(res, 413, { error: 'SKILL.md exceeds 512KB' });
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm || !/^description:\s*\S/m.test(fm[1])) {
    return json(res, 422, {
      error: 'SKILL.md needs YAML front-matter with a description (--- name/description ---)',
    });
  }
  try {
    const skillDir = path.join(USER_SKILLS_DIR, clean);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    // Hand-authored here → "custom". Only stamp when there's no origin yet, so
    // editing an imported skill's SKILL.md never overwrites its provenance.
    const originFile = path.join(skillDir, '.origin.json');
    if (!fs.existsSync(originFile)) {
      fs.writeFileSync(originFile, JSON.stringify({ label: 'custom' } satisfies SkillOrigin));
    }
    return json(res, 200, { ok: true, name: clean });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Pull `description` from YAML front-matter, handling the common shapes: an
// inline value, quoted, or a folded/literal block scalar (>- | etc.) whose text
// continues on the following indented lines.
export function frontMatterDescription(fmBody: string): string {
  const lines = fmBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m) continue;
    const val = m[1].trim();
    if (['>', '>-', '|', '|-'].includes(val)) {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
      return parts.join(' ');
    }
    return val.replace(/^["']|["']$/g, '');
  }
  return '';
}
