// ── Agent template library ──────────────────────────────────────────────────
//
// Managing the LOCAL template library: browsing a remote source, fetching a
// template into the library, describing one, and removing one.
//
// Fetching goes through the GitHub contents API (the same `githubFetch` the
// skills registry uses — retry, rate-limit handling, optional token) rather
// than the wizard's `git clone`. A server process should not shell out to git,
// and the API path is the one that works for a private repo with a token,
// which is the point of having a source LIST at all.
//
// Every fetched template is validated on ARRIVAL with upstream's own reader:
// containment, symlink refusal, size caps, secret lint, manifest validity. A
// template that would fail at stamp time must fail here, while the operator is
// looking at it — not weeks later when someone tries to use it.
import fs from 'fs';
import path from 'path';

import { parseTemplate } from '../../../templates/parse.js';
import { resolveLocalTemplate, listLocalTemplates, type LocalTemplateEntry } from '../../../templates/local-dir.js';
import { TEMPLATES_DIR } from '../../../config.js';
import { log } from '../../../log.js';
import type { WebchatTemplateSource } from '../db.js';
import { fetchGithubDir, githubFetch } from './skill-sources.js';

/** One template offered by a remote source. */
export interface RemoteTemplate {
  ref: string;
  name: string;
  description?: string;
}

const MANIFEST = 'plugin.json';

/**
 * List the templates a source offers.
 *
 * The registry layout is `<category>/<template>/plugin.json`, so this walks two
 * levels rather than the whole tree — a full recursive walk of a repo to find
 * manifests would be dozens of API calls against a rate limit for no extra
 * information. A repo that IS a single plugin (manifest at the root) is
 * recognised too, and reported as ref ".".
 */
export async function browseTemplateSource(src: WebchatTemplateSource): Promise<RemoteTemplate[]> {
  const api = (p: string) =>
    `https://api.github.com/repos/${src.owner}/${src.repo}/contents${p ? '/' + encodeURI(p) : ''}?ref=${encodeURIComponent(src.branch)}`;
  const headers = { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' };

  type Entry = { type: string; name: string; path: string; download_url: string | null };
  const listDir = async (p: string): Promise<Entry[]> => {
    const r = await githubFetch(api(p), headers);
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const items: unknown = await r.json();
    if (!Array.isArray(items)) throw new Error('That path is a file, not a folder');
    return items as Entry[];
  };

  const root = await listDir('');
  if (root.some((e) => e.type === 'file' && e.name === MANIFEST)) {
    const meta = await readManifest(root.find((e) => e.name === MANIFEST)!.download_url);
    return [{ ref: '.', name: meta.name ?? src.repo, ...(meta.description ? { description: meta.description } : {}) }];
  }

  const out: RemoteTemplate[] = [];
  for (const cat of root) {
    // Skip repo furniture rather than probing it: .github, scripts, media…
    if (cat.type !== 'dir' || cat.name.startsWith('.') || cat.name === 'scripts') continue;
    let children: Entry[];
    try {
      children = await listDir(cat.path);
    } catch {
      continue; // an unreadable category should not fail the whole listing
    }
    for (const tpl of children) {
      if (tpl.type !== 'dir') continue;
      let inner: Entry[];
      try {
        inner = await listDir(tpl.path);
      } catch {
        continue;
      }
      const manifest = inner.find((e) => e.type === 'file' && e.name === MANIFEST);
      if (!manifest) continue;
      const meta = await readManifest(manifest.download_url);
      out.push({
        ref: `${cat.name}/${tpl.name}`,
        name: meta.name ?? tpl.name,
        ...(meta.description ? { description: meta.description } : {}),
      });
    }
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Best-effort manifest read for the listing — a bad manifest still lists, under its folder name. */
async function readManifest(url: string | null): Promise<{ name?: string; description?: string }> {
  if (!url) return {};
  try {
    const r = await githubFetch(url, { 'User-Agent': 'nanoclaw' });
    if (!r.ok) return {};
    const m = (await r.json()) as Record<string, unknown>;
    return {
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
    };
  } catch {
    return {};
  }
}

/** A ref is a path into the library: reject anything that could leave it. */
function assertSafeRef(ref: string): void {
  if (!ref || ref !== ref.trim()) throw new Error(`Invalid template ref: "${ref}"`);
  if (path.isAbsolute(ref) || ref.startsWith('~')) throw new Error('Template ref must be relative to the library');
  const candidate = path.resolve(TEMPLATES_DIR, ref);
  const rel = path.relative(TEMPLATES_DIR, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Template ref escapes the library: "${ref}"`);
}

/**
 * Fetch a template from a source into the local library.
 *
 * Downloaded into a staging directory and VALIDATED before it replaces
 * anything: a half-written or invalid template must never become the thing
 * sitting in the library. Returns the reader's report so a skipped component
 * is named, never silently dropped.
 */
export async function fetchTemplateInto(
  src: WebchatTemplateSource,
  ref: string,
): Promise<{ ref: string; name: string; report: string[] }> {
  assertSafeRef(ref);
  const dirPath = ref === '.' ? '' : ref;
  const files = await fetchGithubDir(src.owner, src.repo, src.branch, dirPath);
  if (!files.some((f) => f.rel === MANIFEST)) {
    throw new Error(`Not an agent plugin: ${MANIFEST} not found at ${src.owner}/${src.repo}/${ref}`);
  }

  const dest = path.resolve(TEMPLATES_DIR, ref === '.' ? src.repo : ref);
  const staging = `${dest}.incoming-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const f of files) {
      // The archive's own paths are untrusted: resolve each one and refuse
      // anything that lands outside the staging dir.
      const out = path.resolve(staging, f.rel);
      if (!out.startsWith(staging + path.sep)) throw new Error(`Refusing path outside the template: ${f.rel}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, f.content);
    }
    // Upstream's reader IS the validator — containment, symlinks, caps, secret
    // lint, manifest validity. Throwing here leaves the library untouched.
    const parsed = parseTemplate(staging);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(staging, dest);
    return { ref: ref === '.' ? src.repo : ref, name: parsed.name, report: parsed.report };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** What one library template contains — enough to decide whether to stamp it. */
/**
 * What an MCP server in a template will actually launch.
 *
 * Names alone are not reviewable. `command` is already tightly constrained by
 * the reader (single bare token or ./-relative, no shell strings, no ${}
 * expansion) — but `args` is not, so `command: "bash"` with
 * `args: ["-c", "…"]` is a legal template. That runs inside the agent's
 * container, where the agent already has a shell, so it is not privilege
 * escalation; what it buys is code running without the operator asking the
 * agent for anything. The answer is to show it before stamping, not to guess
 * intent from a blocklist — plenty of legitimate servers are
 * `npx -y @modelcontextprotocol/server-filesystem /path`.
 *
 * env VALUES never leave the host: a template carrying a high-confidence
 * secret is rejected outright, but keys-only is the safer default for the
 * rest.
 */
export interface TemplateMcpSummary {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
}

export interface TemplateDetail extends LocalTemplateEntry {
  persona: string | null;
  skills: string[];
  tasks: { name: string; schedule: string }[];
  mcpServers: TemplateMcpSummary[];
  contextFiles: string[];
  report: string[];
}

export function templateDetail(ref: string): TemplateDetail {
  assertSafeRef(ref);
  const dir = resolveLocalTemplate(ref);
  const t = parseTemplate(dir);
  const listed = listLocalTemplates().find((e) => e.ref === ref);
  return {
    ref,
    name: t.agentName ?? t.name,
    ...(listed?.description ? { description: listed.description } : {}),
    ...(listed?.version ? { version: listed.version } : {}),
    // Persona is always in the agent's prompt, so show it rather than assert it
    // exists — a template without one stamps fine and uses the default doc.
    persona: t.instructions ?? null,
    skills: t.skills.map((s) => s.name).sort(),
    tasks: t.tasks.map((k) => ({ name: k.name, schedule: k.schedule })),
    mcpServers: Object.entries(t.mcpServers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, s]): TemplateMcpSummary => {
        // `'url' in s` narrows the McpServerConfig union properly. Casting it to
        // Record<string, unknown> does not typecheck — the http variant has no
        // index signature — and would have thrown away the narrowing anyway.
        if ('url' in s) {
          return {
            name,
            transport: 'http',
            url: s.url,
            ...(s.headers ? { envKeys: Object.keys(s.headers).sort() } : {}),
          };
        }
        return {
          name,
          transport: 'stdio',
          command: s.command,
          ...(s.args?.length ? { args: [...s.args] } : {}),
          ...(s.env ? { envKeys: Object.keys(s.env).sort() } : {}),
        };
      }),
    contextFiles: t.contextExtras.map((c) => c.name).sort(),
    report: t.report,
  };
}

/**
 * Remove a template from the library. This does NOT touch agents already
 * stamped from it: the stamped plugin lives in the group's own directory, and
 * deleting the library copy only means it can no longer be stamped or updated.
 */
export function deleteLocalTemplate(ref: string): boolean {
  assertSafeRef(ref);
  const dir = path.resolve(TEMPLATES_DIR, ref);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  // Tidy an emptied category so the library does not accumulate husks.
  const parent = path.dirname(dir);
  try {
    if (parent !== path.resolve(TEMPLATES_DIR) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch (err) {
    log.warn('Webchat: could not remove empty template category', { parent, err });
  }
  return true;
}
