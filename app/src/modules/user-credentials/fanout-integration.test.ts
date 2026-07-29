/**
 * Integration: a file upload must survive the ROUTER -> per-member session path.
 *
 * The unit tests in fanout.test.ts call writeMemberTranscript directly, so they
 * all still pass if the router stops invoking the writer, if the session-key
 * override stops firing, or if the writer is handed the wrong currentMessageId.
 * That seam is exactly where the production bug lived: both halves looked
 * correct on their own and the file died in the interaction — 21 uploads
 * reached the agent as `{"text":""}` with no attachment.
 *
 * So this drives routeInbound end to end and asserts the bytes land on disk in
 * the per-member session, which is the thing a human actually noticed.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-fanout-int' };
});

import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { findSession } from '../../db/sessions.js';
import { openInboundDb, sessionDir } from '../../session-manager.js';
import {
  storeWebchatFileMessage,
  storeWebchatMessage,
  createWebchatThread,
  setRoomModeOverride,
  setCredentialsConfig,
} from '../../channels/webchat/db.js';
import { uploadsDir } from '../../channels/webchat/files.js';
import { registerChannelAdapter, initChannelAdapters } from '../../channels/channel-registry.js';
import { upsertUserCredential } from './db.js';
import { memberSessionKey } from './identity.js';
import '../permissions/index.js'; // registers the sender resolver (router needs a userId)
import './index.js'; // registers the session-key resolver + inbound writer

const TEST_DIR = '/tmp/nanoclaw-test-fanout-int';
const ROOM = 'room-int';
const AG = 'ag-int';
const USER = 'webchat:tailscale:mark@example.com';

const now = () => new Date().toISOString();

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'Int', folder: 'int', agent_provider: null, created_at: now() });
  db.prepare(
    `INSERT INTO messaging_groups (id,channel_type,instance,platform_id,is_group,unknown_sender_policy,created_at)
     VALUES ('mg-int','webchat','webchat',?,1,'public',?)`,
  ).run(ROOM, now());
  db.prepare(
    `INSERT INTO messaging_group_agents
       (id,messaging_group_id,agent_group_id,engage_mode,engage_pattern,sender_scope,ignored_message_policy,session_mode,priority,created_at)
     VALUES ('mga-int','mg-int',?, 'pattern','.*','all','drop','shared',0,?)`,
  ).run(AG, now());

  // Per-member routing only engages for a member who has CONNECTED a credential.
  setCredentialsConfig({ allowAnthropicKey: true });
  setRoomModeOverride(ROOM, 'required');
  upsertUserCredential(USER, 'claude', 'sec-1', 'api_key');
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

/**
 * THE REGRESSION THIS SUITE EXISTED TO CATCH AND DIDN'T.
 *
 * Mark's symptom was not "the message vanished" — it was a message posted in
 * the ROOM being answered in a THREAD. Keyed by user alone, every thread in a
 * room shared one per-member session, so one queue held 89 main-thread rows
 * and 60 topic-thread rows and the agent replied on whichever it picked.
 *
 * Every earlier test here stops at "the message arrived", which PASSES on a
 * mixed queue. The load-bearing assertion is the negative one: each session's
 * queue must contain the other thread's messages NOT AT ALL.
 */
describe('router -> per-member sessions: threads stay separate', () => {
  async function routeText(text: string, threadId: string | null) {
    const { routeInbound } = await import('../../router.js');
    const stored = storeWebchatMessage(ROOM, USER, 'user', text, threadId ?? 'main');
    await routeInbound({
      channelType: 'webchat',
      platformId: ROOM,
      threadId,
      message: {
        id: stored.id,
        kind: 'chat',
        timestamp: now(),
        content: JSON.stringify({ text, sender: USER, senderId: USER, senderName: USER }),
      },
    });
    return stored;
  }

  function queueTexts(sessionId: string): string[] {
    const db = openInboundDb(AG, sessionId);
    try {
      return (db.prepare('SELECT content FROM messages_in').all() as { content: string }[]).map(
        (r) => (JSON.parse(r.content) as { text: string }).text,
      );
    } finally {
      db.close();
    }
  }

  it('routes each thread to its own session and never mixes their queues', async () => {
    // Thread routing is capability-gated: the router only keeps a thread id
    // when the ADAPTER declares supportsThreads (webchat does). Without a
    // registered adapter every turn collapses to main and this test would pass
    // for the wrong reason.
    registerChannelAdapter('webchat', {
      factory: () => ({
        name: 'webchat',
        channelType: 'webchat',
        supportsThreads: true,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({}) as never);

    const topic = createWebchatThread(ROOM, 'Project Management');

    await routeText('room question', null);
    await routeText('thread question', topic.thread_id);

    const mainSession = findSession('mg-int', memberSessionKey(USER, null));
    const topicSession = findSession('mg-int', memberSessionKey(USER, topic.thread_id));

    expect(mainSession, 'the room turn needs its own per-member session').toBeDefined();
    expect(topicSession, 'the thread turn needs its own per-member session').toBeDefined();
    expect(topicSession!.id).not.toBe(mainSession!.id);

    const mainQ = queueTexts(mainSession!.id);
    const topicQ = queueTexts(topicSession!.id);

    // Each got its own turn...
    expect(mainQ).toContain('room question');
    expect(topicQ).toContain('thread question');
    // ...and, the part that actually failed in production, NOT the other's.
    expect(mainQ, 'a room session must not carry thread messages').not.toContain('thread question');
    expect(topicQ, 'a thread session must not carry room messages').not.toContain('room question');
  });
});

describe('router -> per-member session: file delivery', () => {
  it('lands an uploaded file in the member session inbox, not a blank message', async () => {
    const { routeInbound } = await import('../../router.js');

    // The upload as webchat produces it: a stored file row (caption empty —
    // dragging a PDF in with no text is the common case) plus an inbound event
    // carrying the bytes.
    const meta = { url: '/api/files/room-int/u1.pdf', filename: 'Drawing.pdf', mime: 'application/pdf', size: 9 };
    // The bytes must exist where webchat staged them: the fan-out claims this
    // write and rebuilds content from the stored row + file_meta, discarding
    // the attachment the router was handed. That indirection is precisely what
    // made the original bug invisible.
    fs.mkdirSync(uploadsDir(ROOM), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir(ROOM), 'u1.pdf'), 'PDF-BYTES');
    const stored = storeWebchatFileMessage(ROOM, USER, 'user', '', meta);

    await routeInbound({
      channelType: 'webchat',
      platformId: ROOM,
      threadId: null,
      message: {
        id: stored.id,
        kind: 'chat',
        timestamp: now(),
        content: JSON.stringify({
          text: '',
          sender: USER,
          senderId: USER,
          senderName: USER,
          attachments: [
            {
              name: 'Drawing.pdf',
              type: 'file',
              data: Buffer.from('PDF-BYTES').toString('base64'),
              size: 9,
              mime: 'application/pdf',
            },
          ],
        }),
      },
    });

    // Per-member sessions are keyed by (user, thread) — main here.
    const session = findSession('mg-int', memberSessionKey(USER, null));
    expect(session, 'a per-member session should exist for a connected member').toBeDefined();

    const db = openInboundDb(AG, session!.id);
    const rows = db.prepare('SELECT content, trigger FROM messages_in').all() as {
      content: string;
      trigger: number;
    }[];
    db.close();

    const wake = rows.find((r) => r.trigger === 1);
    expect(wake, 'the turn must wake the member session').toBeTruthy();

    const parsed = JSON.parse(wake!.content) as { text: string; attachments?: { localPath?: string }[] };
    // The bug's signature: a wake row with empty text and no attachment.
    expect(parsed.attachments, 'the upload must reach the agent as an attachment').toBeTruthy();

    const staged = path.join(sessionDir(AG, session!.id), parsed.attachments![0].localPath!);
    expect(fs.existsSync(staged), 'the file must be staged where the container can read it').toBe(true);
    expect(fs.readFileSync(staged, 'utf8')).toBe('PDF-BYTES');
  });
});

