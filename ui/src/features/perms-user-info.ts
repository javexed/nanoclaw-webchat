// ── User info helpers ───────────────────────────────────────────────────────
// Pure derivations from one /api/users record: the display name, the role
// predicates, and the summary line. No DOM, no legacy state, no fetches.
//
// A separate module because the PermsUserList island needs them and members.ts
// mounts that island — a component importing members.ts would close a cycle.
// They are the *only* thing in members.ts the component needed, and they were
// already pure, so lifting them is a move rather than a rewrite. members.ts
// re-exports the two that other modules import so no call site changes.
//
// findRole and auditTooltip are the same shape of problem and live next door in
// perms-audit.ts — separate because these describe a user and those describe a
// grant, and the two detail islands need only the latter.

/**
 * Prefer the channel-supplied display name, else extract a readable token from
 * the namespaced id (handle/email after the last colon).
 */
export function userDisplayName(u?: any) {
  if (u.display_name && u.display_name.trim()) return u.display_name.trim();
  const lastColon = u.id.lastIndexOf(':');
  return lastColon >= 0 ? u.id.slice(lastColon + 1) : u.id;
}

export function userIsOwner(u?: any) {
  return !!u.roles.find((r: any) => r.kind === 'owner' && r.agent_group_id === null);
}

export function userIsGlobalAdmin(u?: any) {
  return !!u.roles.find((r: any) => r.kind === 'admin' && r.agent_group_id === null);
}

export function userScopedAdminCount(u?: any) {
  return u.roles.filter((r: any) => r.kind === 'admin' && r.agent_group_id).length;
}

export function userMemberCount(u?: any) {
  return u.memberships.length;
}

export function findMembership(u?: any, agentGroupId?: any) {
  return u.memberships.find((m: any) => m.agent_group_id === agentGroupId);
}

export function userRoleSummary(u?: any) {
  const parts = [];
  if (userIsOwner(u)) parts.push('owner');
  if (userIsGlobalAdmin(u)) parts.push('global admin');
  const sa = userScopedAdminCount(u);
  if (sa) parts.push(`admin · ${sa} group${sa > 1 ? 's' : ''}`);
  const m = userMemberCount(u);
  if (m) parts.push(`member · ${m} group${m > 1 ? 's' : ''}`);
  return parts.join(' · ') || 'no roles';
}
