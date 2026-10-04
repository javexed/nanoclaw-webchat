/**
 * writeAgentSettingsForAssignedModel and the env key it sets only for some
 * models: a cloud provider's output cap. It is removed when the model changes
 * only if this writer put it there — an operator's own value survives every
 * rewrite.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get DATA_DIR() {
    return env.dataDir;
  },
}));
vi.mock('./cloud-models.js', async (orig) => ({
  ...(await orig<object>()),
  cloudModelMaxOutput: (id: string) => (id === 'command-a' ? 8192 : null),
  routerSettings: () => ({ port: 4000, container: 'nanoclaw-litellm' }),
}));

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { assignModelToAgent, createWebchatModel } from './db.js';
import { writeAgentSettingsForAssignedModel } from './models.js';

const GROUP = 'ag-1';
let settingsPath: string;

beforeEach(async () => {
  env.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-settings-env-'));
  await initDb(path.join(env.dataDir, 'test.db'));
  await runMigrations(getDb());
  await getDb().run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?,?,?,NULL,'t')`,
    GROUP,
    GROUP,
    GROUP,
  );
  for (const [id, kind, endpoint, modelId] of [
    ['cloud', 'openai-compatible', 'http://127.0.0.1:4000/v1', 'command-a'],
    ['local', 'ollama', 'http://192.0.2.9:11434', 'qwen3:8b'],
  ] as const) {
    await createWebchatModel({
      id,
      name: id,
      kind,
      endpoint,
      model_id: modelId,
      credential_ref: null,
      created_at: Date.now(),
    });
  }
  const dir = path.join(env.dataDir, 'v2-sessions', GROUP, '.claude-shared');
  fs.mkdirSync(dir, { recursive: true });
  settingsPath = path.join(dir, 'settings.json');
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(env.dataDir, { recursive: true, force: true });
});

const settingsEnv = (): Record<string, string> =>
  (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env;

describe('env keys this writer owns', () => {
  it('sets the cap for a cloud model, and takes it away again', async () => {
    await assignModelToAgent(GROUP, 'cloud');
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv()).toMatchObject({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' });

    await assignModelToAgent(GROUP, 'local');
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv()).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
  });

  it("keeps an operator's own output cap through every rewrite, and lets it win", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' } }));
    await assignModelToAgent(GROUP, 'local');
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4096');

    await assignModelToAgent(GROUP, 'cloud');
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4096');
  });

  it('a cap written before ownership was recorded still counts as ours', async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' } }));
    await assignModelToAgent(GROUP, 'local');
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv()).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
  });
});
