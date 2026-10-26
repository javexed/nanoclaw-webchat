/**
 * Instruction guard — an agent's edits to its own standing instructions take
 * effect only after a human approves them.
 *
 * The group folder (`/workspace/agent`) and the provider's home directory
 * (`/home/node/.claude`, `/home/node/.codex`) are mounted read-write, and some
 * files in them load into EVERY later session: the group persona, and the
 * provider's user-level instruction file. A single prompt-injected turn that
 * writes there changes the agent for good, silently. Memory stays freely
 * writable — gating it would end memory — but these few files are standing
 * policy, so a change to one waits for an owner or admin.
 *
 * How: the host keeps the last approved content of each file in a store that
 * no container mounts (`data/instruction-baselines/<agent-group-id>/`). Every
 * spawn, before the project document is composed, each file is compared with
 * its baseline. A difference is moved aside as a HELD copy, the approved
 * content is put back, and one approval card goes out with a compact diff. The
 * session about to run is told its edit is waiting. Approve writes the held
 * content into the file and the baseline and restarts the group once it is
 * idle; reject (or expiry) drops the held copy.
 *
 * First sight — a file with no baseline yet — adopts what is there (trust on
 * first use), so an existing install sees no change in behaviour. Host-side
 * writers that are themselves the owner acting (the webchat instructions
 * editor, a template restamp) record the new baseline as they write.
 *
 * Files are read and replaced through an AnchoredDir: a symlink, FIFO or
 * directory the agent planted under one of these names is refused, never
 * followed, and cleared so the approved content can go back.
 */
import { audit } from '../../audit.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { INSTRUCTION_CHANGE_ACTION, instructionChange, parsePayload } from './guard.js';
import { digest, dropHeld, fileSpec, heldPath, putContent, readJson, saveBaseline, type Held } from './store.js';

registerApprovalHandler(INSTRUCTION_CHANGE_ACTION, async ({ session, payload, approval, notify }) => {
  const decision = await guard(instructionChange, {
    actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
    resource: { agentGroupId: String(payload.agentGroupId), file: String(payload.fileId) },
    payload,
    grant: approval,
  });
  if (decision.effect !== 'allow') {
    await notify(`Your instruction change was not applied: ${decision.reason}.`);
    return;
  }
  if (payload.agentGroupId !== session.agent_group_id) {
    await notify('Your instruction change was not applied: it belongs to another agent.');
    return;
  }
  const file = fileSpec(String(payload.fileId));
  const sha256 = String(payload.sha256);
  const held = readJson<Held>(heldPath(session.agent_group_id, file.id, sha256));
  const group = await getAgentGroup(session.agent_group_id);
  if (!held || !group || digest(held.content) !== sha256) {
    await notify(`Your edit to ${file.label} was approved, but the held copy is gone. Make the change again.`);
    return;
  }
  putContent(group, file, held.content);
  saveBaseline(group.id, file.id, held.content);
  dropHeld(group.id, file.id, sha256);
  audit({
    type: 'instructions.applied',
    actor: `agent:${group.id}`,
    action: INSTRUCTION_CHANGE_ACTION,
    effect: 'allow',
    detail: { agentGroupId: group.id, file: file.id, sha256, approvalId: approval.approval_id },
  });
  // Loaded here, not at the top: it reaches back into the container runner,
  // which imports this module.
  const { restartAgentGroupContainersWhenIdle } = await import('../../container-restart-idle.js');
  await restartAgentGroupContainersWhenIdle(group.id, 'standing instructions change approved');
  await notify(`Your edit to ${file.label} was approved. It takes effect when your container restarts.`);
});

registerApprovalResolvedHandler(({ approval, outcome }) => {
  if (approval.action !== INSTRUCTION_CHANGE_ACTION || outcome !== 'reject') return;
  const payload = parsePayload(approval.payload);
  if (typeof payload.agentGroupId !== 'string') return;
  try {
    dropHeld(payload.agentGroupId, String(payload.fileId), String(payload.sha256));
  } catch (err) {
    log.warn('Could not drop a rejected held instruction change', { approvalId: approval.approval_id, err });
  }
});
