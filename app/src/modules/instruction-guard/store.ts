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
import type { AgentGroup } from '../../types.js';
import { INSTRUCTION_CHANGE_ACTION } from './guard.js';

/** A held copy is kept only up to this size; a larger write is reset outright. */
const MAX_HELD_BYTES = 1024 * 1024;

export interface GuardedFile {
  id: string;
  /** How the card and the agent's notice name the file. */
  label: string;
  /** The group folder, or the group's provider state directory (data/v2-sessions/<id>). */
  base: 'group' | 'state';
  /** Directories below the base; each must be a real directory, never a link. */
  segments: readonly string[];
  name: string;
  /**
   * The directory is the agent's to create (nothing on the host makes it), so
   * its absence is itself the approved state: "no file". Without this a
   * directory the agent creates mid-session would be adopted at first sight.
   */
  absentDirIsNoFile?: boolean;
}

/**
 * The guarded files. A row whose directory does not exist for a group (a
 * Claude group has no .codex-shared) is skipped — nothing is created.
 */
const GUARDED_FILES: readonly GuardedFile[] = [
  {
    id: 'persona',
    label: '`instructions.prepend.md` (standing instructions)',
    base: 'group',
    segments: [],
    name: PERSONA_PREPEND_FILE,
  },
  {
    id: 'claude-project-local',
    label: '`CLAUDE.local.md` (Claude project instructions)',
    base: 'group',
    segments: [],
    name: 'CLAUDE.local.md',
  },
  {
    id: 'claude-project-dir',
    label: '`.claude/CLAUDE.md` (Claude project instructions)',
    base: 'group',
    segments: ['.claude'],
    name: 'CLAUDE.md',
    absentDirIsNoFile: true,
  },
  {
    id: 'claude-user-memory',
    label: '`~/.claude/CLAUDE.md` (Claude user instructions)',
    base: 'state',
    segments: ['.claude-shared'],
    name: 'CLAUDE.md',
  },
  {
    id: 'codex-user-instructions',
    label: '`~/.codex/AGENTS.md` (Codex global instructions)',
    base: 'state',
    segments: ['.codex-shared'],
    name: 'AGENTS.md',
  },
  {
    id: 'codex-user-override',
    label: '`~/.codex/AGENTS.override.md` (Codex global instructions)',
    base: 'state',
    segments: ['.codex-shared'],
    name: 'AGENTS.override.md',
  },
];

export type GuardedFileId =
  | 'persona'
  | 'claude-project-local'
  | 'claude-project-dir'
  | 'claude-user-memory'
  | 'codex-user-instructions'
  | 'codex-user-override';

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

export function groupStore(agentGroupId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentGroupId)) throw new Error(`unsafe agent group id: ${agentGroupId}`);
  return path.join(DATA_DIR, 'instruction-baselines', agentGroupId);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const baselinePath = (agentGroupId: string, fileId: string): string =>
  path.join(groupStore(agentGroupId), `${fileId}.json`);
export function heldPath(agentGroupId: string, fileId: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('malformed content hash');
  return path.join(groupStore(agentGroupId), 'held', `${fileSpec(fileId).id}.${sha256}.json`);
}

export function saveBaseline(agentGroupId: string, fileId: string, content: string | null): void {
  const value = normalize(content);
  const baseline: Baseline = { sha256: digest(value), content: value, recordedAt: new Date().toISOString() };
  writeJson(baselinePath(agentGroupId, fileId), baseline);
}

export function dropHeld(agentGroupId: string, fileId: string, sha256: string): void {
  fs.rmSync(heldPath(agentGroupId, fileId, sha256), { force: true });
}

/**
 * Record `content` as the approved version of a guarded file — for host-side
 * writers acting for the owner (an editor save, a template restamp), so their
 * write is not mistaken for the agent's at the next spawn.
 */
export function recordInstructionBaseline(agentGroupId: string, fileId: GuardedFileId, content: string | null): void {
  saveBaseline(agentGroupId, fileId, content);
}

// ── Reading and replacing the live file ──

type Observed =
  | { kind: 'content'; content: string | null }
  | { kind: 'foreign'; what: string }
  | { kind: 'oversize'; bytes: number };

function rootOf(group: GroupRef, file: GuardedFile): string {
  return file.base === 'group' ? path.resolve(GROUPS_DIR, group.folder) : path.join(DATA_DIR, 'v2-sessions', group.id);
}

function lstatOrNull(dir: AnchoredDir, name: string): fs.Stats | null {
  try {
    return dir.lstat(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function observe(dir: AnchoredDir, name: string): Observed {
  const st = lstatOrNull(dir, name);
  if (!st) return { kind: 'content', content: null };
  if (!st.isFile()) {
    const what = st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : 'not a regular file';
    return { kind: 'foreign', what };
  }
  if (st.size > MAX_HELD_BYTES) return { kind: 'oversize', bytes: st.size };
  let buf: Buffer;
  try {
    buf = dir.readFile(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'content', content: null };
    // Swapped for a link or FIFO between the lstat and the open.
    return { kind: 'foreign', what: 'not a regular file' };
  }
  if (buf.length > MAX_HELD_BYTES) return { kind: 'oversize', bytes: buf.length };
  return { kind: 'content', content: normalize(buf.toString('utf-8')) };
}

/**
 * Put `content` (null = no file) at the guarded path. Whatever the agent left
 * under the name is cleared first without being followed: a link or FIFO is
 * unlinked, a directory renamed aside (removing an agent-owned tree by path
 * could be steered outside it mid-walk). The parent is the mount point itself
 * or a host-owned directory above it, which the container cannot replace.
 */
export function putContent(group: GroupRef, file: GuardedFile, content: string | null): void {
  const dir = AnchoredDir.open(rootOf(group, file), file.segments);
  if (!dir) throw new Error(`directory for ${file.name} is missing`);
  const target = path.join(rootOf(group, file), ...file.segments, file.name);
  try {
    const st = lstatOrNull(dir, file.name);
    if (st?.isDirectory()) {
      fs.renameSync(target, `${target}.refused-${Date.now()}`);
    } else if (st && (!st.isFile() || content === null)) {
      dir.unlink(file.name);
    }
    if (content !== null) dir.replaceFile(file.name, content);
  } finally {
    dir.close();
  }
  // The agent must still be able to edit (and so propose) the file: on a
  // root host, hand it back to the container user. lchown never follows.
  if (content !== null) makeContainerWritable(target);
}

/** Record whatever the guarded file holds now (for writers that just wrote it). */
function recordFromDisk(group: GroupRef, fileId: GuardedFileId): void {
  const file = fileSpec(fileId);
  const dir = AnchoredDir.open(rootOf(group, file), file.segments);
  if (!dir) return;
  let seen: Observed;
  try {
    seen = observe(dir, file.name);
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
  /** held: waiting for approval. refused: reset outright (not a regular file, or too large to hold). */
  outcome: 'held' | 'refused';
  sha256: string;
  before: string | null;
  after: string | null;
  detail?: string;
}

/**
 * Compare every guarded file with its baseline; hold and revert each change.
 * Synchronous on purpose: two sessions of one group spawning at once cannot
 * interleave between the read and the restore. Throws when a file cannot be
 * restored — composing the agent's unapproved version instead would defeat
 * the gate, so the spawn fails loudly rather than silently.
 */
export function checkInstructionFiles(group: GroupRef): InstructionChange[] {
  const changes: InstructionChange[] = [];
  for (const file of GUARDED_FILES) {
    const dir = AnchoredDir.open(rootOf(group, file), file.segments);
    if (!dir) {
      if (file.absentDirIsNoFile && !readJson<Baseline>(baselinePath(group.id, file.id))) {
        saveBaseline(group.id, file.id, null);
      }
      continue;
    }
    let seen: Observed;
    try {
      seen = observe(dir, file.name);
    } finally {
      dir.close();
    }

    let baseline = readJson<Baseline>(baselinePath(group.id, file.id));
    if (!baseline) {
      if (seen.kind === 'content') {
        saveBaseline(group.id, file.id, seen.content);
        continue;
      }
      // A link or oversized file at first sight is not adopted: the approved
      // state is "no file", and the entry is cleared below.
      saveBaseline(group.id, file.id, null);
      baseline = readJson<Baseline>(baselinePath(group.id, file.id))!;
    }
    if (seen.kind === 'content' && digest(seen.content) === baseline.sha256) continue;

    if (seen.kind === 'content') {
      const sha256 = digest(seen.content);
      const held: Held = {
        agentGroupId: group.id,
        fileId: file.id,
        sha256,
        content: seen.content,
        heldAt: new Date().toISOString(),
      };
      if (!fs.existsSync(heldPath(group.id, file.id, sha256))) writeJson(heldPath(group.id, file.id, sha256), held);
      putContent(group, file, baseline.content);
      changes.push({ file, outcome: 'held', sha256, before: baseline.content, after: seen.content });
    } else {
      putContent(group, file, baseline.content);
      const detail = seen.kind === 'foreign' ? `it was ${seen.what}` : `it was too large to hold (${seen.bytes} bytes)`;
      changes.push({ file, outcome: 'refused', sha256: '', before: baseline.content, after: null, detail });
    }
    const last = changes[changes.length - 1];
    log.warn('Standing instruction change reverted pending approval', {
      agentGroupId: group.id,
      file: file.id,
      outcome: last.outcome,
      detail: last.detail,
    });
    audit({
      type: 'instructions.reverted',
      actor: `agent:${group.id}`,
      action: INSTRUCTION_CHANGE_ACTION,
      effect: last.outcome === 'held' ? 'hold' : 'deny',
      reason: last.detail,
      detail: { agentGroupId: group.id, file: file.id, sha256: last.sha256 || null },
    });
  }
  return changes;
}
