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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { registerProviderContainerConfig } from '../../providers/provider-container-registry.js';
import { assignModelToAgent, createWebchatModel, unassignModelFromAgent, type WebchatModelKind } from './db.js';
import { providerForModelKind, syncAgentProviderForAssignedModel } from './models.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-provider-sync-'));
  initDb(path.join(tmpDir, 'test.db'));
  runMigrations(getDb());
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1','AG','ag-1',NULL,'t')`,
    )
    .run();
});

afterEach(() => {
  closeDb();
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
  it('maps every kind to the default provider when OpenCode is absent', () => {
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
  it('keeps the default provider on an openai-compatible assignment (direct path)', () => {
    makeModel('openai-compatible', 'm-oc');
    assignModelToAgent('ag-1', 'm-oc');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBeNull();
  });

  it('reverts a group a pre-direct install left on opencode', () => {
    makeModel('openai-compatible', 'm-oc');
    assignModelToAgent('ag-1', 'm-oc');
    syncAgentProviderForAssignedModel('ag-1'); // ensures the config row exists
    // Simulate the legacy state: an older install wrote provider='opencode'.
    getDb().prepare(`UPDATE container_configs SET provider = 'opencode' WHERE agent_group_id = 'ag-1'`).run();
    expect(getContainerConfig('ag-1')?.provider).toBe('opencode');

    syncAgentProviderForAssignedModel('ag-1'); // any (re)assignment un-wedges it
    expect(getContainerConfig('ag-1')?.provider).toBeNull();

    unassignModelFromAgent('ag-1');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBeNull();
  });
});

// Runs LAST: the registry is a process singleton with no unregister, so once we
// register a stub 'opencode' here every later opencodeInstalled() check is true.
// The not-installed suites above must observe the absent state first.
describe('with OpenCode installed', () => {
  beforeAll(() => {
    registerProviderContainerConfig('opencode', () => ({ env: {} }));
  });

  it('routes ollama to opencode, other kinds to the default', () => {
    expect(providerForModelKind('ollama')).toBe('opencode');
    expect(providerForModelKind('openai-compatible')).toBeNull();
    expect(providerForModelKind('anthropic')).toBeNull();
  });

  it('auto-assigns opencode when the effective model is ollama', () => {
    makeModel('ollama', 'm-ol');
    assignModelToAgent('ag-1', 'm-ol');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBe('opencode');
  });

  it('keeps an explicit opencode choice sticky across re-sync', () => {
    makeModel('ollama', 'm-ol');
    assignModelToAgent('ag-1', 'm-ol');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBe('opencode');
    syncAgentProviderForAssignedModel('ag-1'); // boot convergence / re-sync must not flip it
    expect(getContainerConfig('ag-1')?.provider).toBe('opencode');
  });

  it('never clobbers an explicit codex group (unmanaged axis)', () => {
    makeModel('ollama', 'm-ol');
    assignModelToAgent('ag-1', 'm-ol');
    syncAgentProviderForAssignedModel('ag-1'); // creates the config row
    getDb().prepare(`UPDATE container_configs SET provider = 'codex' WHERE agent_group_id = 'ag-1'`).run();
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBe('codex');
  });
});
