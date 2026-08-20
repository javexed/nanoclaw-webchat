/**
 * An agent must be able to reach a PERSON. The mention machinery already
 * worked; the agent just never learned the handles, so it escalated to another
 * agent and nobody was told. These pin the host half: the room's humans reach
 * the session DB, scoped to the room and to actual people.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-room-humans' };
});

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import { storeWebchatMessage, setWebchatUserHandle } from './db.js';
import { getRoomHumans, writeRoomHumans } from './room-humans.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-room-humans';
const AG = 'ag-rh';
const SESS = 'sess-rh';
const now = () => new Date().toISOString();

async function seedUser(id: string, display: string, handle: string) {
  await getDb().run(`INSERT OR IGNORE INTO users (id,kind,display_name,created_at) VALUES (?,?,?,?)`, id, 'webchat', display, now());
  await setWebchatUserHandle(id, handle);
}

function readRoomHumans(): { handle: string; display_name: string | null }[] {
  const db = new Database(inboundDbPath(AG, SESS));
  try {
    return db.prepare('SELECT handle, display_name FROM room_humans ORDER BY handle').all() as {
      handle: string;
      display_name: string | null;
    }[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'RH', folder: 'rh', agent_provider: null, created_at: now() });
  await db.run(`INSERT INTO messaging_groups (id,channel_type,instance,platform_id,is_group,created_at)
     VALUES ('mg-rh','webchat','webchat','room-rh',1,?)`, now());
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: 'mg-rh',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  } as Session);
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('room humans -> session DB', () => {
  it('publishes the handles of people who have spoken in the room', async () => {
    await seedUser('webchat:mark', 'Mark', 'mark');
    await storeWebchatMessage('room-rh', 'webchat:mark', 'user', 'hello');

    await writeRoomHumans(AG, SESS);

    expect(readRoomHumans()).toEqual([{ handle: 'mark', display_name: 'Mark' }]);
  });

  it('scopes to the room — someone who only speaks elsewhere is not listed', async () => {
    // Naming every registered handle to every agent would leak people who have
    // no presence in this room. Room members can already read it, so they cost
    // nothing to name.
    await seedUser('webchat:mark', 'Mark', 'mark');
    await seedUser('webchat:elsewhere', 'Elsewhere', 'elsewhere');
    await storeWebchatMessage('room-rh', 'webchat:mark', 'user', 'hello');
    await storeWebchatMessage('other-room', 'webchat:elsewhere', 'user', 'hi');

    await writeRoomHumans(AG, SESS);

    expect(readRoomHumans().map((h) => h.handle)).toEqual(['mark']);
  });

  it('lists people only — agent authors are not mentionable', async () => {
    await seedUser('webchat:mark', 'Mark', 'mark');
    await seedUser('Example Assistant', 'Example Assistant', 'construction');
    await storeWebchatMessage('room-rh', 'webchat:mark', 'user', 'hello');
    await storeWebchatMessage('room-rh', 'Example Assistant', 'agent', 'hi back');

    expect((await getRoomHumans('room-rh')).map((h) => h.handle)).toEqual(['mark']);
  });

  it('refreshes on each spawn, so a newcomer becomes mentionable without a restart', async () => {
    await seedUser('webchat:mark', 'Mark', 'mark');
    await storeWebchatMessage('room-rh', 'webchat:mark', 'user', 'hello');
    await writeRoomHumans(AG, SESS);
    expect(readRoomHumans()).toHaveLength(1);

    await seedUser('webchat:owen', 'Owen', 'owen');
    await storeWebchatMessage('room-rh', 'webchat:owen', 'user', 'me too');
    await writeRoomHumans(AG, SESS);

    expect(readRoomHumans().map((h) => h.handle)).toEqual(['mark', 'owen']);
  });
});
