// The runner's side of central's requests. The agent runs on central; this
// machine serves it one thing, the laptop tools (laptop-tools.ts): read and
// change the developer's project, in a proposal copy the developer reviews
// before anything reaches their own tree. It starts nothing and runs nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProposalClone, recoverProposal, type Proposal } from './git-changes.js';
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
   */
  approveFolder?: (folder: string) => Promise<boolean>;
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
      await this.laptopTools(payload, true);
      return { tools: toolDefinitions() };
    }
    const tools = await this.laptopTools(payload, false);
    return { ...(await tools.call(String(payload.name ?? ''), payload.input ?? {})) };
  }

  /**
   * The tools for a group, over its proposal copy of the project bound at the
   * workspace slot — the folder, allowlist and secret scan the developer set.
   * `refresh` (at each agent start, when central lists the tools) re-takes the
   * copy when it holds no unapplied proposal.
   */
  private async laptopTools(payload: Record<string, unknown>, refresh: boolean): Promise<LaptopTools> {
    const why = this.installRefusal(payload.installSlug);
    if (why) throw new RefusedError({ kind: 'spec-invalid', retryable: false, detail: why });
    const agentGroupId = String(payload.agentGroupId ?? '');
    if (!GROUP_ID.test(agentGroupId))
      throw new RefusedError({ kind: 'spec-invalid', retryable: false, detail: 'bad agent group id' });
    const known = this.#laptopTools.get(agentGroupId);
    if (known && !refresh) return known;
    const policy = this.d.policy();
    const real = boundSlot(policy, WORKSPACE_SLOT);
    if (this.d.approveFolder && !(await this.d.approveFolder(real)))
      throw new RefusedError({
        kind: 'denied-by-policy',
        retryable: false,
        detail: `the developer has not allowed the agent to work on ${real}`,
      });
    const excludes = [...new Set(policy.excludes ?? DEFAULT_WORKSPACE_EXCLUDES)];
    let proposal: Proposal;
    try {
      proposal = await ensureProposalClone(real, this.proposalDir(agentGroupId), excludes);
    } catch (err) {
      throw new RefusedError({
        kind: 'denied-by-policy',
        retryable: false,
        detail: `could not copy ${real} for the agent (it needs a git repository there): ${String((err as Error).message).slice(0, 240)}`,
      });
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
      detail: `slot ${slotPath} is not bound on this machine (set nanoclaw.slots)`,
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
      detail: `slot ${slotPath}: ${real} is outside the mount allowlist`,
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
