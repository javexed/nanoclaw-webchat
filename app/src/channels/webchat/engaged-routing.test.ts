/**
 * Tests for resolveInboundDeliveryPlan — the engaged-thread routing decision used by
 * the host router. Verifies @mention auto-engage, expected vs defer, the
 * sole-engaged-agent rule, and the null fall-throughs (regular chat, agent
 * fan-out, non-webchat, nothing engaged). See docs/webchat/thread-engaged-agents.md.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { engageAgent, getEngagedAgents } from './db.js';
import { resolveInboundDeliveryPlan } from './server.js';
import type { MessagingGroup } from '../../types.js';

const now = () => new Date().toISOString();
let mg: MessagingGroup;

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  createAgentGroup({ id: 'ag-a', name: 'Alice', folder: 'alice', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-b', name: 'Bob', folder: 'bob', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-r1',
    channel_type: 'webchat',
    platform_id: 'r1',
    name: 'r1',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  for (const ag of ['ag-a', 'ag-b']) {
    createMessagingGroupAgent({
      id: randomUUID(),
      messaging_group_id: 'mg-r1',
      agent_group_id: ag,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }
  mg = getMessagingGroupByPlatform('webchat', 'r1') as MessagingGroup;
});

afterEach(() => closeDb());

describe('resolveInboundDeliveryPlan', () => {
  it('returns null for the regular chat (main) and null thread', () => {
    expect(resolveInboundDeliveryPlan(mg, 'main', '@alice hi', undefined)).toBeNull();
    expect(resolveInboundDeliveryPlan(mg, null, '@alice hi', undefined)).toBeNull();
  });

  it('peer fan-out: an agent reply goes to the OTHER engaged agents as defer context', async () => {
    engageAgent('r1', 't1', 'ag-a');
    engageAgent('r1', 't1', 'ag-b');
    // ag-a (Alice) just replied → fanned to ag-b only, as defer + isPeerReply.
    const d = resolveInboundDeliveryPlan(mg, 't1', "alice's reply text", 'ag-a');
    expect(d).not.toBeNull();
    expect((await d!).isPeerReply).toBe(true);
    expect((await d!).perAgent.get('ag-b')).toBe('defer');
    expect((await d!).perAgent.has('ag-a')).toBe(false); // never fan back to the producer
  });

  it('peer fan-out: null when the producer is the only engaged agent', () => {
    engageAgent('r1', 't1', 'ag-a');
    expect(resolveInboundDeliveryPlan(mg, 't1', 'solo reply', 'ag-a')).toBeNull();
  });

  it('returns null when nothing is engaged and nobody is mentioned', () => {
    expect(resolveInboundDeliveryPlan(mg, 't1', 'just chatting', undefined)).toBeNull();
    expect(getEngagedAgents('r1', 't1')).toEqual([]);
  });

  it('@mention auto-engages the agent and marks it expected', async () => {
    const d = resolveInboundDeliveryPlan(mg, 't1', '@alice please review', undefined);
    expect(d).not.toBeNull();
    expect((await d!).participants).toEqual(['ag-a']);
    expect((await d!).perAgent.get('ag-a')).toBe('expected');
    expect((await d!).perAgent.has('ag-b')).toBe(false); // not engaged → absent → silent
    expect(getEngagedAgents('r1', 't1')).toEqual(['ag-a']); // persisted
  });

  it('sole engaged agent replies to un-addressed follow-ups (stay engaged)', async () => {
    engageAgent('r1', 't1', 'ag-a');
    const d = resolveInboundDeliveryPlan(mg, 't1', 'and what about the tests?', undefined);
    expect((await d!).perAgent.get('ag-a')).toBe('expected');
  });

  it('with multiple engaged, only the addressed agent is expected; others defer', async () => {
    engageAgent('r1', 't1', 'ag-a');
    engageAgent('r1', 't1', 'ag-b');
    const d = resolveInboundDeliveryPlan(mg, 't1', '@bob thoughts?', undefined);
    expect((await d!).perAgent.get('ag-b')).toBe('expected');
    expect((await d!).perAgent.get('ag-a')).toBe('defer');
  });

  it('multiple engaged + un-addressed broadcast → everyone defers (no pile-on)', async () => {
    engageAgent('r1', 't1', 'ag-a');
    engageAgent('r1', 't1', 'ag-b');
    const d = resolveInboundDeliveryPlan(mg, 't1', 'hmm', undefined);
    expect((await d!).perAgent.get('ag-a')).toBe('defer');
    expect((await d!).perAgent.get('ag-b')).toBe('defer');
  });

  it('does not match mentions inside words (email ≠ @alice)', () => {
    const d = resolveInboundDeliveryPlan(mg, 't1', 'send to alice@example.com', undefined);
    expect(d).toBeNull(); // no real @mention, nothing engaged
    expect(getEngagedAgents('r1', 't1')).toEqual([]);
  });
});
