/**
 * status_events readers — moved here with the readers themselves when the
 * table became module-owned (declared container-side via the outbound
 * schema-extension seam; the host reads best-effort). All readers tolerate a
 * missing table: a session whose container hasn't opened its DB yet simply
 * has no feed.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { getStatusEventsSince, getMaxStatusEventSeq } from './index.js';

const TEST_DIR = path.join(os.tmpdir(), 'nanoclaw-agent-status-readers-test');

describe('status_events readers (webchat thinking bubble)', () => {
  const OUT_PATH = path.join(TEST_DIR, 'outbound.db');

  function freshOutbound(): Database.Database {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = new Database(OUT_PATH);
    db.exec(`
      CREATE TABLE status_events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        text       TEXT,
        detail     TEXT,
        created_at TEXT NOT NULL
      );
    `);
    return db;
  }

  function append(db: Database.Database, kind: string, text: string | null, detail: string | null = null): void {
    db.prepare('INSERT INTO status_events (kind, text, detail, created_at) VALUES (?, ?, ?, ?)').run(
      kind,
      text,
      detail,
      new Date().toISOString(),
    );
  }

  it('getStatusEventsSince returns only rows past the watermark, in order', () => {
    const db = freshOutbound();
    append(db, 'tool', 'Read', 'a.ts');
    append(db, 'progress', 'Building');
    append(db, 'done', null);

    const all = getStatusEventsSince(db, 0);
    expect(all.map((e) => e.kind)).toEqual(['tool', 'progress', 'done']);
    expect(all[0]).toMatchObject({ kind: 'tool', text: 'Read', detail: 'a.ts' });

    // Past the first row's seq → only the later two.
    const after = getStatusEventsSince(db, all[0].seq);
    expect(after.map((e) => e.kind)).toEqual(['progress', 'done']);
    db.close();
  });

  it('getMaxStatusEventSeq tracks the latest seq across a clear', () => {
    const db = freshOutbound();
    expect(getMaxStatusEventSeq(db)).toBe(0);
    append(db, 'tool', 'Bash', 'ls');
    append(db, 'tool', 'Read', 'b.ts');
    const max = getMaxStatusEventSeq(db);
    expect(max).toBe(2);

    // Per-turn clear: rows gone, but AUTOINCREMENT keeps seq climbing.
    db.prepare('DELETE FROM status_events').run();
    expect(getMaxStatusEventSeq(db)).toBe(0); // empty table
    append(db, 'progress', 'Next turn');
    // New row's seq is higher than the pre-clear max → host watermark (= old max) sees it.
    const newRows = getStatusEventsSince(db, max);
    expect(newRows.map((e) => e.text)).toEqual(['Next turn']);
    db.close();
  });

  it('readers tolerate a missing status_events table (older session DB)', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = new Database(OUT_PATH);
    db.exec('CREATE TABLE messages_out (id TEXT PRIMARY KEY)'); // no status_events
    expect(getStatusEventsSince(db, 0)).toEqual([]);
    expect(getMaxStatusEventSeq(db)).toBe(0);
    db.close();
  });
});
