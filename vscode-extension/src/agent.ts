// The runner's side of central's requests. The agent runs on central; this
// machine serves it one thing, the laptop tools (laptop-tools.ts): read and
// change the developer's project, in a proposal copy the developer reviews
// before anything reaches their own tree. It starts nothing and runs nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureProposalClone,
  proposalChanges,
  recoverProposal,
  workingTreeStamp,
  type Proposal,
} from './git-changes.js';
import { LaptopTools, toolDefinitions } from './laptop-tools.js';
import { DEFAULT_WORKSPACE_EXCLUDES, UNTRACKED_SECRET_EXCLUDES, WORKSPACE_SLOT } from './policy.js';

export interface AgentPolicy {
  /** Slot path (e.g. /workspace/project) → local directory the developer bound to it. */
  slots: Record<string, string>;
  /** Slot targets must resolve (symlinks followed) under one of these. */
  allowlist: string[];
  /** Secret-like paths left out of the agent's copy. */
  excludes?: readonly string[];
}

export interface AgentDeps {
  storageRoot: string; // <globalStorage>/runner
  policy: () => AgentPolicy;
  log: (line: string) => void;
  /**
   * Why this machine serves nothing now (the developer pressed Stop all), or
   * null. Checked on this machine, whatever central believes.
   */
  halted?: () => string | null;
  /** The install central's welcome named: requests for any other are refused. */
  installSlug?: () => string | undefined;
  /** A proposal copy became known: the chat panel should re-read it. */
  proposalChanged?: () => void;
  /** A snapshot left these files out: the secret scan found a secret in each (secret-scan.ts). */
  secretsLeftOut?: (paths: string[]) => void;
  /**
   * Whether the developer lets the agent work on this folder (a real path).
   * Asked before a folder is first served; without it every bound folder is served.
   * A string is a refusal with its reason (a folder VS Code does not trust).
   */
  approveFolder?: (folder: string) => Promise<boolean | string>;
  /** test seam: how often a tool call may check the developer's folder (STAMP_CHECK_MS). */
  stampCheckMs?: number;
}

/** A request this machine will not carry out; `failure` goes back to central as is. */
export class RefusedError extends Error {
  constructor(
    readonly failure: { kind: string; retryable: boolean; detail?: string },
    message = `${failure.kind}: ${failure.detail ?? ''}`,
  ) {
    super(message);
    this.name = 'RefusedError';
  }
}

export class RunnerAgent {
  /** Proposal copies by agent group, newest last. */
  private readonly proposals = new Map<string, Proposal>();
  /** Laptop tools by agent group: one proposal copy of the bound project per group on this machine. */
  readonly #laptopTools = new Map<string, LaptopTools>();
  /** The developer's working tree as each group's copy last saw it (workingTreeStamp), and when it was checked. */
  readonly #stamps = new Map<string, { stamp: string; checkedAt: number }>();
  /** One refresh of a group's copy at a time: concurrent tool calls would race on its git index. */
  readonly #busy = new Map<string, Promise<unknown>>();
  /** A folder that moved on while its copy held a proposal: said once until the copy catches up. */
  readonly #behindNoted = new Set<string>();
  /** Each group's copy as taken at its agent's start: tool calls wait for it; a failed one is dropped, and the next call takes it again. */
  readonly #started = new Map<string, Promise<unknown>>();

  constructor(private readonly d: AgentDeps) {}

  /** Where a group's proposal copy lives (the path earlier versions used, so existing copies are kept). */
  proposalDir(agentGroupId: string): string {
    return path.join(this.d.storageRoot, 'proposals', safe(agentGroupId), 'laptop-tools');
  }

  /** The proposal a chat panel should review: the most recently bound one. */
  currentProposal(): Proposal | null {
    const all = [...this.proposals.values()];
    return all.length ? all[all.length - 1] : null;
  }

  /** Dispatch one request; returns the result fields or throws (RefusedError → structured failure). */
  async handle(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (op !== 'tools.list' && op !== 'tools.call')
      throw new RefusedError({
        kind: 'unknown',
        retryable: false,
        detail: `unknown op ${op}: this runner serves laptop tools only`,
      });
    const halt = this.d.halted?.();
    if (halt)
      throw new RefusedError({
        kind: 'denied-by-policy',
        retryable: false,
        detail: `the developer stopped all agents on this machine (${halt}); nothing is served until they resume`,
      });
    if (op === 'tools.list') {
      // The list is fixed; the copy is not needed to answer it. A large project
      // takes longer to copy than the agent waits for its tools to connect.
      this.checkRequest(payload);
      const key = String(payload.agentGroupId);
      const copy = this.laptopTools(payload, true);
      this.#started.set(key, copy);
      copy.catch((err) => {
        // A failed copy (a refusal, dismissed consent, a transient git error) is
        // not kept: the next tool call takes it again rather than failing with it.
        if (this.#started.get(key) === copy) this.#started.delete(key);
        this.d.log(`laptop tools: copy failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return { tools: toolDefinitions() };
    }
    await this.#started.get(String(payload.agentGroupId ?? ''))?.catch(() => {});
    const tools = await this.laptopTools(payload, false);
    return { ...(await tools.call(String(payload.name ?? ''), payload.input ?? {})) };
  }

  /**
   * The tools for a group, over its proposal copy of the project bound at the
   * workspace slot — the folder, allowlist and secret scan the developer set.
   * `refresh` (at each agent start, when central lists the tools) re-takes the
   * copy when it holds no unapplied proposal.
   */
  private laptopTools(payload: Record<string, unknown>, refresh: boolean): Promise<LaptopTools> {
    const key = String(payload.agentGroupId ?? '');
    const run = (this.#busy.get(key) ?? Promise.resolve()).then(() => this.laptopToolsNow(payload, refresh));
    this.#busy.set(
      key,
      run.catch(() => {}),
    );
    return run;
  }

  /**
   * Whether the developer's folder moved on (a pull, a checkout, an edit)
   * since the group's copy was taken. Checked at most every few seconds.
   */
  private async folderMoved(agentGroupId: string, repoRoot: string): Promise<boolean> {
    const seen = this.#stamps.get(agentGroupId);
    if (!seen || Date.now() - seen.checkedAt < (this.d.stampCheckMs ?? STAMP_CHECK_MS)) return false;
    seen.checkedAt = Date.now();
    const now = await workingTreeStamp(repoRoot).catch(() => seen.stamp);
    return now !== seen.stamp;
  }

  /** The install and group a request names are well formed, or it is refused. */
  private checkRequest(payload: Record<string, unknown>): void {
    const why = this.installRefusal(payload.installSlug);
    if (why) throw new RefusedError({ kind: 'spec-invalid', retryable: false, detail: why });
    if (!GROUP_ID.test(String(payload.agentGroupId ?? '')))
      throw new RefusedError({ kind: 'spec-invalid', retryable: false, detail: 'bad agent group id' });
  }

  private async laptopToolsNow(payload: Record<string, unknown>, refresh: boolean): Promise<LaptopTools> {
    this.checkRequest(payload);
    const agentGroupId = String(payload.agentGroupId ?? '');
    const known = this.#laptopTools.get(agentGroupId);
    const had = this.proposals.get(agentGroupId);
    // The copy is re-taken when the agent starts, and between starts when the
    // developer's folder has moved on — a pull mid-session must reach the agent.
    const moved = !!known && !refresh && !!had && (await this.folderMoved(agentGroupId, had.repoRoot));
    if (known && !refresh && !moved) return known;
    const policy = this.d.policy();
    const real = boundSlot(policy, WORKSPACE_SLOT);
    const allowed = this.d.approveFolder ? await this.d.approveFolder(real) : true;
    if (allowed !== true)
      throw new RefusedError({
        kind: 'denied-by-policy',
        retryable: false,
        detail: typeof allowed === 'string' ? allowed : `the developer has not allowed the agent to work on ${real}`,
      });
    const excludes = [...new Set(policy.excludes ?? DEFAULT_WORKSPACE_EXCLUDES)];
    let proposal: Proposal;
    // Stamped before the copy: a change made while it is taken shows as a move next time.
    const stamp = await workingTreeStamp(real).catch(() => '');
    try {
      proposal = await ensureProposalClone(real, this.proposalDir(agentGroupId), excludes);
    } catch (err) {
      throw new RefusedError({
        kind: 'denied-by-policy',
        retryable: false,
        detail: `could not copy ${real} for the agent (it needs a git repository there): ${String((err as Error).message).slice(0, 240)}`,
      });
    }
    // A copy kept for its unapplied proposal keeps the stamp it was taken at:
    // the folder stays "moved" until that proposal is applied or rejected, and
    // the next check after that takes the copy again.
    const kept = !!had && proposal.base === had.base && (await proposalChanges(proposal)).length > 0;
    if (!kept || !this.#stamps.has(agentGroupId)) this.#stamps.set(agentGroupId, { stamp, checkedAt: Date.now() });
    if (moved && kept) {
      // A clone holding an unapplied proposal is never refreshed under it.
      if (!this.#behindNoted.has(agentGroupId)) {
        this.#behindNoted.add(agentGroupId);
        this.d.log(
          `laptop tools: ${real} changed since the agent's copy was taken; the copy holds a proposal, so it stays as it is until that is applied or rejected`,
        );
      }
    } else {
      this.#behindNoted.delete(agentGroupId);
      if (moved) this.d.log(`laptop tools: ${real} changed; the agent's copy was taken again`);
    }
    this.proposals.delete(agentGroupId);
    this.proposals.set(agentGroupId, proposal);
    this.d.proposalChanged?.();
    const leftOut = proposal.secretsLeftOut ?? [];
    if (leftOut.length) {
      this.d.log(`laptop tools: ${leftOut.length} file(s) with secrets left out of the copy`);
      this.d.secretsLeftOut?.(leftOut);
    }
    // The git tools see the developer's history beneath the copy: what the copy
    // leaves out stays out of them too (laptop-tools.ts HiddenPaths).
    const tools = new LaptopTools(
      proposal.dir,
      { gitDir: proposal.gitDir, workTree: proposal.dir },
      { base: proposal.base, patterns: [...excludes, ...UNTRACKED_SECRET_EXCLUDES] },
    );
    this.#laptopTools.set(agentGroupId, tools);
    if (!known) this.d.log(`laptop tools for ${agentGroupId} ← proposal copy of ${real}`);
    return tools;
  }

  /** An install name that is well formed and the one central's welcome named. */
  private installRefusal(slug: unknown): string | null {
    if (typeof slug !== 'string' || !INSTALL_SLUG.test(slug)) return 'the install name is not well formed';
    const welcomed = this.d.installSlug?.();
    if (welcomed && slug !== welcomed)
      return `the request names install ${slug}, but central's welcome named ${welcomed}`;
    return null;
  }
}

/**
 * After a window reload: the laptop-tools copy of the workspace bound now, if
 * one is on disk — the proposal an agent on central left there. Without it
 * the panel and Source Control showed nothing until the agent next used a
 * tool. The newest such copy wins; one of another folder is not this
 * workspace's proposal.
 */
export async function recoverLaptopToolsProposal(storageRoot: string, policy: AgentPolicy): Promise<Proposal | null> {
  let real: string;
  try {
    real = boundSlot(policy, WORKSPACE_SLOT);
  } catch {
    return null;
  }
  const root = path.join(storageRoot, 'proposals');
  let groups: string[] = [];
  try {
    groups = fs.readdirSync(root);
  } catch {
    return null;
  }
  const found: Array<{ p: Proposal; at: number }> = [];
  for (const g of groups) {
    const dir = path.join(root, g, 'laptop-tools');
    if (!fs.existsSync(dir)) continue;
    const p = await recoverProposal(dir);
    if (p && p.repoRoot === real) found.push({ p, at: fs.statSync(dir).mtimeMs });
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.p ?? null;
}

/** How often a tool call may check whether the developer's folder moved on. */
const STAMP_CHECK_MS = 10_000;
const GROUP_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const INSTALL_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]/g, '_');

/** The folder this machine binds at a slot: bound, a real directory, inside the allowlist; refused otherwise. */
function boundSlot(policy: AgentPolicy, slotPath: string): string {
  const bound = policy.slots[slotPath];
  if (!bound)
    throw new RefusedError({
      kind: 'denied-by-policy',
      retryable: false,
      detail: `slot ${slotPath} is not bound on this machine (open the project folder in VS Code)`,
    });
  const real = safeRealpath(bound);
  if (!real || !fs.statSync(real).isDirectory())
    throw new RefusedError({
      kind: 'denied-by-policy',
      retryable: false,
      detail: `slot ${slotPath}: ${bound} is not a directory`,
    });
  const allowed = policy.allowlist.map(safeRealpath).filter((x): x is string => !!x);
  if (!allowed.some((root) => real === root || real.startsWith(root + path.sep)))
    throw new RefusedError({
      kind: 'denied-by-policy',
      retryable: false,
      detail: `slot ${slotPath}: ${real} is outside the folders open in VS Code`,
    });
  return real;
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
  } catch {
    return null;
  }
}
