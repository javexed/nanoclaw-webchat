import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { recordActivity, pruneActivity, getActivityForRoom, getReasoningForRoom } from './db.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-activity-'));
  await initDb(path.join(tmpDir, 'test.db'));
  await runMigrations(getDb());
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

describe('durable activity log', () => {
  it('persists a frame and reads it back newest-first', async () => {
    const t0 = Date.now();
    await recordActivity({
      roomId: 'gardens',
      agentName: 'AG',
      kind: 'tool',
      text: 'Bash',
      detail: 'ls',
      createdAt: t0,
    });
    await recordActivity({
      roomId: 'gardens',
      agentName: 'AG',
      kind: 'reasoning',
      text: 'first line',
      detail: 'FULL\nBLOCK',
      createdAt: t0 + 1,
    });

    const rows = await getActivityForRoom('gardens');
    expect(rows.map((r) => r.kind)).toEqual(['reasoning', 'tool']);
    expect(rows[0]!.detail).toBe('FULL\nBLOCK');
  });

  it('scopes by room', async () => {
    await recordActivity({
      roomId: 'gardens',
      agentName: null,
      kind: 'progress',
      text: 'x',
      detail: null,
      createdAt: Date.now(),
    });
    await recordActivity({
      roomId: 'excavating',
      agentName: null,
      kind: 'progress',
      text: 'y',
      detail: null,
      createdAt: Date.now(),
    });
    expect(await getActivityForRoom('gardens')).toHaveLength(1);
    expect(await getActivityForRoom('excavating')).toHaveLength(1);
  });

  it('getReasoningForRoom returns only reasoning rows that carry a full block', async () => {
    const now = Date.now();
    await recordActivity({
      roomId: 'r',
      agentName: null,
      kind: 'reasoning',
      text: 'clip',
      detail: 'the whole trace',
      createdAt: now,
    });
    await recordActivity({
      roomId: 'r',
      agentName: null,
      kind: 'reasoning',
      text: 'clip2',
      detail: null,
      createdAt: now + 1,
    });
    await recordActivity({
      roomId: 'r',
      agentName: null,
      kind: 'tool',
      text: 'Bash',
      detail: 'cmd',
      createdAt: now + 2,
    });

    const reasoning = await getReasoningForRoom('r');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.detail).toBe('the whole trace');
  });

  it('prunes rows past 30 days, keeps newer ones', async () => {
    const now = Date.now();
    await recordActivity({
      roomId: 'r',
      agentName: null,
      kind: 'progress',
      text: 'old',
      detail: null,
      createdAt: now - 31 * DAY,
    });
    await recordActivity({
      roomId: 'r',
      agentName: null,
      kind: 'progress',
      text: 'fresh',
      detail: null,
      createdAt: now - 1 * DAY,
    });

    const removed = await pruneActivity(now);
    expect(removed).toBe(1);
    const rows = await getActivityForRoom('r');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('fresh');
  });
});
