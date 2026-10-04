// Which project on this machine the agent's tools work on, decided HERE.
//
// Central names the slot /workspace/project; only the laptop can say which
// local directory that is: the open workspace folder, so an agent placed on
// this machine works on the code in front of the developer. No folder open,
// no slot — the tools then refuse with "slot not bound", never a fallback.
export const WORKSPACE_SLOT = '/workspace/project';

export function workspaceSlots(workspaceFolders: readonly string[], activeFile?: string): Record<string, string> {
  return workspaceFolders.length > 0 ? { [WORKSPACE_SLOT]: pickWorkspaceFolder(workspaceFolders, activeFile) } : {};
}

/**
 * Which folder of a multi-root workspace the agent gets. The one holding the
 * file the developer is looking at, when that is one of them — otherwise the
 * first. (The slot holds one folder; binding several would
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
  '*.env',
  '.envrc',
  '.kube',
  'kubeconfig',
  'id_ecdsa',
  'id_ecdsa.*',
  'id_dsa',
  'id_dsa.*',
  '*.ppk',
  '**/.docker/config.json',
  '.pgpass',
  '.htpasswd',
  '.vault-token',
  '*.tfstate',
  '*.tfstate.backup',
  'application_default_credentials.json',
  'settings.local.php',
  'wp-config.php',
  '*.kdbx',
];

/**
 * Names that are secrets or data dumps when git does not track them, and
 * ordinary project files when it does: an i18n `auth.json`, a yarn berry
 * `.yarnrc.yml`, a `.tfvars` per environment, a test fixture `*.db`. Hiding
 * those would break real projects, so this list applies only where the tracked
 * ones can be told apart — the propose-mode snapshot, which leaves the
 * untracked matches out. A read-only slot overlays whatever is on disk and
 * cannot tell them apart, so it does not use this list.
 */
export const UNTRACKED_SECRET_EXCLUDES: readonly string[] = [
  'auth.json',
  '.yarnrc.yml',
  '*.tfvars',
  '*.sql',
  '*.sql.gz',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.dump',
];

/**
 * Glob → RegExp for one path segment or a relative path: `*` (no `/`), `?`, `**`.
 * Case-insensitive: on Windows (and macOS) `.ENV` is the same file as `.env`,
 * and a secret list that a capital letter walks past is no list.
 */
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
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Whether `relPath` is hidden by `patterns`: it, or a folder it is in, matches
 * one. (A snapshot lists tracked files one by one, so `.aws/credentials` must
 * be caught by `.aws` as the walk below catches the folder whole.)
 */
export function matchesExclude(relPath: string, patterns: readonly string[]): boolean {
  const segs = relPath.split(/[\\/]+/).filter(Boolean);
  const prefixes = segs.map((_, i) => segs.slice(0, i + 1).join('/'));
  for (const raw of patterns) {
    const pat = raw.trim().replace(/\/+$/, '');
    if (!pat) continue;
    const re = globToRegExp(pat.replace(/^\.\//, ''));
    if (pat.includes('/') ? prefixes.some((p) => re.test(p)) : segs.some((seg) => re.test(seg))) return true;
  }
  return false;
}
