import { describe, expect, it } from 'vitest';

import { parseOutboundTs, recentOutbound, replayThread } from './reconcile.js';

describe('webchat reconcile window', () => {
  it('reads both timestamp forms as UTC', () => {
    expect(parseOutboundTs('2026-09-23T17:32:45.092Z')).toBe(Date.UTC(2026, 8, 23, 17, 32, 45, 92));
    expect(parseOutboundTs('2026-09-23 17:32:45')).toBe(Date.UTC(2026, 8, 23, 17, 32, 45));
    expect(Number.isNaN(parseOutboundTs('garbage'))).toBe(true);
  });

  it("keeps only the last minute's rows — an ISO row from earlier today is not recent", () => {
    const now = Date.UTC(2026, 8, 23, 18, 0, 0);
    const rows = [
      { id: 'old-iso', timestamp: '2026-09-23T00:57:00.000Z' }, // "pong", 17 hours ago
      { id: 'old-sql', timestamp: '2026-09-23 17:40:00' },
      { id: 'fresh', timestamp: '2026-09-23T17:59:30.000Z' },
      { id: 'fresh-sql', timestamp: '2026-09-23 17:59:10' },
    ];
    expect(recentOutbound(rows, now - 60_000).map((r) => r.row.id)).toEqual(['fresh-sql', 'fresh']);
  });
});

describe('webchat reconcile replay target', () => {
  it("replays into the session's thread, not the room's main thread", async () => {
    // A per-member session key carries its thread; a replay must land there.
    expect(await replayThread({ thread_id: 'webchat:alice::topic-7' }, 'room-1')).toBe('topic-7');
    // A main-thread session (no key) replays into main.
    expect(await replayThread({ thread_id: null }, 'room-1')).toBe('main');
  });
});
