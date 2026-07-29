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

function seedUser(id: string, display: string, handle: string) {
  getDb().prepare(`INSERT OR IGNORE INTO users (id,kind,display_name,created_at) VALUES (?,?,?,?)`).run(id, 'webchat', display, now());
  setWebchatUserHandle(id, handle);
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

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: AG, name: 'RH', folder: 'rh', agent_provider: null, created_at: now() });
  db.prepare(
    `INSERT INTO messaging_groups (id,channel_type,instance,platform_id,is_group,created_at)
     VALUES ('mg-rh','webchat','webchat','room-rh',1,?)`,
  ).run(now());
  createSession({
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

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('room humans -> session DB', () => {
  it('publishes the handles of people who have spoken in the room', () => {
    seedUser('webchat:mark', 'Mark', 'mark');
    storeWebchatMessage('room-rh', 'webchat:mark', 'user', 'hello');

    writeRoomHumans(AG, SESS);

    expect(readRoomHumans()).toEqual([{ handle: 'mark', display_name: 'Mark' }]);
  });

  it('scopes to the room — someone who only speaks elsewhere is not listed', () => {
    // Naming every registered handle to every agent would leak people who have
    // no presence in this room. Room members can already read it, so they cost
    // nothing to name.
    seedUser('webchat:mark', 'Mark', 'mark');
    seedUser('webchat:elsewhere', 'Elsewhere', 'elsewhere');
    storeWebchatMessage('room-rh', 'webchat:mark', 'user', 'hello');
    storeWebchatMessage('other-room', 'webchat:elsewhere', 'user', 'hi');

    writeRoomHumans(AG, SESS);

    expect(readRoomHumans().map((h) => h.handle)).toEqual(['mark']);
  });

  it('lists people only — agent authors are not mentionable', () => {
    seedUser('webchat:mark', 'Mark', 'mark');
    seedUser('Construction AI Assistant', 'Construction AI Assistant', 'construction');
    storeWebchatMessage('room-rh', 'webchat:mark', 'user', 'hello');
    storeWebchatMessage('room-rh', 'Construction AI Assistant', 'agent', 'hi back');

    expect(getRoomHumans('room-rh').map((h) => h.handle)).toEqual(['mark']);
  });

  it('refreshes on each spawn, so a newcomer becomes mentionable without a restart', () => {
    seedUser('webchat:mark', 'Mark', 'mark');
    storeWebchatMessage('room-rh', 'webchat:mark', 'user', 'hello');
    writeRoomHumans(AG, SESS);
    expect(readRoomHumans()).toHaveLength(1);

    seedUser('webchat:owen', 'Owen', 'owen');
    storeWebchatMessage('room-rh', 'webchat:owen', 'user', 'me too');
    writeRoomHumans(AG, SESS);

    expect(readRoomHumans().map((h) => h.handle)).toEqual(['mark', 'owen']);
  });
});
