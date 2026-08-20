/**
 * Exporting an agent as a template — and stamping the result back.
 *
 * The assertion that matters is the ROUND TRIP: whatever export writes must be
 * something upstream's own reader accepts, because a template that cannot be
 * stamped is not a template. Every other check here is about what must NOT
 * travel — secrets above all.
 *
 * These call the module directly rather than over HTTP: the HTTP surface's gate
 * is covered in templates-routes.test.ts, and what needs proving here is the
 * file-level contract.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let libDir = '';

// GROUPS_DIR and DATA_DIR derive from process.cwd(), not from the environment,
// so the agent's on-disk side is written into the (disposable) tree the tests
// already run in and removed afterwards. Only the template library is
// env-overridable, and that is the one that must not touch the real one.
let groupDir = '';
let overlayDir = '';

beforeEach(() => {
  vi.resetModules();
  libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-exp-lib-'));
  vi.stubEnv('NANOCLAW_TEMPLATES_DIR', libDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    conn.closeDb();
  } catch {
    // ignore
  }
  for (const d of [libDir, groupDir, overlayDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  groupDir = overlayDir = '';
  vi.resetModules();
});

const GROUP = { id: 'ag-exp', name: 'Research Buddy', folder: 'research-buddy', agent_provider: null, created_at: '' };

/** An agent with every surface a template can carry. */
async function seedAgent(mcpServers: Record<string, unknown> = {}): Promise<void> {
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  await migrations.runMigrations(conn.getDb());
  await conn
    .getDb().run(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`, GROUP.id, GROUP.name, GROUP.folder, '2026-08-17T00:00:00.000Z');

  const { ensureContainerConfig, updateContainerConfigScalars } = await import('../../db/container-configs.js');
  ensureContainerConfig(GROUP.id);
  if (Object.keys(mcpServers).length) {
    await conn
      .getDb().run('UPDATE container_configs SET mcp_servers = ? WHERE agent_group_id = ?', JSON.stringify(mcpServers), GROUP.id);
  }
  updateContainerConfigScalars(GROUP.id, { timezone: 'Europe/Amsterdam' });

  const { GROUPS_DIR } = await import('../../config.js');
  groupDir = path.join(GROUPS_DIR, GROUP.folder);
  fs.mkdirSync(path.join(groupDir, 'additional_context'), { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'instructions.prepend.md'), '# Research Buddy\n\nYou research things.\n');
  fs.writeFileSync(path.join(groupDir, 'additional_context', 'sources.md'), '# Sources\n');

  const { groupSkillsOverlayDir } = await import('../../templates/create-agent.js');
  const { DATA_DIR } = await import('../../config.js');
  overlayDir = path.join(DATA_DIR, 'v2-sessions', GROUP.id);
  const skill = path.join(groupSkillsOverlayDir(GROUP.id), 'deep-read');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(skill, 'SKILL.md'),
    '---\nname: deep-read\ndescription: Read a source carefully and summarise it\n---\n\nSteps…\n',
  );
}

describe('exporting an agent as a template', () => {
  it('round-trips: what it writes, upstream can read back', async () => {
    await seedAgent();
    const { exportAgentAsTemplate } = await import('./server/template-export.js');
    const result = await exportAgentAsTemplate(GROUP, { name: 'research-buddy', description: 'Researches things' });

    expect(result.ref).toBe('mine/research-buddy');
    expect(result.included).toMatchObject({ persona: true, skills: ['deep-read'], contextFiles: ['sources.md'] });

    // The real assertion: upstream's reader accepts it.
    const { parseTemplate } = await import('../../templates/parse.js');
    const parsed = parseTemplate(path.join(libDir, 'mine', 'research-buddy'));
    expect(parsed.name).toBe('research-buddy');
    expect(parsed.instructions).toContain('You research things');
    expect(parsed.skills.map((s) => s.name)).toEqual(['deep-read']);
    // Names carry their path relative to instructions.md — the layout the
    // stamp reproduces in the agent workspace.
    expect(parsed.contextExtras.map((c) => c.name)).toContain('additional_context/sources.md');
    // The display name survives, so a stamped agent is not renamed to the slug.
    expect(parsed.agentName).toBe('Research Buddy');
  });

  it('replaces every env and header value with the placeholder', async () => {
    await seedAgent({
      hubspot: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@hubspot/mcp-server'],
        // A real-looking key: the point is that it must NOT reach the file.
        env: { PRIVATE_APP_ACCESS_TOKEN: 'sk-ant-secret-value-that-must-not-ship' }, // leak-scan-allow
        plugin: 'someplugin',
        pluginRoot: '/workspace/agent/plugins/someplugin',
      },
      docs: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer abc123' } },
    });
    const { exportAgentAsTemplate } = await import('./server/template-export.js');
    const result = await exportAgentAsTemplate(GROUP, { name: 'research-buddy' });

    const raw = fs.readFileSync(path.join(libDir, 'mine', 'research-buddy', 'mcp.json'), 'utf8');
    expect(raw).not.toContain('sk-ant-secret');
    expect(raw).not.toContain('abc123');
    const mcp = JSON.parse(raw) as { mcpServers: Record<string, Record<string, any>> };
    expect(mcp.mcpServers.hubspot.env).toEqual({ PRIVATE_APP_ACCESS_TOKEN: 'placeholder' });
    expect(mcp.mcpServers.docs.headers).toEqual({ Authorization: 'placeholder' });
    // Stamp-time state, not template content — re-derived on the next stamp.
    expect(mcp.mcpServers.hubspot.plugin).toBeUndefined();
    expect(mcp.mcpServers.hubspot.pluginRoot).toBeUndefined();
    // And the operator is TOLD, rather than left to notice.
    expect(result.omitted.join(' ')).toContain('placeholder');
  });

  it('names what a template cannot carry, packages loudest', async () => {
    await seedAgent();
    const conn = await import('../../db/connection.js');
    await conn
      .getDb().run('UPDATE container_configs SET packages_apt = ?, provider = ? WHERE agent_group_id = ?', JSON.stringify(['ripgrep']), 'codex', GROUP.id);

    const { exportAgentAsTemplate } = await import('./server/template-export.js');
    const { omitted } = await exportAgentAsTemplate(GROUP, { name: 'research-buddy' });
    const text = omitted.join('\n');
    // Packages are the sharp edge: the spec has no slot, so a stamped agent
    // silently lacks them. Saying so is the whole mitigation.
    expect(text).toContain('ripgrep');
    expect(text).toContain('will NOT have them installed');
    expect(text).toContain('provider and model');
    expect(text).toContain('Europe/Amsterdam');
    expect(text).toContain('memory and conversations');
  });

  it('rejects a name the plugin spec would not accept, before writing anything', async () => {
    await seedAgent();
    const { exportAgentAsTemplate } = await import('./server/template-export.js');
    for (const bad of ['Research Buddy', 'has_underscore', '-leading', '']) {
      expect(() => exportAgentAsTemplate(GROUP, { name: bad })).toThrow();
    }
    expect(fs.existsSync(path.join(libDir, 'mine'))).toBe(false);
  });

  it('refuses a ref that escapes the library', async () => {
    await seedAgent();
    const { exportAgentAsTemplate } = await import('./server/template-export.js');
    expect(() => exportAgentAsTemplate(GROUP, { name: 'ok-name', ref: '../../escape' })).toThrow(/escapes/);
  });
});
