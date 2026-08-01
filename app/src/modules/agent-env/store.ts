/**
 * Per-agent environment variables — the tier between the vault and a workspace file.
 *
 * The vault is best: OneCLI injects an HTTP header and the container never sees the
 * value. But it can only inject headers, so a query-param API key or an SSH password
 * has nowhere to go except somewhere the agent can read.
 *
 * A workspace file is the bad version of that: READING it is how you use it, so the
 * value lands in context — and therefore in transcripts, logs and compaction — every
 * single time. An env var is used as `$NAME`; the shell expands it and the model never
 * sees the value at all unless it deliberately echoes it.
 *
 * Not a hard boundary: the agent CAN `echo $NAME` or read /proc/self/environ. This
 * removes incidental exposure, not access. Anything the container must never see
 * belongs in the vault.
 *
 * STORED AS 0600 FILES, NOT IN THE DB, for a measured reason: data/v2.db is 0644 on a
 * real install, so the database is the wrong place for a secret. Encrypting into it
 * would need a key beside the ciphertext, which buys nothing. File permissions are the
 * boundary the host already relies on for .env.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

/** POSIX-ish env name. Anchored, so a crafted name cannot smuggle a second var. */
const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_VALUE = 4096;

const dir = (): string => path.join(DATA_DIR, 'agent-env');
const file = (agentGroupId: string): string => path.join(dir(), `${agentGroupId}.json`);

export function isValidEnvName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** Reject what cannot survive a `docker -e NAME=value` argv round trip. */
export function validateEnvValue(value: unknown): { error: string } | null {
  if (typeof value !== 'string') return { error: 'value must be a string' };
  if (value.length > MAX_VALUE) return { error: `value must be at most ${MAX_VALUE} characters` };
  if (value.includes('\0')) return { error: 'value must not contain a NUL byte' };
  if (/[\r\n]/.test(value)) return { error: 'value must be a single line' };
  return null;
}

export function readAgentEnv(agentGroupId: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(file(agentGroupId), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      // Re-validate on READ as well as write: the file is operator-editable, and a
      // malformed name reaching `docker -e` is worse than dropping one entry.
      if (isValidEnvName(k) && typeof v === 'string' && !validateEnvValue(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Names only — what a UI or the agent's own note may see. Never the values. */
export function listAgentEnvNames(agentGroupId: string): string[] {
  return Object.keys(readAgentEnv(agentGroupId)).sort();
}

function write(agentGroupId: string, vars: Record<string, string>): void {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const p = file(agentGroupId);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(vars, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  // rename preserves the tmp file's mode, but be explicit — an existing file created
  // by an older version (or restored from a backup) may be looser.
  fs.chmodSync(p, 0o600);
}

export function setAgentEnv(agentGroupId: string, name: string, value: string): void {
  const vars = readAgentEnv(agentGroupId);
  vars[name] = value;
  write(agentGroupId, vars);
}

export function deleteAgentEnv(agentGroupId: string, name: string): boolean {
  const vars = readAgentEnv(agentGroupId);
  if (!(name in vars)) return false;
  delete vars[name];
  write(agentGroupId, vars);
  return true;
}
