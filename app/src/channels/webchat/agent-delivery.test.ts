/**
 * A delivery that fails on an attachment is retried by trunk with the same
 * content. The retry must not store (or broadcast) the text a second time,
 * nor re-store attachments that already landed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { deliveryKey, storeAgentDelivery, type DeliverySink } from './agent-delivery.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
});

function sink(failOn: Set<string>): DeliverySink & { frames: unknown[] } {
  const frames: unknown[] = [];
  return {
    frames,
    broadcast: (_roomId, payload) => frames.push(payload),
    persistOutboundFile: (_roomId, file) => {
      if (failOn.has(file.filename)) throw new Error('disk full');
      return `/files/${file.filename}`;
    },
  };
}

async function rows(roomId: string): Promise<{ content: string; message_type: string }[]> {
  return (await getDb().all(
    `SELECT content, message_type FROM webchat_messages WHERE room_id = ? ORDER BY created_at, id`,
    roomId,
  )) as { content: string; message_type: string }[];
}

describe('storeAgentDelivery', () => {
  it('a retry after an attachment failure stores the text and earlier files once', async () => {
    const content = { text: 'here you go', files: ['a.txt', 'b.txt'] };
    const files = [
      { filename: 'a.txt', data: Buffer.from('a') },
      { filename: 'b.txt', data: Buffer.from('b') },
    ];
    const d = {
      key: deliveryKey('sess-1', 'room-r', 'main', content),
      roomId: 'room-r',
      senderName: 'Agent',
      text: content.text,
      files,
      thread: 'main',
    };

    const failing = new Set(['b.txt']);
    const first = sink(failing);
    await expect(storeAgentDelivery(first, d)).rejects.toThrow('disk full');
    expect(first.frames).toHaveLength(2); // text + a.txt

    failing.clear();
    const retry = sink(failing);
    const textId = await storeAgentDelivery(retry, d);
    expect(retry.frames).toHaveLength(1); // only b.txt
    expect(textId).toBeTruthy();

    const stored = await rows('room-r');
    expect(stored.filter((r) => r.content === 'here you go')).toHaveLength(1);
    expect(stored.filter((r) => r.message_type === 'file')).toHaveLength(2);
  });

  it('a later identical reply after a clean delivery is stored again', async () => {
    const d = {
      key: deliveryKey('sess-1', 'room-s', 'main', { text: 'ok' }),
      roomId: 'room-s',
      senderName: 'Agent',
      text: 'ok',
      files: undefined,
      thread: 'main',
    };
    await storeAgentDelivery(sink(new Set()), d);
    await storeAgentDelivery(sink(new Set()), d);
    expect((await rows('room-s')).filter((r) => r.content === 'ok')).toHaveLength(2);
  });
});
