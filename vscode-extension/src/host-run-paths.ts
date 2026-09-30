// Paths in a project that tools on the developer's machine act on: VS Code
// (settings, tasks, Dev Containers), git (hooks, attributes, submodules) and
// the hook managers. A proposed change to one is applied only after the
// developer says yes.
//
// Names are compared without case: on Windows `.VSCode` is `.vscode`.

/** Editor config folders (anywhere in the tree): what they hold VS Code applies on the developer's machine. */
const EDITOR_CONFIG_DIRS = ['.vscode', '.devcontainer'];
/**
 * Files at a folder's top that tools on the developer's machine run commands
 * from: Dev Containers (`initializeCommand`), pre-commit and lefthook (hooks
 * the developer's next commit runs). Lefthook reads any of its names, with or
 * without a dot, in YAML, TOML or JSON, and a `-local` override of each (at
 * any depth, which covers `.config/lefthook.yml`).
 */
const LEFTHOOK_FILES = ['', '.'].flatMap((dot) =>
  ['lefthook', 'lefthook-local'].flatMap((base) =>
    ['yml', 'yaml', 'toml', 'json', 'jsonc'].map((ext) => `${dot}${base}.${ext}`),
  ),
);
const HOST_RUN_FILES = ['.devcontainer.json', '.pre-commit-config.yaml', ...LEFTHOOK_FILES];
/** Conventional hooks folders (husky, a plain `.githooks`); a configured core.hooksPath is added by the caller. */
const HOOK_DIRS = ['.husky', '.githooks'];

/** Why applying a proposed change needs the developer's explicit yes. Short: shown as a label. */
export type Risk =
  | 'runs code in VS Code'
  | 'git hook'
  | 'changes git attributes'
  | 'changes submodules'
  | 'symbolic link'
  | 'makes a file executable'
  | 'changes file mode';

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * What a proposed change to `rel` would let run on the developer's machine,
 * if anything. `oldMode`/`newMode` are git modes ('100644', '100755',
 * '120000', …; '000000' or absent when the file is new or gone).
 * `hooksDirs` are further hooks folders, relative, forward slashes.
 */
export function riskOf(
  rel: string,
  modes: { oldMode?: string; newMode?: string } = {},
  hooksDirs: readonly string[] = [],
): Risk | null {
  const { oldMode = '000000', newMode = '000000' } = modes;
  const segs = rel.split('/').filter(Boolean);
  const base = segs[segs.length - 1] ?? '';
  if (newMode === '120000' || (oldMode === '120000' && newMode !== '000000')) return 'symbolic link';
  if (segs.some((s) => EDITOR_CONFIG_DIRS.some((d) => same(s, d)))) return 'runs code in VS Code';
  if (same(base, '.devcontainer.json') || base.toLowerCase().endsWith('.code-workspace')) return 'runs code in VS Code';
  if (
    segs.some((s) => HOOK_DIRS.some((d) => same(s, d))) ||
    HOST_RUN_FILES.some((f) => same(base, f)) ||
    hooksDirs.some((d) => same(rel, d) || rel.toLowerCase().startsWith(`${d.toLowerCase()}/`))
  )
    return 'git hook';
  if (same(base, '.gitattributes')) return 'changes git attributes';
  if (same(base, '.gitmodules') || newMode === '160000') return 'changes submodules';
  if (newMode === '100755' && oldMode !== '100755') return 'makes a file executable';
  if (oldMode !== '000000' && newMode !== '000000' && oldMode !== newMode) return 'changes file mode';
  return null;
}
