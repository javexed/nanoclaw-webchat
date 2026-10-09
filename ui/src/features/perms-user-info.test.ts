import { describe, expect, it } from 'vitest';

import { findMembership, userDisplayName, userIsGlobalAdmin, userIsOwner, userRoleSummary } from './perms-user-info.js';

const user = (o: Partial<{ id: string; display_name: string; roles: any[]; memberships: any[] }> = {}) => ({
  id: 'webchat:sam@example.com',
  display_name: '',
  roles: [],
  memberships: [],
  ...o,
});
const role = (kind: string, agent_group_id: string | null = null) => ({ kind, agent_group_id });

describe('a user record, as the people views show it', () => {
  it('names a user by display name, else by the handle after the last colon', () => {
    expect(userDisplayName(user({ display_name: '  Sam  ' }))).toBe('Sam');
    expect(userDisplayName(user())).toBe('sam@example.com');
    expect(userDisplayName(user({ id: 'plainid' }))).toBe('plainid');
  });

  it('owner and global admin are install-wide roles only; a scoped admin is neither', () => {
    expect(userIsOwner(user({ roles: [role('owner')] }))).toBe(true);
    expect(userIsGlobalAdmin(user({ roles: [role('admin')] }))).toBe(true);
    const scoped = user({ roles: [role('admin', 'ag-1'), role('owner', 'ag-2')] });
    expect(userIsOwner(scoped)).toBe(false);
    expect(userIsGlobalAdmin(scoped)).toBe(false);
  });

  it('summarizes every role, with counts and plurals', () => {
    expect(userRoleSummary(user())).toBe('no roles');
    expect(userRoleSummary(user({ roles: [role('owner')] }))).toBe('owner');
    expect(
      userRoleSummary(
        user({
          roles: [role('admin'), role('admin', 'a'), role('admin', 'b')],
          memberships: [{ agent_group_id: 'c' }],
        }),
      ),
    ).toBe('global admin · admin · 2 groups · member · 1 group');
  });

  it('finds a membership by agent group', () => {
    const u = user({ memberships: [{ agent_group_id: 'a' }, { agent_group_id: 'b' }] });
    expect(findMembership(u, 'b')).toEqual({ agent_group_id: 'b' });
    expect(findMembership(u, 'z')).toBeUndefined();
  });
});
