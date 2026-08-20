/**
 * Per-member session-key codec, and the property that matters: decoding a
 * composite key resolves to the SAME credential identity as the bare user id.
 *
 * Why that property and not just "the codec round-trips": if a seam consumer
 * fails to decode, it looks up a credential for `webchat:mark::main`, finds
 * none, and the container silently falls back to the workspace-default
 * credential. Nothing throws. The agent keeps answering — on the wrong
 * identity, with someone else's key. These tests pin the identity, not the
 * string.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { resolveAgentIdentity, resolveContainerEnv } from '../../container-runtime.js';
import { upsertUserCredential } from './db.js';
import { memberSessionKey, memberUserFromKey, memberThreadFromKey, userCredsAgentIdentifier } from './identity.js';
import './index.js'; // registers the resolvers under test

const USER = 'webchat:tailscale:mark@example.com';
const AG = 'ag-key';

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await db.run(`INSERT OR IGNORE INTO agent_groups (id,name,folder,agent_provider,created_at) VALUES (?,?,?,NULL,'t')`, AG, AG, AG);
  await upsertUserCredential(USER, 'claude', 'sec-1', 'api_key');
});
afterEach(() => closeDb());

describe('member session key codec', () => {
  it('round-trips a user id that itself contains colons', async () => {
    // User ids are `<channel>:<instance>:<handle>` — single colons everywhere.
    // Splitting on the LAST `::` is what keeps them out of the boundary.
    const key = memberSessionKey(USER, '10a2ab64-8fd3-435d-a94b-a08cb73cfc54');
    expect(memberUserFromKey(key)).toBe(USER);
    expect(memberThreadFromKey(key)).toBe('10a2ab64-8fd3-435d-a94b-a08cb73cfc54');
  });

  it('encodes main explicitly so room and topic thread never collide', async () => {
    const main = memberSessionKey(USER, null);
    const topic = memberSessionKey(USER, 'topic-1');
    expect(main).not.toBe(topic);
    expect(memberThreadFromKey(main)).toBe('main');
    // ...and neither can be mistaken for a bare user id.
    expect(main).not.toBe(USER);
  });

  it('reports a bare user id as NOT a composite key', async () => {
    // This is what makes `memberUserFromKey(x) ?? x` safe for legacy sessions.
    expect(memberUserFromKey(USER)).toBeNull();
    expect(memberUserFromKey(null)).toBeNull();
  });
});

describe('seam consumers resolve the same identity for both key shapes', () => {
  it('agent identity is identical for a composite and a bare key', async () => {
    const expected = userCredsAgentIdentifier(AG, USER);
    expect(resolveAgentIdentity(AG, USER)).toBe(expected); // legacy shape
    expect(resolveAgentIdentity(AG, memberSessionKey(USER, 'topic-1'))).toBe(expected);
    expect(resolveAgentIdentity(AG, memberSessionKey(USER, null))).toBe(expected);
  });

  it('an unknown member still resolves to no per-member identity', async () => {
    expect(resolveAgentIdentity(AG, memberSessionKey('webchat:nobody', 'topic-1'))).toBeNull();
  });

  it('container env is identical for a composite and a bare key', async () => {
    // api_key member → no OAuth env either way. The failure this guards is a
    // composite key falling through to the workspace-default branch.
    const legacy = resolveContainerEnv(AG, USER);
    const composite = resolveContainerEnv(AG, memberSessionKey(USER, 'topic-1'));
    expect(composite).toEqual(legacy);
  });

  it('an OAuth member gets OAuth env under a composite key too', async () => {
    await upsertUserCredential(USER, 'claude', 'sec-oauth', 'oauth_token');
    const env = resolveContainerEnv(AG, memberSessionKey(USER, 'topic-1'));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN, 'composite key must not drop to workspace default').toBeTruthy();
    expect(env).toEqual(resolveContainerEnv(AG, USER));
  });

  void getDb;
});
