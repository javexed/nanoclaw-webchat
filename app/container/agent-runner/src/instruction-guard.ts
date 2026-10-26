/**
 * Instruction guard, container side — the per-query half of the host's
 * modules/instruction-guard (see its index.ts).
 *
 * The host checks the agent's standing instruction files (persona, CLAUDE.md
 * files, `.claude/rules`, subagents, output styles, settings.json, AGENTS
 * overrides) at every spawn. One container lives through many turns, though,
 * and each turn starts a query that loads those files afresh — so an edit made
 * in one turn would steer the next without approval. Before every query this
 * module compares each guarded file with the approved snapshot the host
 * mounts read-only at /app/.instruction-baseline, restores any difference,
 * and leaves the agent's version in /workspace/.instruction-proposals/ for the
 * next spawn to raise as an approval card.
 *
 * The snapshot is the only authority: the proposals folder is agent-writable,
 * and the host treats whatever it finds there as a proposal, nothing more.
 * Everything here runs with the agent's own privileges, so plain path
 * operations are fine — there is nothing to escalate to.
 *
 * Limits (see the host module): a process the agent leaves running can still
 * rewrite a file between this check and the query reading it; the next turn
 * restores it again.
 */
import fs from 'fs';
import path from 'path';

import { registerProviderMessageObserver, registerProviderQueryOptionsContributor } from './providers/hooks.js';

const MAX_BYTES = 1024 * 1024;
const MAX_TREE_FILES = 200;
const MAX_TREE_DEPTH = 8;

export interface GuardPaths {
  baselineFile: string;
  proposalsDir: string;
}

const DEFAULT_PATHS: GuardPaths = {
  baselineFile: '/app/.instruction-baseline/baseline.json',
  proposalsDir: '/workspace/.instruction-proposals',
};

interface Entry {
  id: string;
  /** Absolute path in the container. */
  path: string;
  /** The mount it lives in; an entry whose mount is absent is skipped. */
  root: string;
  kind: 'file' | 'tree';
  content: string | null;
  proposable: boolean;
  settings?: 'claude';
}

type Observed = { kind: 'content'; content: string | null } | { kind: 'foreign'; detail: string };

function log(msg: string): void {
  console.error(`[instruction-guard] ${msg}`);
}

const normalize = (content: string | null): string | null => (content !== null && content.trim() ? content : null);

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function encodeTree(files: Record<string, string>): string | null {
  const keys = Object.keys(files).sort();
  if (keys.length === 0) return null;
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, files[k]])));
}

function decodeTree(content: string | null): Record<string, string> {
  if (content === null) return {};
  const parsed = JSON.parse(content) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(parsed)) {
    // The host wrote it, but a path must still stay inside the tree.
    if (typeof text === 'string' && rel.split('/').every((p) => p && p !== '.' && p !== '..')) out[rel] = text;
  }
  return out;
}

// The runner's own startup additions to settings.json (provider-contracts/
// claude.ts: the memory SessionStart hook, the default outputStyle) are left
// out of comparisons. Keep in step with comparableSettings in the host's
// modules/instruction-guard/store.ts.
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

/** A non-directory planted in place of a directory above the entry, or null. */
function foreignAncestor(entry: Entry): string | null {
  const rel = path.relative(entry.root, path.dirname(entry.path));
  if (!rel) return null;
  let p = entry.root;
  for (const part of rel.split('/')) {
    p = path.join(p, part);
    const st = lstatOrNull(p);
    if (!st) return null;
    if (!st.isDirectory()) return p;
  }
  return null;
}

function observeFile(p: string): Observed {
  const st = lstatOrNull(p);
  if (!st) return { kind: 'content', content: null };
  if (!st.isFile()) return { kind: 'foreign', detail: 'not a regular file' };
  if (st.size > MAX_BYTES) return { kind: 'foreign', detail: 'too large' };
  return { kind: 'content', content: normalize(fs.readFileSync(p, 'utf-8')) };
}

function observeTree(p: string): Observed {
  const st = lstatOrNull(p);
  if (!st) return { kind: 'content', content: null };
  if (!st.isDirectory()) return { kind: 'foreign', detail: 'not a directory' };
  const files: Record<string, string> = {};
  let bytes = 0;
  let count = 0;
  const walk = (dir: string, rel: string, depth: number): string | null => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const est = lstatOrNull(full);
      if (!est) continue;
      if (est.isDirectory()) {
        if (depth + 1 >= MAX_TREE_DEPTH) return 'nested too deep';
        const refused = walk(full, relPath, depth + 1);
        if (refused) return refused;
        continue;
      }
      if (!est.isFile()) return `${relPath} is not a regular file`;
      if (++count > MAX_TREE_FILES) return 'too many files';
      bytes += est.size;
      if (bytes > MAX_BYTES) return 'too large';
      files[relPath] = fs.readFileSync(full, 'utf-8');
    }
    return null;
  };
  const refused = walk(p, '', 0);
  if (refused) return { kind: 'foreign', detail: refused };
  return { kind: 'content', content: encodeTree(files) };
}

function same(entry: Entry, seen: string | null): boolean {
  if (entry.kind === 'tree') return encodeTree(decodeTree(seen)) === encodeTree(decodeTree(entry.content));
  if (entry.settings === 'claude') return comparableSettings(seen) === comparableSettings(entry.content);
  return seen === entry.content;
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function restore(entry: Entry): void {
  // rmSync removes a link itself, never its target.
  fs.rmSync(entry.path, { recursive: true, force: true });
  if (entry.content === null) return;
  if (entry.kind === 'file') {
    writeAtomic(entry.path, entry.content);
    return;
  }
  for (const [rel, text] of Object.entries(decodeTree(entry.content))) writeAtomic(path.join(entry.path, rel), text);
}

function readSnapshot(file: string): Entry[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as { version?: number; entries?: Entry[] };
  return parsed.version === 1 && Array.isArray(parsed.entries) ? parsed.entries : null;
}

let warnedMissing = false;

/**
 * Restore every guarded file that differs from the approved snapshot; the
 * agent's version of a proposable file is left as a proposal. Returns the ids
 * restored. Never throws: a guard bug must not cost the agent its turn.
 */
export function enforceInstructionBaseline(paths: GuardPaths = DEFAULT_PATHS): string[] {
  let entries: Entry[] | null;
  try {
    entries = readSnapshot(paths.baselineFile);
  } catch (err) {
    log(`snapshot unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (!entries) {
    if (!warnedMissing) log('no approved snapshot mounted; per-turn check is off');
    warnedMissing = true;
    return [];
  }
  const restored: string[] = [];
  for (const entry of entries) {
    try {
      if (!lstatOrNull(entry.root)?.isDirectory()) continue;
      const planted = foreignAncestor(entry);
      if (planted) fs.rmSync(planted, { force: true });
      const seen = planted
        ? ({ kind: 'foreign', detail: 'a directory above it was not a directory' } as Observed)
        : entry.kind === 'tree'
          ? observeTree(entry.path)
          : observeFile(entry.path);
      if (seen.kind === 'content' && same(entry, seen.content)) continue;
      if (seen.kind === 'content' && entry.proposable) {
        writeAtomic(
          path.join(paths.proposalsDir, `${entry.id}.json`),
          JSON.stringify({ fileId: entry.id, content: seen.content, at: new Date().toISOString() }),
        );
      }
      restore(entry);
      restored.push(entry.id);
      log(
        `${entry.path} restored to its approved version` +
          (seen.kind === 'foreign'
            ? ` (${seen.detail})`
            : entry.proposable
              ? '; the edit waits for owner approval'
              : ''),
      );
    } catch (err) {
      log(`could not check ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return restored;
}

// Before every query: turn_start fires right before the poll loop starts one
// (any provider); the query-options contributor runs inside every Claude
// query's construction, which also covers the queries modules run themselves
// (a learning review, a turn retry). A second pass in one turn finds nothing.
registerProviderMessageObserver((ev) => {
  if (ev.kind === 'turn_start') enforceInstructionBaseline();
});
registerProviderQueryOptionsContributor(() => {
  enforceInstructionBaseline();
  return null;
});
