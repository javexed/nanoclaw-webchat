/**
 * A cloud model's lifecycle around the router install: the model is
 * registered by the install itself (an abandoned browser leaves nothing
 * served-but-unregistered), a failed or refused install withdraws the backend
 * it added, and deleting it finds the router's backend even after the
 * router's port changed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  start: { started: true } as { started: boolean; code?: string; error?: string },
  args: [] as unknown[],
  removed: [] as string[],
  reinstalls: 0,
  added: true,
  reloads: [] as string[],
}));
vi.mock('./http.js', async (orig) => ({
  ...(await orig<object>()),
  readJsonObject: async (req: { body: unknown }) => req.body,
  json: (res: { out?: unknown }, status: number, body: unknown) => void (res.out = { status, body }),
}));
vi.mock('../install-engine.js', async (orig) => ({
  ...(await orig<object>()),
  hasFeatureInstall: () => true,
  installStatus: async () => ({ running: true }),
  startFeatureInstall: async (_name: string, _root: string, args: unknown) => {
    h.args.push(args);
    return h.start;
  },
}));
vi.mock('../cloud-models.js', async (orig) => ({
  ...(await orig<object>()),
  prepareCloudModel: async () => ({
    provider: { id: 'cohere', label: 'Cohere' },
    modelId: 'command-r',
    added: h.added,
  }),
  removeCloudModel: async (id: string) => {
    h.removed.push(id);
    return { removed: true, remaining: 1 };
  },
  cloudModelNames: () => ['command-r'],
  // The router serves no cloud model yet: this one moves it behind the gateway.
  routerViaGateway: () => false,
  routerSettings: () => ({ port: 4000, container: 'nanoclaw-litellm' }),
}));
vi.mock('./model-wiring.js', async (orig) => ({
  ...(await orig<object>()),
  reloadRouterModelAgents: async (reason: string) => void h.reloads.push(reason),
}));
vi.mock('../ollama-manage.js', async (orig) => ({
  ...(await orig<object>()),
  deriveModelServerHosts: async () => '',
  startRouterReinstall: () => void h.reinstalls++,
}));

import { closeDb, initDb } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { getDb } from '../../../db/connection.js';
import { createWebchatModel, listWebchatModels } from '../db.js';
import type { CloudModelStep } from '../ollama-manage.js';
import { deleteModelHandler, rCloudModelsPost } from './routes-models.js';

let dir: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-routes-'));
  await initDb(path.join(dir, 'test.db'));
  await runMigrations(getDb());
  Object.assign(h, { start: { started: true }, args: [], removed: [], reinstalls: 0, added: true, reloads: [] });
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(): Promise<{ status: number; body: unknown }> {
  const res: { out?: { status: number; body: unknown } } = {};
  const body = { provider: 'cohere', model_id: 'command-r', api_key: 'k' };
  await rCloudModelsPost({ req: { body }, res } as never, [] as unknown as RegExpMatchArray);
  return res.out!;
}
const cloudStep = (): CloudModelStep => (h.args[0] as { cloud: CloudModelStep }).cloud;

describe('adding a cloud model', () => {
  it('the install registers the model, once', async () => {
    expect((await post()).status).toBe(202);
    await cloudStep().register();
    await cloudStep().register();
    const models = (await listWebchatModels()).filter((m) => m.model_id === 'command-r');
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      kind: 'openai-compatible',
      endpoint: 'http://127.0.0.1:4000/v1',
      name: 'Cohere command-r',
    });
  });

  it('agents on the router move to the gateway once the router is there, not before', async () => {
    await post();
    expect(h.reloads).toEqual([]);
    await cloudStep().register();
    expect(h.reloads).toHaveLength(1);
  });

  it('a refused install withdraws the backend it just added', async () => {
    h.start = { started: false, code: 'already-running', error: 'LiteLLM router is already installing' };
    const out = await post();
    expect(out).toEqual({
      status: 409,
      body: { error: 'LiteLLM router is already installing', code: 'already-running' },
    });
    expect(h.removed).toEqual(['command-r']);
  });

  it('a failed install withdraws only a backend it added', async () => {
    await post();
    await cloudStep().rollback();
    expect(h.removed).toEqual(['command-r']);
    h.added = false;
    h.args = [];
    await post();
    await cloudStep().rollback();
    expect(h.removed).toEqual(['command-r']);
  });
});

describe('deleting a cloud model', () => {
  it("finds the router's backend for a registration made before the port changed", async () => {
    await createWebchatModel({
      id: 'm1',
      name: 'Cohere command-r',
      kind: 'openai-compatible',
      endpoint: 'http://127.0.0.1:4555/v1',
      model_id: 'command-r',
      credential_ref: null,
      created_at: Date.now(),
    });
    const res: { out?: { status: number } } = {};
    await deleteModelHandler(res as never, 'm1', false);
    expect(res.out?.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.removed).toEqual(['command-r']);
    expect(h.reinstalls).toBe(1);
  });
});
