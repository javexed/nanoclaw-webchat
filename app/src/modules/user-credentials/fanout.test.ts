/**
 * Phase 4: shared-context fan-out. On a per-member wake, the member's session
 * receives the full room transcript — current message trigger=1, the rest
 * trigger=0 — idempotently. The INVARIANT that matters: exactly one trigger=1
 * (the current message); everything else is context.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import { openInboundDb, initSessionFolder } from '../../session-manager.js';
import { storeWebchatMessage, storeWebchatFileMessage } from '../../channels/webchat/db.js';
import { uploadsDir } from '../../channels/webchat/files.js';
import { writeMemberTranscript } from './fanout.js';
import type { Session } from '../../types.js';

const SESSION: Session = {
  id: 'sess-alice',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: 'webchat:alice',
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: 't',
} as Session;

async function seedSession() {
  await getDb().run(`INSERT OR IGNORE INTO agent_groups (id,name,folder,agent_provider,created_at) VALUES ('ag-1','ag-1','ag-1',NULL,'t')`);
  await getDb().run(`INSERT INTO messaging_groups (id,channel_type,instance,platform_id,created_at) VALUES ('mg-1','webchat','webchat','room-1','t')`);
  await createSession(SESSION);
  initSessionFolder('ag-1', 'sess-alice'); // scaffolds the session dir + inbound.db
}

function inboundRows() {
  const db = openInboundDb('ag-1', 'sess-alice');
  try {
    return db.prepare('SELECT id, trigger, content FROM messages_in ORDER BY seq').all() as {
      id: string;
      trigger: number;
      content: string;
    }[];
  } finally {
    db.close();
  }
}

const addr = { platformId: 'room-1', channelType: 'webchat', threadId: null };

const testSessionTree = path.join(DATA_DIR, 'v2-sessions', 'ag-1');

beforeEach(async () => {
  fs.rmSync(testSessionTree, { recursive: true, force: true }); // fresh session dir each test
  await initTestDb();
  await runMigrations(getDb());
  await seedSession();
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(testSessionTree, { recursive: true, force: true });
});

describe('writeMemberTranscript', () => {
  it('writes the transcript with exactly one trigger=1 (the current message)', async () => {
    const a = await storeWebchatMessage('room-1', 'Alice', 'user', 'hi from alice');
    const b = await storeWebchatMessage('room-1', 'Bob', 'user', 'hi from bob');
    const cur = await storeWebchatMessage('room-1', 'Alice', 'user', 'what did bob say?');
    const handled = await writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: cur.id,
      deliveryAddr: addr,
    });
    expect(handled).toBe(true);
    const rows = inboundRows();
    expect(rows).toHaveLength(3);
    const triggers = rows.filter((r) => r.trigger === 1);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].id).toBe(`user-creds-sess-alice-${cur.id}`);
    // Bob's message is present as context (shared transcript).
    expect(rows.some((r) => r.content.includes('hi from bob') && r.trigger === 0)).toBe(true);
    void [a, b];
  });

  // REGRESSION: a file row's `content` column is only the caption; the bytes
  // live in file_meta. Serialising content alone handed the agent {"text":""}
  // for every upload — 21 of Mark's files in a row arrived blank and the
  // attachment never reached the container at all.
  it("delivers the current turn's file as a staged attachment, not a blank message", async () => {
    const meta = { url: '/api/files/room-1/abc123.pdf', filename: 'Drawing.pdf', mime: 'application/pdf', size: 5 };
    fs.mkdirSync(uploadsDir('room-1'), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir('room-1'), 'abc123.pdf'), 'HELLO');
    const cur = await storeWebchatFileMessage('room-1', 'Alice', 'user', '', meta);

    await writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: cur.id,
      deliveryAddr: addr,
    });

    const row = inboundRows().find((r) => r.trigger === 1)!;
    const parsed = JSON.parse(row.content) as { text: string; attachments?: { localPath?: string }[] };
    // The bug: no attachments key and an empty text.
    expect(parsed.attachments, 'file must reach the agent as an attachment').toBeTruthy();
    // syncSessionContext must STAGE it — a path the container can actually read.
    const staged = parsed.attachments![0].localPath;
    expect(staged, 'attachment must be staged into the session inbox').toBeTruthy();
    const onDisk = path.join(testSessionTree, 'sess-alice', 'inbox', `user-creds-sess-alice-${cur.id}`, 'Drawing.pdf');
    expect(fs.existsSync(onDisk), 'staged file must exist on disk').toBe(true);
    expect(fs.readFileSync(onDisk, 'utf8')).toBe('HELLO');
  });

  it('describes historical files rather than inlining them, and never emits an empty message', async () => {
    const meta = { url: '/api/files/room-1/old1.pdf', filename: 'Old.pdf', mime: 'application/pdf', size: 3 };
    fs.mkdirSync(uploadsDir('room-1'), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir('room-1'), 'old1.pdf'), 'OLD');
    const old = await storeWebchatFileMessage('room-1', 'Alice', 'user', '', meta);
    const cur = await storeWebchatMessage('room-1', 'Alice', 'user', 'what was in that PDF?');

    await writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: cur.id,
      deliveryAddr: addr,
    });

    const ctx = inboundRows().find((r) => r.id === `user-creds-sess-alice-${old.id}`)!;
    const parsed = JSON.parse(ctx.content) as { text: string; attachments?: unknown[] };
    expect(parsed.text).toContain('Old.pdf');
    expect(parsed.text.trim()).not.toBe('');
    expect(parsed.attachments, 'past uploads are described, not re-encoded every turn').toBeUndefined();
  });

  it('is idempotent — re-running adds only genuinely new messages', async () => {
    const m1 = await storeWebchatMessage('room-1', 'Alice', 'user', 'one');
    await writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: m1.id,
      deliveryAddr: addr,
    });
    expect(inboundRows()).toHaveLength(1);
    // Same turn re-run → no dup.
    await writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: m1.id,
      deliveryAddr: addr,
    });
    expect(inboundRows()).toHaveLength(1);
    // A new message arrives → only it is added (idempotent: m1 not rewritten,
    // keeps its original trigger; the new current message is trigger=1).
    const m2 = await storeWebchatMessage('room-1', 'Alice', 'user', 'two');
    await writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: m2.id,
      deliveryAddr: addr,
    });
    const rows = inboundRows();
    expect(rows).toHaveLength(2); // no duplication
    expect(rows.find((r) => r.id === `user-creds-sess-alice-${m2.id}`)!.trigger).toBe(1); // current wakes
  });

  it('falls back (returns false) when the current message is not in the transcript', async () => {
    await storeWebchatMessage('room-1', 'Alice', 'user', 'old');
    const handled = await writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: 'not-in-room',
      deliveryAddr: addr,
    });
    expect(handled).toBe(false);
  });

  it('skips a2a / approval side-channel rows', async () => {
    const cur = await storeWebchatMessage('room-1', 'Alice', 'user', 'hello');
    // an a2a side-channel row in the same room
    await getDb().run(`INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, created_at)
         VALUES ('a2a-1','room-1','x','a2a','{"to":"y","text":"z"}','a2a', ${Date.now() - 1000})`);
    await writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: cur.id,
      deliveryAddr: addr,
    });
    const rows = inboundRows();
    expect(rows.some((r) => r.id === 'user-creds-sess-alice-a2a-1')).toBe(false);
  });
});
