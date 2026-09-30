/**
 * Runner pairing — the approval card raised when an unknown machine says hello,
 * and what happens when an owner clicks it. Rides the session-less approval
 * sibling; there is no second approval system here.
 */
import { createHash } from 'crypto';

import { audit } from '../../audit.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import type { AgentGroup } from '../../types.js';
import { updateContainerConfigScalars } from '../../db/container-configs.js';
import { grantCreatorAdmin, provisionWebchatAgentWithRoom } from './server/routes-agents.js';
import { broadcastRooms } from './state.js';
import { getPendingApproval } from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerSessionlessApprovalHandler, requestSessionlessApproval } from '../../modules/approvals/sessionless.js';
import {
  approveMachine,
  listPlacements,
  revokeMachine,
  setMachineApprovalId,
  setPlacement,
  type RunnerMachineRow,
  type RunnerMachineStatus,
  type RunnerPlacementRow,
} from './runner-registry.js';
import { runnerToolsPersona } from './runner-persona.js';
import { applyPlacementMode, releasePlacement } from './runner-tools.js';

export const PAIRING_ACTION = 'runner_pair';
/** Default model for a machine's coding agent, unless an admin sets one on the group. */
export const RUNNER_DEFAULT_MODEL = 'sonnet';
/** Network mode of a machine's new dedicated group: "Model only" (egress-policy.ts). */
export const RUNNER_DEFAULT_EGRESS = 'none';

type PairingListener = (fingerprint: string, status: RunnerMachineStatus, by: string) => void;
let listener: PairingListener | null = null;
/** The runner socket registers here so a decision reaches the live connection. */
export function setPairingListener(fn: PairingListener | null): void {
  listener = fn;
}
export function notifyPairingChanged(fingerprint: string, status: RunnerMachineStatus, by: string): void {
  listener?.(fingerprint, status, by);
}

/** Raise the pairing card once per pending machine; a reconnect while the card is open raises nothing. */
export async function ensurePairingRequested(machine: RunnerMachineRow, displayName: string): Promise<void> {
  if (machine.status !== 'pending') return;
  if (machine.approval_id && (await getPendingApproval(machine.approval_id))) return;
  const where = `${machine.hostname || 'a machine'} (${machine.os || '?'}/${machine.arch || '?'}, ${machine.runner_version || 'runner'})`;
  const approvalId = await requestSessionlessApproval({
    action: PAIRING_ACTION,
    payload: {
      fingerprint: machine.fingerprint,
      userId: machine.user_id,
      hostname: machine.hostname,
      os: machine.os,
      arch: machine.arch,
      runner: machine.runner_version,
    },
    title: 'Runner pairing request',
    question:
      `${displayName} wants to pair ${where} as a runner. ` +
      'Approving lets agent groups be placed on that machine; nothing runs there until a placement is made.',
  });
  if (!approvalId) {
    log.warn('Runner pairing: could not raise the approval card', {
      fingerprint: machine.fingerprint.slice(0, 12),
      userId: machine.user_id,
    });
    return;
  }
  await setMachineApprovalId(machine.fingerprint, approvalId);
  audit({
    type: 'runner.pair.request',
    actor: `human:${machine.user_id}`,
    effect: 'allow',
    detail: { fingerprint: machine.fingerprint, hostname: machine.hostname, approvalId },
  });
}

/** Default on: approving a machine gives it a dedicated agent group. `WEBCHAT_RUNNER_AUTO_GROUP=false` turns it off. */
export function runnerAutoGroupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEBCHAT_RUNNER_AUTO_GROUP !== 'false';
}

const slug = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'machine';

/** A machine's dedicated group folder: 60 characters at most (group folders stop at 63). */
export function runnerGroupFolder(label: string, fingerprint: string): string {
  return `runner-${slug(label).slice(0, 20)}-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)}`;
}

export interface ApprovalOutcome {
  machine: RunnerMachineRow | undefined;
  /** The dedicated agent group (created or reused) — absent when auto-group is off or provisioning failed. */
  group?: AgentGroup;
  placement?: RunnerPlacementRow;
  groupCreated?: boolean;
}

/**
 * Approve a machine and, by default, give it a dedicated agent group with its
 * own room, placed on that machine. One entry point for the approval card AND
 * the admin API so both paths produce the same result. Re-approving a machine
 * that was revoked reuses its group (matched by folder) instead of minting a
 * second one — the group's room, memory and history belong to that laptop.
 */
export async function completeApproval(fingerprint: string, by: string): Promise<ApprovalOutcome> {
  const machine = await approveMachine(fingerprint, by);
  if (!machine) return { machine: undefined };
  audit({
    type: 'runner.pair.approve',
    actor: `human:${by}`,
    effect: 'allow',
    detail: { fingerprint, hostname: machine.hostname, boundTo: machine.user_id },
  });
  notifyPairingChanged(fingerprint, 'approved', by);
  return ensureDedicatedGroup(machine, by);
}

/**
 * Give an approved machine its dedicated agent group + placement if it has
 * none. Called on approval and again on every hello from an approved machine,
 * so a machine approved before this feature existed — or while provisioning
 * failed — gets its agent on its next connect. No-op when auto-group is off.
 */
export async function ensureDedicatedGroup(
  machine: RunnerMachineRow,
  by: string,
  opts: { reconnect?: boolean } = {},
): Promise<ApprovalOutcome> {
  const fingerprint = machine.fingerprint;
  if (machine.status !== 'approved' || !runnerAutoGroupEnabled()) return { machine };
  // Already has a placed group (approve clicked twice, placed by hand, or reconciled earlier)? Nothing to add.
  const existing = (await listPlacements()).find((p) => p.fingerprint === fingerprint);
  if (existing) return { machine, placement: existing };

  const label = machine.hostname || fingerprint.slice(0, 12);
  // The folder names the machine by its WHOLE fingerprint (hashed to fit a
  // folder name), which the registry binds to one user: a group found under it
  // was made for this machine and this person. Hostname and a fingerprint
  // prefix are both what a runner says about itself; a folder built from those
  // let a lookalike be handed another laptop's group, room and workspace on
  // approval.
  const folder = runnerGroupFolder(label, fingerprint);
  let group = await getAgentGroupByFolder(folder);
  // On reconnect, only a machine that never got its group is provisioned. If the
  // group exists but is not placed here, an admin removed the placement. Groups
  // under the older folders (hostname only, then hostname + 8 characters of
  // fingerprint) count too; they are never reused, because nothing records
  // which machine they were made for.
  const older = [`runner-${slug(label)}`, `runner-${slug(label)}-${fingerprint.slice(0, 8)}`];
  if (opts.reconnect && (group || (await Promise.all(older.map((f) => getAgentGroupByFolder(f)))).some(Boolean)))
    return { machine };
  let groupCreated = false;
  if (!group) {
    const owner = machine.user_id.replace(/^webchat:/, '');
    const provisioned = await provisionWebchatAgentWithRoom(`Runner · ${label}`, {
      folder,
      instructions: runnerToolsPersona(label, owner),
    });
    if ('error' in provisioned) {
      log.warn('Runner auto-group: provisioning failed — machine approved without a dedicated group', {
        fingerprint: fingerprint.slice(0, 12),
        error: provisioned.error,
      });
      return { machine };
    }
    group = provisioned.group;
    groupCreated = true;
    await grantCreatorAdmin(machine.user_id, group.id);
    // A coding agent for a laptop defaults to Sonnet: fast and inexpensive for
    // the read-edit loop. An admin can raise it per group later, and the
    // install-wide NANOCLAW_DEFAULT_MODEL still applies to non-runner groups.
    // Its network starts at Model only: the agent has the developer's
    // repository in front of it, and anything it reaches leaves from central's
    // address, past the corporate network's own controls (egress-policy.ts).
    // An admin widens it per group (Allowlist, Open) when the work needs it.
    await updateContainerConfigScalars(group.id, { model: RUNNER_DEFAULT_MODEL, egress: RUNNER_DEFAULT_EGRESS });
    await broadcastRooms();
  }
  // The dedicated group exists to work on what is in front of the developer, through the laptop tools.
  const placement = await setPlacement(group.id, fingerprint, by);
  await applyPlacementMode(group.id, placement);
  audit({
    type: 'runner.group.place',
    actor: `human:${by}`,
    effect: 'allow',
    detail: {
      fingerprint,
      hostname: machine.hostname,
      agentGroupId: group.id,
      folder: group.folder,
      created: groupCreated,
    },
  });
  log.info('Runner approved with dedicated agent group', {
    hostname: machine.hostname,
    group: group.folder,
    created: groupCreated,
  });
  return { machine, group, placement, groupCreated };
}

let registered = false;
/** Idempotent: the socket setup calls it, tests may call it again. */
export function registerPairingApprovalHandler(): void {
  if (registered) return;
  registered = true;
  registerSessionlessApprovalHandler(PAIRING_ACTION, async ({ payload, outcome, userId }) => {
    const fingerprint = String(payload.fingerprint ?? '');
    if (!fingerprint) return;
    if (outcome === 'approve') {
      await completeApproval(fingerprint, userId);
    } else {
      // Rejecting drops the machine's placements; each group gets its own configuration back.
      const placed = (await listPlacements()).filter((p) => p.fingerprint === fingerprint);
      const row = await revokeMachine(fingerprint, userId);
      for (const p of placed) await releasePlacement(p.agent_group_id, p);
      audit({
        type: 'runner.pair.reject',
        actor: `human:${userId}`,
        effect: 'deny',
        detail: { fingerprint, hostname: row?.hostname ?? null, boundTo: row?.user_id ?? null },
      });
      notifyPairingChanged(fingerprint, 'revoked', userId);
    }
  });
}
