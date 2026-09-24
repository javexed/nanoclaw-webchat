// ── Install engine ───────────────────────────────────────────────────────────
// One place for what every optional stack's install has in common: a state the
// UI polls, a chain of steps run in sequence with a rolling log, the refusals
// (already installed, already running, a missing prerequisite), progress, and
// the "green but this process cannot see it yet" restart-pending reading.
//
// A feature registers its steps builder and the two facts that differ — what
// proves it installed, and what must be true before starting — and gets the
// GET/POST contract for free. Before this there were twelve hand-rolled copies
// of the state and start/progress pair in ollama-manage.ts, and a fix to one
// (progress labels, restart-pending, the pnpm lookup) reached the others only
// by hand.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { pnpmDir } from './host-path.js';

const LINES_CAP = 200;

export interface InstallState {
  running: boolean;
  lines: string[];
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 1-based position in the chain, 0 before the first step. */
  stepIndex: number;
  /** How many steps this chain has, so a client can say "3 of 5". */
  stepCount: number;
  /** Human name of the step in flight. */
  stepLabel: string | null;
}

/** A chain step: a spawned command, or an in-process callback (with a log label).
 *  Callbacks may be async — the chain awaits a returned promise. */
export type InstallStep =
  | { run: [string, string[]]; env?: Record<string, string>; label?: string }
  | { call: () => void | Promise<void>; label: string };

/**
 * A readable name for a run-step that was not given one: the script/command.
 * A `-c <script>` step names the shell, not the script text — that would put a
 * whole install script on the progress line.
 */
function stepName(run: [string, string[]]): string {
  const [cmd, args] = run;
  const first = args.find((a) => !a.startsWith('-') && !/\s/.test(a)) ?? cmd;
  return first.split('/').slice(-1)[0];
}

/**
 * The chain succeeded, but THIS process still reports the provider as absent.
 *
 * The provider registry is populated when the provider barrel is imported —
 * before the skill was applied — so the process that runs the install can never
 * see the result of it, whatever is on disk. And the last step only SCHEDULES
 * the restart, so the chain reports complete while the process reporting it is
 * still the old one. A client that reads "finished, not installed" as failure
 * puts the Install button back; pressing it asks the NEW process, which answers
 * "already installed". That is the loop this exists to break.
 */
export function restartPending(
  state: Pick<InstallState, 'running' | 'exitCode' | 'finishedAt'> & { installed: boolean },
): boolean {
  return !state.running && !state.installed && state.exitCode === 0 && state.finishedAt !== null;
}

/**
 * Child env for a chain step. The service PATH frequently omits the directory of
 * the node that's running us — mise/nvm/asdf/Volta install node under a
 * versioned dir that systemd's own PATH never lists — so a bare
 * `spawn('pnpm', …)` dies with `spawn pnpm ENOENT`. Splice that dir, and the one
 * pnpm is actually in, onto PATH for every step and its own children (e.g.
 * `container/build.sh`'s pnpm/node calls). Step-specific env still layers on top.
 */
function installChainEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const parts = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // Our own node, and wherever pnpm actually lives — which is NOT always the
  // same directory. See host-path.ts: a host with two node installs puts pnpm
  // beside the other one, and splicing only node's dir gives `spawn pnpm
  // ENOENT`. Both go on, so a step and anything it spawns can reach either.
  for (const dir of [pnpmDir(), path.dirname(process.execPath)]) {
    if (dir && !parts.includes(dir)) parts.unshift(dir);
  }
  env.PATH = parts.join(path.delimiter);
  return env;
}

/**
 * Run installer steps in sequence, streaming a capped rolling log into `state`.
 * Stops on the first non-zero exit or thrown callback. Every registered
 * feature and the roster refresh run through it, so the spawn/log boilerplate
 * lives once.
 */
export function runInstallChain(state: InstallState, steps: InstallStep[], root: string): void {
  // Line-buffered append. Chunks rarely align with lines: progress output
  // (health-check dots, docker/ollama status) arrives newline-free or
  // \r-separated. An unterminated tail is held as `partial` and rendered as a
  // mutable last line — so a dot stream reads "....." growing in place instead
  // of one single-dot line per chunk. \r counts as a line break so in-place
  // progress rewrites surface as their latest state.
  let partial = '';
  let partialShown = false;
  const append = (chunk: Buffer | string): void => {
    const parts = (partial + String(chunk)).split(/\r\n|\n|\r/);
    partial = parts.pop() ?? '';
    if (partialShown) {
      state.lines.pop();
      partialShown = false;
    }
    for (const l of parts) {
      const line = l.trimEnd();
      if (!line) continue;
      state.lines.push(line);
    }
    if (partial.trimEnd()) {
      state.lines.push(partial.trimEnd());
      partialShown = true;
    }
    while (state.lines.length > LINES_CAP) state.lines.shift();
  };
  // Finalize any partial at a step boundary so the next step's header can't
  // pop-and-merge into real output from the previous one.
  const flush = (): void => {
    partial = '';
    partialShown = false;
  };
  const fail = (code: number): void => {
    state.running = false;
    state.exitCode = code;
    state.finishedAt = Date.now();
  };
  const runStep = (i: number): void => {
    if (i >= steps.length) {
      state.running = false;
      state.exitCode = 0;
      state.finishedAt = Date.now();
      state.stepLabel = null;
      return;
    }
    const step = steps[i];
    // Stamped before the step runs, so a client polling mid-step sees the step
    // that is actually in flight. A long silent step (an image rebuild emits
    // little) is the whole reason this exists: without it the UI has only the
    // last output line, which stops changing and reads as hung.
    state.stepIndex = i + 1;
    state.stepCount = steps.length;
    state.stepLabel = 'call' in step ? step.label : (step.label ?? stepName(step.run));
    if ('call' in step) {
      append(`→ ${state.stepLabel} …\n`);
      Promise.resolve()
        .then(() => step.call())
        .then(() => runStep(i + 1))
        .catch((err: unknown) => {
          append(`✗ ${err instanceof Error ? err.message : String(err)}
`);
          fail(1);
        });
      return;
    }
    const [cmd, args] = step.run;
    append(`→ ${state.stepLabel} …\n`);
    // A step may carry extra env (e.g. a secret token) — merged over the parent
    // so it reaches the child WITHOUT ever appearing in the streamed log or args.
    const child = spawn(cmd, args, { cwd: root, env: installChainEnv(step.env) });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    // A missing binary (ENOENT — e.g. node/pnpm not on the service PATH) emits
    // 'error', not 'close'. Without this listener it becomes an uncaughtException
    // → process.exit(1), taking down the whole host on one install click.
    let closed = false;
    child.on('error', (err) => {
      if (closed) return;
      closed = true;
      append(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
      flush();
      fail(1);
    });
    child.on('close', (code) => {
      if (closed) return; // 'error' already finalized this step
      closed = true;
      flush();
      if (code !== 0) return fail(code ?? 1);
      runStep(i + 1);
    });
  };
  state.stepIndex = 0;
  state.stepCount = steps.length;
  state.stepLabel = null;
  runStep(0);
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** Why an install may not start. `code` is what a client branches on. */
export interface InstallRefusal {
  code: string;
  error: string;
}

export interface FeatureInstallSpec<A = undefined> {
  /** Human name for messages: "OpenCode". */
  label: string;
  /**
   * Whether THIS process has the feature. For a provider that is true only
   * after the restart re-imports its barrel — see restartPending. May probe
   * (a backend answering on loopback), hence possibly async.
   */
  installed: (root: string) => boolean | Promise<boolean>;
  /**
   * The install may run again while installed: an idempotent installer
   * (LiteLLM re-pointed at new hosts), or a second phase on the same state
   * (cloudflared's connect). A provider apply is neither, so the default is
   * to refuse.
   */
  idempotent?: boolean;
  /**
   * The chain ends by restarting the host, and `installed` can only turn true
   * in the process that comes back — so a green chain that still reads "not
   * installed" is a restart in progress, not a failure (restartPending). An
   * install that lands in-process never has that gap and must not claim it.
   */
  restarts?: boolean;
  /** Fields a feature's clients read beyond the common status (canInstall, a pull job, …). */
  status?: (root: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Checked before anything runs; null when clear. */
  preflight?: (root: string, args: A) => InstallRefusal | null;
  /** Side effect at start, outside the chain (routing kicks a model pull in parallel). */
  onStart?: (root: string, args: A) => void;
  steps: (root: string, args: A) => InstallStep[];
}

/** What a client reads: the chain state plus the two facts that interpret it. */
export interface InstallStatus extends InstallState {
  feature: string;
  installed: boolean;
  restartPending: boolean;
  [extra: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const features = new Map<string, { spec: FeatureInstallSpec<any>; state: InstallState }>();

function idleState(): InstallState {
  return {
    running: false,
    lines: [],
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    stepIndex: 0,
    stepCount: 0,
    stepLabel: null,
  };
}

export function registerFeatureInstall<A = undefined>(name: string, spec: FeatureInstallSpec<A>): void {
  features.set(name, { spec, state: idleState() });
}

export function hasFeatureInstall(name: string): boolean {
  return features.has(name);
}

export function listFeatureInstalls(): string[] {
  return [...features.keys()];
}

function entry(name: string) {
  const e = features.get(name);
  if (!e) throw new Error(`No install registered for '${name}'`);
  return e;
}

export async function installStatus(name: string, root = process.cwd()): Promise<InstallStatus> {
  const { spec, state } = entry(name);
  const installed = await spec.installed(root);
  const extra = spec.status ? await spec.status(root) : {};
  return {
    ...extra,
    ...state,
    lines: state.lines.slice(-40),
    feature: name,
    installed,
    restartPending: spec.restarts ? restartPending({ ...state, installed }) : false,
  };
}

export type StartResult = { started: true } | ({ started: false } & InstallRefusal);

/**
 * Start a feature's chain. Refuses — in this order — when this process already
 * has it (unless the install is idempotent), when a run is in flight, and when
 * a preflight says no; every refusal is a code the client can show, never a
 * thrown error.
 */
export async function startFeatureInstall<A = undefined>(
  name: string,
  root = process.cwd(),
  args?: A,
): Promise<StartResult> {
  const { spec, state } = entry(name);
  if (!spec.idempotent && (await spec.installed(root)))
    return { started: false, code: 'already-installed', error: `${spec.label} is already installed` };
  if (state.running) return { started: false, code: 'already-running', error: `${spec.label} is already installing` };
  const refusal = spec.preflight?.(root, args as A) ?? null;
  if (refusal) return { started: false, ...refusal };
  spec.onStart?.(root, args as A);
  state.running = true;
  state.lines = [];
  state.exitCode = null;
  state.startedAt = Date.now();
  state.finishedAt = null;
  runInstallChain(state, spec.steps(root, args as A), root);
  return { started: true };
}

/** Tests only: forget every registration. */
export function _resetFeatureInstallsForTest(): void {
  features.clear();
}

// ── Preflights the features share ────────────────────────────────────────────

/** The skill the chain applies must be in the checkout. */
export function skillPreflight(skillDir: string): (root: string) => InstallRefusal | null {
  return (root) =>
    fs.existsSync(path.join(root, '.claude/skills', skillDir, 'SKILL.md'))
      ? null
      : { code: 'skill-missing', error: `The ${skillDir} skill is not present in this checkout.` };
}

/**
 * Checked before the button is honoured rather than discovered by the first
 * step: the chains shell out to pnpm, and the skill apply is the first of
 * them. Failing on it later would be a half-applied provider.
 */
export function pnpmPreflight(): InstallRefusal | null {
  return pnpmDir() === null
    ? { code: 'pnpm-missing', error: 'pnpm is not on this service’s PATH — the rebuild steps need it.' }
    : null;
}

/** A feature whose installer is a script shipped by a skill: it must be there. */
export function installerPreflight(relPath: string, message: string): (root: string) => InstallRefusal | null {
  return (root) => (fs.existsSync(path.join(root, relPath)) ? null : { code: 'installer-missing', error: message });
}

/** First refusal wins. */
export function allPreflights(
  ...checks: Array<(root: string) => InstallRefusal | null>
): (root: string) => InstallRefusal | null {
  return (root) => {
    for (const check of checks) {
      const r = check(root);
      if (r) return r;
    }
    return null;
  };
}
