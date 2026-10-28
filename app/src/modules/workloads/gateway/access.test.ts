import { describe, expect, it } from 'vitest';

import { canOpen, emailOfUser, type OpenDeps } from './access.js';

const deps: OpenDeps = {
  userExists: async (u) => ['webchat:owner@x.example', 'webchat:alice@x.example', 'webchat:bob@x.example'].includes(u),
  isOwner: async (u) => u === 'webchat:owner@x.example',
  canAccessAgentGroup: async (u, g) =>
    g === 'ag-1' && (u === 'webchat:alice@x.example' || u === 'webchat:owner@x.example'),
};
const route = (
  who: 'only-me' | 'agent-members' | 'signed-in',
  ownerUserId: string | null = 'webchat:bob@x.example',
) => ({
  who,
  ownerUserId,
  agentGroupId: 'ag-1',
});

describe('who can open a published app', () => {
  it('only-me: the person it belongs to, and owners', async () => {
    expect(await canOpen(route('only-me'), 'webchat:bob@x.example', deps)).toEqual({ ok: true });
    expect(await canOpen(route('only-me'), 'webchat:owner@x.example', deps)).toEqual({ ok: true });
    expect(await canOpen(route('only-me'), 'webchat:alice@x.example', deps)).toEqual({
      ok: false,
      reason: 'not-allowed',
    });
  });

  it('only-me with nobody named yet: owners only', async () => {
    expect(await canOpen(route('only-me', null), 'webchat:bob@x.example', deps)).toMatchObject({ ok: false });
    expect(await canOpen(route('only-me', null), 'webchat:owner@x.example', deps)).toEqual({ ok: true });
  });

  it('agent-members: whoever may use the agent', async () => {
    expect(await canOpen(route('agent-members'), 'webchat:alice@x.example', deps)).toEqual({ ok: true });
    expect(await canOpen(route('agent-members'), 'webchat:bob@x.example', deps)).toMatchObject({ ok: false });
  });

  it('specific: the NanoClaw user signed in with one of the named addresses, nobody else', async () => {
    const r = { ...route('signed-in'), who: 'specific' as const, emails: ['alice@x.example'] };
    expect(await canOpen(r, 'webchat:alice@x.example', deps)).toEqual({ ok: true });
    expect(await canOpen(r, 'webchat:bob@x.example', deps)).toMatchObject({ ok: false, reason: 'not-allowed' });
    expect(await canOpen(r, 'webchat:owner@x.example', deps)).toMatchObject({ ok: false });
    expect(await canOpen({ ...r, emails: ['eve@evil.example'] }, 'webchat:eve@evil.example', deps)).toMatchObject({
      reason: 'unknown-user',
    });
  });

  it('reads an email only from an email-shaped webchat id', () => {
    expect(emailOfUser('webchat:Alice@X.example')).toBe('alice@x.example');
    expect(emailOfUser('webchat:tailscale:alice@x.example')).toBeNull();
    expect(emailOfUser('slack:U123')).toBeNull();
    expect(emailOfUser('webchat:alice')).toBeNull();
  });

  it('signed-in: anyone NanoClaw knows', async () => {
    expect(await canOpen(route('signed-in'), 'webchat:bob@x.example', deps)).toEqual({ ok: true });
  });

  it('never someone NanoClaw does not know, whatever the rule', async () => {
    for (const who of ['only-me', 'agent-members', 'signed-in'] as const) {
      expect(await canOpen(route(who, 'webchat:eve@evil.example'), 'webchat:eve@evil.example', deps)).toEqual({
        ok: false,
        reason: 'unknown-user',
      });
    }
    expect(
      await canOpen({ ...route('signed-in'), who: 'anyone' as never }, 'webchat:bob@x.example', deps),
    ).toMatchObject({
      ok: false,
    });
  });
});
