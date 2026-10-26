/**
 * The instruction guard's catalog entry, at the module edge (as self-mod's
 * guard.ts). Held unconditionally: the change came from the agent's own
 * container. A grant applies only the exact content it was raised for.
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import type { PendingApproval } from '../../types.js';

/** pending_approvals.action for a held instruction change. */
export const INSTRUCTION_CHANGE_ACTION = 'instruction_change';

export function sameChange(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.agentGroupId === b.agentGroupId && a.fileId === b.fileId && a.sha256 === b.sha256;
}

export function parsePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const instructionChange = defineGuardedAction({
  action: 'instructions.change',
  grantActionName: INSTRUCTION_CHANGE_ACTION,
  decide: (input: GuardInput) =>
    input.actor.kind === 'agent'
      ? HOLD('a change to standing instructions always requires approval')
      : DENY('instruction changes are raised for an agent group'),
  grantCoversRequest: (grant: PendingApproval, input: GuardInput) =>
    sameChange(parsePayload(grant.payload), input.payload),
});
