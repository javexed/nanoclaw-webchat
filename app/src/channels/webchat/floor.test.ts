import { describe, expect, it } from 'vitest';

import { deskState, roomFor, sortDesks, STUCK_AFTER_MS, type Desk } from './server/floor.js';

// The state machine is the whole point of this view: a desk's colour is the
// answer a sysadmin came for. Everything else (DB reads, scoping) is covered by
// the shared helpers it borrows, so the tests that earn their place are the
// ones that pin the classification and the trouble-first ordering.

const MIN = 60_000;

describe('deskState', () => {
  it('is cold when no container is running, whatever the last event said', () => {
    // A finished session keeps its last status row forever. Reading that as
    // activity would paint a floor full of ghosts.
    expect(deskState(false, 'tool', 5 * MIN)).toBe('cold');
    expect(deskState(false, null, null)).toBe('cold');
  });

  it('is idle when a container is up and its last turn finished', () => {
    expect(deskState(true, 'done', 5 * MIN)).toBe('idle');
  });

  it('is idle when a container is up but never streamed anything', () => {
    // No status feed at all is the normal shape for a container that just came
    // up. It is not evidence of trouble on its own — the sweep's own
    // no-heartbeat rule owns that call, and it uses uptime, which this does not
    // have. Guessing "stuck" here would contradict it.
    expect(deskState(true, null, 10 * MIN)).toBe('idle');
  });

  it('is working mid-turn, before the ceiling', () => {
    for (const kind of ['start', 'tool', 'progress', 'reasoning']) {
      expect(deskState(true, kind, 5 * MIN)).toBe('working');
    }
  });

  it('is stuck once a mid-turn desk passes the sweep ceiling', () => {
    expect(deskState(true, 'tool', STUCK_AFTER_MS + 1)).toBe('stuck');
  });

  it('is still working exactly AT the ceiling, not stuck', () => {
    // The boundary belongs to the sweep: a desk should turn red when the sweep
    // starts considering a kill, not a tick before it.
    expect(deskState(true, 'tool', STUCK_AFTER_MS)).toBe('working');
  });

  it('is stuck when a container is alive but the host called it stalled', () => {
    // 'stalled' is host-generated and means the container went away mid-turn.
    // Seeing a live process at the same time is a disagreement between two
    // sources, and that disagreement is exactly what wants a human.
    expect(deskState(true, 'stalled', 1 * MIN)).toBe('stuck');
  });

  it('does not call a long-quiet desk stuck when idle age is unknown', () => {
    // A session with no parseable last_active gives no age to judge. Never
    // guess one — the same rule the sweep follows for unknown uptime.
    expect(deskState(true, 'tool', null)).toBe('working');
  });
});

describe('sortDesks', () => {
  const desk = (state: Desk['state'], idle_ms: number, id: string): Desk => ({
    session_id: id,
    agent_group_id: 'ag',
    agent_name: 'a',
    room_id: null,
    room_name: null,
    state,
    last_kind: null,
    idle_ms,
  });

  it('puts trouble first, so a 40-desk floor still reads at a glance', () => {
    const out = sortDesks([desk('cold', 1, 'c'), desk('idle', 1, 'i'), desk('working', 1, 'w'), desk('stuck', 1, 's')]);
    expect(out.map((d) => d.session_id)).toEqual(['s', 'w', 'i', 'c']);
  });

  it('breaks ties by how long the desk has been quiet, longest first', () => {
    const out = sortDesks([desk('stuck', 1 * MIN, 'new'), desk('stuck', 90 * MIN, 'old')]);
    expect(out.map((d) => d.session_id)).toEqual(['old', 'new']);
  });

  it('does not mutate its input', () => {
    const input = [desk('cold', 1, 'c'), desk('stuck', 1, 's')];
    sortDesks(input);
    expect(input.map((d) => d.session_id)).toEqual(['c', 's']);
  });
});

describe('roomFor', () => {
  // The shipped bug: sessions carry a messaging-group ROW id, but
  // getWebchatRoom() keys on PLATFORM id. Both are strings, so nothing failed
  // loudly — every desk just read "no room" on a live floor.
  it('uses the platform id for webchat, which is what room click-through expects', () => {
    expect(roomFor({ channel_type: 'webchat', platform_id: 'control', name: 'Control Room' })).toEqual({
      roomId: 'control',
      roomName: 'Control Room',
    });
  });

  it('still names a non-webchat room, but offers no click-through', () => {
    // A slack-wired session belongs on the floor; its platform id is not a
    // webchat room, so linking there would 404.
    expect(roomFor({ channel_type: 'slack', platform_id: 'C123', name: 'ops' })).toEqual({
      roomId: null,
      roomName: 'ops',
    });
  });

  it('falls back to the platform id when a group has no name', () => {
    expect(roomFor({ channel_type: 'webchat', platform_id: 'weight-sensor', name: null }).roomName).toBe(
      'weight-sensor',
    );
  });

  it('reports no room for an agent-shared session', () => {
    // 11 of 53 sessions on the live install have no messaging group at all.
    // "no room" is the correct answer there, and must stay distinguishable
    // from the bug it looked identical to.
    expect(roomFor(undefined)).toEqual({ roomId: null, roomName: null });
  });
});
