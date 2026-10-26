import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-group-context-test';
const REPO_ROOT = process.cwd();

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-group-context-test/groups',
    DATA_DIR: '/tmp/nanoclaw-group-context-test/data',
  };
});
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { dispatch } from '../../cli/dispatch.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { PERSONA_PREPEND_FILE } from '../../group-persona.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC } from '../../project-doc-compose.js';
import { ensureSchema } from '../../mailbox/sqlite/session-db.js';
import type { AgentGroup } from '../../types.js';
import { groupContextSources } from './index.js';
import { projectDocManifest } from './project-doc.js';
import { splitAddendum } from './runtime.js';

const groupsDir = path.join(TEST_ROOT, 'groups');
const dataDir = path.join(TEST_ROOT, 'data');

async function seed(id: string, folder = id): Promise<AgentGroup> {
  const ag = { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
  await createAgentGroup(ag);
  // A provider with no host contract and no own surfaces: the default document.
  await ensureContainerConfig(id, 'fixture-provider');
  fs.mkdirSync(path.join(groupsDir, folder), { recursive: true });
  return ag;
}

/** What the spawn path writes for the same group, read back from disk. */
async function composeForReal(ag: AgentGroup): Promise<string> {
  const dir = path.join(TEST_ROOT, 'written', ag.folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(path.join(groupsDir, ag.folder))) {
    fs.copyFileSync(path.join(groupsDir, ag.folder, f), path.join(dir, f));
  }
  await composeGroupProjectDoc(ag, dir, DEFAULT_PROJECT_DOC, ['fixture-skill']);
  return fs.readFileSync(path.join(dir, DEFAULT_PROJECT_DOC.fileName), 'utf-8');
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const sourceRoot = path.join(TEST_ROOT, 'source');
  for (const skill of ['fixture-skill', 'unselected-skill']) {
    const dir = path.join(sourceRoot, 'container', 'skills', skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'instructions.md'), `Resident prose for ${skill}.`);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill}\n---\nOn-demand body.`);
  }
  for (const entry of ['CLAUDE.md', 'agent-runner']) {
    fs.symlinkSync(path.join(REPO_ROOT, 'container', entry), path.join(sourceRoot, 'container', entry));
  }
  fs.mkdirSync(groupsDir, { recursive: true });
  process.chdir(sourceRoot);
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  process.chdir(REPO_ROOT);
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('project document manifest', () => {
  it('concatenates byte-for-byte to the document the spawn path writes', async () => {
    const ag = await seed('ag-exact');
    fs.writeFileSync(path.join(groupsDir, 'ag-exact', PERSONA_PREPEND_FILE), 'You are the fixture.\n\nBe brief.');
    await updateContainerConfigJson('ag-exact', 'skills', ['fixture-skill']);
    await updateContainerConfigJson('ag-exact', 'mcp_servers', {
      docs: { command: 'docs-mcp', args: [], env: {}, instructions: 'Use docs for lookups.' },
    });

    const manifest = await projectDocManifest(ag);
    const written = await composeForReal(ag);

    const concatenated = manifest.sources.map((s) => s.text).join('');
    expect(concatenated).toBe(written);
    expect(manifest.content).toBe(written);
    // A dry run: nothing was written into the group's own folder.
    expect(fs.existsSync(path.join(groupsDir, 'ag-exact', DEFAULT_PROJECT_DOC.fileName))).toBe(false);

    const names = manifest.sources.map((s) => s.name);
    expect(names[0]).toBe('Composed header');
    expect(names).toContain('Persona');
    expect(names).toContain('NanoClaw Skill: fixture-skill');
    expect(names).toContain('MCP Server: docs');
    const unselected = manifest.sources.find((s) => s.name === 'NanoClaw Skill: unselected-skill');
    expect(unselected).toMatchObject({ status: 'excluded', reason: 'skill not selected for this group', text: '' });
  });

  it('says why cli_scope=disabled leaves the ncl modules out', async () => {
    const ag = await seed('ag-nocli');
    await updateContainerConfigScalars('ag-nocli', { cli_scope: 'disabled' });

    const manifest = await projectDocManifest(ag);

    const cli = manifest.sources.find((s) => s.name === 'NanoClaw Module: cli');
    expect(cli).toMatchObject({ status: 'excluded', reason: 'cli_scope is disabled' });
    expect(manifest.sources.find((s) => s.name === 'Persona')).toMatchObject({ status: 'excluded' });
    expect(manifest.sources.map((s) => s.text).join('')).toBe(manifest.content);
  });

  it('marks sections the size cap dropped, and still adds up exactly', async () => {
    const ag = await seed('ag-cap');
    await updateContainerConfigJson('ag-cap', 'skills', ['fixture-skill']);
    const full = Buffer.byteLength((await projectDocManifest(ag)).content, 'utf-8');

    const spec = DEFAULT_PROJECT_DOC as { maxBytes?: number };
    const original = spec.maxBytes;
    spec.maxBytes = full - 1;
    try {
      const manifest = await projectDocManifest(ag);
      expect(manifest.sources.filter((s) => s.status === 'dropped').length).toBeGreaterThan(0);
      expect(manifest.sources.at(-1)?.name).toBe('Omitted for size');
      expect(manifest.sources.map((s) => s.text).join('')).toBe(manifest.content);
    } finally {
      spec.maxBytes = original;
    }
  });
});

describe('runner sources', () => {
  it('splits the recorded addendum back into the exact addendum', () => {
    const addendum = [
      '# You are Fixture',
      '',
      'Your name is **Fixture**.',
      '',
      '## Sending messages',
      '',
      'Your destination is `room`.',
      '',
      '### Sending files',
      '',
      'Use send_file.',
      '',
      '## Reading messages',
      '',
      'Chat turns can include:',
    ].join('\n');
    const pieces = splitAddendum(addendum);
    expect(pieces.map((p) => p.heading)).toEqual([
      'You are Fixture',
      'Sending messages',
      'Sending files',
      'Reading messages',
    ]);
    expect(pieces.map((p) => p.text).join('')).toBe(addendum);
  });

  it('reads the snapshot the runner recorded in its session', async () => {
    const ag = await seed('ag-run');
    const now = new Date().toISOString();
    await createSession({
      id: 'sess-run',
      agent_group_id: 'ag-run',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now,
      created_at: now,
    });
    const sessDir = path.join(dataDir, 'v2-sessions', 'ag-run', 'sess-run');
    fs.mkdirSync(sessDir, { recursive: true });
    ensureSchema(path.join(sessDir, 'outbound.db'), 'outbound');
    const contributor = '### Sending files\n\nUse send_file.';
    const addendum = `# You are Fixture\n\nHi.\n\n## Sending messages\n\nTo room.\n\n${contributor}`;
    const db = new Database(path.join(sessDir, 'outbound.db'));
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'context:snapshot',
      JSON.stringify({
        recordedAt: now,
        provider: 'claude',
        addendum,
        contributorSections: [contributor],
        memory: '## Memory\n\nindex\n[truncated: slim this file and move detail into linked memory files]',
        memoryTruncated: true,
        memoryBudgetChars: 16000,
      }),
      now,
    );
    db.close();

    const { report, sources } = await groupContextSources(ag.id);

    const runner = sources.filter((s) => s.layer === 'system-prompt');
    expect(runner.map((s) => s.text).join('')).toBe(addendum);
    expect(runner.find((s) => s.name === 'Sending files')?.origin).toBe('prompt-section contributor');
    expect(sources.find((s) => s.name === 'Memory')?.status).toBe('truncated');
    expect(report.session).toMatchObject({ id: 'sess-run', provider: 'claude' });
    // The total counts exactly the always-loaded sources that made it in.
    const counted = report.sources.filter(
      (r) =>
        ['project-doc', 'system-prompt', 'memory'].includes(r.layer) && ['included', 'truncated'].includes(r.status),
    );
    expect(report.total.bytes).toBe(counted.reduce((n, r) => n + r.bytes, 0));
    expect(report.sources.find((r) => r.name === 'Skill: fixture-skill')?.status).toBe('on-demand');
  });
});

describe('ncl groups context scope', () => {
  const agentCtx = (agentGroupId: string) => ({
    caller: 'agent' as const,
    sessionId: 's1',
    agentGroupId,
    messagingGroupId: 'mg1',
  });

  it('lets a group-scoped agent read its own group, auto-filling --id', async () => {
    await seed('ag-self');
    const resp = await dispatch({ id: '1', command: 'groups-context', args: {} }, agentCtx('ag-self'));
    expect(resp.ok).toBe(true);
    if (resp.ok) expect((resp.data as { group: { id: string } }).group.id).toBe('ag-self');
  });

  it("refuses a group-scoped agent another group's context", async () => {
    await seed('ag-self');
    await seed('ag-other');
    const resp = await dispatch({ id: '2', command: 'groups-context', args: { id: 'ag-other' } }, agentCtx('ag-self'));
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
  });

  it('refuses an agent whose cli_scope is disabled', async () => {
    await seed('ag-off');
    await updateContainerConfigScalars('ag-off', { cli_scope: 'disabled' });
    const resp = await dispatch({ id: '3', command: 'groups-context', args: {} }, agentCtx('ag-off'));
    expect(resp.ok).toBe(false);
  });

  it('shows one source as composed', async () => {
    await seed('ag-show');
    const resp = await dispatch(
      { id: '4', command: 'groups-context', args: { id: 'ag-show', show: 'NanoClaw Runtime Contract' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const shown = resp.data as { text: string; status: string };
      expect(shown.status).toBe('included');
      expect(shown.text.startsWith('# NanoClaw Runtime Contract\n\n')).toBe(true);
    }
  });
});
