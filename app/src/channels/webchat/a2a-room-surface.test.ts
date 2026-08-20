/**
 * Tests for surfacing agent↔agent (a2a) messages into a shared webchat room.
 *
 * When two agents are both wired to the same webchat room, an a2a message
 * between them is copied into that room as a read-only side-channel entry
 * (message_type/sender_type='a2a', content={to,text}) so humans can watch the
 * exchange. Surfacing is skipped when the agents share no room, for
 * self-messages, and for empty text.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { surfaceA2aMessage } from './state.js';
import { getSharedWebchatRooms } from './db.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));

const now = () => new Date().toISOString();

function wire(roomId: string, agentId: string) {
  createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: roomId,
    agent_group_id: agentId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

async function a2aRows(roomId: string) {
  return (await getDb().all(`SELECT * FROM webchat_messages WHERE room_id = ? AND message_type = 'a2a'`, roomId)) as {
    sender: string;
    sender_type: string;
    content: string;
  }[];
}

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());

  await createAgentGroup({
    id: 'ag-gamma',
    name: 'Gamma Agent',
    folder: 'green',
    agent_provider: null,
    created_at: now(),
  });
  await createAgentGroup({
    id: 'ag-delta',
    name: 'Delta Agent',
    folder: 'rev',
    agent_provider: null,
    created_at: now(),
  });
  await createAgentGroup({
    id: 'ag-lonely',
    name: 'Lonely',
    folder: 'lonely',
    agent_provider: null,
    created_at: now(),
  });

  // Shared room: Gamma Agent + Delta Agent both wired.
  await createMessagingGroup({
    id: 'mg-shared',
    channel_type: 'webchat',
    platform_id: 'plant-vision',
    name: 'Plant Vision',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  wire('mg-shared', 'ag-gamma');
  wire('mg-shared', 'ag-delta');

  // A room only Gamma Agent is in (Lonely is not co-resident anywhere with green).
  await createMessagingGroup({
    id: 'mg-solo',
    channel_type: 'webchat',
    platform_id: 'solo',
    name: 'Solo',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  wire('mg-solo', 'ag-gamma');
});

afterEach(async () => {
  await closeDb();
});

describe('getSharedWebchatRooms', () => {
  it('returns rooms both agents are wired to', async () => {
    const rooms = await getSharedWebchatRooms('ag-gamma', 'ag-delta');
    expect(rooms.map((r) => r.id)).toEqual(['plant-vision']);
  });

  it('returns nothing when the agents share no room', async () => {
    expect(await getSharedWebchatRooms('ag-gamma', 'ag-lonely')).toEqual([]);
  });
});

describe('surfaceA2aMessage', () => {
  it('writes an a2a-typed copy into the shared room with from/to attribution', async () => {
    await surfaceA2aMessage('ag-gamma', 'ag-delta', JSON.stringify({ text: 'can you check your status?' }));

    const rows = await a2aRows('plant-vision');
    expect(rows).toHaveLength(1);
    expect(rows[0].sender).toBe('Gamma Agent');
    expect(rows[0].sender_type).toBe('a2a');
    const parsed = JSON.parse(rows[0].content);
    expect(parsed).toEqual({ to: 'Delta Agent', text: 'can you check your status?' });
  });

  it('does not surface when the agents share no room', async () => {
    await surfaceA2aMessage('ag-gamma', 'ag-lonely', JSON.stringify({ text: 'hi' }));
    expect(await a2aRows('solo')).toHaveLength(0);
  });

  it('skips self-messages (from === to)', async () => {
    await surfaceA2aMessage('ag-gamma', 'ag-gamma', JSON.stringify({ text: 'note to self' }));
    expect(await a2aRows('plant-vision')).toHaveLength(0);
    expect(await a2aRows('solo')).toHaveLength(0);
  });

  it('skips empty text', async () => {
    await surfaceA2aMessage('ag-gamma', 'ag-delta', JSON.stringify({ text: '   ' }));
    expect(await a2aRows('plant-vision')).toHaveLength(0);
  });
});
