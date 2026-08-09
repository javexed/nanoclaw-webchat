import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-gate-notice' };
});

import Database from 'better-sqlite3';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { consultTurnGates } from '../../session-manager.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { setRoomModeOverride } from '../../channels/webchat/db.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import './index.js'; // gate registers at import

const AG = 'ag-gate';

const webchatMg = (platformId: string) => ({
  id: `mg-${platformId}`,
  channel_type: 'webchat',
  platform_id: platformId,
  is_group: 0 as const,
});

function outboundTexts(sessionId: string): string[] {
  const p = `/tmp/nanoclaw-test-gate-notice/v2-sessions/${AG}/${sessionId}/outbound.db`;
  if (!fs.existsSync(p)) return [];
  const db = new Database(p, { readonly: true });
  try {
    return (db.prepare(`SELECT content FROM messages_out`).all() as { content: string }[]).map(
      (r) => (JSON.parse(r.content) as { text?: string }).text ?? '',
    );
  } finally {
    db.close();
  }
}

function seedRoom(platformId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO messaging_groups (id, channel_type, platform_id, name, instance, created_at)
       VALUES (?, 'webchat', ?, ?, 'webchat', ?)`,
    )
    .run(`mg-${platformId}`, platformId, platformId, new Date().toISOString());
}

beforeEach(() => {
  fs.rmSync('/tmp/nanoclaw-test-gate-notice', { recursive: true, force: true });
  initTestDb();
  runMigrations(getDb());
  createAgentGroup({
    id: AG,
    name: 'Gate',
    folder: 'gate',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync('/tmp/nanoclaw-test-gate-notice', { recursive: true, force: true });
});

describe('turn-gate veto notice — must land in a delivery-polled session', () => {
  it('writes the notice into the room’s REAL shared session (exists in the sessions table)', () => {
    seedRoom('room-1');
    setRoomModeOverride('room-1', 'required');

    const veto = consultTurnGates(webchatMg('room-1'), AG, 'webchat:bob');
    expect(veto?.reason).toBe('user-creds-required-no-key');

    // The regression this guards: the notice used to target session id ==
    // agent group id, which no sessions row contains — written where no
    // delivery poll would ever read it.
    const sessions = getSessionsByAgentGroup(AG);
    expect(sessions).toHaveLength(1);
    const texts = outboundTexts(sessions[0].id);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('requires your own');
  });

  it('de-dupes the notice per (room, user) within the window', () => {
    seedRoom('room-2');
    setRoomModeOverride('room-2', 'required');
    consultTurnGates(webchatMg('room-2'), AG, 'webchat:carol');
    consultTurnGates(webchatMg('room-2'), AG, 'webchat:carol');
    const sessions = getSessionsByAgentGroup(AG);
    expect(outboundTexts(sessions[0].id)).toHaveLength(1);
  });
});

describe('turn-gate failure posture', () => {
  it('fails CLOSED in a required-mode room when evaluation throws', () => {
    seedRoom('room-3');
    setRoomModeOverride('room-3', 'required');
    getDb().exec('DROP TABLE user_credentials'); // force the evaluation to throw
    const veto = consultTurnGates(webchatMg('room-3'), AG, 'webchat:bob');
    expect(veto?.reason).toBe('user-creds-evaluation-failed');
  });

  it('stays available in a known-optional room even when evaluation throws', () => {
    seedRoom('room-4');
    setRoomModeOverride('room-4', 'optional');
    getDb().exec('DROP TABLE user_credentials');
    expect(consultTurnGates(webchatMg('room-4'), AG, 'webchat:bob')).toBeNull();
  });
});
