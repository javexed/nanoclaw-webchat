/**
 * Agent-behaviour evals — the runner.
 *
 *   pnpm exec tsx scripts/eval/run-evals.ts --room <room-id> [options]
 *
 *   --room <id>     send every case here, overriding the room each case names
 *   --case <name>   run just one case
 *   --cases <dir>   load cases from somewhere other than ./cases
 *   --url <ws-url>  default ws://127.0.0.1:3100/ws, or $WEBCHAT_WS_URL
 *   --token <tok>   bearer token, or $WEBCHAT_TOKEN (unneeded on localhost when
 *                   the install has no explicit auth configured)
 *   --header 'K: V' extra header on the upgrade request; repeatable. For an
 *                   install behind an identity-aware proxy that wants a service
 *                   credential — Cloudflare Access takes CF-Access-Client-Id
 *                   and CF-Access-Client-Secret, Entra/EasyAuth a bearer for
 *                   the app registration. The edge validates it and injects the
 *                   identity header the app trusts, so the runner never needs
 *                   to know how that install authenticates people.
 *   --no-clear      do NOT reset the room's agents between cases. Only for
 *                   debugging the runner itself — cases share a room, so
 *                   without the reset each one is scored in a context built by
 *                   the cases before it.
 *   --settle <ms>   quiet period after `done` before the turn is called over
 *   --verbose       print every status frame as it arrives
 *   --json          machine-readable results on stdout
 *
 * Sends each case's prompt to its room, watches the turn, and compares the tool
 * calls the agent actually made against what the case expected. The comparison
 * itself lives in ./match.ts, which is pure and unit-tested; this file is only
 * the part that needs a live install.
 *
 * WHY OVER THE WEBSOCKET. Two reasons, and the second is the important one.
 * First, it is the same path a person uses — auth, routing, session resolution
 * and wiring all get exercised rather than bypassed, so a case can fail for the
 * reasons a user would experience. Second, the socket already carries the status
 * frames: every tool call is broadcast to the room as it executes, so watching
 * the turn and observing it are one connection, with no session-directory
 * lookup and no second reader of a container's DB.
 *
 * WHY NOT READ THE AGENT'S REPLY. Because prose about what an agent did is
 * exactly the claim under test. Local models have both announced work they never
 * started and reported a finished path for a file that was never written; a
 * grader that reads the reply scores the announcement. Status frames are emitted
 * by the tool call itself, so they record what happened.
 *
 * WHY THIS IS NOT IN CI. It needs a live install: containers, credentials, a
 * model. CI has none, and a suite that cannot run there rots. Run it by hand
 * against a real install, or on a timer against a staging group. The half that
 * decides pass or fail is covered in CI.
 *
 * Exits non-zero if any case fails, so a timer can alert on it.
 */
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

import WebSocket from 'ws';

import { type EvalCase, type ObservedCall, describeExpected, matchCalls } from './match.js';
import { resolveModelProfile } from '../../src/model-profiles.js';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** The case's own budget, widened to the model's derived one when that is larger. */
export function effectiveTimeoutMs(caseMs: number | undefined, modelMs: number | null | undefined): number {
  const base = caseMs ?? DEFAULT_TIMEOUT_MS;
  return modelMs && modelMs > base ? modelMs : base;
}

/**
 * Grace after the last agent goes quiet before the turn is called finished.
 *
 * Two reasons a turn looks over when it is not. A multi-agent room can emit one
 * agent's `done` while another is between tool calls and has not sent its
 * `start` yet. And an agent that stumbles can emit `done` and then resume: a
 * local model observed here sent `done`, sat for sixteen seconds, and worked for
 * another ninety trying to reach a tool that did not exist. Closing on the first
 * quiet moment scores a fraction of what the prompt actually caused.
 *
 * Ten seconds bridges that stumble without running so long that a genuinely
 * finished turn absorbs whatever the room does next. `--settle` overrides it.
 */
const DEFAULT_SETTLE_MS = 10_000;

/**
 * Budget for one HTTP call (model lookup, between-case clear). These are quick
 * reads and one write; an install that stops answering must fail the case, not
 * hang the suite with no timer running.
 */
const HTTP_TIMEOUT_MS = 30_000;

interface CaseResult {
  name: string;
  passed: boolean;
  score: number;
  elapsedMs: number;
  observed: ObservedCall[];
  missing: string[];
  /** Calls a `forbidden` entry banned, rendered for the failure line. */
  violations: string[];
  error?: string;
}

interface StatusFrame {
  type?: string;
  event?: string;
  text?: string | null;
  detail?: string | null;
  agent_name?: string | null;
  error?: string;
  /** Present on a `message` frame echoing the sender's own prompt. */
  client_id?: string;
}

function loadCases(dir: string, only?: string): EvalCase[] {
  if (!fs.existsSync(dir)) return [];
  const cases: EvalCase[] = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EvalCase | EvalCase[];
    for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!only || c.name === only) cases.push(c);
    }
  }
  return cases;
}

/**
 * Run one turn and return the tool calls it made.
 *
 * Resolves on the turn finishing or on the case's timeout — a timeout is not an
 * exception here because a half-finished turn's calls are still worth reporting;
 * the caller decides what a timeout means for the verdict.
 */
interface RunOpts {
  /**
   * Turn budget derived from the model actually behind the room, or null when
   * it could not be resolved. A case's own `timeoutMs` is a FLOOR, not a
   * ceiling: it says how long the task ought to take, while this says how slow
   * this particular model is. Taking the larger keeps a slow-but-correct model
   * from being reported as a capability failure — which is what ornith-1.5:9b
   * looked like against a budget written for a 4B model.
   */
  modelTimeoutMs?: number | null;
  url: string;
  token?: string;
  headers: Record<string, string>;
  settleMs: number;
  verbose: boolean;
  /** Clear the room's sessions before each run. See clearRoomSessions. */
  clear: boolean;
}

/**
 * The HTTP origin behind a WebSocket URL.
 *
 * Exported because getting this wrong is silent: a `wss://` install would be
 * called over plain http, the clear would fail, and the suite would carry on
 * scoring contaminated turns — the exact failure this whole seam exists to
 * prevent.
 */
export function httpBaseFromWsUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

/**
 * Reset the room's agents before a case runs.
 *
 * WHY THIS IS NOT OPTIONAL. Cases share a room, and a room's agent carries
 * context between turns — pi by replaying its whole transcript, Claude by
 * resuming a continuation server-side. So without this, case N is scored in a
 * context built by cases 1..N-1, and the later a case runs the less its result
 * means. Observed here: a single 90-line pi transcript accumulated every case's
 * prompt across two runs, and a file-writing case answered mid-task with
 * `echo "6" > /tmp/ans.txt` — arithmetic bleeding in from a "what is 2 + 2"
 * case that had run earlier.
 *
 * This posts the same `/clear` the room's own "clear all" control sends, so it
 * resets whatever the provider actually keeps rather than reaching into any
 * one provider's storage.
 *
 * A failure here is fatal to the case rather than a warning. A suite that
 * quietly keeps scoring contaminated turns is worse than one that stops.
 */
/** GET one JSON endpoint with the run's auth. Null on any failure. */
async function getJson<T>(o: RunOpts, pathname: string): Promise<T | null> {
  const url = `${httpBaseFromWsUrl(o.url)}${pathname}`;
  const headers: Record<string, string> = { ...o.headers };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method: 'GET', headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('error', () => resolve(null));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Which model is actually behind this room, as a bare id ("ornith-1.5:9b").
 *
 * Null whenever it cannot be determined — an unassigned agent, an older
 * install without these endpoints, a room with several agents and no `--agent`
 * to disambiguate. Null means "fall back to the case's own budget", never
 * "guess": a wrong budget is worse than the documented default, because it
 * turns a slow model into a fake capability failure or hides a real hang.
 */
async function resolveRoomModel(o: RunOpts, room: string, agentName?: string): Promise<string | null> {
  const roomAgents = await getJson<Array<{ id: string; name?: string }>>(
    o,
    `/api/rooms/${encodeURIComponent(room)}/agents`,
  );
  if (!roomAgents?.length) return null;
  const agent = agentName ? roomAgents.find((a) => a.name === agentName) : roomAgents[0];
  // Several agents and no way to tell which the case scores: refuse rather
  // than budget for an arbitrary one.
  if (!agent || (!agentName && roomAgents.length > 1)) return null;

  const all = await getJson<Array<{ id: string; assigned_model_id?: string | null }>>(o, '/api/agents');
  const assignedId = all?.find((a) => a.id === agent.id)?.assigned_model_id;
  if (!assignedId) return null;

  const models = await getJson<Array<{ id: string; model_id?: string }>>(o, '/api/models');
  return models?.find((m) => m.id === assignedId)?.model_id ?? null;
}

async function clearRoomSessions(o: RunOpts, room: string): Promise<number> {
  const url = `${httpBaseFromWsUrl(o.url)}/api/rooms/${encodeURIComponent(room)}/sessions/broadcast`;
  const body = JSON.stringify({ command: '/clear' });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    // The route is CSRF-guarded like every state-changing webchat endpoint.
    'X-Webchat-CSRF': '1',
    ...o.headers,
  };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;

  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method: 'POST', headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`clear failed: HTTP ${res.statusCode} ${raw.slice(0, 200)}`));
          return;
        }
        try {
          resolve((JSON.parse(raw) as { count?: number }).count ?? 0);
        } catch {
          resolve(0);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function observeTurn(o: RunOpts, c: EvalCase): Promise<{ observed: ObservedCall[]; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const observed: ObservedCall[] = [];
    // Which agents are mid-turn. A room can have several, and the turn is over
    // only when all of them are.
    const active = new Set<string>();
    let sawStart = false;
    let settleTimer: NodeJS.Timeout | undefined;
    let done = false;
    // Status frames carry no turn id, so a previous case's turn that is still
    // winding down would be scored against this one. Nothing counts until the
    // server echoes THIS prompt back (matched by client_id): the echo is sent
    // once the message is routed, before the agent it wakes can emit anything.
    const clientId = randomUUID();
    let echoed = false;

    // `bearer.<token>` as a subprotocol, matching the PWA: it keeps the secret
    // out of the URL and therefore out of any proxy's access log.
    const ws = new WebSocket(o.url, o.token ? [`bearer.${o.token}`] : undefined, {
      headers: o.headers,
    });

    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      try {
        ws.close();
      } catch {}
      resolve({ observed, timedOut });
    };
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      try {
        ws.close();
      } catch {}
      reject(err);
    };

    // On timeout, stop the turn before leaving (the room's own "stop" control).
    // Otherwise the agent keeps working and its frames land in the next case.
    // Close once the frame is flushed, or after a short grace if it never is.
    const stopThenFinish = (): void => {
      if (done || ws.readyState !== WebSocket.OPEN) return finish(true);
      const grace = setTimeout(() => finish(true), 2000);
      const leave = (): void => {
        clearTimeout(grace);
        finish(true);
      };
      try {
        ws.send(JSON.stringify({ type: 'interrupt', ...(c.agent ? { agent_name: c.agent } : {}) }), leave);
      } catch {
        leave();
      }
    };
    const hardTimer = setTimeout(stopThenFinish, effectiveTimeoutMs(c.timeoutMs, o.modelTimeoutMs));

    const armSettle = (): void => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (sawStart && active.size === 0) finish(false);
      }, o.settleMs);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth' }));
      ws.send(JSON.stringify({ type: 'join', room_id: c.room }));
      ws.send(JSON.stringify({ type: 'message', content: c.prompt, client_id: clientId }));
    });

    ws.on('message', (raw) => {
      let f: StatusFrame;
      try {
        f = JSON.parse(raw.toString()) as StatusFrame;
      } catch {
        return;
      }
      // A refused join is reported and then nothing else ever arrives, which
      // would read as a timeout ten minutes later. Fail it immediately and say
      // why — the room id being wrong is the most likely reason a case is red.
      if (f.type === 'error') {
        fail(new Error(f.error ?? 'websocket error frame'));
        return;
      }
      if (f.type === 'message' && f.client_id === clientId) {
        echoed = true;
        return;
      }
      if (f.type !== 'status') return;
      if (!echoed) {
        if (o.verbose) console.log(`      · (ignored, before this prompt) ${f.event} ${f.agent_name ?? ''}`.trimEnd());
        return;
      }
      // A case that fails for an invisible reason costs more than it saves.
      // `--verbose` prints the turn as it arrives, which is how the settle
      // window and the agent-name filter get diagnosed at all.
      if (o.verbose) {
        console.log(`      · ${f.event} ${f.agent_name ?? ''} ${f.text ?? ''} ${f.detail ?? ''}`.trimEnd());
      }
      // Frames are room-wide. A case may name one agent when the room has
      // several, so that another agent's work is not scored against it.
      if (c.agent && f.agent_name && f.agent_name !== c.agent) return;

      const who = f.agent_name ?? '';
      if (f.event === 'start') {
        sawStart = true;
        active.add(who);
        clearTimeout(settleTimer);
        return;
      }
      if (f.event === 'done' || f.event === 'stalled') {
        active.delete(who);
        armSettle();
        return;
      }
      if (f.event === 'tool') {
        // text is the tool name, detail its target — the same pair the room's
        // thinking bubble renders.
        observed.push({ tool: f.text ?? '', target: f.detail ?? null });
      }
    });

    ws.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    ws.on('close', () => finish(!sawStart || active.size > 0));
  });
}

async function runCase(o: RunOpts, c: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  try {
    if (o.clear) {
      const n = await clearRoomSessions(o, c.room);
      if (o.verbose) console.log(`      · cleared ${n} session(s)`);
      // The clear is written to the session's inbound DB before the prompt is,
      // and the poll loop drops the continuation before it runs anything in the
      // same batch — so ordering alone is enough. The pause is only to keep a
      // cold room's spawn from racing the two writes into one confusing batch.
      await new Promise((r) => setTimeout(r, 1500));
    }
    const { observed, timedOut } = await observeTurn(o, c);
    const result = matchCalls(observed, c.expected, c.matchMode ?? 'ordered_subset', c.forbidden ?? []);
    return {
      name: c.name,
      // A timeout fails regardless of what matched. An agent that needs longer
      // than its case allows has regressed even if it was heading the right way.
      passed: result.passed && !timedOut,
      score: result.score,
      elapsedMs: Date.now() - started,
      observed,
      missing: result.missing.map(describeExpected),
      violations: (result.violations ?? []).map((o) => `${o.tool}(${o.target ?? ''})`),
      error: timedOut ? `turn did not finish within ${effectiveTimeoutMs(c.timeoutMs, o.modelTimeoutMs)}ms` : undefined,
    };
  } catch (err) {
    return {
      name: c.name,
      passed: false,
      score: 0,
      elapsedMs: Date.now() - started,
      observed: [],
      missing: c.expected.map(describeExpected),
      violations: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function report(r: CaseResult): void {
  console.log(
    `${r.passed ? 'PASS' : 'FAIL'}  ${r.name}  (${Math.round(r.elapsedMs / 1000)}s, score ${r.score.toFixed(2)})`,
  );
  if (r.passed) return;
  if (r.error) console.log(`      ${r.error}`);
  if (r.missing.length) console.log(`      missing:  ${r.missing.join(', ')}`);
  if (r.violations.length) console.log(`      forbidden: ${r.violations.join(', ')}`);
  console.log(`      observed: ${r.observed.map((o) => `${o.tool}(${o.target ?? ''})`).join(' → ') || '(none)'}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = arg('--cases') ?? path.join(here, 'cases');
  const asJson = argv.includes('--json');
  // Repeatable, so several credential headers can be supplied together.
  const headers: Record<string, string> = {};
  argv.forEach((a, i) => {
    if (a !== '--header') return;
    const raw = argv[i + 1] ?? '';
    const at = raw.indexOf(':');
    if (at === -1) throw new Error(`--header wants 'Name: value', got: ${raw}`);
    headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
  });

  const opts: RunOpts = {
    url: arg('--url') ?? process.env.WEBCHAT_WS_URL ?? 'ws://127.0.0.1:3100/ws',
    token: arg('--token') ?? process.env.WEBCHAT_TOKEN,
    headers,
    settleMs: Number(arg('--settle') ?? DEFAULT_SETTLE_MS),
    verbose: argv.includes('--verbose'),
    clear: !argv.includes('--no-clear'),
  };

  // Shipped cases name a room this install may not have. `--room` points the
  // whole suite at a real one, which is what makes the bundled cases portable
  // rather than a description of one machine.
  const roomOverride = arg('--room');
  const cases = loadCases(dir, arg('--case')).map((c) => (roomOverride ? { ...c, room: roomOverride } : c));
  if (cases.length === 0) {
    console.error(`No cases found in ${dir}`);
    process.exit(2);
  }

  // Resolve the turn budget ONCE, from the model actually behind the room. A
  // case's timeoutMs is written for the task, not for the hardware: ornith
  // answering correctly in 122s against a 120s case read as "did not finish",
  // which is a capability failure the model did not commit. `--model` skips
  // the lookup for an install whose endpoints do not expose it.
  const modelOverride = arg('--model');
  const modelId = modelOverride ?? (await resolveRoomModel(opts, cases[0].room, cases[0].agent));
  if (modelId) {
    const profile = resolveModelProfile({ model: modelId });
    opts.modelTimeoutMs = profile.turnTimeoutMs;
    if (!asJson) {
      console.log(`model ${modelId} (${profile.source}) — turn budget ${Math.round(profile.turnTimeoutMs / 1000)}s\n`);
    }
  } else if (!asJson) {
    // Say so rather than silently using the case budget: an unexplained
    // timeout on a slow model is the exact confusion this exists to remove.
    console.log("model not resolved — using each case's own timeout\n");
  }

  const results: CaseResult[] = [];
  for (const c of cases) {
    // Sequential on purpose. Two agents working at once on one host contend for
    // CPU and for the model, which turns any latency assertion into a coin flip
    // and makes a red run impossible to attribute.
    const runs = c.runs ?? 1;
    for (let i = 0; i < runs; i += 1) {
      const r = await runCase(opts, c);
      const named = runs > 1 ? { ...r, name: `${c.name} #${i + 1}` } : r;
      results.push(named);
      if (!asJson) report(named);
    }
  }

  const failed = results.filter((r) => !r.passed);
  if (asJson) {
    console.log(JSON.stringify({ results, passed: results.length - failed.length, failed: failed.length }, null, 2));
  } else {
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

// Only when run as a command. Importing this module — which the unit test for
// the pure helpers does — must not start a suite. It did: the test passed
// anyway, but only because vitest finished before main() got far enough to
// matter, which is a flake rather than a pass.
//
// Compared by real path: launched through a symlink (a linked checkout, a
// /usr/local/bin shim), argv[1] names the link while import.meta.url names the
// target, and a plain string compare exits 0 having run nothing.
function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === b;
  }
}
const invokedDirectly = process.argv[1] !== undefined && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) void main();
