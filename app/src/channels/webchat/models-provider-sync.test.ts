/**
 * Provider follows the assigned model's kind — which, post-OpenCode, is
 * always the default Claude provider (openai-compatible endpoints are
 * consumed through LiteLLM's Anthropic-spec /v1/messages surface).
 *
 * The sync's remaining job is REVERSION: a group some earlier install
 * flipped to 'opencode' must come back to null (default) on its next
 * (re)assignment. Guards that wiring end-to-end against the real central
 * DB: delete the syncAgentProviderForAssignedModel call (or its column
 * write) and this goes red.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { registerProviderContainerConfig } from '../../providers/provider-container-registry.js';
import { assignModelToAgent, createWebchatModel, unassignModelFromAgent, type WebchatModelKind } from './db.js';
import { providerForModelKind, syncAgentProviderForAssignedModel } from './models.js';

// The sync writes the OpenCode backend into the install's .env; capture the
// writes instead of touching the tree the tests run in.
const envWrites = vi.hoisted(() => [] as Array<[string, string]>);
vi.mock('./env-write.js', () => ({
  upsertEnv: (_root: string, k: string, v: string) => envWrites.push([k, v]),
}));
vi.mock('../../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../env.js')>()),
  readEnvFile: () => ({}),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-provider-sync-'));
  envWrites.length = 0;
  await initDb(path.join(tmpDir, 'test.db'));
  await runMigrations(getDb());
  await getDb().run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1','AG','ag-1',NULL,'t')`,
  );
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeModel(kind: WebchatModelKind, id: string): void {
  createWebchatModel({
    id,
    name: id,
    kind,
    endpoint: kind === 'anthropic' ? null : 'http://host.docker.internal:4000/v1',
    model_id: 'gemma4:latest',
    credential_ref: null,
    created_at: Date.now(),
  });
}

describe('providerForModelKind (OpenCode not installed)', () => {
  it('maps every kind to the default provider when OpenCode is absent', async () => {
    // No OpenCode harness registered → even ollama stays on the default Claude
    // provider; there's nothing to switch to.
    expect(providerForModelKind('openai-compatible')).toBeNull();
    expect(providerForModelKind('anthropic')).toBeNull();
    expect(providerForModelKind('ollama')).toBeNull();
    expect(providerForModelKind(null)).toBeNull();
    expect(providerForModelKind(undefined)).toBeNull();
  });
});

describe('syncAgentProviderForAssignedModel', () => {
  it('keeps the default provider on an openai-compatible assignment (direct path)', async () => {
    makeModel('openai-compatible', 'm-oc');
    await assignModelToAgent('ag-1', 'm-oc');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBeNull();
  });

  it('reverts a group a pre-direct install left on opencode', async () => {
    makeModel('openai-compatible', 'm-oc');
    await assignModelToAgent('ag-1', 'm-oc');
    await syncAgentProviderForAssignedModel('ag-1'); // ensures the config row exists
    // Simulate the legacy state: an older install wrote provider='opencode'.
    await getDb().run(`UPDATE container_configs SET provider = 'opencode' WHERE agent_group_id = 'ag-1'`);
    expect((await getContainerConfig('ag-1'))?.provider).toBe('opencode');

    await syncAgentProviderForAssignedModel('ag-1'); // any (re)assignment un-wedges it
    expect((await getContainerConfig('ag-1'))?.provider).toBeNull();

    await unassignModelFromAgent('ag-1');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBeNull();
  });
});

// Runs LAST: the registry is a process singleton with no unregister, so once we
// register a stub 'opencode' here every later opencodeInstalled() check is true.
// The not-installed suites above must observe the absent state first.
describe('with OpenCode installed', () => {
  beforeAll(async () => {
    registerProviderContainerConfig('opencode', () => ({ env: {} }));
  });

  it('routes ollama to opencode, other kinds to the default', async () => {
    expect(providerForModelKind('ollama')).toBe('opencode');
    expect(providerForModelKind('openai-compatible')).toBeNull();
    expect(providerForModelKind('anthropic')).toBeNull();
  });

  it('auto-assigns opencode when the effective model is ollama', async () => {
    makeModel('ollama', 'm-ol');
    await assignModelToAgent('ag-1', 'm-ol');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBe('opencode');
  });

  it('keeps an explicit opencode choice sticky across re-sync', async () => {
    makeModel('ollama', 'm-ol');
    await assignModelToAgent('ag-1', 'm-ol');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBe('opencode');
    await syncAgentProviderForAssignedModel('ag-1'); // boot convergence / re-sync must not flip it
    expect((await getContainerConfig('ag-1'))?.provider).toBe('opencode');
  });

  it('never clobbers an explicit codex group (unmanaged axis)', async () => {
    makeModel('ollama', 'm-ol');
    await assignModelToAgent('ag-1', 'm-ol');
    await syncAgentProviderForAssignedModel('ag-1'); // creates the config row
    await getDb().run(`UPDATE container_configs SET provider = 'codex' WHERE agent_group_id = 'ag-1'`);
    envWrites.length = 0;
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBe('codex');
    expect(envWrites).toEqual([]); // and never re-points OpenCode for a group not on it
  });

  // Upstream's provider reads the group's container config model first, then
  // OPENCODE_MODEL from .env. Neither used to be written: the skill hardcoded
  // one model and the UI pick never reached the harness.
  it('carries the picked model to the group config and the install env', async () => {
    makeModel('ollama', 'm-ol');
    await assignModelToAgent('ag-1', 'm-ol');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.model).toBe('openai/gemma4:latest');
    const env = Object.fromEntries(envWrites);
    expect(env.OPENCODE_PROVIDER).toBe('openai');
    expect(env.OPENCODE_BASE_URL).toBe('http://host.docker.internal:4000/v1');
    expect(env.OPENCODE_MODEL).toBe('openai/gemma4:latest');
    expect(env.OPENCODE_SMALL_MODEL).toBe('openai/gemma4:latest');
    expect(env.OPENCODE_MODEL_CONTEXT_LIMIT).toBe('32768');
    expect(env.NO_PROXY).toContain('host.docker.internal');
  });

  it('clears the model it wrote when the group leaves opencode, never an operator-set one', async () => {
    makeModel('ollama', 'm-ol');
    makeModel('anthropic', 'm-an');
    await assignModelToAgent('ag-1', 'm-ol');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.model).toBe('openai/gemma4:latest');

    await assignModelToAgent('ag-1', 'm-an');
    await syncAgentProviderForAssignedModel('ag-1');
    // The explicit opencode harness is sticky (above); the model this module
    // wrote for it is not — a stale local id must not outlive the pick.
    expect((await getContainerConfig('ag-1'))?.provider).toBe('opencode');
    expect((await getContainerConfig('ag-1'))?.model).toBeNull();

    await getDb().run(`UPDATE container_configs SET model = 'claude-opus-5' WHERE agent_group_id = 'ag-1'`);
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.model).toBe('claude-opus-5');
  });
});

// Runs LAST, and must stay last: registering a stub 'pi' makes piInstalled()
// true for the rest of the process, so every suite that needs to observe pi
// ABSENT — including the OpenCode ones above, which assert ollama → 'opencode' —
// has to have run already. Same singleton constraint as the opencode block.
describe('with BOTH pi and OpenCode installed', () => {
  beforeAll(async () => {
    registerProviderContainerConfig('pi', () => ({ env: {} }));
  });

  it('prefers pi over opencode for ollama', async () => {
    // The preference is the whole point: both are valid local harnesses, and pi
    // wins on prompt budget (587 vs 6,443 tokens head-to-head). If this ever
    // flips back to 'opencode' the auto-selection silently regresses to the
    // heavier harness on exactly the models that can least afford it.
    expect(providerForModelKind('ollama')).toBe('pi');
  });

  it('still routes non-ollama kinds to the default provider', async () => {
    expect(providerForModelKind('openai-compatible')).toBeNull();
    expect(providerForModelKind('anthropic')).toBeNull();
    expect(providerForModelKind(null)).toBeNull();
    expect(providerForModelKind(undefined)).toBeNull();
  });

  it('auto-assigns pi when the effective model is ollama', async () => {
    makeModel('ollama', 'm-pi');
    await assignModelToAgent('ag-1', 'm-pi');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBe('pi');
  });

  it('keeps an explicit pi choice sticky across re-sync', async () => {
    makeModel('ollama', 'm-pi');
    await assignModelToAgent('ag-1', 'm-pi');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBe('pi');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBe('pi');
  });

  it('un-wedges a group left on an ollama-less kind back to the default', async () => {
    makeModel('anthropic', 'm-an');
    await assignModelToAgent('ag-1', 'm-an');
    await syncAgentProviderForAssignedModel('ag-1');
    expect((await getContainerConfig('ag-1'))?.provider).toBeNull();
  });
});
