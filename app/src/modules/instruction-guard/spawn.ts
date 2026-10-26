/**
 * The spawn hook of the instruction guard (see ./index.ts): check, revert,
 * tell the session about to run, raise the approvals. The container runner
 * imports this file, so the approvals module is loaded lazily — it reaches
 * back into the runner, and a module-load cycle there leaves its handler
 * registry uninitialised.
 */
import fs from 'fs';
import path from 'path';

import { MAX_CARD_QUESTION_LENGTH } from '../../channels/ask-question.js';
import { getPendingApprovalsByAction } from '../../db/sessions.js';
import { guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, PendingApproval, Session } from '../../types.js';
import { compactDiff } from './diff.js';
import { INSTRUCTION_CHANGE_ACTION, instructionChange, parsePayload, sameChange } from './guard.js';
import { checkInstructionFiles, dropHeld, groupStore, readJson, type Held, type InstructionChange } from './store.js';

/** A held copy with no pending approval behind it is dropped after this long. */
const ORPHAN_HELD_MS = 60 * 60 * 1000;

const inflight = new Set<string>();

function pruneOrphanHeld(agentGroupId: string, pending: PendingApproval[], keep: string): void {
  const dir = path.join(groupStore(agentGroupId), 'held');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const live = new Set(pending.map((row) => parsePayload(row.payload)).map((p) => `${p.fileId}.${p.sha256}.json`));
  for (const name of names) {
    if (name === keep || live.has(name)) continue;
    const held = readJson<Held>(path.join(dir, name));
    if (held && Date.now() - Date.parse(held.heldAt) < ORPHAN_HELD_MS) continue;
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

async function raiseApproval(group: AgentGroup, session: Session, change: InstructionChange): Promise<void> {
  const payload = { agentGroupId: group.id, fileId: change.file.id, sha256: change.sha256 };
  const key = `${group.id}:${change.file.id}:${change.sha256}`;
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    const pending = await getPendingApprovalsByAction(INSTRUCTION_CHANGE_ACTION);
    pruneOrphanHeld(group.id, pending, `${change.file.id}.${change.sha256}.json`);
    if (pending.some((row) => sameChange(parsePayload(row.payload), payload))) return;

    const decision = await guard(instructionChange, {
      actor: { kind: 'agent', agentGroupId: group.id, sessionId: session.id },
      resource: { agentGroupId: group.id, file: change.file.id },
      payload,
    });
    if (decision.effect !== 'hold') {
      dropHeld(group.id, change.file.id, change.sha256);
      return;
    }
    const title = `Instruction change: ${group.name}`;
    const intro =
      `${group.name} edited ${change.file.label}. The approved version stays in effect until you decide; ` +
      'approving applies this edit and restarts the agent once it is idle.';
    const budget = MAX_CARD_QUESTION_LENGTH - title.length - intro.length - 32;
    const question = `${intro}\n\n\`\`\`diff\n${compactDiff(change.before, change.after, budget)}\n\`\`\``;
    const { requestApproval } = await import('../approvals/index.js');
    await requestApproval({
      session,
      agentName: group.name,
      action: INSTRUCTION_CHANGE_ACTION,
      payload,
      title,
      question,
      approverUserId: decision.approverUserId,
    });
  } finally {
    inflight.delete(key);
  }
}

function noticeText(change: InstructionChange): string {
  if (change.outcome === 'refused') {
    return (
      `${change.file.label} was reset to its approved version (${change.detail}). ` +
      'Standing instruction files must be regular files, and a change to one needs owner approval.'
    );
  }
  return (
    `Your edit to ${change.file.label} was not applied: standing instructions change only after an owner approves. ` +
    'The approved version is back in place and your version is waiting for a decision; you will be told the outcome.'
  );
}

/**
 * The spawn hook: check, revert, tell the session about to run, and raise the
 * approvals. Called before the project document is composed.
 *
 * The approval request is not awaited. It can wake the session (when no
 * approver is reachable it notifies the agent), and a wake issued from inside
 * this session's own spawn would wait on that spawn.
 */
export async function guardStandingInstructions(group: AgentGroup, session: Session): Promise<void> {
  const changes = checkInstructionFiles(group);
  for (const change of changes) {
    try {
      await writeSessionMessage(group.id, session.id, {
        id: `instr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: group.id,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({ text: noticeText(change), sender: 'system', senderId: 'system' }),
        trigger: false,
      });
    } catch (err) {
      log.warn('Could not tell the agent its instruction change is held', { agentGroupId: group.id, err });
    }
    if (change.outcome !== 'held') continue;
    void raiseApproval(group, session, change).catch((err: unknown) => {
      log.error('Instruction change approval could not be raised', {
        agentGroupId: group.id,
        file: change.file.id,
        err,
      });
    });
  }
}
