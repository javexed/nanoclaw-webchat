// What this machine binds into an agent container, decided HERE.
//
// Central may declare a slot (a container path it wants filled, e.g. the
// developer's project at /workspace/project); only the laptop can say which
// local directory that is. An explicit `nanoclaw.slots` entry always wins; the
// workspace slot is otherwise filled with the first open workspace folder, so
// an agent placed on this machine works on the code in front of the developer
// without any configuration. `workspaceMount: 'off'` withholds it — central's
// spec then refuses with "slot not bound", never a silent fallback.
export const WORKSPACE_SLOT = '/workspace/project';

export type WorkspaceMount = 'workspace' | 'off';

export function effectiveSlots(
  configured: Record<string, string>,
  workspaceFolders: readonly string[],
  workspaceMount: WorkspaceMount,
  activeFile?: string,
): Record<string, string> {
  const auto: Record<string, string> = {};
  if (workspaceMount === 'workspace' && workspaceFolders.length > 0) {
    auto[WORKSPACE_SLOT] = pickWorkspaceFolder(workspaceFolders, activeFile);
  }
  return { ...auto, ...configured };
}

/**
 * Which folder of a multi-root workspace the agent gets. The one holding the
 * file the developer is looking at, when that is one of them — otherwise the
 * first. (A single container path can hold one folder; binding several would
 * make "the project" ambiguous for the agent and for review.)
 */
export function pickWorkspaceFolder(folders: readonly string[], activeFile?: string): string {
  if (activeFile) {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const file = norm(activeFile);
    const containing = folders
      .filter((f) => file === norm(f) || file.startsWith(`${norm(f)}/`))
      .sort((a, b) => norm(b).length - norm(a).length); // the most specific root wins
    if (containing.length) return containing[0];
  }
  return folders[0];
}

/**
 * Secret-like paths hidden from the agent inside the workspace slot. Matched
 * against paths relative to the slot root; a pattern without a slash matches a
 * basename anywhere. Central may add patterns on the placement; a machine can
 * add its own; neither can remove the other's — the union is what applies.
 */
export const DEFAULT_WORKSPACE_EXCLUDES: readonly string[] = [
  'secrets',
  'secret',
  '.secrets',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.jks',
  '*.keystore',
  'id_rsa',
  'id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'credentials.json',
  'service-account*.json',
  'terraform.tfstate',
  'terraform.tfstate.*',
];

/** Glob → RegExp for one path segment or a relative path: `*` (no `/`), `?`, `**`. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesExclude(relPath: string, patterns: readonly string[]): boolean {
  const rel = relPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  for (const raw of patterns) {
    const pat = raw.trim().replace(/\/+$/, '');
    if (!pat) continue;
    const re = globToRegExp(pat.replace(/^\.\//, ''));
    if (pat.includes('/')) {
      if (re.test(rel)) return true;
    } else if (re.test(base)) return true;
  }
  return false;
}

export interface ExcludedPath {
  rel: string;
  kind: 'dir' | 'file';
}

/**
 * Walk the slot root and list what the patterns hide. A matched directory is
 * hidden whole (not descended). `.git` and `node_modules` are skipped unless a
 * pattern names them — they are huge and hold no secrets of this shape.
 * Bounded: the walk stops (and reports `truncated`) rather than spend minutes
 * on a monorepo; a hidden set that large is a sign to exclude a directory.
 */
export function findExcluded(
  root: string,
  patterns: readonly string[],
  fs: {
    readdirSync: (
      p: string,
      o: { withFileTypes: true },
    ) => Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  },
  limits: { maxMatches?: number; maxVisited?: number; maxDepth?: number } = {},
): { excluded: ExcludedPath[]; truncated: boolean } {
  const maxMatches = limits.maxMatches ?? 500;
  const maxVisited = limits.maxVisited ?? 200_000;
  const maxDepth = limits.maxDepth ?? 24;
  const excluded: ExcludedPath[] = [];
  let visited = 0;
  let truncated = false;
  const skipDirs = new Set(['.git', 'node_modules']);
  const namesPatterns = (name: string) => patterns.some((p) => p.replace(/\/+$/, '') === name);
  const walk = (dirRel: string, depth: number): void => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dirRel ? `${root}/${dirRel}` : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++visited > maxVisited || excluded.length >= maxMatches) {
        truncated = true;
        return;
      }
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        // Never follow: a link out of the workspace must not widen what is visible, and a
        // link named like a secret is hidden as a file.
        if (matchesExclude(rel, patterns)) excluded.push({ rel, kind: 'file' });
        continue;
      }
      if (e.isDirectory()) {
        if (matchesExclude(rel, patterns)) {
          excluded.push({ rel, kind: 'dir' });
          continue;
        }
        if (skipDirs.has(e.name) && !namesPatterns(e.name)) continue;
        if (depth < maxDepth) walk(rel, depth + 1);
      } else if (e.isFile() && matchesExclude(rel, patterns)) excluded.push({ rel, kind: 'file' });
    }
  };
  walk('', 0);
  return { excluded, truncated };
}
