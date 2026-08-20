import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  getUserCredsCredential,
  userHasActiveKey,
  userHasActiveOauth,
  getUserSecretId,
  userHasConnectedCredential,
  agentGroupForUserCredsAgent,
  activeMembersForGroup,
  upsertUserCredsCredential,
  upsertUserCredential,
  setUserCredentialStatus,
  setUserCredsStatus,
} from './db.js';
import {
  getRoomCredentialMode,
  setRoomCredentialMode,
  getRoomOauthAllowed,
  setRoomOauthAllowed,
} from '../../channels/webchat/db.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});
afterEach(() => closeDb());

describe('user_credential_members', () => {
  it('upsert + get round-trips and marks active', async () => {
    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice-aaa', 'sec-1');
    expect(await getUserCredsCredential('webchat:alice', 'ag-1')).toMatchObject({
      onecli_agent_id: 'user-creds-alice-aaa',
      secret_id: 'sec-1',
      status: 'active',
    });
    expect(await userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
    expect(await userHasActiveKey('webchat:bob', 'ag-1')).toBe(false);
  });

  it('getUserSecretId is sourced from the user-level credential (one secret, all rooms)', async () => {
    expect(await getUserSecretId('webchat:alice')).toBeNull(); // not connected yet
    await upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(await userHasConnectedCredential('webchat:alice', 'claude')).toBe(true);
    expect(await getUserSecretId('webchat:alice')).toBe('sec-1');
    // Provider-scoped: a Codex credential is a separate secret.
    await upsertUserCredential('webchat:alice', 'codex', 'sec-cdx', 'api_key');
    expect(await getUserSecretId('webchat:alice', 'codex')).toBe('sec-cdx');
    expect(await getUserSecretId('webchat:alice', 'claude')).toBe('sec-1');
    // Revoking clears it.
    await setUserCredentialStatus('webchat:alice', 'claude', 'revoked');
    expect(await getUserSecretId('webchat:alice')).toBeNull();
  });

  it('recovers the agent group from a UserCreds agent id (approval routing)', async () => {
    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice-aaa', 'sec-1');
    expect(await agentGroupForUserCredsAgent('user-creds-alice-aaa')).toBe('ag-1');
    expect(await agentGroupForUserCredsAgent('unknown')).toBeNull();
  });

  it('lists only ACTIVE members for a group (fan-out source)', async () => {
    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice', 'sec-a');
    await upsertUserCredsCredential('webchat:bob', 'ag-1', 'user-creds-bob', 'sec-b');
    await upsertUserCredsCredential('webchat:carol', 'ag-2', 'user-creds-carol', 'sec-c');
    await setUserCredsStatus('webchat:bob', 'ag-1', 'revoked');
    expect((await activeMembersForGroup('ag-1')).sort()).toEqual(['webchat:alice']);
  });

  it('revoke clears active status', async () => {
    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice', 'sec-1');
    await setUserCredsStatus('webchat:alice', 'ag-1', 'revoked');
    expect(await userHasActiveKey('webchat:alice', 'ag-1')).toBe(false);
    // re-onboard re-activates
    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice', 'sec-1');
    expect(await userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
  });
});

describe('userCreds oauth credentials (vault-only)', () => {
  it('stores an oauth credential with a vault secret_id + oauth cred_type', async () => {
    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice-aaa', 'sec-oat', 'oauth_token');
    const row = (await getUserCredsCredential('webchat:alice', 'ag-1'))!;
    expect(row.cred_type).toBe('oauth_token');
    expect(row.secret_id).toBe('sec-oat'); // lives in the OneCLI vault, like api keys
    expect(await userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
    expect(await userHasActiveOauth('webchat:alice', 'ag-1')).toBe(true);
  });

  it('userHasActiveOauth is false for api_key rows and after revoke', async () => {
    await upsertUserCredsCredential('webchat:bob', 'ag-1', 'user-creds-bob', 'sec-1'); // default api_key
    expect(await userHasActiveOauth('webchat:bob', 'ag-1')).toBe(false);

    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice', 'sec-oat', 'oauth_token');
    await setUserCredsStatus('webchat:alice', 'ag-1', 'revoked');
    expect(await userHasActiveOauth('webchat:alice', 'ag-1')).toBe(false); // revoked
  });

  it('switching oauth→api_key flips cred_type and updates secret_id', async () => {
    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice', 'sec-oat', 'oauth_token');
    expect(await userHasActiveOauth('webchat:alice', 'ag-1')).toBe(true);

    await upsertUserCredsCredential('webchat:alice', 'ag-1', 'user-creds-alice', 'sec-key', 'api_key');
    const row = (await getUserCredsCredential('webchat:alice', 'ag-1'))!;
    expect(row.cred_type).toBe('api_key');
    expect(row.secret_id).toBe('sec-key');
    expect(await userHasActiveOauth('webchat:alice', 'ag-1')).toBe(false);
  });
});

describe('room oauth_allowed', () => {
  it('defaults to false and round-trips, orthogonal to credential_mode', async () => {
    expect(await getRoomOauthAllowed('room-z')).toBe(false);
    await setRoomCredentialMode('room-z', 'optional');
    await setRoomOauthAllowed('room-z', true);
    expect(await getRoomOauthAllowed('room-z')).toBe(true);
    expect(await getRoomCredentialMode('room-z')).toBe('optional'); // untouched
    await setRoomOauthAllowed('room-z', false);
    expect(await getRoomOauthAllowed('room-z')).toBe(false);
  });
});

describe('room credential_mode', () => {
  it('defaults to disabled, round-trips, preserves engage_default', async () => {
    expect(await getRoomCredentialMode('room-x')).toBe('disabled');
    await getDb().run(`INSERT INTO webchat_room_settings (room_id, engage_default, updated_at) VALUES ('room-y','mention-only',1)`);
    await setRoomCredentialMode('room-y', 'required');
    expect(await getRoomCredentialMode('room-y')).toBe('required');
    const row = (await getDb().get(`SELECT engage_default, credential_mode FROM webchat_room_settings WHERE room_id='room-y'`)) as { engage_default: string; credential_mode: string };
    expect(row).toEqual({ engage_default: 'mention-only', credential_mode: 'required' });
  });
});
