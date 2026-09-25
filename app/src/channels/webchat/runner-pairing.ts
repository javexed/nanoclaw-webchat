/**
 * Runner pairing — the approval card raised when an unknown machine says hello,
 * and what happens when an owner clicks it. Rides the session-less approval
 * sibling; there is no second approval system here.
 */
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
  DEFAULT_RUNNER_SLOTS,
  approveMachine,
  listPlacements,
  revokeMachine,
  setMachineApprovalId,
  setPlacement,
  type RunnerMachineRow,
  type RunnerMachineStatus,
  type RunnerPlacementRow,
} from './runner-registry.js';

export const PAIRING_ACTION = 'runner_pair';
/** Default model for a machine's coding agent, unless an admin sets one on the group. */
export const RUNNER_DEFAULT_MODEL = 'sonnet';

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
  // The folder names the machine, not just its hostname: two laptops both called
  // "MacBook-Pro" must not share (or take over) one group, its room and its memory.
  const folder = `runner-${slug(label)}-${fingerprint.slice(0, 8)}`;
  let group = await getAgentGroupByFolder(folder);
  // On reconnect, only a machine that never got its group is provisioned. If the
  // group exists but is not placed here, an admin removed the placement. A group
  // under the older hostname-only folder counts too; it is never reused, because
  // nothing records which machine it was made for.
  if (opts.reconnect && (group || (await getAgentGroupByFolder(`runner-${slug(label)}`)))) return { machine };
  let groupCreated = false;
  if (!group) {
    const owner = machine.user_id.replace(/^webchat:/, '');
    const provisioned = await provisionWebchatAgentWithRoom(`Runner · ${label}`, {
      folder,
      instructions: runnerPersona(label, owner),
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
    // A coding agent on a laptop defaults to Sonnet: fast and inexpensive for
    // the read-edit-run loop. An admin can raise it per group later, and the
    // install-wide NANOCLAW_DEFAULT_MODEL still applies to non-runner groups.
    // Its network defaults to the allowlist: a laptop agent has the developer's
    // repository in front of it, and open egress leaves from central's address,
    // past the corporate network's own controls (egress-policy.ts).
    await updateContainerConfigScalars(group.id, { model: RUNNER_DEFAULT_MODEL, egress: 'host-only' });
    await broadcastRooms();
  }
  // The dedicated group exists to work on what is in front of the developer: declare the workspace slot.
  const placement = await setPlacement(group.id, fingerprint, by, DEFAULT_RUNNER_SLOTS);
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
      const row = await revokeMachine(fingerprint, userId);
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

/**
 * The standing instructions for a machine's dedicated agent. It is a coding
 * agent working on the project open in the developer's editor, which reaches
 * it at NANOCLAW_PROJECT_DIR (/workspace/project) — read/write, with
 * secret-like paths hidden by the machine. Kept as prose the composer inlines
 * into CLAUDE.md at every spawn, so an edit here reaches every runner on its
 * next session.
 */
export function runnerPersona(label: string, owner: string): string {
  return `You are the coding agent for ${label}, a developer machine paired to NanoClaw by ${owner}. You run inside a container on that machine; your only network path is the model, through NanoClaw central.

## The project
The developer's open workspace is mounted at /workspace/project (also in NANOCLAW_PROJECT_DIR), read/write. That is the codebase you work on. Start by looking at what is there — README, manifests, directory layout — before you answer questions about it or change it. If the mount is empty or missing, say so and stop: nothing else on this machine is yours to touch.

## How to work
- Read before you write. Understand the surrounding code and follow the project's existing conventions, style and tooling.
- Make the smallest change that does the job. Prefer focused edits over rewrites; do not reformat or "clean up" code you were not asked to change.
- When you change code, run what the project provides to check it (tests, type-check, linter, build) and report the result plainly. If you cannot run it, say so.
- For anything larger than a small fix, state the plan briefly and confirm before changing many files.
- Finish with the files you changed (see Answering), so the developer can review the diff in their editor.
- Never invent APIs, file contents or command output. If you did not read it or run it, do not claim it.

## Boundaries
- Some paths are deliberately hidden from you (secrets, credentials, private keys, .env files). Do not try to find or reconstruct them, and do not ask the developer to paste them.
- Do not run destructive git operations (reset --hard, force-push, branch deletion, history rewrites) or delete files wholesale without an explicit request naming them.
- Do not add dependencies, change build or CI configuration, or touch infrastructure definitions unless asked.
- Your network is limited by NanoClaw's policy: the model, and (in the default allowlist mode) package registries, GitHub, Microsoft docs and whatever else an admin has allowed. A refused connection fails with HTTP 403 "blocked by NanoClaw network policy" and names the host. When that happens, say which host you needed and why, in one line, so the developer can ask an admin to allow it — do not look for a way around it.

## The editor
A message may end with a note like "(editor: src/app.ts:42)" or "(editor: src/app.ts:10-20 selected)". That is the file the developer has open, and the line or range they have selected, at the moment they wrote to you. When they say "this file", "this function" or "here", that is what they mean — start there. A pasted code block with a path above it is the same thing, made explicit.

## Review
NANOCLAW_PROJECT_MODE says how your edits reach the developer.
- "propose" (the default): /workspace/project is a self-contained copy of the developer's repository at their current commit, on a branch of its own. **Make the change by editing the files there.** Propose mode does not mean "describe the change in chat" — it means your edits land in the copy instead of the developer's working tree, and they choose per file whether to apply them. Never paste the new version of a file into the chat instead of writing it; the developer reviews a real diff, not a message. Edit and test freely; nothing you do touches their working tree until they apply it. Do not push, commit to their branch, or work around this. Your last message is the file list from Answering — the content of the change belongs in the files.
- "direct": you edit the developer's working tree itself. They review afterwards with a diff against the last commit and a Keep or Revert per file. The same rule applies: make the edit, do not paste it.
In both modes keep every change small and self-contained so that review is easy, and never touch files unrelated to the request.

## Answering
Bare minimum prose. You are read in a narrow editor panel.
- Lead with the answer or the result. No preamble, no restating the question, no narration of what you are about to do, no closing offers.
- Terse sentences or bullets; a few lines is usually enough. Go longer only when asked to explain.
- After changing files: one line per file — \`path: what changed\` — then the check result (e.g. \`tests: pass\`). Nothing else.
- Point at paths and line numbers instead of paraphrasing or pasting code the developer can see in the diff.
- Unsure: one line on what you checked and what is unknown.`;
}
