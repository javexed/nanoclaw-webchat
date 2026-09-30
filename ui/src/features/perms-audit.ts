// ── Permission audit helpers ────────────────────────────────────────────────
// Audit-aware lookup driven by the /api/users response shape. `roles[]` carries
// `{kind, agent_group_id, granted_by, granted_at}`, `memberships[]` carries
// `{agent_group_id, added_by, added_at}`. Not in perms.ts: the detail islands
// need these and perms.ts mounts them, so importing it would close a cycle.

export function findRole(u: any, kind: string, agentGroupId: string | null) {
  return u.roles.find((r: any) => r.kind === kind && r.agent_group_id === agentGroupId);
}

export function auditTooltip(audit: any) {
  if (!audit) return '';
  const who = audit.granted_by || audit.added_by || 'system';
  const whenIso = audit.granted_at || audit.added_at || '';
  const when = whenIso ? new Date(whenIso).toLocaleString() : '';
  return `Granted by ${who}${when ? ' on ' + when : ''}`;
}
