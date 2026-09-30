/** The runner half of "an agent can reach a human": the prompt names the handles. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';
import './mention-human.js'; // registers the prompt-section contributor

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('room', 'Room', 'channel', 'webchat', 'room-1', NULL)`,
    )
    .run();
}

function seedHumans(rows: [string, string | null][]): void {
  getInboundDb().exec(
    `CREATE TABLE IF NOT EXISTS room_humans (user_id TEXT PRIMARY KEY, handle TEXT NOT NULL, display_name TEXT)`,
  );
  const insert = getInboundDb().prepare('INSERT INTO room_humans (user_id, handle, display_name) VALUES (?, ?, ?)');
  for (const [handle, display] of rows) insert.run(`webchat:${handle}`, handle, display);
}

describe('reaching a human', () => {
  it('names the room’s people and how to get their attention', () => {
    seedDestination();
    seedHumans([
      ['mark', 'Mark'],
      ['dana', null],
    ]);

    const prompt = buildSystemPromptAddendum('Example Assistant');

    expect(prompt).toContain('Reaching a human');
    expect(prompt).toContain('`@mark` (Mark)');
    expect(prompt).toContain('`@dana`'); // no display name — handle alone
  });

  it('tells the agent NOT to route human matters to another agent', () => {
    seedDestination();
    seedHumans([['mark', 'Mark']]);

    expect(buildSystemPromptAddendum('A')).toContain('Do NOT route these to another agent');
  });

  it('says nothing when the room has no mentionable people', () => {
    // Non-webchat sessions and older hosts have no room_humans table at all;
    // an empty section would be noise in every one of those prompts.
    seedDestination();

    expect(buildSystemPromptAddendum('A')).not.toContain('Reaching a human');
  });
});
