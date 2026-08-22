/**
 * Tests for the per-thread engaged-agents set (webchat_thread_engaged).
 * The 'main' thread (regular chat) can never engage — it stays mention-only.
 * See docs/webchat/thread-engaged-agents.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { engageAgent, disengageAgent, getEngagedAgents, isAgentEngaged, deleteWebchatThread } from './db.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
});

describe('thread engaged agents', () => {
  it('engage / getEngaged / disengage round-trips', async () => {
    await engageAgent('room-1', 't1', 'ag-a');
    await engageAgent('room-1', 't1', 'ag-b');
    expect((await getEngagedAgents('room-1', 't1')).sort()).toEqual(['ag-a', 'ag-b']);
    expect(await isAgentEngaged('room-1', 't1', 'ag-a')).toBe(true);
    await disengageAgent('room-1', 't1', 'ag-a');
    expect(await getEngagedAgents('room-1', 't1')).toEqual(['ag-b']);
    expect(await isAgentEngaged('room-1', 't1', 'ag-a')).toBe(false);
  });

  it('engage is idempotent', async () => {
    await engageAgent('room-1', 't1', 'ag-a', 100);
    await engageAgent('room-1', 't1', 'ag-a', 200);
    expect(await getEngagedAgents('room-1', 't1')).toEqual(['ag-a']);
  });

  it('never engages the main thread (regular chat stays mention-only)', async () => {
    await engageAgent('room-1', 'main', 'ag-a');
    expect(await getEngagedAgents('room-1', 'main')).toEqual([]);
    expect(await isAgentEngaged('room-1', 'main', 'ag-a')).toBe(false);
  });

  it('engaged set is scoped per thread', async () => {
    await engageAgent('room-1', 't1', 'ag-a');
    await engageAgent('room-1', 't2', 'ag-b');
    expect(await getEngagedAgents('room-1', 't1')).toEqual(['ag-a']);
    expect(await getEngagedAgents('room-1', 't2')).toEqual(['ag-b']);
  });

  it('returns agents in engage order (engaged_at)', async () => {
    await engageAgent('room-1', 't1', 'ag-b', 200);
    await engageAgent('room-1', 't1', 'ag-a', 100);
    expect(await getEngagedAgents('room-1', 't1')).toEqual(['ag-a', 'ag-b']);
  });

  it('deleteWebchatThread clears the thread engaged set', async () => {
    await engageAgent('room-1', 't1', 'ag-a');
    await deleteWebchatThread('room-1', 't1');
    expect(await getEngagedAgents('room-1', 't1')).toEqual([]);
  });
});
