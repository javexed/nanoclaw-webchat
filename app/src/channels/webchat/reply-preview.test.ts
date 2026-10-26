/**
 * The live reply preview frame names the thread the reply is being written
 * in, so a client never shows one thread's reply in another.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { ensureThread } from './db.js';
import { replyPreviewFrame } from './reply-preview.js';

const base = { channelType: 'webchat', platformId: 'room-1', agentName: 'Agent', text: 'Half a reply' };

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
});

describe('replyPreviewFrame', () => {
  it("names the session's thread", async () => {
    await ensureThread('room-1', 't1', 'Topic', 'topic');
    expect(await replyPreviewFrame({ ...base, threadId: null })).toMatchObject({
      type: 'status',
      event: 'preview',
      room_id: 'room-1',
      thread_id: 'main',
      text: 'Half a reply',
    });
    expect(await replyPreviewFrame({ ...base, threadId: 't1' })).toMatchObject({ thread_id: 't1' });
    expect(await replyPreviewFrame({ ...base, threadId: 'webchat:alice::t1' })).toMatchObject({ thread_id: 't1' });
  });

  it('keeps a clear a clear, and redacts the text', async () => {
    expect(await replyPreviewFrame({ ...base, threadId: null, text: null })).toMatchObject({ text: null });
    const secret = `sk-ant-api03-${'A'.repeat(95)}`; // leak-scan-allow
    const frame = await replyPreviewFrame({ ...base, threadId: null, text: `key ${secret}` });
    expect(frame.text).not.toContain(secret);
  });
});
