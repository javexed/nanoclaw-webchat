import { describe, it, expect, beforeEach } from 'bun:test';

import { initTestSessionDb, closeTestSessionDb } from './mailbox/sqlite/connection.js';
import { appendStatusEvent, clearStatusEvents } from './status-feed.js';

/**
 * The feed is the one choke point every provider's events pass through on the
 * way to something a person reads — the live bubble, and the durable feed
 * next. Reasoning is where a model most readily restates a token it just read,
 * so redaction belongs HERE and not at each call site: one missed site would
 * put a secret somewhere it is kept rather than somewhere it scrolls past.
 *
 * This asserts on the ROW, not on redactSecrets — testing the helper would
 * pass just as happily if nothing called it.
 */
const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // leak-scan-allow: synthetic fixture, the point of the test

let outbound: ReturnType<typeof initTestSessionDb>['outbound'];

beforeEach(() => {
  ({ outbound } = initTestSessionDb());
  clearStatusEvents();
});

function rows(): { kind: string; text: string | null; detail: string | null }[] {
  return outbound.prepare('SELECT kind, text, detail FROM status_events ORDER BY seq').all() as {
    kind: string;
    text: string | null;
    detail: string | null;
  }[];
}

describe('status feed redaction', () => {
  it('never stores a secret the model restated in its reasoning', () => {
    appendStatusEvent('reasoning', `I will call the API with ${SECRET}`);
    const [row] = rows();
    expect(row!.text).toContain('[REDACTED]');
    expect(row!.text).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('redacts the detail column too — the durable feed reads from it', () => {
    appendStatusEvent('tool', 'Bash', `export TOKEN=${SECRET}`);
    const [row] = rows();
    expect(row!.detail).toContain('[REDACTED]');
    expect(row!.detail).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('leaves ordinary reasoning byte-identical', () => {
    const plain = 'First I check the file, then I edit it';
    appendStatusEvent('reasoning', plain);
    expect(rows()[0]!.text).toBe(plain);
  });

  it('tolerates a null text/detail', () => {
    appendStatusEvent('done', null);
    expect(rows()[0]!.kind).toBe('done');
    expect(rows()[0]!.text).toBeNull();
  });
});
