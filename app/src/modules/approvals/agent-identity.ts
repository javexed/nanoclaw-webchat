/**
 * Map a gateway's external agent identity back to the agent group it belongs to.
 *
 * Normally they are the same string: the gateway registers each session under
 * its agent group id. A module that re-points the identity at spawn (the seam's
 * agent-identity resolver — per-member credentials use a derived
 * `user-creds-…` identity so each member's own secret is injected) must also
 * say which group such an identity belongs to, or the gateway's approval
 * requests for it cannot be routed: core only knows agent group ids.
 *
 * One fallback, registered by the module that derives the identities.
 */
import { getAgentGroup } from '../../db/agent-groups.js';

type AgentGroupFallback = (externalId: string) => string | null | Promise<string | null>;
let fallback: AgentGroupFallback | null = null;

export function registerApprovalAgentGroupFallback(fn: AgentGroupFallback): void {
  fallback = fn;
}

/**
 * The agent group id for an external identity: itself when it already names a
 * group, else what the registered fallback says, else the identity unchanged —
 * so an unknown identity still fails the caller's own ownership check.
 */
export async function resolveApprovalAgentGroup(externalId: string): Promise<string> {
  if (!externalId) return externalId;
  try {
    if (await getAgentGroup(externalId)) return externalId;
    return (fallback ? await fallback(externalId) : null) ?? externalId;
    // eslint-disable-next-line no-catch-all/no-catch-all -- never throw: a throw here leaves the gateway's request pending
  } catch {
    return externalId;
  }
}
