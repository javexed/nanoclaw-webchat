/**
 * The model that answered a reply rides from the runner's content field onto
 * the stored reply, its live broadcast and history — and nowhere else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { storeAgentDelivery } from './agent-delivery.js';
import { getWebchatMessages, storeWebchatMessage } from './db.js';
import { servedModelOf } from './served-model.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
});

describe('servedModelOf', () => {
  it('reads the runner field', () => {
    expect(servedModelOf({ text: 'hi', servedModel: 'qwen3.5:4b' })).toBe('qwen3.5:4b');
    expect(servedModelOf({ text: 'hi', servedModel: '  gemma4:latest ' })).toBe('gemma4:latest');
  });

  it('gives null when it is missing, blank, oversized or carries control characters', () => {
    expect(servedModelOf({ text: 'hi' })).toBeNull();
    expect(servedModelOf('plain text')).toBeNull();
    expect(servedModelOf({ servedModel: '   ' })).toBeNull();
    expect(servedModelOf({ servedModel: 42 })).toBeNull();
    expect(servedModelOf({ servedModel: 'x'.repeat(129) })).toBeNull();
    expect(servedModelOf({ servedModel: 'a\nb' })).toBeNull();
  });
});

describe('a stored reply', () => {
  it('carries its served model live and in history; other messages carry none', async () => {
    const broadcasts: Record<string, unknown>[] = [];
    await storeWebchatMessage('room-1', 'Alice', 'user', 'hello', 'main', 'webchat:alice');
    const id = await storeAgentDelivery(
      { broadcast: (_room, p) => void broadcasts.push(p as Record<string, unknown>), persistOutboundFile: () => '' },
      {
        key: 'k1',
        roomId: 'room-1',
        senderName: 'Agent',
        text: 'hi there',
        files: undefined,
        thread: 'main',
        servedModel: servedModelOf({ text: 'hi there', servedModel: 'qwen3.5:4b' }),
      },
    );
    expect(broadcasts[0]).toMatchObject({ id, served_model: 'qwen3.5:4b' });
    const rows = await getWebchatMessages('room-1');
    expect(rows.find((m) => m.id === id)).toMatchObject({ served_model: 'qwen3.5:4b' });
    expect(rows.find((m) => m.id !== id)).not.toHaveProperty('served_model');
  });

  it('carries none when the runner reported none', async () => {
    const id = await storeAgentDelivery(
      { broadcast: () => {}, persistOutboundFile: () => '' },
      { key: 'k2', roomId: 'room-1', senderName: 'Agent', text: 'hi', files: undefined, thread: 'main' },
    );
    expect((await getWebchatMessages('room-1')).find((m) => m.id === id)).not.toHaveProperty('served_model');
  });
});
