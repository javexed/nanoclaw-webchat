// The tools an agent running on central uses on the developer's project,
// served by this extension and confined to the session's proposal copy.
//
// They mirror Claude's built-in file tools (names, parameters, behaviour) so
// the model uses them the way it was tuned to; central switches its own
// built-ins off. Nothing here runs a command the agent chose: the file tools
// are this extension's own code, and the git tools run git with fixed,
// read-only argv whose only agent-supplied parts are validated revisions and
// paths behind `--`.
//
// What the experiment on a real agent taught (2026-09-29): an edit is a
// literal replacement (String.replace turns `$$` into `$`), and a malformed
// call is refused with what is missing, never answered as if it were valid.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { git, type GitRepo } from './git-changes.js';
import { matchesExclude } from './policy.js';

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** The path the agent sees for the project root (the prompt names it). */
export const PROJECT_ROOT_PATH = '/workspace/project';

const READ_DEFAULT_LINES = 2000;
const READ_MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_MAX_LINE_CHARS = 10_000;
const GLOB_MAX_RESULTS = 1000;
const OUTPUT_MAX_CHARS = 100_000;
const GIT_LOG_MAX = 200;
/** A Grep pattern that backtracks without end must not freeze the editor: it runs in a worker, stopped after this. */
const GREP_TIMEOUT_MS = 20_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

type Field = 'string' | 'number' | 'boolean';
interface Param {
  type: Field;
  description: string;
  required?: boolean;
  enum?: string[];
}
interface Tool {
  name: string;
  description: string;
  params: Record<string, Param>;
}

export const LAPTOP_TOOLS: readonly Tool[] = [
  {
    name: 'Read',
    description:
      "Reads a file from the developer's project. Lines come numbered (`cat -n` style). Long files: pass offset and limit. Paths are relative to the project root, or absolute under " +
      PROJECT_ROOT_PATH +
      '.',
    params: {
      file_path: { type: 'string', description: 'The file to read', required: true },
      offset: { type: 'number', description: 'Line number to start from (1-based)' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
  },
  {
    name: 'Edit',
    description:
      'Replaces exact text in a file. old_string must match the file exactly (whitespace included) and be unique in it unless replace_all is set. Read the file first.',
    params: {
      file_path: { type: 'string', description: 'The file to change', required: true },
      old_string: { type: 'string', description: 'The exact text to replace', required: true },
      new_string: { type: 'string', description: 'The text to put in its place', required: true },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
    },
  },
  {
    name: 'Write',
    description: 'Writes a file, creating it or replacing it whole. An existing file must be read first.',
    params: {
      file_path: { type: 'string', description: 'The file to write', required: true },
      content: { type: 'string', description: 'The whole new content', required: true },
    },
  },
  {
    name: 'Glob',
    description: 'Finds files by glob pattern (`src/**/*.ts`, `*.{js,ts}`), newest first.',
    params: {
      pattern: { type: 'string', description: 'The glob', required: true },
      path: { type: 'string', description: 'Directory to search in (default: the project root)' },
    },
  },
  {
    name: 'Grep',
    description:
      'Searches file contents with a regular expression. output_mode: files_with_matches (default), content (matching lines, numbered, with -A/-B/-C context), count.',
    params: {
      pattern: { type: 'string', description: 'The regular expression', required: true },
      path: { type: 'string', description: 'File or directory to search (default: the project root)' },
      glob: { type: 'string', description: 'Only files matching this glob' },
      output_mode: {
        type: 'string',
        description: 'What to return',
        enum: ['files_with_matches', 'content', 'count'],
      },
      '-i': { type: 'boolean', description: 'Case-insensitive' },
      '-A': { type: 'number', description: 'Lines of context after each match (content mode)' },
      '-B': { type: 'number', description: 'Lines of context before each match (content mode)' },
      '-C': { type: 'number', description: 'Lines of context around each match (content mode)' },
      head_limit: { type: 'number', description: 'Return at most this many entries' },
    },
  },
  {
    name: 'GitStatus',
    description: 'What has changed in the project copy since the session started (git status).',
    params: {},
  },
  {
    name: 'GitDiff',
    description:
      'Shows changes: the working copy against HEAD by default, or between two revisions (from, to), optionally for one path.',
    params: {
      from: { type: 'string', description: 'Revision to compare from (default: HEAD)' },
      to: { type: 'string', description: 'Revision to compare to (default: the working copy)' },
      path: { type: 'string', description: 'Limit to this file or directory' },
    },
  },
  {
    name: 'GitLog',
    description: 'Commit history, newest first, optionally for one path.',
    params: {
      path: { type: 'string', description: 'Only commits touching this file or directory' },
      revision: { type: 'string', description: 'Start from this revision (default: HEAD)' },
      max_count: { type: 'number', description: `How many commits (default 20, at most ${GIT_LOG_MAX})` },
    },
  },
  {
    name: 'GitShow',
    description: "A commit's summary and changed files, or a file's content at a revision (with path).",
    params: {
      revision: { type: 'string', description: 'The commit (hash, tag, HEAD~2, …)', required: true },
      path: { type: 'string', description: 'Show this file as it was at that revision' },
    },
  },
  {
    name: 'GitBlame',
    description: 'Who last changed each line of a file, and when; optionally a line range.',
    params: {
      path: { type: 'string', description: 'The file', required: true },
      start_line: { type: 'number', description: 'First line' },
      end_line: { type: 'number', description: 'Last line' },
    },
  },
];

/** MCP tool definitions: JSON Schema for each tool's input. */
export function toolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return LAPTOP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(t.params).map(([k, p]) => [
          k,
          { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) },
        ]),
      ),
      required: Object.entries(t.params)
        .filter(([, p]) => p.required)
        .map(([k]) => k),
      additionalProperties: false,
    },
  }));
}

class ToolError extends Error {}
const fail = (message: string): never => {
  throw new ToolError(message);
};

/** Refuse a malformed call with what is wrong, never guess at it. */
function validate(tool: Tool, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${tool.name}: the input must be an object`);
  const args = input as Record<string, unknown>;
  const problems: string[] = [];
  for (const [k, p] of Object.entries(tool.params)) {
    const v = args[k];
    if (v === undefined || v === null) {
      if (p.required) problems.push(`${k} (${p.type}) is required`);
      continue;
    }
    if (typeof v !== p.type) problems.push(`${k} must be a ${p.type}`);
    else if (p.enum && !p.enum.includes(v as string)) problems.push(`${k} must be one of ${p.enum.join(', ')}`);
  }
  for (const k of Object.keys(args)) if (!(k in tool.params)) problems.push(`${k} is not a parameter of ${tool.name}`);
  if (problems.length) fail(`${tool.name}: ${problems.join('; ')}`);
  return args;
}

/** Glob to RegExp over forward-slash relative paths: `**`, `*`, `?`, `{a,b}`. */
export function globRegExp(glob: string): RegExp {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Every file under `dir` (relative to `root`), skipping .git and node_modules; bounded. */
function walk(root: string, dir: string, out: string[], max: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, abs, out, max);
    else if (e.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
}

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0);
const clip = (s: string): string =>
  s.length > OUTPUT_MAX_CHARS ? `${s.slice(0, OUTPUT_MAX_CHARS)}\n… (output cut at ${OUTPUT_MAX_CHARS} characters)` : s;

/**
 * A git revision the agent may name: never an option, never a path escape,
 * and always a commit (peeled with ^{commit}), so a blob or tree cannot be
 * named by its hash to read content the path checks would refuse.
 */
function revision(v: unknown, what: string): string {
  const r = String(v);
  if (!/^[A-Za-z0-9._/~^@{}-]{1,200}$/.test(r) || r.startsWith('-') || r.includes('..'))
    fail(`${what}: ${r.slice(0, 80)} is not a revision name`);
  return `${r}^{commit}`;
}

/**
 * What the copy leaves out, for the git tools. The copy sits on the
 * developer's history, so a file the snapshot left out (a secret, an excluded
 * path) is still in the commits beneath it: the git tools refuse those paths
 * and leave them out of diffs, the way Read cannot see them.
 */
export interface HiddenPaths {
  /** The snapshot commit (the proposal's base): whatever it dropped from the commit below it is hidden. */
  base?: string;
  /** Exclude patterns (policy.ts syntax): hidden at any revision. */
  patterns?: readonly string[];
}

/**
 * The tools over one proposal copy. One instance per session: it remembers
 * which files the agent has read, since editing or overwriting a file it has
 * not read is refused (as Claude's own tools do).
 */
export class LaptopTools {
  readonly #root: string;
  readonly #read = new Set<string>();
  readonly #patterns: readonly string[];
  #dropped: Promise<Set<string>> | null = null;

  constructor(
    root: string,
    private readonly repo: GitRepo | null,
    private readonly hidden: HiddenPaths = {},
    private readonly grepTimeoutMs = GREP_TIMEOUT_MS,
  ) {
    this.#root = fs.realpathSync(root);
    this.#patterns = hidden.patterns ?? [];
  }

  /** Files the snapshot dropped from the developer's commit: left out of the copy on purpose. */
  #droppedFiles(): Promise<Set<string>> {
    this.#dropped ??= (async () => {
      if (!this.repo || !this.hidden.base) return new Set<string>();
      const base = this.hidden.base;
      const out = await git(
        this.#root,
        ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', `${base}^`, base],
        undefined,
        this.repo,
      ).catch(() => '');
      return new Set(out.split('\0').filter(Boolean));
    })();
    return this.#dropped;
  }

  /** Refuse a path the copy left out (at any revision). */
  async #visible(rel: string, what: string): Promise<string> {
    if (rel !== '.' && (matchesExclude(rel, this.#patterns) || (await this.#droppedFiles()).has(rel)))
      fail(`${what} ${rel} is left out of the project copy`);
    return rel;
  }

  /** Pathspecs that keep everything left out of the copy out of a diff. */
  async #excludeSpecs(): Promise<string[]> {
    const specs = [...(await this.#droppedFiles())].map((f) => `:(exclude,literal)${f}`);
    for (const raw of this.#patterns) {
      const p = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
      if (!p) continue;
      const at = p.includes('/') ? [p] : [p, `**/${p}`];
      for (const g of at) specs.push(`:(exclude,glob)${g}`, `:(exclude,glob)${g}/**`);
    }
    return specs;
  }

  async call(name: string, input: unknown): Promise<ToolResult> {
    const tool = LAPTOP_TOOLS.find((t) => t.name === name);
    try {
      if (!tool) fail(`unknown tool ${name}`);
      const args = validate(tool!, input ?? {});
      return { text: clip(await this.#run(tool!.name, args)) };
    } catch (err) {
      if (err instanceof ToolError) return { text: err.message, isError: true };
      return { text: `${name} failed: ${String((err as Error)?.message ?? err).slice(0, 500)}`, isError: true };
    }
  }

  /** A path inside the project, absolute on this machine. */
  #resolve(p: unknown, what = 'path'): string {
    const raw = String(p ?? '').trim();
    if (!raw) fail(`${what} is empty`);
    const rel =
      raw === PROJECT_ROOT_PATH
        ? '.'
        : raw.startsWith(PROJECT_ROOT_PATH + '/')
          ? raw.slice(PROJECT_ROOT_PATH.length + 1)
          : raw;
    if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel))
      fail(`${what} ${raw} is outside the project (use a path relative to it, or under ${PROJECT_ROOT_PATH})`);
    const abs = path.resolve(this.#root, rel);
    const inside = (x: string): boolean => x === this.#root || x.startsWith(this.#root + path.sep);
    if (!inside(abs)) fail(`${what} ${raw} is outside the project`);
    // The nearest existing ancestor must really be inside too: no link leads out.
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    if (!inside(fs.realpathSync(probe))) fail(`${what} ${raw} is outside the project`);
    if (path.relative(this.#root, abs).split(path.sep).includes('.git')) fail(`${what} ${raw} is inside .git`);
    return abs;
  }

  #rel(abs: string): string {
    return path.relative(this.#root, abs).split(path.sep).join('/') || '.';
  }

  async #run(name: string, a: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'Read':
        return this.#readFile(a);
      case 'Edit':
        return this.#edit(a);
      case 'Write':
        return this.#write(a);
      case 'Glob':
        return this.#glob(a);
      case 'Grep':
        return this.#grep(a);
      default:
        return this.#git(name, a);
    }
  }

  #readFile(a: Record<string, unknown>): string {
    const abs = this.#resolve(a.file_path, 'file_path');
    if (!fs.existsSync(abs)) fail(`${this.#rel(abs)} does not exist`);
    const st = fs.statSync(abs);
    if (st.isDirectory()) fail(`${this.#rel(abs)} is a directory (use Glob to list it)`);
    if (st.size > MAX_FILE_BYTES) fail(`${this.#rel(abs)} is ${st.size} bytes, over the ${MAX_FILE_BYTES}-byte limit`);
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) fail(`${this.#rel(abs)} is a binary file`);
    this.#read.add(abs);
    const lines = buf.toString('utf8').split('\n');
    if (lines.length === 1 && lines[0] === '') return `${this.#rel(abs)} is empty`;
    const start = Math.max(1, Math.floor(Number(a.offset ?? 1)));
    const count = Math.max(1, Math.floor(Number(a.limit ?? READ_DEFAULT_LINES)));
    if (start > lines.length) fail(`${this.#rel(abs)} has ${lines.length} lines; offset ${start} is past the end`);
    return lines
      .slice(start - 1, start - 1 + count)
      .map((l, i) => {
        const line = l.length > READ_MAX_LINE_CHARS ? `${l.slice(0, READ_MAX_LINE_CHARS)}… (line cut)` : l;
        return `${String(start + i).padStart(6)}\t${line}`;
      })
      .join('\n');
  }

  #mustHaveRead(abs: string): void {
    if (!this.#read.has(abs)) fail(`read ${this.#rel(abs)} before changing it`);
  }

  #edit(a: Record<string, unknown>): string {
    const abs = this.#resolve(a.file_path, 'file_path');
    if (!fs.existsSync(abs)) fail(`${this.#rel(abs)} does not exist (use Write to create it)`);
    this.#mustHaveRead(abs);
    const oldS = String(a.old_string);
    const newS = String(a.new_string);
    if (!oldS) fail('old_string is empty (use Write to create or replace a whole file)');
    if (oldS === newS) fail('old_string and new_string are the same');
    const text = fs.readFileSync(abs, 'utf8');
    const parts = text.split(oldS);
    const count = parts.length - 1;
    if (count === 0) fail(`old_string was not found in ${this.#rel(abs)} (it must match exactly, whitespace included)`);
    if (count > 1 && a.replace_all !== true)
      fail(
        `old_string occurs ${count} times in ${this.#rel(abs)}; include more context to make it unique, or set replace_all`,
      );
    // Literal, never String.replace: a `$` in new_string is just a `$`.
    const out = a.replace_all === true ? parts.join(newS) : parts[0] + newS + parts.slice(1).join(oldS);
    if (Buffer.byteLength(out) > MAX_FILE_BYTES) fail(`the result would be over the ${MAX_FILE_BYTES}-byte limit`);
    fs.writeFileSync(abs, out);
    return `Edited ${this.#rel(abs)} (${a.replace_all === true ? count : 1} replacement${a.replace_all === true && count > 1 ? 's' : ''})`;
  }

  #write(a: Record<string, unknown>): string {
    const abs = this.#resolve(a.file_path, 'file_path');
    const content = String(a.content);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) fail(`content is over the ${MAX_FILE_BYTES}-byte limit`);
    const exists = fs.existsSync(abs);
    if (exists) {
      if (fs.statSync(abs).isDirectory()) fail(`${this.#rel(abs)} is a directory`);
      this.#mustHaveRead(abs);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    this.#read.add(abs);
    return `${exists ? 'Wrote' : 'Created'} ${this.#rel(abs)}`;
  }

  #glob(a: Record<string, unknown>): string {
    const base = a.path === undefined ? this.#root : this.#resolve(a.path);
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) fail(`${this.#rel(base)} is not a directory`);
    const re = globRegExp(String(a.pattern).replace(/^\.\//, ''));
    const files: string[] = [];
    walk(base, base, files, 200_000);
    const hits = files
      .filter((f) => re.test(f))
      .map((f) => {
        const abs = path.join(base, f);
        return { rel: this.#rel(abs), mtime: fs.statSync(abs).mtimeMs };
      })
      .sort((x, y) => y.mtime - x.mtime);
    if (!hits.length) return 'No files found';
    const shown = hits.slice(0, GLOB_MAX_RESULTS).map((h) => h.rel);
    return shown.join('\n') + (hits.length > shown.length ? `\n… and ${hits.length - shown.length} more` : '');
  }

  async #grep(a: Record<string, unknown>): Promise<string> {
    const flags = a['-i'] === true ? 'i' : '';
    try {
      new RegExp(String(a.pattern), flags);
    } catch (err) {
      return fail(`pattern is not a valid regular expression: ${(err as Error).message}`);
    }
    const target = a.path === undefined ? this.#root : this.#resolve(a.path);
    if (!fs.existsSync(target)) fail(`${this.#rel(target)} does not exist`);
    const only = a.glob === undefined ? null : globRegExp(String(a.glob));
    const files: string[] = [];
    if (fs.statSync(target).isDirectory()) walk(this.#root, target, files, 200_000);
    else files.push(this.#rel(target));
    const ctx = Number(a['-C'] ?? 0);
    const job: GrepJob = {
      root: this.#root,
      files: files.filter((rel) => !only || only.test(rel) || only.test(path.posix.basename(rel))),
      pattern: String(a.pattern),
      flags,
      mode: String(a.output_mode ?? 'files_with_matches'),
      before: Math.max(0, Math.min(20, Number(a['-B'] ?? ctx))),
      after: Math.max(0, Math.min(20, Number(a['-A'] ?? ctx))),
      limit: a.head_limit === undefined ? Infinity : Math.max(1, Math.floor(Number(a.head_limit))),
      maxFileBytes: GREP_MAX_FILE_BYTES,
      maxLineChars: GREP_MAX_LINE_CHARS,
      shownLineChars: READ_MAX_LINE_CHARS,
    };
    const out = await runGrep(job, this.grepTimeoutMs);
    if (out === null)
      fail(
        `Grep took over ${this.grepTimeoutMs / 1000} s and was stopped: narrow the pattern (nested repeats backtrack badly) or the path`,
      );
    return out!.length ? out!.join('\n') : 'No matches found';
  }

  async #git(name: string, a: Record<string, unknown>): Promise<string> {
    if (!this.repo) fail('this project copy has no git history');
    const rel = (p: unknown, what = 'path'): Promise<string> => this.#visible(this.#rel(this.#resolve(p, what)), what);
    let args: string[];
    switch (name) {
      case 'GitStatus':
        args = ['status', '--short', '--branch'];
        break;
      case 'GitDiff': {
        args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
        if (a.from !== undefined) args.push(revision(a.from, 'from'));
        if (a.to !== undefined) {
          if (a.from === undefined) args.push('HEAD');
          args.push(revision(a.to, 'to'));
        }
        args.push('--');
        if (a.path !== undefined) args.push(await rel(a.path));
        else args.push('.');
        args.push(...(await this.#excludeSpecs()));
        break;
      }
      case 'GitLog': {
        const n = Math.max(1, Math.min(GIT_LOG_MAX, Math.floor(Number(a.max_count ?? 20))));
        args = ['log', '--no-color', '--date=iso', '--format=%H %ad %an%n    %s', `-n${n}`];
        if (a.revision !== undefined) args.push(revision(a.revision, 'revision'));
        args.push('--');
        if (a.path !== undefined) args.push(await rel(a.path));
        break;
      }
      case 'GitShow': {
        const r = revision(a.revision, 'revision');
        args =
          a.path !== undefined
            ? ['show', '--no-color', '--no-textconv', `${r}:${await rel(a.path)}`]
            : [
                'show',
                '--no-color',
                '--no-ext-diff',
                '--no-textconv',
                '--stat',
                '--format=%H %ad %an%n%n%B',
                r,
                '--',
                '.',
                ...(await this.#excludeSpecs()),
              ];
        break;
      }
      case 'GitBlame': {
        args = ['blame', '--date=short'];
        if (a.start_line !== undefined || a.end_line !== undefined) {
          const s = Math.max(1, Math.floor(Number(a.start_line ?? 1)));
          const e = Math.max(s, Math.floor(Number(a.end_line ?? s + 199)));
          args.push(`-L${s},${e}`);
        }
        args.push('--', await rel(a.path));
        break;
      }
      default:
        return fail(`unknown tool ${name}`);
    }
    const out = await git(this.#root, args, undefined, this.repo!).catch((err: unknown) =>
      fail(
        `git: ${String((err as Error)?.message ?? err)
          .split('\n')
          .slice(0, 3)
          .join(' ')
          .slice(0, 300)}`,
      ),
    );
    return out.trim() || '(nothing)';
  }
}

interface GrepJob {
  root: string;
  files: string[];
  pattern: string;
  flags: string;
  mode: string;
  before: number;
  after: number;
  limit: number;
  maxFileBytes: number;
  maxLineChars: number;
  shownLineChars: number;
}

/**
 * The matching itself, run in a worker (plain JS: it is evaluated, not
 * bundled). A pattern the agent chose can backtrack for hours on one line;
 * in the extension host that would freeze every extension, so the worker is
 * terminated instead.
 */
const GREP_WORKER = `
const { parentPort, workerData: j } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const re = new RegExp(j.pattern, j.flags);
const out = [];
for (const rel of j.files) {
  if (out.length >= j.limit) break;
  let buf;
  try {
    const abs = path.join(j.root, rel);
    if (fs.statSync(abs).size > j.maxFileBytes) continue;
    buf = fs.readFileSync(abs);
  } catch { continue; }
  if (buf.subarray(0, 8192).includes(0)) continue;
  const lines = buf.toString('utf8').split('\\n');
  const hit = lines.map((l) => l.length <= j.maxLineChars && re.test(l));
  const n = hit.filter(Boolean).length;
  if (!n) continue;
  if (j.mode === 'files_with_matches') out.push(rel);
  else if (j.mode === 'count') out.push(rel + ':' + n);
  else {
    const show = new Set();
    hit.forEach((h, i) => {
      if (!h) return;
      for (let k = Math.max(0, i - j.before); k <= Math.min(lines.length - 1, i + j.after); k++) show.add(k);
    });
    for (const i of [...show].sort((x, y) => x - y)) {
      if (out.length >= j.limit) break;
      out.push(rel + ':' + (i + 1) + (hit[i] ? ':' : '-') + lines[i].slice(0, j.shownLineChars));
    }
  }
}
parentPort.postMessage(out);
`;

/** The Grep lines, or null when the worker ran past `timeoutMs` and was stopped. */
function runGrep(job: GrepJob, timeoutMs: number): Promise<string[] | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(GREP_WORKER, { eval: true, workerData: job });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(null);
    }, timeoutMs);
    worker.once('message', (lines: string[]) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(lines);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
