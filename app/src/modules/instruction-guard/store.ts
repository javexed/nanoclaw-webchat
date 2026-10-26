/**
 * The approved-content store and the spawn-time comparison for the instruction
 * guard (see ./index.ts). Host-only: nothing here imports the approvals
 * module or the container runner, so the runner can load it without a cycle.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { AnchoredDir } from '../../anchored-dir.js';
import { audit } from '../../audit.js';
import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { makeContainerWritable } from '../../container-runtime-extras.js';
import { PERSONA_PREPEND_FILE } from '../../group-persona.js';
import { log } from '../../log.js';
import { claudeSettingsTransformer } from '../../migrate-claude-memory-settings.js';
import type { AgentGroup } from '../../types.js';
import { INSTRUCTION_CHANGE_ACTION } from './guard.js';

/** A held copy is kept only up to this size; a larger write is reset outright. */
const MAX_HELD_BYTES = 1024 * 1024;
/** A guarded directory holding more than this is reset outright. */
const MAX_TREE_FILES = 200;
const MAX_TREE_DEPTH = 8;
/** An owner's reject stands this long: the same content is reverted without a new card. */
export const REJECT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The approved snapshot the agent-runner checks before every query (read-only in the container). */
export const RUNTIME_BASELINE_DIR = '.instruction-baseline';
export const RUNTIME_BASELINE_CONTAINER_DIR = '/app/.instruction-baseline';
/** Where the agent-runner leaves an edit it reverted mid-session, in the session folder. */
export const PROPOSALS_DIR = '.instruction-proposals';

export interface GuardedFile {
  id: string;
  /** How the card and the agent's notice name the file. */
  label: string;
  /**
   * The group folder, the group's provider state directory
   * (data/v2-sessions/<id>), or the spawning session's folder (`/workspace`).
   */
  base: 'group' | 'state' | 'session';
  /** Directories below the base; a non-directory there is cleared as foreign. */
  segments: readonly string[];
  name: string;
  /** 'tree': every regular file below the directory `name`, guarded as one unit. */
  kind: 'file' | 'tree';
  /**
   * The directory is the agent's to create (nothing on the host makes it), so
   * its absence is itself the approved state: "no file". Without this a
   * directory the agent creates mid-session would be adopted at first sight.
   */
  absentDirIsNoFile?: boolean;
  /**
   * Claude's settings.json: compared without the runner's own startup
   * additions, and the baseline is first advanced through the host's settings
   * reconcile (the host's own write at every spawn).
   */
  settings?: 'claude';
  /** Where the container sees it; the agent-runner's per-turn check works on this path. */
  containerPath: string;
}

/**
 * Everything below `.claude` that Claude Code loads into every session, for
 * the project (group folder) and the user (provider state) scope.
 */
function claudeDirEntries(scope: 'project' | 'user'): GuardedFile[] {
  const base = scope === 'project' ? 'group' : 'state';
  const segments = scope === 'project' ? ['.claude'] : ['.claude-shared'];
  const root = scope === 'project' ? '/workspace/agent/.claude' : '/home/node/.claude';
  const shown = scope === 'project' ? '.claude' : '~/.claude';
  const what = scope === 'project' ? 'project' : 'user';
  const entry = (
    name: string,
    kind: 'file' | 'tree',
    label: string,
    extra: Partial<GuardedFile> = {},
  ): GuardedFile => ({
    id: `claude-${scope}-${name.replace(/[^a-z]+/g, '-').replace(/-$/, '')}`,
    label: `\`${shown}/${name}${kind === 'tree' ? '/' : ''}\` (Claude ${what} ${label})`,
    base,
    segments,
    name,
    kind,
    containerPath: `${root}/${name}`,
    ...(scope === 'project' ? { absentDirIsNoFile: true } : {}),
    ...extra,
  });
  const rows = [
    entry('settings.json', 'file', 'settings and hooks', scope === 'user' ? { settings: 'claude' } : {}),
    entry('rules', 'tree', 'rules'),
    entry('agents', 'tree', 'subagents'),
    entry('output-styles', 'tree', 'output styles'),
  ];
  if (scope === 'project') rows.push(entry('settings.local.json', 'file', 'local settings and hooks'));
  return rows;
}

/**
 * The guarded files. A row whose directory does not exist for a group (a
 * Claude group has no .codex-shared) is skipped — nothing is created.
 *
 * Session rows: Claude Code reads CLAUDE.md files in every directory above
 * its working directory, and `/workspace` is the session folder. Nothing
 * there is ever approved, so any of these is cleared without a card.
 */
const GUARDED_FILES: readonly GuardedFile[] = [
  {
    id: 'persona',
    label: '`instructions.prepend.md` (standing instructions)',
    base: 'group',
    segments: [],
    name: PERSONA_PREPEND_FILE,
    kind: 'file',
    containerPath: `/workspace/agent/${PERSONA_PREPEND_FILE}`,
  },
  {
    id: 'claude-project-local',
    label: '`CLAUDE.local.md` (Claude project instructions)',
    base: 'group',
    segments: [],
    name: 'CLAUDE.local.md',
    kind: 'file',
    containerPath: '/workspace/agent/CLAUDE.local.md',
  },
  {
    id: 'claude-project-dir',
    label: '`.claude/CLAUDE.md` (Claude project instructions)',
    base: 'group',
    segments: ['.claude'],
    name: 'CLAUDE.md',
    kind: 'file',
    absentDirIsNoFile: true,
    containerPath: '/workspace/agent/.claude/CLAUDE.md',
  },
  ...claudeDirEntries('project'),
  {
    id: 'codex-project-override',
    label: '`AGENTS.override.md` (Codex project instructions)',
    base: 'group',
    segments: [],
    name: 'AGENTS.override.md',
    kind: 'file',
    containerPath: '/workspace/agent/AGENTS.override.md',
  },
  {
    id: 'claude-user-memory',
    label: '`~/.claude/CLAUDE.md` (Claude user instructions)',
    base: 'state',
    segments: ['.claude-shared'],
    name: 'CLAUDE.md',
    kind: 'file',
    containerPath: '/home/node/.claude/CLAUDE.md',
  },
  ...claudeDirEntries('user'),
  {
    id: 'codex-user-instructions',
    label: '`~/.codex/AGENTS.md` (Codex global instructions)',
    base: 'state',
    segments: ['.codex-shared'],
    name: 'AGENTS.md',
    kind: 'file',
    containerPath: '/home/node/.codex/AGENTS.md',
  },
  {
    id: 'codex-user-override',
    label: '`~/.codex/AGENTS.override.md` (Codex global instructions)',
    base: 'state',
    segments: ['.codex-shared'],
    name: 'AGENTS.override.md',
    kind: 'file',
    containerPath: '/home/node/.codex/AGENTS.override.md',
  },
  ...(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md'] as const).map(
    (name): GuardedFile => ({
      id: `session-${name.replace(/\./g, '-').toLowerCase()}`,
      label: `\`/workspace/${name}\` (session folder)`,
      base: 'session',
      segments: [],
      name,
      kind: 'file',
      containerPath: `/workspace/${name}`,
    }),
  ),
  {
    id: 'session-claude-dir',
    label: '`/workspace/.claude/` (session folder)',
    base: 'session',
    segments: [],
    name: '.claude',
    kind: 'tree',
    containerPath: '/workspace/.claude',
  },
];

export type GuardedFileId =
  | 'persona'
  | 'claude-project-local'
  | 'claude-project-dir'
  | 'claude-user-memory'
  | 'claude-user-settings-json'
  | 'codex-user-instructions'
  | 'codex-user-override'
  | (string & {});

export function guardedFiles(): readonly GuardedFile[] {
  return GUARDED_FILES;
}

export function fileSpec(id: string): GuardedFile {
  const file = GUARDED_FILES.find((f) => f.id === id);
  if (!file) throw new Error(`unknown guarded instruction file: ${id}`);
  return file;
}

export type GroupRef = Pick<AgentGroup, 'id' | 'folder'>;

// ── The approved-content store (host-only) ──

interface Baseline {
  sha256: string;
  content: string | null;
  recordedAt: string;
}

export interface Held {
  agentGroupId: string;
  fileId: string;
  sha256: string;
  content: string | null;
  heldAt: string;
}

/** Whitespace-only and absent are the same instructions: nothing. */
const normalize = (content: string | null): string | null => (content !== null && content.trim() ? content : null);
export const digest = (content: string | null): string =>
  crypto
    .createHash('sha256')
    .update(content ?? '')
    .digest('hex');

// A tree's content is the canonical JSON of { relative path: text }, sorted,
// or null when it holds no file. One string, so a tree is held, diffed and
// approved like a single file.
function encodeTree(files: Record<string, string>): string | null {
  const keys = Object.keys(files).sort();
  if (keys.length === 0) return null;
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, files[k]])));
}

/** A tree's files, or null when `content` is not a well-formed tree (unsafe paths included). */
export function decodeTree(content: string | null): Record<string, string> | null {
  if (content === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof text !== 'string' || !safeRelPath(rel)) return null;
    out[rel] = text;
  }
  return out;
}

function safeRelPath(rel: string): boolean {
  const parts = rel.split('/');
  return (
    parts.length <= MAX_TREE_DEPTH &&
    parts.every((p) => p.length > 0 && p !== '.' && p !== '..' && !p.includes('\0') && !p.includes('\\'))
  );
}

/** How the card shows `content`: a tree as one `### path` section per file. */
export function displayContent(file: GuardedFile, content: string | null): string | null {
  if (file.kind !== 'tree' || content === null) return content;
  const files = decodeTree(content) ?? {};
  return Object.entries(files)
    .map(([rel, text]) => `### ${rel}\n${text}`)
    .join('\n');
}

// The runner adds its memory SessionStart hook and seeds `outputStyle` when
// it starts (container/agent-runner/src/provider-contracts/claude.ts). Both
// are its own, fixed values, so comparisons ignore exactly those — keep in
// step with container/agent-runner/src/instruction-guard.ts.
const RUNNER_MEMORY_HOOK = JSON.stringify({
  matcher: 'startup|clear|compact',
  hooks: [{ type: 'command', command: 'bun /app/src/memory/hook.ts', timeout: 10 }],
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The settings as compared: the runner's own startup additions left out, key order ignored. */
export function comparableSettings(content: string | null): string | null {
  if (content === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content;
  const settings = { ...(parsed as Record<string, unknown>) };
  if (settings.outputStyle === 'default') delete settings.outputStyle;
  const hooks = settings.hooks;
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    const h = { ...(hooks as Record<string, unknown>) };
    if (Array.isArray(h.SessionStart)) {
      const rest = h.SessionStart.filter((e) => JSON.stringify(e) !== RUNNER_MEMORY_HOOK);
      if (rest.length > 0) h.SessionStart = rest;
      else delete h.SessionStart;
    }
    settings.hooks = h;
  }
  return canonicalJson(settings);
}

function comparable(file: GuardedFile, content: string | null): string | null {
  return file.settings === 'claude' ? comparableSettings(content) : content;
}

const sameContent = (file: GuardedFile, a: string | null, b: string | null): boolean =>
  comparable(file, a) === comparable(file, b);

/** The host's own settings reconcile applied to `content` (what every spawn writes). */
function hostReconciled(file: GuardedFile, content: string | null): string | null {
  if (file.settings !== 'claude' || content === null) return content;
  let current = content;
  for (let i = 0; i < 4; i++) {
    const result = claudeSettingsTransformer.transform(current, file.name);
    if (result.kind !== 'replace') break;
    current = result.content;
  }
  return current;
}

export function groupStore(agentGroupId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentGroupId)) throw new Error(`unsafe agent group id: ${agentGroupId}`);
  return path.join(DATA_DIR, 'instruction-baselines', agentGroupId);
}

/** Host side of the runner's read-only baseline mount (under the group's state root, which no container mounts). */
export function runtimeBaselineDir(agentGroupId: string): string {
  groupStore(agentGroupId); // validates the id
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, RUNTIME_BASELINE_DIR);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function writeJson(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: mode === 0o600 ? 0o700 : 0o755 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode });
  fs.renameSync(tmp, file);
}

const baselinePath = (agentGroupId: string, fileId: string): string =>
  path.join(groupStore(agentGroupId), `${fileId}.json`);
export function heldPath(agentGroupId: string, fileId: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('malformed content hash');
  return path.join(groupStore(agentGroupId), 'held', `${fileSpec(fileId).id}.${sha256}.json`);
}
function rejectedPath(agentGroupId: string, fileId: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('malformed content hash');
  return path.join(groupStore(agentGroupId), 'rejected', `${fileSpec(fileId).id}.${sha256}.json`);
}

function readBaseline(agentGroupId: string, fileId: string): Baseline | null {
  return readJson<Baseline>(baselinePath(agentGroupId, fileId));
}

export function saveBaseline(agentGroupId: string, fileId: string, content: string | null): void {
  const value = normalize(content);
  const baseline: Baseline = { sha256: digest(value), content: value, recordedAt: new Date().toISOString() };
  writeJson(baselinePath(agentGroupId, fileId), baseline);
  writeRuntimeBaseline(agentGroupId);
}

export function dropHeld(agentGroupId: string, fileId: string, sha256: string): void {
  fs.rmSync(heldPath(agentGroupId, fileId, sha256), { force: true });
}

/** Remember an owner's reject, so the same content is not raised again for a while. */
export function recordRejected(agentGroupId: string, fileId: string, sha256: string): void {
  writeJson(rejectedPath(agentGroupId, fileId, sha256), { rejectedAt: new Date().toISOString() });
}

function recentlyRejected(agentGroupId: string, fileId: string, sha256: string): boolean {
  const file = rejectedPath(agentGroupId, fileId, sha256);
  const row = readJson<{ rejectedAt: string }>(file);
  if (!row) return false;
  if (Date.now() - Date.parse(row.rejectedAt) < REJECT_COOLDOWN_MS) return true;
  fs.rmSync(file, { force: true });
  return false;
}

/**
 * Record `content` as the approved version of a guarded file — for host-side
 * writers acting for the owner (an editor save, a template restamp), so their
 * write is not mistaken for the agent's at the next spawn.
 */
export function recordInstructionBaseline(agentGroupId: string, fileId: GuardedFileId, content: string | null): void {
  saveBaseline(agentGroupId, fileId, content);
}

/**
 * For a host writer that edits a guarded file in place (read, change, write):
 * record `after` only when `before` was the approved version. Had the agent
 * already changed the file, recording would approve its change along with
 * the host's — so it is left for the next spawn to hold instead.
 */
export function recordInstructionEdit(
  agentGroupId: string,
  fileId: GuardedFileId,
  before: string | null,
  after: string | null,
): void {
  const file = fileSpec(fileId);
  const baseline = readBaseline(agentGroupId, file.id);
  if (baseline && !sameContent(file, normalize(before), baseline.content)) return;
  saveBaseline(agentGroupId, file.id, after);
}

/**
 * The approved state the agent-runner checks before every query: one
 * world-readable JSON file in a directory mounted read-only. Rewritten with
 * every baseline, so an approval reaches a running container at its next turn.
 */
export function writeRuntimeBaseline(agentGroupId: string): void {
  const entries = GUARDED_FILES.flatMap((file) => {
    // The mount the entry lives in: the runner skips an entry whose mount is absent.
    const root =
      file.base === 'group'
        ? '/workspace/agent'
        : file.base === 'session'
          ? '/workspace'
          : path.posix.dirname(file.containerPath);
    if (file.base === 'session') {
      return [{ id: file.id, path: file.containerPath, root, kind: file.kind, content: null, proposable: false }];
    }
    const baseline = readBaseline(agentGroupId, file.id);
    if (!baseline) return [];
    return [
      {
        id: file.id,
        path: file.containerPath,
        root,
        kind: file.kind,
        content: baseline.content,
        proposable: true,
        ...(file.settings ? { settings: file.settings } : {}),
      },
    ];
  });
  writeJson(path.join(runtimeBaselineDir(agentGroupId), 'baseline.json'), { version: 1, entries }, 0o644);
}

// ── Reading and replacing the live file ──

type Observed = { kind: 'content'; content: string | null } | { kind: 'foreign'; detail: string };

function rootOf(group: GroupRef, file: GuardedFile, sessionId?: string): string | null {
  if (file.base === 'group') return path.resolve(GROUPS_DIR, group.folder);
  if (file.base === 'state') return path.join(DATA_DIR, 'v2-sessions', group.id);
  return sessionId ? path.join(DATA_DIR, 'v2-sessions', group.id, sessionId) : null;
}

function lstatOrNull(dir: AnchoredDir, name: string): fs.Stats | null {
  try {
    return dir.lstat(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

const describe = (st: fs.Stats): string =>
  st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : 'not a regular file';

/**
 * Remove `name` from `dir` without following anything: a directory is walked
 * by descriptor and emptied first, so a link planted inside is unlinked, never
 * entered. Removing by path could be steered outside the tree mid-walk.
 */
function removeEntry(dir: AnchoredDir, name: string, depth = 0): void {
  const st = lstatOrNull(dir, name);
  if (!st) return;
  if (!st.isDirectory()) {
    dir.unlink(name);
    return;
  }
  if (depth > 32) throw new Error(`refusing to clear '${name}': nested too deep`);
  const sub = dir.openDir(name);
  if (!sub) return;
  try {
    for (const entry of sub.entries()) removeEntry(sub, entry, depth + 1);
  } finally {
    sub.close();
  }
  dir.rmdir(name);
}

/**
 * Open the directory a guarded file lives in. A segment that is not a real
 * directory (a symlink, a file) is the agent's doing: it is removed, never
 * followed, and reported so the caller records a refused change. Null when
 * the directory does not exist (and `create` is false).
 */
function openParent(
  root: string,
  segments: readonly string[],
  create: boolean,
): { dir: AnchoredDir | null; cleared?: string } {
  const top = AnchoredDir.open(root, [], create);
  if (!top) return { dir: null };
  let dir: AnchoredDir = top;
  let cleared: string | undefined;
  try {
    for (const segment of segments) {
      const st = lstatOrNull(dir, segment);
      if (st && !st.isDirectory()) {
        dir.unlink(segment);
        cleared ??= `\`${segment}\` was ${describe(st)}`;
      }
      const next = dir.openDir(segment, create);
      dir.close();
      if (!next) return { dir: null, cleared };
      dir = next;
    }
  } catch (err) {
    dir.close();
    throw err;
  }
  return { dir, cleared };
}

function observeFile(dir: AnchoredDir, name: string): Observed {
  const st = lstatOrNull(dir, name);
  if (!st) return { kind: 'content', content: null };
  if (!st.isFile()) return { kind: 'foreign', detail: `it was ${describe(st)}` };
  if (st.size > MAX_HELD_BYTES) return { kind: 'foreign', detail: `it was too large to hold (${st.size} bytes)` };
  let buf: Buffer;
  try {
    buf = dir.readFile(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'content', content: null };
    // Swapped for a link or FIFO between the lstat and the open.
    return { kind: 'foreign', detail: 'it was not a regular file' };
  }
  if (buf.length > MAX_HELD_BYTES) {
    return { kind: 'foreign', detail: `it was too large to hold (${buf.length} bytes)` };
  }
  return { kind: 'content', content: normalize(buf.toString('utf-8')) };
}

function observeTree(dir: AnchoredDir, name: string): Observed {
  const st = lstatOrNull(dir, name);
  if (!st) return { kind: 'content', content: null };
  if (!st.isDirectory()) return { kind: 'foreign', detail: `it was ${describe(st)}` };
  const files: Record<string, string> = {};
  let bytes = 0;
  let count = 0;
  const walk = (d: AnchoredDir, rel: string, depth: number): string | null => {
    for (const entry of d.entries().sort()) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      const est = lstatOrNull(d, entry);
      if (!est) continue;
      if (est.isDirectory()) {
        if (depth + 1 >= MAX_TREE_DEPTH) return 'it was nested too deep';
        const sub = d.openDir(entry);
        if (!sub) continue;
        try {
          const refused = walk(sub, relPath, depth + 1);
          if (refused) return refused;
        } finally {
          sub.close();
        }
        continue;
      }
      if (!est.isFile()) return `\`${relPath}\` in it was ${describe(est)}`;
      if (++count > MAX_TREE_FILES) return `it held more than ${MAX_TREE_FILES} files`;
      const buf = d.readFile(entry);
      bytes += buf.length;
      if (bytes > MAX_HELD_BYTES) return `it was too large to hold (over ${MAX_HELD_BYTES} bytes)`;
      files[relPath] = buf.toString('utf-8');
    }
    return null;
  };
  const sub = dir.openDir(name);
  if (!sub) return { kind: 'content', content: null };
  try {
    const refused = walk(sub, '', 0);
    if (refused) return { kind: 'foreign', detail: refused };
  } catch {
    // Swapped for a link or FIFO mid-walk.
    return { kind: 'foreign', detail: 'it changed shape while being read' };
  } finally {
    sub.close();
  }
  return { kind: 'content', content: encodeTree(files) };
}

function observe(file: GuardedFile, dir: AnchoredDir): Observed {
  return file.kind === 'tree' ? observeTree(dir, file.name) : observeFile(dir, file.name);
}

/** Hand a file the host wrote back to the container user, by descriptor (lchown on a path could be steered). */
function handBack(dir: AnchoredDir, name: string): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const uid = Number(process.env.NANOCLAW_CONTAINER_UID ?? 1000);
  const fd = dir.openReadFd(name);
  try {
    fs.fchownSync(fd, uid, uid);
  } finally {
    fs.closeSync(fd);
  }
}

function writeTree(dir: AnchoredDir, name: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const parts = rel.split('/');
    let d = dir.openDir(name, true)!;
    try {
      for (const part of parts.slice(0, -1)) {
        const next = d.openDir(part, true)!;
        d.close();
        d = next;
      }
      d.replaceFile(parts[parts.length - 1], text);
      handBack(d, parts[parts.length - 1]);
    } finally {
      d.close();
    }
  }
}

/**
 * Put `content` (null = no file) at the guarded path. Whatever the agent left
 * under the name is cleared first without being followed: a link or FIFO is
 * unlinked, a directory emptied by descriptor and removed. A held copy keeps
 * anything worth keeping, so nothing is moved aside.
 */
export function putContent(group: GroupRef, file: GuardedFile, content: string | null, sessionId?: string): void {
  const root = rootOf(group, file, sessionId);
  if (!root) return;
  const tree = file.kind === 'tree' ? decodeTree(content) : null;
  if (file.kind === 'tree' && !tree) throw new Error(`malformed content for ${file.name}`);
  const { dir } = openParent(root, file.segments, content !== null);
  if (!dir) {
    if (content === null) return;
    throw new Error(`directory for ${file.name} is missing`);
  }
  try {
    const st = lstatOrNull(dir, file.name);
    if (file.kind === 'tree') {
      if (st) removeEntry(dir, file.name);
      if (content !== null) writeTree(dir, file.name, tree!);
      return;
    }
    if (st?.isDirectory()) removeEntry(dir, file.name);
    else if (st && (!st.isFile() || content === null)) dir.unlink(file.name);
    if (content !== null) {
      dir.replaceFile(file.name, content);
      handBack(dir, file.name);
    }
  } finally {
    dir.close();
  }
  // A segment directory the host just created (e.g. `.claude`, whose parent is
  // the base itself) goes back to the container user too; lchown never follows.
  if (content !== null && file.segments.length === 1) makeContainerWritable(path.join(root, file.segments[0]));
}

/** Record whatever the guarded file holds now (for writers that just wrote it). */
function recordFromDisk(group: GroupRef, fileId: GuardedFileId): void {
  const file = fileSpec(fileId);
  const root = rootOf(group, file);
  if (!root) return;
  const { dir } = openParent(root, file.segments, false);
  if (!dir) return;
  let seen: Observed;
  try {
    seen = observe(file, dir);
  } finally {
    dir.close();
  }
  if (seen.kind === 'content') saveBaseline(group.id, file.id, seen.content);
}

/**
 * After `ncl groups create --template` updates a stamped agent in place: the
 * restamp is the owner's (or an approved) write, so a persona it created,
 * replaced or removed becomes the baseline. A restamp that left the persona
 * alone records nothing — an agent edit waiting in the file stays a change.
 */
export function recordRestampedInstructions(result: {
  applied: boolean;
  group: GroupRef;
  changes: readonly { surface: string; action: string }[];
}): void {
  if (!result.applied) return;
  const touched = result.changes.some(
    (c) => c.surface === 'persona' && (c.action === 'create' || c.action === 'update' || c.action === 'remove'),
  );
  if (touched) recordFromDisk(result.group, 'persona');
}

// ── The spawn-time check ──

export interface InstructionChange {
  file: GuardedFile;
  /** held: waiting for approval. refused: reset outright (not a regular file, too large, or never loadable). */
  outcome: 'held' | 'refused';
  sha256: string;
  before: string | null;
  after: string | null;
  detail?: string;
  /** An owner rejected this exact content within REJECT_COOLDOWN_MS: reverted, no new card. */
  rejected?: boolean;
  /** Reverted because a directory above it was cleared, which an earlier change already reports. */
  segmentReported?: boolean;
}

function report(group: GroupRef, change: InstructionChange): void {
  log.warn('Standing instruction change reverted pending approval', {
    agentGroupId: group.id,
    file: change.file.id,
    outcome: change.outcome,
    detail: change.detail,
    rejected: change.rejected,
  });
  audit({
    type: 'instructions.reverted',
    actor: `agent:${group.id}`,
    action: INSTRUCTION_CHANGE_ACTION,
    effect: change.outcome === 'held' && !change.rejected ? 'hold' : 'deny',
    reason: change.detail ?? (change.rejected ? 'rejected recently' : undefined),
    detail: { agentGroupId: group.id, file: change.file.id, sha256: change.sha256 || null },
  });
}

/** Hold `content` for approval (or note a recent reject) and describe the change. */
function holdChange(
  group: GroupRef,
  file: GuardedFile,
  before: string | null,
  content: string | null,
): InstructionChange {
  const sha256 = digest(content);
  if (recentlyRejected(group.id, file.id, sha256)) {
    return { file, outcome: 'held', sha256, before, after: content, rejected: true };
  }
  const held: Held = { agentGroupId: group.id, fileId: file.id, sha256, content, heldAt: new Date().toISOString() };
  if (!fs.existsSync(heldPath(group.id, file.id, sha256))) writeJson(heldPath(group.id, file.id, sha256), held);
  return { file, outcome: 'held', sha256, before, after: content };
}

function checkOne(
  group: GroupRef,
  file: GuardedFile,
  sessionId: string | undefined,
  clearedSegments: Map<string, string>,
): InstructionChange | null {
  const root = rootOf(group, file, sessionId);
  if (!root) return null;
  const opened = openParent(root, file.segments, false);
  const dir = opened.dir;
  // A segment cleared for an earlier row of the same directory counts for this one too.
  const segmentKey = `${file.base}:${file.segments.join('/')}`;
  if (opened.cleared) clearedSegments.set(segmentKey, opened.cleared);
  const cleared = opened.cleared ?? clearedSegments.get(segmentKey);
  let seen: Observed = { kind: 'content', content: null };
  if (dir) {
    try {
      seen = observe(file, dir);
    } finally {
      dir.close();
    }
  }

  if (file.base === 'session') {
    if (seen.kind === 'content' && seen.content === null) return null;
    putContent(group, file, null, sessionId);
    const detail = seen.kind === 'foreign' ? seen.detail : 'instructions are never loaded from the session folder';
    return { file, outcome: 'refused', sha256: '', before: null, after: null, detail };
  }

  let baseline = readBaseline(group.id, file.id);
  if (!dir && !cleared) {
    if (file.absentDirIsNoFile && !baseline) saveBaseline(group.id, file.id, null);
    // A missing directory matters only where the agent removed one that held
    // approved content (absentDirIsNoFile rows); it is put back below.
    if (!file.absentDirIsNoFile || !baseline || baseline.content === null) return null;
  }
  if (!baseline) {
    if (seen.kind === 'content' && !cleared) {
      saveBaseline(group.id, file.id, seen.content);
      return null;
    }
    // A link or oversized file at first sight is not adopted: the approved
    // state is "no file", and the entry is cleared below.
    saveBaseline(group.id, file.id, null);
    baseline = readBaseline(group.id, file.id)!;
  }
  // The host's own settings reconcile ran this spawn (group init); its output
  // on the approved content is approved content.
  const reconciled = normalize(hostReconciled(file, baseline.content));
  if (seen.kind === 'content' && !cleared) {
    if (sameContent(file, seen.content, baseline.content)) return null;
    if (reconciled !== baseline.content && sameContent(file, seen.content, reconciled)) {
      saveBaseline(group.id, file.id, seen.content);
      return null;
    }
  }
  if (reconciled !== baseline.content) saveBaseline(group.id, file.id, reconciled);

  let change: InstructionChange;
  if (seen.kind === 'content' && !cleared) {
    change = holdChange(group, file, reconciled, seen.content);
  } else {
    const detail = cleared ?? (seen.kind === 'foreign' ? seen.detail : undefined);
    change = { file, outcome: 'refused', sha256: '', before: reconciled, after: null, detail };
    if (cleared && !opened.cleared) change.segmentReported = true;
  }
  putContent(group, file, reconciled, sessionId);
  return change;
}

/**
 * Compare every guarded file with its baseline; hold and revert each change.
 * Synchronous on purpose: two sessions of one group spawning at once cannot
 * interleave between the read and the restore. Throws when a file cannot be
 * restored — composing the agent's unapproved version instead would defeat
 * the gate, so the spawn fails loudly rather than silently. With `sessionId`,
 * that session's folder is checked as well. Ends by refreshing the snapshot
 * the agent-runner enforces between turns.
 */
export function checkInstructionFiles(group: GroupRef, sessionId?: string): InstructionChange[] {
  const changes: InstructionChange[] = [];
  const clearedSegments = new Map<string, string>();
  for (const file of GUARDED_FILES) {
    const change = checkOne(group, file, sessionId, clearedSegments);
    if (!change) continue;
    report(group, change);
    // A cleared directory is told once, on the row that found it.
    if (!change.segmentReported) changes.push(change);
  }
  writeRuntimeBaseline(group.id);
  return changes;
}

interface Proposal {
  fileId?: unknown;
  content?: unknown;
}

/**
 * Edits the agent-runner reverted mid-session: each waits in a session
 * folder's PROPOSALS_DIR (written by the container, so untrusted — any file
 * there is only ever a proposal, validated like one). Every session folder
 * of the group is read, the proposals are held like spawn-time changes, and
 * the files are removed.
 */
export function ingestRuntimeProposals(group: GroupRef): InstructionChange[] {
  const changes: InstructionChange[] = [];
  // The runner writes one proposal per file (<id>.json); more is the agent
  // planting them, so each file gets at most one card per spawn.
  const seenFiles = new Set<string>();
  const stateRoot = AnchoredDir.open(path.join(DATA_DIR, 'v2-sessions', group.id), []);
  if (!stateRoot) return changes;
  let sessions: string[];
  try {
    sessions = stateRoot.entries().filter((name) => !name.startsWith('.'));
  } finally {
    stateRoot.close();
  }
  for (const sessionId of sessions) {
    let dir: AnchoredDir | null;
    try {
      dir = AnchoredDir.open(path.join(DATA_DIR, 'v2-sessions', group.id), [sessionId, PROPOSALS_DIR]);
    } catch {
      continue; // a planted link or file: not a proposals folder
    }
    if (!dir) continue;
    try {
      for (const name of dir.entries()) {
        let proposal: Proposal | null = null;
        try {
          const st = dir.lstat(name);
          if (st.isFile() && st.size <= MAX_HELD_BYTES * 2) {
            proposal = JSON.parse(dir.readFile(name).toString('utf-8')) as Proposal;
          }
        } catch {
          proposal = null;
        }
        try {
          removeEntry(dir, name);
        } catch {
          /* left for the next spawn */
        }
        if (!proposal || typeof proposal.fileId !== 'string' || seenFiles.has(proposal.fileId)) continue;
        const change = proposalChange(group, proposal);
        if (!change) continue;
        seenFiles.add(change.file.id);
        report(group, change);
        changes.push(change);
      }
    } finally {
      dir.close();
    }
  }
  return changes;
}

function proposalChange(group: GroupRef, proposal: Proposal): InstructionChange | null {
  if (typeof proposal.fileId !== 'string') return null;
  const file = GUARDED_FILES.find((f) => f.id === proposal.fileId);
  if (!file || file.base === 'session') return null;
  if (proposal.content !== null && typeof proposal.content !== 'string') return null;
  let content = normalize(proposal.content as string | null);
  if (content !== null && Buffer.byteLength(content) > MAX_HELD_BYTES) return null;
  if (file.kind === 'tree') {
    const files = decodeTree(content);
    if (!files || Object.keys(files).length > MAX_TREE_FILES) return null;
    content = encodeTree(files);
  }
  const baseline = readBaseline(group.id, file.id);
  if (!baseline || sameContent(file, content, baseline.content)) return null;
  return holdChange(group, file, baseline.content, content);
}
