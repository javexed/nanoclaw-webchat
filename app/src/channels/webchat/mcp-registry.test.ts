/**
 * MCP registry tests — CRUD, the many-to-many assignment join, and the
 * container-config sync invariant: syncAgentMcpConfig only ever touches the
 * one key it owns in container_configs.mcp_servers (an ncl-added server with
 * a different name must survive attach/detach cycles).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import type { McpServerConfig } from '../../container-config.js';
import {
  assignMcpServerToAgent,
  createWebchatMcpServer,
  deleteWebchatMcpServer,
  getAgentsAssignedToMcpServer,
  getMcpServersForAgent,
  getWebchatMcpServer,
  getWebchatMcpServerByName,
  listWebchatMcpServers,
  mcpServerToConfig,
  syncAgentMcpConfig,
  unassignMcpServerFromAgent,
  updateWebchatMcpServer,
} from './mcp-registry.js';

const GID = 'ag-mcp-test';

async function seedAgentWithConfig(mcpServers: Record<string, McpServerConfig> = {}): Promise<void> {
  await createAgentGroup({ id: GID, name: 'mcp', folder: 'mcp', agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(`INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', ?, '[]', '[]', '[]', 'group', ?)`, GID, JSON.stringify(mcpServers), new Date().toISOString());
}

async function configServers(): Promise<Record<string, McpServerConfig>> {
  const row = (await getDb().get(`SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?`, GID)) as {
    mcp_servers: string;
  };
  return JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
}

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
});

describe('mcp-registry CRUD', () => {
  it('creates, lists, fetches by id and name', async () => {
    const s = await createWebchatMcpServer({ name: 'windows', transport: 'sse', url: 'http://box:8000/sse' });
    expect((await listWebchatMcpServers()).map((r) => r.name)).toEqual(['windows']);
    expect((await getWebchatMcpServer(s.id))?.url).toBe('http://box:8000/sse');
    expect((await getWebchatMcpServerByName('windows'))?.id).toBe(s.id);
  });

  it('updates fields and preserves the rest', async () => {
    const s = await createWebchatMcpServer({ name: 'w', transport: 'sse', url: 'http://a' });
    await updateWebchatMcpServer(s.id, { url: 'http://b' });
    const after = await getWebchatMcpServer(s.id);
    expect(after?.url).toBe('http://b');
    expect(after?.name).toBe('w');
    expect(after?.transport).toBe('sse');
  });

  it('delete cascades the assignment join', async () => {
    await seedAgentWithConfig();
    const s = await createWebchatMcpServer({ name: 'x', transport: 'http', url: 'http://x' });
    await assignMcpServerToAgent(GID, s.id);
    expect(await getAgentsAssignedToMcpServer(s.id)).toEqual([GID]);
    await deleteWebchatMcpServer(s.id);
    expect(await getWebchatMcpServer(s.id)).toBeUndefined();
    expect(await getAgentsAssignedToMcpServer(s.id)).toEqual([]);
  });
});

describe('many-to-many assignment', () => {
  it('one server on many agents; one agent with many servers; idempotent assign', async () => {
    await seedAgentWithConfig();
    await createAgentGroup({
      id: 'ag-2',
      name: 'two',
      folder: 'two',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const a = await createWebchatMcpServer({ name: 'a', transport: 'sse', url: 'http://a' });
    const b = await createWebchatMcpServer({ name: 'b', transport: 'stdio', command: 'mcp-b' });
    await assignMcpServerToAgent(GID, a.id);
    await assignMcpServerToAgent(GID, a.id); // idempotent — ON CONFLICT DO NOTHING
    await assignMcpServerToAgent(GID, b.id);
    await assignMcpServerToAgent('ag-2', a.id);
    expect((await getMcpServersForAgent(GID)).map((s) => s.name)).toEqual(['a', 'b']);
    expect((await getAgentsAssignedToMcpServer(a.id)).sort()).toEqual(['ag-2', GID].sort());
    await unassignMcpServerFromAgent(GID, a.id);
    expect((await getMcpServersForAgent(GID)).map((s) => s.name)).toEqual(['b']);
    expect(await getAgentsAssignedToMcpServer(a.id)).toEqual(['ag-2']);
  });
});

describe('mcpServerToConfig', () => {
  it('stdio row → command/args/env config', async () => {
    const s = await createWebchatMcpServer({ name: 's', transport: 'stdio', command: 'c', args: ['--x'], env: { A: '1' } });
    expect(mcpServerToConfig(await s)).toEqual({ command: 'c', args: ['--x'], env: { A: '1' } });
  });

  it('remote row → type/url/headers config, instructions carried', async () => {
    const s = await createWebchatMcpServer({
      name: 'r',
      transport: 'http',
      url: 'https://h/mcp',
      headers: { Authorization: 'Bearer t' },
      instructions: 'use sparingly',
    });
    expect(mcpServerToConfig(await s)).toEqual({
      type: 'http',
      url: 'https://h/mcp',
      headers: { Authorization: 'Bearer t' },
      instructions: 'use sparingly',
    });
  });
});

describe('syncAgentMcpConfig — incremental single-key writes', () => {
  it('adds and removes only its own key, preserving ncl-added servers', async () => {
    // Simulate a server added out-of-band via `ncl groups config add-mcp-server`.
    await seedAgentWithConfig({ nclthing: { command: 'ncl-added', args: [], env: {} } });
    const s = await createWebchatMcpServer({ name: 'windows', transport: 'sse', url: 'http://box:8000/sse' });

    expect(await syncAgentMcpConfig(GID, await s, true)).toBe(true);
    let servers = await configServers();
    expect(Object.keys(servers).sort()).toEqual(['nclthing', 'windows']);
    expect(servers.windows).toEqual({ type: 'sse', url: 'http://box:8000/sse', headers: {} });

    expect(await syncAgentMcpConfig(GID, await s, false)).toBe(true);
    servers = await configServers();
    expect(Object.keys(servers)).toEqual(['nclthing']); // the ncl-added key survived
  });

  it('returns false when the group has no container config row', async () => {
    const s = await createWebchatMcpServer({ name: 'w', transport: 'sse', url: 'http://x' });
    expect(await syncAgentMcpConfig('no-such-group', await s, true)).toBe(false);
  });
});
