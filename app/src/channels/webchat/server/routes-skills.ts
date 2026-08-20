// ── Skill routes ─────────────────────────────────────────────────────────────
// The skill surface: the marketplace catalog and its pool, import (inspect,
// then apply), user skills (read, write, delete), the source setting, update
// checks and suggestions.
//
// Storage lives in server/skills-store.ts, shared with the agent routes — see
// the note there.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { listSkillDrafts } from '../../../db/skill-drafts.js';
import { revertLastRevision, snapshotRevision } from '../../../modules/learning/apply.js';
import {
  findDuplicateScopedSkills,
  promoteScopedSkill,
  restoreArchivedSkill,
} from '../../../modules/learning/curator.js';
import { inspectSkillFiles } from '../../../modules/skills/inspect.js';
import { deleteSkillSource, isSourceDisabled, listSkillSources, setSourceDisabled, upsertSkillSource } from '../db.js';
import type { WebchatSkillSource } from '../db.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../roles.js';
import { listAgentsForUser, resolveAgent } from './agent-lookup.js';
import { MARKETPLACE_ID } from './constants.js';
import {
  SKILL_DISCOVERY_URL,
  fetchGithubDir,
  latestCommitSha,
  resolveDiscoveredSkillUrl,
  resolveSourceUrl,
} from './skill-sources.js';
import {
  SkillOrigin,
  USER_SKILLS_DIR,
  draftSourceRoom,
  frontMatterDescription,
  listAvailableSkills,
  listScopedSkillsForUser,
  putUserSkillHandler,
  readSkillOrigin,
  sanitizeOrigin,
  sanitizeSkillName,
  scopedSkillsDir,
} from './skills-store.js';
import fs from 'fs';
import path from 'path';
import type { RouteCtx } from '../server.js';

// ── Skills (per-agent capability toggles) ──────────────────────────────
// Available skills = the folders in container/skills (bind-mounted read-only
// into every container); each agent's container config picks which it gets.
// Plus the AGENT-SCOPED skills (learned-and-kept / per-agent imports) across
// every agent the caller administers, so a skill that lives on one agent only
// still shows in the registry — with enough context to say where it lives.
export async function rSkillsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const pool = listAvailableSkills();
  const skills = [...pool, ...listScopedSkillsForUser(userId, pool)].sort((a, b) => a.name.localeCompare(b.name));
  return json(res, 200, { skills });
}

// Import a skill from a GitHub folder URL into data/user-skills (no rebuild).
// Owner/global-admin only: an imported skill lands in a shared mount that fans
// out to every 'all' agent install-wide, so importing code is an install-wide
// trust action (same bar as the source registry), NOT a per-group one — a
// scoped admin of one group must not be able to inject code into others'.
export async function rSkillsImportPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importSkillHandler(req, res);
}

// One merged pool of skills for a trust tier (official = Anthropic; community =
// every community GitHub collection + the awesomeskill.ai marketplace). `q`
// filters/searches the pool. Community results are unvetted — the UI warns +
// gates import behind a review confirm.
export async function rSkillsCatalogGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  return catalogPoolHandler(res, url.searchParams.get('tier') || 'official', url.searchParams.get('q') || '');
}

// Suggest skills (installed + catalogs) matching a new agent's description.
export async function rSkillsSuggestGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  return suggestSkillsHandler(res, url.searchParams.get('text') || '');
}

// Catalog-source registry: list is admin-visible; changes are global-admin
// only ("well-known sites" are an install-wide trust decision).
// NOTE: these literal routes must stay ABOVE the /api/skills/:name matcher.
export async function rSkillsSourcesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  // `sources` = editable GitHub collections; `builtins` = code-wired sources
  // that also feed the pool but have nothing to edit (the marketplace).
  return json(res, 200, {
    sources: listSkillSources(),
    builtins: [
      {
        id: MARKETPLACE_ID,
        label: SKILL_DISCOVERY_SOURCE.name,
        url: SKILL_DISCOVERY_SOURCE.url,
        disabled: isSourceDisabled(MARKETPLACE_ID),
      },
    ],
  });
}

export async function rSkillSource(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const sourceId = decodeURIComponent(m[1]);
  // Built-in marketplace: there's nothing in the DB to edit/delete — DELETE
  // switches it off (removed from the pool), PUT switches it back on.
  if (sourceId === MARKETPLACE_ID) {
    setSourceDisabled(MARKETPLACE_ID, method === 'DELETE');
    return json(res, 200, { ok: true });
  }
  if (method === 'PUT') return putSkillSourceHandler(req, res, sourceId);
  catalogCache.delete(sourceId);
  return (await deleteSkillSource(sourceId)) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Source not found' });
}

// Delete a user skill (imported/uploaded). Shipped skills can't be removed.
// Read / write / delete a single skill. GET returns its SKILL.md (any
// source); PUT creates or edits a USER skill's SKILL.md (shipped skills are
// read-only — they're repo files); DELETE removes a user skill.
// Cross-agent duplicates + promotion (learning loop). Detection is read-only
// and admin-visible; PROMOTION writes the shared pool — install-wide reach —
// so it stays owner/global-admin, the pool's own boundary.
// Pre-import inspection: fetch the skill's files WITHOUT writing anything and
// return the "what's inside" inventory + lint findings. Read-only, so any
// admin may look (per-group admins import scoped skills through the same
// preview). NOTE: literal /api/skills/* routes must stay ABOVE the
// /api/skills/:name matcher.
export async function rSkillsInspectPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return inspectSkillHandler(req, res);
}

// Update checks for pinned pool imports: which user skills' upstream has
// moved since their recorded commit. Read-only.
export async function rSkillsUpdatesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return skillUpdatesHandler(res);
}

export async function rSkillUpdatePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  // Same gate as pool import — an update IS a pool import.
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return applySkillUpdateHandler(res, decodeURIComponent(m[1]));
}

export async function rSkillsDuplicatesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const dups = findDuplicateScopedSkills().map((d) => ({
    ...d,
    agents: d.agents.map(async (id) => (await getAgentGroup(id))?.name || id),
  }));
  return json(res, 200, { duplicates: dups });
}

export async function rSkillsPromotePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let name = '';
  try {
    name = sanitizeSkillName(String((JSON.parse(raw) as { name?: unknown }).name || ''));
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (!name) return json(res, 400, { error: 'Invalid skill name' });
  const dup = findDuplicateScopedSkills().find((d) => d.name === name);
  const r = promoteScopedSkill(name);
  if (!r.ok) return json(res, 409, { error: r.error });
  // Every holder's containers must respawn to see the pooled copy.
  let restarted = 0;
  for (const g of listAgentsForUser(userId)) {
    if (dup?.agents.includes(g.id)) restarted += restartAgentGroupContainers(g.id, 'Skill promoted to shared pool');
  }
  return json(res, 200, { ok: true, restarted });
}

export async function rSkillItem(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const skillName = decodeURIComponent(m[1]);
  if (method === 'GET') return getSkillContentHandler(res, skillName); // viewing is fine for any admin
  // Writing a skill (create/edit/delete) introduces code that fans out to every
  // 'all' agent install-wide → owner/global-admin only, like import.
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (method === 'PUT') return putUserSkillHandler(req, res, skillName);
  return deleteUserSkillHandler(res, skillName);
}

export async function rSkillRevertPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const name = sanitizeSkillName(decodeURIComponent(m[2]));
  if (!name) return json(res, 400, { error: 'Invalid skill name' });
  const r = revertLastRevision(scopedSkillsDir(group.id), name);
  if (!r.ok) return json(res, 409, { error: r.error });
  const restarted = restartAgentGroupContainers(group.id, 'Skill revision reverted');
  return json(res, 200, { ok: true, restarted });
}

export async function rSkillRestorePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const name = sanitizeSkillName(decodeURIComponent(m[2]));
  if (!name) return json(res, 400, { error: 'Invalid skill name' });
  const r = restoreArchivedSkill(group.id, name);
  if (!r.ok) return json(res, 409, { error: r.error });
  const restarted = restartAgentGroupContainers(group.id, 'Webchat archived skill restored');
  return json(res, 200, { ok: true, restarted });
}

// ── Learning loop: skill drafts (proposed skills awaiting review) ───────
export async function rSkillDraftsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  // Scoped admins see only their own groups' drafts (owners/global admins
  // pass hasAdminPrivilege for every group) — same tier as the per-draft routes.
  const drafts = listSkillDrafts()
    .filter((d) => hasAdminPrivilege(userId, d.agent_group_id))
    .map(async (d) => ({
      id: d.id,
      skillName: d.skill_name,
      description: d.description,
      kind: d.kind,
      targetSkill: d.target_skill,
      agentGroupId: d.agent_group_id,
      agentName: (await getAgentGroup(d.agent_group_id))?.name || d.agent_group_id,
      createdAt: d.created_at,
      // The conversation this draft was distilled FROM — reviewing a skill
      // without the session that produced it is guessing.
      roomId: draftSourceRoom(d.session_id),
    }));
  return json(res, 200, { drafts });
}

// Skill collections (each a GitHub repo with one skill folder per entry under
// `dir`). The registry lives in webchat_skill_sources (seeded by migration 120,
// managed by global admins from Settings). Listing goes through the GitHub API
// (1 call); descriptions come from raw.githubusercontent (not API-rate-limited).
// Cached for an hour — catalogs change rarely and the API allows 60/hr.
export const catalogCache = new Map<
  string,
  { at: number; skills: Array<{ name: string; description: string; url: string }> }
>();

// Fetch (or serve cached) the skill list for one source row. Throws only when
// there's no cache to fall back on.
export async function loadCatalog(
  src: WebchatSkillSource,
): Promise<Array<{ name: string; description: string; url: string }>> {
  let entry = catalogCache.get(src.id);
  if (!entry || Date.now() - entry.at > 3600_000) {
    try {
      // Walk the repo tree once and take EVERY folder that contains a SKILL.md
      // at any depth under `dir` (empty dir = whole repo). This lets a collection
      // be a repo root, a single folder, or skills nested under category folders
      // (e.g. letta-ai/skills → letta/*, meta/*, tools/*) — not just one flat dir.
      const treeApi = `https://api.github.com/repos/${src.owner}/${src.repo}/git/trees/${src.branch}?recursive=1`;
      const r = await fetch(treeApi, {
        headers: { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(`GitHub API ${r.status}`);
      const tree = ((await r.json()) as { tree?: Array<{ path: string; type: string }> }).tree || [];
      const prefix = src.dir && src.dir !== '.' ? src.dir.replace(/^\/+|\/+$/g, '') + '/' : '';
      const seen = new Set<string>();
      const folders: Array<{ folder: string; name: string }> = [];
      for (const t of tree) {
        if (t.type !== 'blob' || !t.path.endsWith('/SKILL.md')) continue;
        if (prefix && !t.path.startsWith(prefix)) continue;
        const folder = t.path.slice(0, -'/SKILL.md'.length);
        const name = sanitizeSkillName(folder.split('/').pop() || '');
        if (!name || seen.has(name)) continue; // first wins on a leaf-name collision
        seen.add(name);
        folders.push({ folder, name });
      }
      // A one-skill repo/folder: SKILL.md sits at `dir` itself (no subfolder),
      // e.g. jdilla1277/agentcad-skill (SKILL.md at the repo root). Surface it as
      // a single skill named after the repo (or the dir).
      if (folders.length === 0) {
        const rootBase = prefix.replace(/\/$/, '');
        if (tree.some((t) => t.type === 'blob' && t.path === `${prefix}SKILL.md`)) {
          const name = sanitizeSkillName((rootBase ? rootBase.split('/').pop() : src.repo) || src.repo);
          if (name) folders.push({ folder: rootBase, name });
        }
      }
      const skills = await Promise.all(
        folders.slice(0, 100).map(async ({ folder, name }) => {
          const sub = folder ? `${folder}/` : ''; // '' when the skill IS the repo/dir root
          // description is best-effort
          let description = '';
          try {
            const raw = await fetch(
              `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${src.branch}/${sub}SKILL.md`,
              { headers: { 'User-Agent': 'nanoclaw' }, signal: AbortSignal.timeout(8000) },
            );
            if (raw.ok) {
              const fm = (await raw.text()).match(/^---\s*\n([\s\S]*?)\n---/);
              if (fm) description = frontMatterDescription(fm[1]);
            }
          } catch {
            /* best-effort */
          }
          return {
            name,
            description,
            url: `https://github.com/${src.owner}/${src.repo}/tree/${src.branch}${folder ? '/' + folder : ''}`,
          };
        }),
      );
      entry = { at: Date.now(), skills };
      catalogCache.set(src.id, entry);
    } catch (err) {
      // Serve a stale cache over an error if we have one.
      if (!entry) throw err;
    }
  }
  return entry.skills;
}

export const SKILL_DISCOVERY_SOURCE = { name: 'awesomeskill.ai', url: 'https://awesomeskill.ai' };

// Fetch community skills from awesomeskill.ai. Empty query = browse top-by-stars
// (the default pool); otherwise search. Best-effort — returns [] on error so a
// marketplace outage can't blank the whole pool.
export async function fetchMarketplace(
  q: string,
  limit = 25,
): Promise<
  Array<{ name: string; title: string; description: string; repo: string; stars: number; reviewUrl: string }>
> {
  const query = q.trim().slice(0, 100);
  try {
    const r = await fetch(`${SKILL_DISCOVERY_URL}?q=${encodeURIComponent(query)}&limit=${limit}&sort=stars`, {
      headers: { 'User-Agent': 'nanoclaw', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Discovery API ${r.status}`);
    const raw = (await r.json()) as unknown;
    const rec = raw as { results?: unknown; skills?: unknown; data?: unknown };
    const items = (Array.isArray(raw) ? raw : rec.results || rec.skills || rec.data || []) as Array<
      Record<string, unknown>
    >;
    return items
      .map((s) => {
        const repo = String(s.githubRepo || '').trim();
        return {
          name: sanitizeSkillName(String(s.name || '')),
          title: String(s.name || ''),
          description: String(s.description || ''),
          repo,
          stars: Number(s.githubStars) || 0,
          // Point Review at the actual code repo (repo is validated owner/repo
          // below), NOT the marketplace-supplied sourceUrl — that's third-party
          // controlled and would otherwise reach an <a href> unvalidated.
          reviewUrl: repo ? `https://github.com/${repo}` : '',
        };
      })
      .filter((s) => s.name && /^[^/]+\/[^/]+$/.test(s.repo));
  } catch {
    return [];
  }
}

export type PoolSkill = {
  name: string;
  description: string;
  origin: SkillOrigin;
  installed: boolean;
  review: string; // GitHub URL to review before importing
  ref: { url: string } | { repo: string; name: string }; // import descriptor
};

// One merged, deduped pool of skills for a trust tier. Official = the Anthropic
// collection(s). Community = every community GitHub collection PLUS the
// awesomeskill.ai marketplace, all badged by origin and treated equally — no
// collection is privileged. A query filters GitHub collections by substring and
// searches the marketplace. Curated collections list first, so they win dedup
// over marketplace copies of the same skill.
export async function catalogPoolHandler(res: ServerResponse, tier: string, q: string): Promise<void> {
  const wantOfficial = tier === 'official';
  const query = q.trim();
  const ql = query.toLowerCase();
  const installed = new Set(listAvailableSkills().map((s) => s.name));
  const tierSources = (await listSkillSources()).filter((s) => !!s.official === wantOfficial);
  const out: PoolSkill[] = [];
  const seen = new Set<string>();
  for (const src of tierSources) {
    let skills: Array<{ name: string; description: string; url: string }>;
    try {
      skills = await loadCatalog(src);
    } catch {
      continue; // one bad source can't blank the pool
    }
    const origin: SkillOrigin = {
      label: src.official ? src.label.replace(/\s*\((?:official|community)\)\s*$/i, '') : `${src.owner}/${src.repo}`,
      url: `https://github.com/${src.owner}/${src.repo}`,
      official: !!src.official,
    };
    for (const s of skills) {
      const name = sanitizeSkillName(s.name);
      if (!name || seen.has(name)) continue;
      if (query && !`${name} ${s.description}`.toLowerCase().includes(ql)) continue;
      seen.add(name);
      out.push({
        name,
        description: s.description,
        origin,
        installed: installed.has(name),
        review: s.url,
        ref: { url: s.url },
      });
    }
  }
  if (!wantOfficial && !isSourceDisabled(MARKETPLACE_ID)) {
    const origin: SkillOrigin = {
      label: SKILL_DISCOVERY_SOURCE.name,
      url: SKILL_DISCOVERY_SOURCE.url,
      official: false,
    };
    for (const m of await fetchMarketplace(query)) {
      if (!m.name || seen.has(m.name)) continue;
      seen.add(m.name);
      out.push({
        name: m.name,
        description: m.description,
        origin,
        installed: installed.has(m.name),
        review: m.reviewUrl,
        ref: { repo: m.repo, name: m.title },
      });
    }
  }
  // Sort by name so collections interleave — no source is grouped first. (Dedup
  // above already let curated collections win over marketplace copies.)
  out.sort((a, b) => a.name.localeCompare(b.name));
  return json(res, 200, { tier, official: wantOfficial, skills: out });
}

export async function putSkillSourceHandler(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const clean = sanitizeSkillName(id);
  if (!clean) return json(res, 400, { error: 'Invalid source id (a-z, 0-9, hyphens)' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { label?: unknown; url?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const parsed = await resolveSourceUrl(String(body.url || ''));
  if (!parsed) {
    return json(res, 400, {
      error: 'Expected a GitHub repo or folder URL, e.g. https://github.com/letta-ai/skills',
    });
  }
  // No label needed — name the collection after what it pulls in (owner/repo),
  // matching its badge everywhere. An explicit label still wins if one's sent.
  const label = String(body.label || '').trim() || `${parsed.owner}/${parsed.repo}`;
  // Verify the location actually lists skill folders before saving it. Admin-
  // added sources are always community (official=false); upsert ignores this
  // field, but the type requires it.
  const probe: WebchatSkillSource = { id: clean, label, ...parsed, official: false };
  catalogCache.delete(clean); // force a fresh fetch on edit
  try {
    const skills = await loadCatalog(probe);
    if (skills.length === 0) return json(res, 422, { error: 'That folder contains no skill directories' });
  } catch (err) {
    return json(res, 422, {
      error: 'Could not list that folder: ' + (err instanceof Error ? err.message : String(err)),
    });
  }
  upsertSkillSource(probe);
  return json(res, 200, { ok: true, source: { id: clean, label } });
}

// ── Skill suggestions for a new agent ───────────────────────────────────────
// Deterministic keyword scoring of the agent's name/description/instructions
// against installed skills + every catalog source. No LLM dependency: the
// create form calls this as the operator types, so it must be instant and work
// on installs with no local model. Synonyms bridge common phrasing gaps
// ("spreadsheet" → xlsx, "website" → frontend).
export const SKILL_SYNONYMS: Record<string, string[]> = {
  pdf: ['pdf', 'pdfs', 'document', 'documents', 'form', 'forms'],
  docx: ['word', 'docx', 'document', 'documents', 'letter', 'report', 'reports'],
  xlsx: [
    'excel',
    'xlsx',
    'spreadsheet',
    'spreadsheets',
    'csv',
    'budget',
    'finance',
    'financial',
    'invoice',
    'invoices',
  ],
  pptx: ['powerpoint', 'pptx', 'presentation', 'presentations', 'slides', 'deck', 'decks'],
  'frontend-design': ['website', 'websites', 'frontend', 'ui', 'web', 'landing', 'design'],
  'web-artifacts-builder': ['website', 'webapp', 'web', 'app', 'artifact'],
  'webapp-testing': ['test', 'testing', 'qa', 'browser', 'e2e'],
  'mcp-builder': ['mcp', 'integration', 'integrations', 'tool', 'tools', 'server'],
  'skill-creator': ['skill', 'skills'],
  'canvas-design': ['poster', 'posters', 'graphic', 'graphics', 'visual', 'design', 'image'],
  'algorithmic-art': ['art', 'generative', 'creative', 'p5js'],
  'slack-gif-creator': ['gif', 'gifs', 'slack'],
  'brand-guidelines': ['brand', 'branding', 'style'],
  'internal-comms': ['announcement', 'announcements', 'comms', 'communication', 'newsletter'],
  'doc-coauthoring': ['write', 'writing', 'draft', 'drafting', 'edit', 'editing', 'coauthor'],
  'agent-browser': ['browse', 'browser', 'web', 'research', 'scrape', 'scraping', 'read', 'news'],
  'frontend-engineer': ['website', 'websites', 'frontend', 'web', 'react', 'ui'],
  'vercel-cli': ['deploy', 'deployment', 'vercel', 'ship', 'publish'],
  brainstorming: ['brainstorm', 'brainstorming', 'ideas', 'ideation', 'creative'],
  'writing-plans': ['plan', 'plans', 'planning'],
  'executing-plans': ['plan', 'plans', 'execute', 'workflow'],
};

export const SUGGEST_STOPWORDS = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to use uses using when with you your agent assistant help helps'.split(
    ' ',
  ),
);

export function suggestTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !SUGGEST_STOPWORDS.has(t)),
  );
}

export async function suggestSkillsHandler(res: ServerResponse, text: string): Promise<void> {
  const tokens = suggestTokens(text);
  if (tokens.size === 0) return json(res, 200, { suggestions: [] });
  const installed = listAvailableSkills();
  const installedNames = new Set(installed.map((s) => s.name));
  // Candidates: installed skills + every catalog entry (cached; a cold cache
  // fetch can take a couple of seconds on the very first call — fine for a form).
  const candidates: Array<{ name: string; description: string; source: string; url?: string }> = installed.map((s) => ({
    name: s.name,
    description: s.description,
    source: 'installed',
  }));
  for (const src of listSkillSources()) {
    try {
      for (const s of await loadCatalog(src)) {
        if (!installedNames.has(sanitizeSkillName(s.name))) candidates.push({ ...s, source: src.label });
      }
    } catch {
      /* an unreachable catalog must not break suggestions */
    }
  }
  const suggestions = candidates
    .map((c) => {
      let score = 0;
      for (const t of suggestTokens(c.name.replace(/-/g, ' '))) if (tokens.has(t)) score += 3;
      for (const t of suggestTokens(c.description)) if (tokens.has(t)) score += 1;
      for (const syn of SKILL_SYNONYMS[c.name] || []) if (tokens.has(syn)) score += 3;
      return { ...c, score };
    })
    .filter((c) => c.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return json(res, 200, { suggestions });
}

export async function importSkillHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown; repo?: unknown; name?: unknown; origin?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let url = String(body.url || '').trim();
  // Discovery import: resolve {repo, name} into a github folder URL first.
  if (!url && body.repo) {
    try {
      url = await resolveDiscoveredSkillUrl(String(body.repo), String(body.name || ''));
    } catch (err) {
      return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Accept a folder URL (…/tree/branch/dir), a branch URL, OR a bare repo root —
  // the last covers a one-skill repo whose SKILL.md is at the root (e.g.
  // jdilla1277/agentcad-skill). Empty dir → import the repo/branch root.
  const resolved = await resolveSourceUrl(url);
  if (!resolved) {
    return json(res, 400, {
      error: 'Expected a GitHub repo or folder URL, e.g. https://github.com/owner/repo or .../tree/main/skill-folder',
    });
  }
  const { owner, repo, branch, dir } = resolved;
  // Provenance: trust the client's display label (catalog collection or the
  // marketplace it was discovered from), but fall back to the git owner/repo —
  // which is the real code origin and can't be spoofed, since it's parsed from
  // the fetch URL above.
  const origin: SkillOrigin = sanitizeOrigin(body.origin) ?? {
    label: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
    official: false,
  };
  // Pin the import: record where it came from and the commit it was taken at,
  // so "update available" is checkable later. Best-effort — never blocks.
  origin.ref = { owner, repo, branch, dir };
  origin.sha = (await latestCommitSha(origin.ref, 0)) ?? undefined;
  // Name after the skill folder, or the repo itself when the skill is the root.
  const skillName = sanitizeSkillName((dir ? dir.split('/').pop() : repo) || repo);
  if (!skillName) return json(res, 400, { error: 'Could not derive a skill name from the URL' });
  if (fs.existsSync(path.join(process.cwd(), 'container', 'skills', skillName))) {
    return json(res, 409, { error: `A built-in skill named "${skillName}" already exists` });
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
  // Stage in a temp dir, then swap into place so a failed import can't leave a
  // half-written skill.
  const dest = path.join(USER_SKILLS_DIR, skillName);
  const staging = `${dest}.importing`;
  try {
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
  // Callers that skipped the /inspect preview (direct API use, the agent-create
  // wizard's batch) still get the lint findings in the response.
  const inspection = inspectSkillFiles(skillName, files, { official: origin.official });
  return json(res, 200, { ok: true, name: skillName, files: files.length, warnings: inspection.warnings });
}

export async function inspectSkillHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown; repo?: unknown; name?: unknown; official?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let url = String(body.url || '').trim();
  if (!url && body.repo) {
    try {
      url = await resolveDiscoveredSkillUrl(String(body.repo), String(body.name || ''));
    } catch (err) {
      return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const resolved = await resolveSourceUrl(url);
  if (!resolved) return json(res, 400, { error: 'Expected a GitHub repo or folder URL' });
  const { owner, repo, branch, dir } = resolved;
  const skillName = sanitizeSkillName((dir ? dir.split('/').pop() : repo) || repo);
  let files: Array<{ rel: string; content: Buffer }>;
  try {
    files = await fetchGithubDir(owner, repo, branch, dir);
  } catch (err) {
    return json(res, 502, { error: 'Fetch failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  if (!files.some((f) => f.rel === 'SKILL.md')) {
    return json(res, 422, { error: 'That folder has no SKILL.md — not an Agent Skill' });
  }
  return json(res, 200, {
    name: skillName,
    ...inspectSkillFiles(skillName, files, { official: !!body.official }),
  });
}

/** Pool skills whose pinned upstream has moved: {name, hasUpdate}. */
export async function skillUpdatesHandler(res: ServerResponse): Promise<void> {
  const updates: Array<{ name: string; hasUpdate: boolean }> = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(USER_SKILLS_DIR);
  } catch {
    /* no pool yet */
  }
  await Promise.all(
    entries.map(async (name) => {
      const origin = readSkillOrigin(path.join(USER_SKILLS_DIR, name));
      if (!origin?.sha || !origin.ref) return; // unpinned (pre-pinning import or hand-written)
      const latest = await latestCommitSha(origin.ref);
      if (latest) updates.push({ name, hasUpdate: latest !== origin.sha });
    }),
  );
  return json(res, 200, { updates: updates.sort((a, b) => a.name.localeCompare(b.name)) });
}

/**
 * Re-import a pinned pool skill from its recorded ref at upstream HEAD. The
 * outgoing version is snapshotted into the pool's .history first — an update
 * is as revertible as a learned-skill patch.
 */
export async function applySkillUpdateHandler(res: ServerResponse, name: string): Promise<void> {
  const clean = sanitizeSkillName(name);
  const dest = path.join(USER_SKILLS_DIR, clean);
  if (!clean || !fs.existsSync(dest)) return json(res, 404, { error: 'Skill not found' });
  const origin = readSkillOrigin(dest);
  if (!origin?.ref) return json(res, 409, { error: 'This skill has no recorded source to update from' });
  let files: Array<{ rel: string; content: Buffer }>;
  try {
    files = await fetchGithubDir(origin.ref.owner, origin.ref.repo, origin.ref.branch, origin.ref.dir);
  } catch (err) {
    return json(res, 502, { error: 'Fetch failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  if (!files.some((f) => f.rel === 'SKILL.md')) {
    return json(res, 422, { error: 'Upstream no longer has a SKILL.md at the recorded path' });
  }
  try {
    snapshotRevision(USER_SKILLS_DIR, clean);
  } catch {
    /* history is protection, not a gate */
  }
  const newSha = (await latestCommitSha(origin.ref, 0)) ?? undefined;
  const staging = `${dest}.updating`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const f of files) {
      const target = path.join(staging, f.rel);
      if (target !== staging && !target.startsWith(staging + path.sep)) continue; // no traversal
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    fs.writeFileSync(path.join(staging, '.origin.json'), JSON.stringify({ ...origin, sha: newSha }));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return json(res, 500, { error: 'Write failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  const inspection = inspectSkillFiles(clean, files, { official: origin.official });
  return json(res, 200, { ok: true, name: clean, files: files.length, warnings: inspection.warnings });
}

export function deleteUserSkillHandler(res: ServerResponse, name: string): void {
  const clean = sanitizeSkillName(name);
  if (clean && fs.existsSync(path.join(process.cwd(), 'container', 'skills', clean))) {
    return json(res, 403, { error: 'Built-in skills cannot be deleted' });
  }
  const dir = path.join(USER_SKILLS_DIR, clean);
  if (!clean || !fs.existsSync(dir)) return json(res, 404, { error: 'Skill not found' });
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export function getSkillContentHandler(res: ServerResponse, name: string): void {
  const clean = sanitizeSkillName(name);
  if (!clean) return json(res, 404, { error: 'Skill not found' });
  const shipped = path.join(process.cwd(), 'container', 'skills', clean, 'SKILL.md');
  const user = path.join(USER_SKILLS_DIR, clean, 'SKILL.md');
  const file = fs.existsSync(shipped) ? shipped : fs.existsSync(user) ? user : null;
  if (!file) return json(res, 404, { error: 'Skill not found' });
  try {
    return json(res, 200, {
      name: clean,
      source: file === shipped ? 'shipped' : 'user',
      content: fs.readFileSync(file, 'utf8'),
    });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
