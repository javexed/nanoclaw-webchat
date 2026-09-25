/**
 * Web Push fan-out reaches only people who can open the room, never the
 * sender. The payload carries the room name and the start of the message, and
 * shows on a lock screen, so a subscriber without room access must not get it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: string[] = [];
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }) => {
      sent.push(sub.endpoint);
      return { statusCode: 201 };
    },
  },
}));
vi.mock('./access.js', () => ({
  canAccessRoom: async (userId: string) => userId !== 'webchat:outsider',
}));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { initWebPush, sendPushForMessage } from './push.js';

async function subscribe(identity: string): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_push_subscriptions (endpoint, identity, keys_json, created_at) VALUES (?, ?, ?, ?)`,
    `https://fcm.googleapis.com/fcm/send/${identity}`,
    identity,
    JSON.stringify({ p256dh: 'k', auth: 'a' }),
    Date.now(),
  );
}

beforeEach(async () => {
  sent.length = 0;
  await initTestDb();
  await runMigrations(getDb());
  vi.stubEnv('WEBCHAT_VAPID_PUBLIC_KEY', 'pub');
  vi.stubEnv('WEBCHAT_VAPID_PRIVATE_KEY', 'priv');
  initWebPush();
  for (const id of ['webchat:sender', 'webchat:member', 'webchat:outsider']) await subscribe(id);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

describe('sendPushForMessage', () => {
  it('pushes to members of the room, not to outsiders or the sender', async () => {
    await sendPushForMessage({
      roomId: 'room-1',
      roomName: 'Private',
      sender: 'Sender Display Name',
      senderUserId: 'webchat:sender',
      content: 'secret plans',
    });
    expect(sent.map((e) => e.split('/').pop())).toEqual(['webchat:member']);
  });

  it('without a sender id (an agent reply) pushes to every member', async () => {
    await sendPushForMessage({ roomId: 'room-1', roomName: 'Private', sender: 'Agent', content: 'done' });
    expect(sent.map((e) => e.split('/').pop()).sort()).toEqual(['webchat:member', 'webchat:sender']);
  });
});
