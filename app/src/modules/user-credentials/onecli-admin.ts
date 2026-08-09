/**
 * Thin wrapper over the `onecli` CLI for UserCreds onboarding (the SDK has no secret
 * management). The CLI reads ONECLI_URL/ONECLI_API_KEY from the host env, same
 * as the SDK. Isolated behind an interface so onboarding orchestration is
 * testable with a fake and the real CLI shapes live in one place.
 *
 * JSON shapes confirmed against onecli 1.2.x:
 *   agents list   → { data: [{ id, identifier, secretMode, ... }] }
 *   secrets list  → { data: [{ id, type, hostPattern, ... }] }
 *   agents secrets --id → { data: [{ id, type, hostPattern, ... }] }
 *   secrets create / agents create → the created row (id) under data
 *
 * NOTE: `secrets create --value <secret>` passes the value in argv (briefly
 * visible in the host process list) — this covers API keys AND Claude OAuth
 * subscription tokens (both go via --value; only Codex auth.json uses --file).
 * onecli has no stdin value input as of 1.2.x; the host is single-user so the
 * exposure window is small — documented residual.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { UserCredsCredType } from './db.js';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, delimiter } from 'path';
import { randomBytes } from 'crypto';

const pexec = promisify(execFile);

/**
 * `onecli <resource> list` pages at 20 rows by default. Every lookup here is a
 * "find the one row I mean" query, so an unbounded call silently misses agents
 * and secrets past the first page — findAgentId returns null for an agent that
 * exists (which makes ensureAgent create a duplicate) and listAllSecrets
 * mis-classifies assignments. Always ask for the full set.
 */
// One page cap for every OneCLI list call. 1000 over the patch's 500: a
// larger page is strictly safer for completeness, and it is the value this
// install already ran for agents.
const LIST_MAX = '1000';
const TIMEOUT_MS = 20_000;

/**
 * Run `fn` with a path to a 0600 temp file holding `content`, then shred it.
 * Used for Codex OAuth credentials — the whole `auth.json` is too large/sensitive
 * to pass via `--value` (which lands in argv / the host process list); onecli's
 * `secrets create/update --file` reads it off disk instead.
 */
async function withSecretFile<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `user-creds-${randomBytes(12).toString('hex')}.json`);
  writeFileSync(path, content, { mode: 0o600 });
  try {
    return await fn(path);
  } finally {
    rmSync(path, { force: true });
  }
}

async function onecli(args: string[]): Promise<unknown> {
  // A bare systemd service env (a Proxmox LXC / any `Environment=`-less unit)
  // carries neither of the two things onecli needs:
  //   • HOME — onecli reads its auth token from $HOME/.config; unset → every call
  //     comes back "Unauthorized" (exit 2).
  //   • ~/.local/bin on PATH — the onecli CLI installs there (setup/onecli.ts),
  //     but systemd's default PATH omits it, so the binary isn't found (ENOENT).
  // Resolve HOME from the OS passwd entry and prepend ~/.local/bin, same as the
  // setup step's childEnv().
  const home = process.env.HOME || homedir();
  const localBin = join(home, '.local', 'bin');
  const env = {
    ...process.env,
    HOME: home,
    PATH: process.env.PATH ? `${localBin}${delimiter}${process.env.PATH}` : localBin,
  };
  try {
    const { stdout } = await pexec('onecli', args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env });
    return stdout.trim() ? (JSON.parse(stdout) as unknown) : {};
  } catch (err) {
    // execFile rejections carry the full argv (incl. any `--value <secret>`) on
    // `.message`/`.cmd`; NEVER surface those — they'd leak a member's plaintext key
    // into the host log. But onecli's own `stderr` is its error REASON (gateway
    // unreachable, secret already exists, bad type, …), not the value it received —
    // surface a short slice of it so a failure is diagnosable instead of a bare
    // exit code. Belt-and-braces: redact any value we passed via `--value`, in case
    // onecli ever echoes it back. See user-creds-adversarial-review (cred-storage).
    const e = err as { code?: unknown; stderr?: unknown } | null;
    const code = e?.code;
    const vi = args.indexOf('--value');
    const secretValue = vi >= 0 ? args[vi + 1] : undefined;
    let reason = (typeof e?.stderr === 'string' ? e.stderr : String(e?.stderr ?? '')).trim();
    if (secretValue && reason) reason = reason.split(secretValue).join('***');
    reason = reason.replace(/\s+/g, ' ').slice(0, 200);
    const base = `onecli ${args[0] ?? '?'} ${args[1] ?? ''}`.trim() + ` failed (exit ${code ?? '?'})`;
    throw new Error(reason ? `${base}: ${reason}` : base);
  }
}

function dataArray(r: unknown): Record<string, unknown>[] {
  const d = (r as { data?: unknown })?.data;
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === 'object') return [d as Record<string, unknown>];
  return [];
}
function createdId(r: unknown): string | null {
  const d = (r as { data?: unknown; id?: unknown })?.data;
  if (Array.isArray(d)) return (d[0] as { id?: string })?.id ?? null;
  if (d && typeof d === 'object') return (d as { id?: string }).id ?? null;
  return (r as { id?: string })?.id ?? null;
}

export interface SecretRow {
  id: string;
  type?: string;
  hostPattern?: string;
  name?: string;
}

/**
 * Injection spec for a `generic` (tool) secret — how the gateway puts the value
 * on the wire. Either a header (`headerName` + `valueFormat`, e.g. `Authorization`
 * / `Basic {value}`) or a query param (`paramName`), scoped to `hostPattern`.
 */
export interface GenericSecretSpec {
  hostPattern: string;
  pathPattern?: string;
  headerName?: string;
  valueFormat?: string;
  paramName?: string;
  paramFormat?: string;
}

export interface AgentRow {
  id: string;
  identifier?: string;
  secretMode?: string;
}

export interface OnecliAdmin {
  /** OneCLI internal agent id (uuid) for a given identifier, or null. */
  findAgentId(identifier: string): Promise<string | null>;
  /** Every agent (uuid + identifier + secretMode) — used to find agents pinned
   *  to a secret about to be deleted so they can be re-pointed. */
  listAgents(): Promise<AgentRow[]>;
  /** Idempotently ensure an agent exists for the identifier; returns its uuid. */
  ensureAgent(name: string, identifier: string): Promise<string>;
  /**
   * Create an `anthropic`-type vault secret. Holds either an API key
   * (`sk-ant-api…`) or a subscription/OAuth token (`sk-ant-oat…`); OneCLI
   * auto-detects the auth mode from the value (x-api-key vs Authorization:
   * Bearer) and serves it as the api.anthropic.com provider credential.
   */
  createAnthropicSecret(name: string, value: string): Promise<string>;
  /**
   * Create the member's OpenAI/Codex vault secret. `oauth_token` stores the whole
   * ChatGPT/Codex `auth.json` via `--file` (host pattern `chatgpt.com`); `api_key`
   * stores the key via `--value` (host pattern `api.openai.com`). Mirrors how the
   * Codex provider's operator credential is registered (setup/providers/codex.ts).
   */
  createOpenAISecret(name: string, value: string, credType: UserCredsCredType): Promise<string>;
  /**
   * Create a `generic` vault secret — an arbitrary API token (Azure DevOps PAT,
   * GitHub token, third-party API key) injected into matching outbound requests
   * at the gateway. Generic secrets are deliberately NOT provider-typed, so the
   * workspace-default reconciliation never deletes them and UserCreds enrollment
   * carries them onto per-member agents (see `groupToolSecretIds`).
   */
  createGenericSecret(name: string, value: string, spec: GenericSecretSpec): Promise<string>;
  /** Update a secret's value. `asFile=true` writes the value (e.g. a refreshed
   *  Codex auth.json) via `--file` instead of `--value`. */
  updateSecretValue(secretId: string, value: string, asFile?: boolean): Promise<void>;
  deleteSecret(secretId: string): Promise<void>;
  setSecretMode(agentId: string, mode: 'selective' | 'all'): Promise<void>;
  /**
   * An agent's current secret mode. Load-bearing for credential scoping: in
   * `all` mode the gateway injects EVERY vault secret whose host pattern
   * matches, so assignment does not scope anything — only `selective` does.
   */
  getSecretMode(agentId: string): Promise<'all' | 'selective' | null>;
  /** Secret IDs assigned to an agent. `agents secrets --id` returns bare id strings. */
  listAgentSecretIds(agentId: string): Promise<string[]>;
  /** All vault secrets (id + type) — used to classify an agent's assigned ids. */
  listAllSecrets(): Promise<SecretRow[]>;
  setSecrets(agentId: string, secretIds: string[]): Promise<void>;
}

// `agents list` returns only the first ~20 rows by default. Every caller here
// needs the FULL fleet — a lookup that misses an agent past row 20 makes
// findAgentId re-create a duplicate, and makes the workspace-default reconcile
// (setWorkspaceDefaultCredential → listAgents) silently skip most agents. Pass a
// high --max so one call covers any realistic fleet.
const AGENTS_LIST = ['agents', 'list', '--max', LIST_MAX];

export const realOnecliAdmin: OnecliAdmin = {
  async findAgentId(identifier) {
    const rows = dataArray(await onecli(AGENTS_LIST));
    return (rows.find((a) => a.identifier === identifier)?.id as string | undefined) ?? null;
  },
  async listAgents() {
    return dataArray(await onecli(AGENTS_LIST)).map((a) => ({
      id: a.id as string,
      identifier: a.identifier as string | undefined,
      secretMode: a.secretMode as string | undefined,
    }));
  },
  async ensureAgent(name, identifier) {
    const existing = await this.findAgentId(identifier);
    if (existing) return existing;
    await onecli(['agents', 'create', '--name', name, '--identifier', identifier]);
    const id = await this.findAgentId(identifier);
    if (!id) throw new Error(`onecli: agent ${identifier} not found after create`);
    return id;
  },
  async createAnthropicSecret(name, value) {
    const r = await onecli([
      'secrets',
      'create',
      '--name',
      name,
      '--type',
      'anthropic',
      '--value',
      value,
      '--host-pattern',
      'api.anthropic.com',
    ]);
    const id = createdId(r);
    if (!id) throw new Error('onecli: secrets create returned no id');
    return id;
  },
  async createOpenAISecret(name, value, credType) {
    // OAuth (ChatGPT/Codex subscription): the whole auth.json, stored via --file,
    // host chatgpt.com. API key: --value, host api.openai.com. The gateway serves
    // the value as the sentinel auth.json stub and swaps it on the wire.
    const r =
      credType === 'oauth_token'
        ? await withSecretFile(value, (path) =>
            onecli([
              'secrets',
              'create',
              '--name',
              name,
              '--type',
              'openai',
              '--file',
              path,
              '--host-pattern',
              'chatgpt.com',
            ]),
          )
        : await onecli([
            'secrets',
            'create',
            '--name',
            name,
            '--type',
            'openai',
            '--value',
            value,
            '--host-pattern',
            'api.openai.com',
          ]);
    const id = createdId(r);
    if (!id) throw new Error('onecli: secrets create returned no id');
    return id;
  },
  async updateSecretValue(secretId, value, asFile = false) {
    if (asFile) {
      await withSecretFile(value, (path) => onecli(['secrets', 'update', '--id', secretId, '--file', path]));
      return;
    }
    await onecli(['secrets', 'update', '--id', secretId, '--value', value]);
  },
  async deleteSecret(secretId) {
    await onecli(['secrets', 'delete', '--id', secretId]);
  },
  async getSecretMode(agentId) {
    const rows = dataArray(await onecli(['agents', 'list', '--max', LIST_MAX]));
    const mode = rows.find((a) => a.id === agentId)?.secretMode as string | undefined;
    return mode === 'all' || mode === 'selective' ? mode : null;
  },
  async setSecretMode(agentId, mode) {
    await onecli(['agents', 'set-secret-mode', '--id', agentId, '--mode', mode]);
  },
  async listAgentSecretIds(agentId) {
    const d = (await onecli(['agents', 'secrets', '--id', agentId])) as { data?: unknown };
    return Array.isArray(d.data) ? d.data.filter((x): x is string => typeof x === 'string') : [];
  },
  async createGenericSecret(name, value, spec) {
    const args = [
      'secrets',
      'create',
      '--name',
      name,
      '--type',
      'generic',
      '--value',
      value,
      '--host-pattern',
      spec.hostPattern,
    ];
    if (spec.pathPattern) args.push('--path-pattern', spec.pathPattern);
    if (spec.headerName) args.push('--header-name', spec.headerName);
    if (spec.valueFormat) args.push('--value-format', spec.valueFormat);
    if (spec.paramName) args.push('--param-name', spec.paramName);
    if (spec.paramFormat) args.push('--param-format', spec.paramFormat);
    const id = createdId(await onecli(args));
    if (!id) throw new Error('onecli: secrets create returned no id');
    return id;
  },
  async listAllSecrets() {
    return dataArray(await onecli(['secrets', 'list', '--max', LIST_MAX])).map((s) => ({
      id: s.id as string,
      type: s.type as string | undefined,
      hostPattern: s.hostPattern as string | undefined,
      name: s.name as string | undefined,
    }));
  },
  async setSecrets(agentId, secretIds) {
    await onecli(['agents', 'set-secrets', '--id', agentId, '--secret-ids', secretIds.join(',')]);
  },
};
