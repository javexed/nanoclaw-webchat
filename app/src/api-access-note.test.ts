import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { ensureContainerConfig } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { composeGroupProjectDoc } from './project-doc-compose.js';
import type { AgentGroup } from './types.js';

const NOTE = path.join('container', 'agent-runner', 'src', 'mcp-tools', 'api-access.instructions.md');

let groupDir: string;

beforeEach(async () => {
  groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-access-note-'));
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(groupDir, { recursive: true, force: true });
});

describe('API access note', () => {
  // The note answers the base document's `ncl groups connect` guidance, so it
  // must reach every agent's project document, not only agents with a secret.
  it('is inlined into a composed project document', async () => {
    const ag = {
      id: 'ag-note',
      name: 'note',
      folder: 'note',
      agent_provider: null,
      created_at: new Date().toISOString(),
    } as AgentGroup;
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);

    await composeGroupProjectDoc(ag, groupDir, { fileName: 'CLAUDE.md' });
    const doc = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');

    expect(doc).toContain(`# NanoClaw Module: api-access\n\n${fs.readFileSync(NOTE, 'utf-8').trim()}`);
  });
});
