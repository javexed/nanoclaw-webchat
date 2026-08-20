/**
 * Phase 1: the session-key resolver. In a UserCreds room a member who has CONNECTED a
 * credential (user-level, applies to every same-provider room) gets a per-member
 * session keyed by userId; everyone else / every other room is unchanged
 * (null → shared session). Enrollment in a given room is then lazy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { consultTurnGates, resolveSessionKeyOverride } from '../../session-manager.js';
import { resolveAgentIdentity, resolveContainerEnv, runSessionPrepareHooks } from '../../container-runtime.js';
import { setRoomModeOverride, setCredentialsConfig } from '../../channels/webchat/db.js';
import { upsertUserCredential, setUserCredentialStatus } from './db.js';
import { userCredsAgentIdentifier, WORKSPACE_DEFAULT_USER_ID } from './identity.js';
import './index.js'; // registers the resolvers

const webchatMg = (platformId: string) => ({
  id: 'mg-1',
  channel_type: 'webchat',
  platform_id: platformId,
  is_group: 0,
});

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});
afterEach(() => closeDb());

describe('userCreds session-key resolver', () => {
  // THE POINT OF THE CHANGE: two threads must not share one session. Keyed by
  // user alone they did, so one member's queue held 89 main-thread rows and 60
  // topic-thread rows and the agent answered a room message into the thread.
  it('gives each thread its own per-member session key', async () => {
    await setRoomModeOverride('room-1', 'required');
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    const main = await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice', null);
    const topic = await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice', 'topic-9');
    expect(main?.threadId).toBe('webchat:alice::main');
    expect(topic?.threadId).toBe('webchat:alice::topic-9');
    expect(main?.threadId).not.toBe(topic?.threadId);
  });

  it('connected member in a UserCreds room → per-member session keyed by (user, thread)', async () => {
    await setRoomModeOverride('room-1', 'required');
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice::main',
    });
  });

  it('optional + not connected → no override (falls back to the shared session)', async () => {
    await setRoomModeOverride('room-1', 'optional');
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:bob')).toBeNull();
  });

  it('required + not connected → turn-gate VETO (never bills the shared key)', async () => {
    await setRoomModeOverride('room-1', 'required');
    // The key resolver itself stays silent (no override) …
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:bob')).toBeNull();
    // … and the veto rides the turn-gate seam with the module's reason. (The
    // user-facing guidance is posted by the module itself — seam contract.)
    const veto = await consultTurnGates(webchatMg('room-1'), 'ag-1', 'webchat:bob');
    expect(veto).toEqual({ reason: 'user-creds-required-no-key' });
  });

  it('disabled room (no API-key mode, no OAuth) → no override', async () => {
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(await resolveSessionKeyOverride(webchatMg('room-x'), 'ag-1', 'webchat:alice')).toBeNull(); // room-x has no row → disabled
  });

  it('disabled room does NOT route OAuth either — mode is the master gate over both methods', async () => {
    // User credentials Off = no UserCreds at all, even with workspace OAuth accepted
    // AND a connected subscription. (The mode gates OAuth, not just API keys.)
    await setCredentialsConfig({ allowClaudeOauth: true });
    await setRoomModeOverride('room-1', 'disabled');
    await upsertUserCredential('webchat:alice', 'claude', 'sec-oat', 'oauth_token');
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toBeNull();
    // Turn the room on → the same connected OAuth member now routes per-member.
    await setRoomModeOverride('room-1', 'optional');
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice::main',
    });
  });

  it('revoked credential → no override', async () => {
    await setRoomModeOverride('room-1', 'optional');
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    await setUserCredentialStatus('webchat:alice', 'claude', 'revoked');
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toBeNull();
  });

  it('connected OAuth member stops routing when the workspace disables OAuth', async () => {
    await setRoomModeOverride('room-1', 'optional');
    await upsertUserCredential('webchat:alice', 'claude', 'sec-oat', 'oauth_token');
    await setCredentialsConfig({ allowClaudeOauth: true });
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice::main',
    });
    // Admin flips OAuth off → the already-connected member must fall back to shared.
    await setCredentialsConfig({ allowClaudeOauth: false });
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toBeNull();
  });

  it('non-webchat channel → no override', async () => {
    await setRoomModeOverride('room-1', 'required');
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    const telegramMg = { id: 'mg-2', channel_type: 'telegram', platform_id: 'room-1', is_group: 1 };
    expect(await resolveSessionKeyOverride(telegramMg, 'ag-1', 'webchat:alice')).toBeNull();
  });

  it('null userId → no override', async () => {
    await setRoomModeOverride('room-1', 'required');
    expect(await resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', null)).toBeNull();
  });
});

// The resolver is SYNC by contract and reads what the prepare hook staged —
// the spawn path runs the hook first, so the test does too.
async function prepared(agentGroupId: string, threadId: string | null): Promise<Record<string, string>> {
  await runSessionPrepareHooks(agentGroupId, threadId);
  return resolveContainerEnv(agentGroupId, threadId);
}

describe('container-env resolver (OAuth sentinel at spawn)', () => {
  const OAUTH_ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'placeholder', ANTHROPIC_API_KEY: '' };

  it('per-member OAuth session → sentinel env', async () => {
    await upsertUserCredential('webchat:alice', 'claude', 'sec-oat', 'oauth_token');
    expect(await prepared('ag-1', 'webchat:alice')).toEqual(OAUTH_ENV);
  });

  it('per-member API-key session → no env (rides x-api-key)', async () => {
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(await prepared('ag-1', 'webchat:alice')).toEqual({});
  });

  it('base session + OAuth workspace default → sentinel env', async () => {
    await upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-oat', 'oauth_token');
    expect(await prepared('ag-1', null)).toEqual(OAUTH_ENV);
  });

  it('base session + API-key workspace default → no env', async () => {
    await upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-key', 'api_key');
    expect(await prepared('ag-1', null)).toEqual({});
  });

  it('base session + no workspace default → no env', async () => {
    expect(await prepared('ag-1', null)).toEqual({});
  });

  it('member API key wins over an OAuth workspace default for that member session', async () => {
    await upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-oat', 'oauth_token');
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(await prepared('ag-1', 'webchat:alice')).toEqual({}); // member key mode
    expect(await prepared('ag-1', null)).toEqual(OAUTH_ENV); // base still OAuth
  });

  it('topic-thread ids (not a credentialed member) fall through to the workspace default', async () => {
    await upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-oat', 'oauth_token');
    expect(await prepared('ag-1', 'main')).toEqual(OAUTH_ENV); // webchat topic thread
  });

  it('revoked workspace default → no sentinel (fail back to key mode)', async () => {
    await upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-oat', 'oauth_token');
    await setUserCredentialStatus(WORKSPACE_DEFAULT_USER_ID, 'claude', 'revoked');
    expect(await prepared('ag-1', null)).toEqual({});
  });
});

async function preparedIdentity(agentGroupId: string, threadId: string | null): Promise<string | null> {
  await runSessionPrepareHooks(agentGroupId, threadId);
  return resolveAgentIdentity(agentGroupId, threadId);
}

describe('userCreds agent-identity resolver (spawn)', () => {
  it('per-member session of a connected member → the member UserCreds identity', async () => {
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(await preparedIdentity('ag-1', 'webchat:alice')).toBe(userCredsAgentIdentifier('ag-1', 'webchat:alice'));
  });
  it('not connected / no thread → null (default agent-group identity)', async () => {
    expect(await preparedIdentity('ag-1', 'webchat:bob')).toBeNull();
    expect(await preparedIdentity('ag-1', null)).toBeNull();
  });
  it('revoked credential → null', async () => {
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    await setUserCredentialStatus('webchat:alice', 'claude', 'revoked');
    expect(await preparedIdentity('ag-1', 'webchat:alice')).toBeNull();
  });
});
