/**
 * Tests for the room-state helpers, split across two concepts:
 *
 *   - Global archive (owner/admin sets, visible to everyone) — covered by
 *     `archive (global)` group below.
 *   - Per-user hide (any user sets for themselves) — covered by `hide
 *     (per-user)` group below.
 *
 * Both are sidebar-presentation state; routing/access are not affected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import {
  archiveRoom,
  clearArchiveForRoom,
  clearHidesForRoom,
  getArchivedRoomIds,
  getHiddenRoomIdsForUser,
  hideRoomForUser,
  isRoomArchived,
  unarchiveRoom,
  unhideRoomForUser,
} from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('archive (global)', () => {
  it('archive then read back returns the room id', async () => {
    archiveRoom('room-1', 'webchat:alice');
    expect(isRoomArchived('room-1')).toBe(true);
    expect((await getArchivedRoomIds()).has('room-1')).toBe(true);
  });

  it('unarchive removes the row', () => {
    archiveRoom('room-1', 'webchat:alice');
    unarchiveRoom('room-1');
    expect(isRoomArchived('room-1')).toBe(false);
  });

  it('archive is idempotent (no PK conflict on re-archive)', async () => {
    archiveRoom('room-1', 'webchat:alice');
    expect(() => archiveRoom('room-1', 'webchat:bob')).not.toThrow();
    expect((await getArchivedRoomIds()).size).toBe(1);
  });

  it('unarchive is idempotent (no error if not archived)', () => {
    expect(() => unarchiveRoom('room-1')).not.toThrow();
  });

  it('clearArchiveForRoom drops the global archive (called on room delete)', () => {
    archiveRoom('room-1', 'webchat:alice');
    archiveRoom('room-2', 'webchat:alice');
    clearArchiveForRoom('room-1');
    expect(isRoomArchived('room-1')).toBe(false);
    expect(isRoomArchived('room-2')).toBe(true);
  });
});

describe('hide (per-user)', () => {
  it('hide then read back returns the room id', async () => {
    hideRoomForUser('webchat:alice', 'room-1');
    expect((await getHiddenRoomIdsForUser('webchat:alice')).has('room-1')).toBe(true);
  });

  it('unhide removes the row', async () => {
    hideRoomForUser('webchat:alice', 'room-1');
    unhideRoomForUser('webchat:alice', 'room-1');
    expect((await getHiddenRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
  });

  it('hide is idempotent (no PK conflict on re-hide)', async () => {
    hideRoomForUser('webchat:alice', 'room-1');
    expect(() => hideRoomForUser('webchat:alice', 'room-1')).not.toThrow();
    expect((await getHiddenRoomIdsForUser('webchat:alice')).size).toBe(1);
  });

  it('unhide is idempotent (no error if not hidden)', () => {
    expect(() => unhideRoomForUser('webchat:alice', 'room-1')).not.toThrow();
  });

  it('hide is per-user — alice hiding does not affect bob', async () => {
    hideRoomForUser('webchat:alice', 'room-1');
    expect((await getHiddenRoomIdsForUser('webchat:alice')).has('room-1')).toBe(true);
    expect((await getHiddenRoomIdsForUser('webchat:bob')).has('room-1')).toBe(false);
  });

  it('clearHidesForRoom drops every user’s hide of that room', async () => {
    hideRoomForUser('webchat:alice', 'room-1');
    hideRoomForUser('webchat:bob', 'room-1');
    hideRoomForUser('webchat:alice', 'room-2');
    clearHidesForRoom('room-1');
    expect((await getHiddenRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
    expect((await getHiddenRoomIdsForUser('webchat:bob')).has('room-1')).toBe(false);
    // Unrelated hides survive
    expect((await getHiddenRoomIdsForUser('webchat:alice')).has('room-2')).toBe(true);
  });
});

describe('archive + hide are orthogonal', () => {
  it('a globally archived room can also be hidden by a user', async () => {
    archiveRoom('room-1', 'webchat:alice');
    hideRoomForUser('webchat:bob', 'room-1');
    expect(isRoomArchived('room-1')).toBe(true);
    expect((await getHiddenRoomIdsForUser('webchat:bob')).has('room-1')).toBe(true);
    expect((await getHiddenRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
  });

  it('unarchive does not clear per-user hides', async () => {
    archiveRoom('room-1', 'webchat:alice');
    hideRoomForUser('webchat:bob', 'room-1');
    unarchiveRoom('room-1');
    expect(isRoomArchived('room-1')).toBe(false);
    expect((await getHiddenRoomIdsForUser('webchat:bob')).has('room-1')).toBe(true);
  });
});
