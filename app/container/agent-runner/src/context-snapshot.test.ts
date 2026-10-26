/** The runner records the addendum it built, so the host can show it without rebuilding it. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CONTEXT_SNAPSHOT_KEY, recordContextSnapshot, type ContextSnapshot } from './context-snapshot.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { MEMORY_FILE_BUDGET_CHARS } from './memory/context.js';
import './send-file-hint.js'; // registers a prompt-section contributor

let memoryBase: string;

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('room', 'Room', 'channel', 'webchat', 'room-1', NULL)`,
    )
    .run();
  memoryBase = fs.mkdtempSync(path.join(os.tmpdir(), 'context-snapshot-'));
  fs.mkdirSync(path.join(memoryBase, 'memory', 'system'), { recursive: true });
  fs.writeFileSync(path.join(memoryBase, 'memory', 'system', 'definition.md'), 'Definition.');
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(memoryBase, { recursive: true, force: true });
});

function recorded(): ContextSnapshot {
  const state = getAgentMailbox().operations.getState(CONTEXT_SNAPSHOT_KEY);
  expect(state).toBeDefined();
  return JSON.parse(state!.value) as ContextSnapshot;
}

describe('recordContextSnapshot', () => {
  it('stores the addendum verbatim, with each contributor section it contains', () => {
    fs.writeFileSync(path.join(memoryBase, 'memory', 'index.md'), 'Index.');
    const addendum = buildSystemPromptAddendum('Fixture', { kind: 'chat' }, { mcpTools: true });

    recordContextSnapshot('claude', addendum, { mcpTools: true }, memoryBase);

    const snapshot = recorded();
    expect(snapshot.addendum).toBe(addendum);
    expect(snapshot.provider).toBe('claude');
    const fileHint = snapshot.contributorSections.find((s) => s.startsWith('### Sending files'));
    expect(fileHint).toBeDefined();
    expect(addendum.includes(fileHint!)).toBe(true);
    expect(snapshot.memory).toContain('Index.');
    expect(snapshot.memoryTruncated).toBe(false);
  });

  it('omits contributor sections the addendum did not carry', () => {
    // Built without MCP tools: the send-file hint stays silent.
    const addendum = buildSystemPromptAddendum('Fixture', { kind: 'chat' }, { mcpTools: false });

    recordContextSnapshot('pi', addendum, { mcpTools: false }, memoryBase);

    expect(recorded().contributorSections).toEqual([]);
  });

  it('flags a memory file cut at its budget', () => {
    fs.writeFileSync(path.join(memoryBase, 'memory', 'index.md'), 'x'.repeat(MEMORY_FILE_BUDGET_CHARS + 10));

    recordContextSnapshot('claude', '# You are Fixture', { mcpTools: true }, memoryBase);

    expect(recorded().memoryTruncated).toBe(true);
  });
});
