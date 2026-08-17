// ── Skill sources ────────────────────────────────────────────────────────────
// Turning a skill source into something fetchable, and the GitHub reads behind
// it: the discovery endpoint, URL resolution for a configured or a discovered
// source, a directory listing and the head commit of one.
//
// Shared rather than moved. The skill routes drive the catalog, but import,
// update checks and the discovery source resolve and fetch through the same
// helpers from outside the cluster.

/**
 * Latest commit SHA touching a path — the freshness probe for update checks
 * and the pin recorded at import. Best-effort: null on any failure (an import
 * must never fail because a SHA lookup did). Cached like the catalogs.
 */
import { SkillOriginRef, sanitizeSkillName } from './skills-store.js';

export const shaCache = new Map<string, { at: number; sha: string | null }>();

export async function latestCommitSha(ref: SkillOriginRef, maxAgeMs = 3600_000): Promise<string | null> {
  const key = `${ref.owner}/${ref.repo}@${ref.branch}:${ref.dir}`;
  const hit = shaCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.sha;
  let sha: string | null = null;
  try {
    const api =
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits` +
      `?sha=${encodeURIComponent(ref.branch)}&per_page=1` +
      (ref.dir ? `&path=${encodeURIComponent(ref.dir)}` : '');
    const r = await githubFetch(api, { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' });
    if (r.ok) {
      const commits = (await r.json()) as Array<{ sha?: string }>;
      sha = commits?.[0]?.sha ?? null;
    }
  } catch {
    /* best-effort */
  }
  shaCache.set(key, { at: Date.now(), sha });
  return sha;
}

// fetch() that retries once on a 5xx or network error — GitHub's gateway
// returns transient 502s under load, which shouldn't fail a whole import.
export async function githubFetch(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
      if (r.status >= 500 && r.status < 600 && attempt < 1) {
        await new Promise((res) => setTimeout(res, 600));
        continue;
      }
      return r;
    } catch (err) {
      if (attempt < 1) {
        await new Promise((res) => setTimeout(res, 600));
        continue;
      }
      throw err;
    }
  }
}

// Recursively fetch a GitHub folder via the contents API. Input is host-locked
// to github.com (parsed by the caller); the API + download_urls only reach
// github's own hosts, so there's no SSRF surface. Capped in files + bytes.
export async function fetchGithubDir(
  owner: string,
  repo: string,
  branch: string,
  dirPath: string,
): Promise<Array<{ rel: string; content: Buffer }>> {
  const MAX_FILES = 60;
  const MAX_BYTES = 8 * 1024 * 1024;
  const base = dirPath.replace(/\/+$/, '');
  // Walk the tree first (serial — each level needs its parent listing), then
  // download contents in parallel: script-heavy skills (xlsx: 54 files) took
  // ~10s serial, ~2s parallel.
  const files: Array<{ rel: string; download_url: string }> = [];
  let totalBytes = 0;
  async function walk(p: string): Promise<void> {
    const api = `https://api.github.com/repos/${owner}/${repo}/contents${p ? '/' + encodeURI(p) : ''}?ref=${encodeURIComponent(branch)}`;
    const r = await githubFetch(api, { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const items = (await r.json()) as Array<{ type: string; path: string; download_url: string | null; size: number }>;
    if (!Array.isArray(items)) throw new Error('That URL is a file, not a folder');
    for (const it of items) {
      if (files.length >= MAX_FILES) throw new Error(`Too many files (>${MAX_FILES})`);
      if (it.type === 'dir') {
        await walk(it.path);
      } else if (it.type === 'file' && it.download_url) {
        totalBytes += it.size || 0;
        if (totalBytes > MAX_BYTES) throw new Error('Skill exceeds 8MB');
        files.push({ rel: it.path.slice(base.length).replace(/^\/+/, ''), download_url: it.download_url });
      }
    }
  }
  await walk(base);
  return Promise.all(
    files.map(async (f) => {
      const fr = await githubFetch(f.download_url, { 'User-Agent': 'nanoclaw' });
      if (!fr.ok) throw new Error(`Download ${fr.status}`);
      return { rel: f.rel, content: Buffer.from(await fr.arrayBuffer()) };
    }),
  );
}

// The awesomeskill.ai marketplace — the ONE allowlisted discovery host, a
// community source pooled alongside the GitHub collections. Public, read-only.
export const SKILL_DISCOVERY_URL = 'https://awesomeskill.ai/api/agent/skills/search';

// Parse a GitHub folder URL into skill-source components (shared by the source
// editor and validated the same way as skill imports).
export function parseGithubDirUrl(url: string): { owner: string; repo: string; branch: string; dir: string } | null {
  const m = url.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/);
  return m ? { owner: m[1], repo: m[2], branch: m[3], dir: m[4] } : null;
}

// Resolve a source URL into {owner, repo, branch, dir}. Accepts a folder URL
// (…/tree/branch/dir), a branch URL (…/tree/branch → whole branch), OR a bare
// repo root (…/owner/repo → default branch, whole repo). loadCatalog walks the
// tree from `dir`, so an empty dir means "find skills anywhere in the repo".
export async function resolveSourceUrl(
  url: string,
): Promise<{ owner: string; repo: string; branch: string; dir: string } | null> {
  const u = url.trim();
  const folder = parseGithubDirUrl(u);
  if (folder) return folder;
  const branchOnly = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?$/);
  if (branchOnly) return { owner: branchOnly[1], repo: branchOnly[2], branch: branchOnly[3], dir: '' };
  const root = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (root) {
    try {
      const r = await fetch(`https://api.github.com/repos/${root[1]}/${root[2]}`, {
        headers: { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const branch = ((await r.json()) as { default_branch?: string }).default_branch || 'main';
      return { owner: root[1], repo: root[2], branch, dir: '' };
    } catch {
      return null;
    }
  }
  return null;
}

// Discovery gives a repo (owner/repo) + skill name, not the folder path. Walk
// the repo tree once and return the github folder URL of the SKILL.md whose
// parent dir matches the name — so a discovered skill imports through the same
// GitHub-only pipeline as a pasted folder URL.
export async function resolveDiscoveredSkillUrl(repoRaw: string, name: string): Promise<string> {
  const m = repoRaw.trim().match(/(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) throw new Error('unrecognized repo');
  const [, owner, repo] = m;
  const gh = async (p: string) => {
    const r = await githubFetch(`https://api.github.com/repos/${owner}/${repo}${p}`, {
      'User-Agent': 'nanoclaw',
      Accept: 'application/vnd.github+json',
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    return r.json();
  };
  const branch = ((await gh('')) as { default_branch?: string }).default_branch || 'main';
  const tree =
    ((await gh(`/git/trees/${branch}?recursive=1`)) as { tree?: Array<{ path: string; type: string }> }).tree || [];
  const skillMds = tree.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path));
  const want = sanitizeSkillName(name);
  const parentDir = (p: string) => p.split('/').slice(-2)[0] || '';
  const match =
    skillMds.find((t) => sanitizeSkillName(parentDir(t.path)) === want) ||
    skillMds.find((t) => sanitizeSkillName(parentDir(t.path)).includes(want) && want.length >= 3) ||
    (skillMds.length === 1 ? skillMds[0] : null);
  if (!match) throw new Error("couldn't pinpoint the skill folder — open the repo and import the folder URL by hand");
  const dir = match.path.replace(/\/?SKILL\.md$/i, '');
  if (!dir) throw new Error('skill lives at the repo root — import the repo URL by hand');
  return `https://github.com/${owner}/${repo}/tree/${branch}/${dir}`;
}
