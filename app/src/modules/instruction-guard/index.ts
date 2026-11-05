/**
 * Instruction guard — an agent's edits to its own standing instructions take
 * effect only after a human approves them.
 *
 * The group folder (`/workspace/agent`), the provider's home directory
 * (`/home/node/.claude`, `/home/node/.codex`) and the session folder
 * (`/workspace`) are mounted read-write, and some files in them load into
 * EVERY later session or query: the group persona, CLAUDE.md / AGENTS.md
 * files (including CLAUDE.md files in subfolders of the project), `.claude`
 * rules, subagents, output styles, skills and slash commands, `.mcp.json`,
 * and settings.json (whose hooks run commands). A single prompt-injected turn
 * that writes there changes the agent for good, silently. Memory stays freely
 * writable — gating it would end memory — but these files are standing
 * policy, so a change to one waits for an owner or admin. The list is
 * GUARDED_FILES in ./store.ts; a directory (rules, agents, output styles,
 * skills, commands) is guarded as one unit, and so are the subfolder
 * CLAUDE.md files.
 *
 * Two surfaces are read-only in the container instead: the composed project
 * document (`/workspace/agent/CLAUDE.md`, rewritten by the host every spawn)
 * and the user-scope skills directory (`~/.claude/skills`), which only the
 * host writes — an agent proposes a skill through its draft tool.
 *
 * How: the host keeps the last approved content of each file in a store that
 * no container mounts (`data/instruction-baselines/<agent-group-id>/`).
 *
 *  - Every spawn, before the project document is composed, each file is
 *    compared with its baseline. A difference is moved aside as a HELD copy,
 *    the approved content is put back, and one approval card goes out with a
 *    compact diff. The session about to run is told its edit is waiting.
 *  - Between spawns the same comparison runs in the container before every
 *    query (container/agent-runner/src/instruction-guard.ts): the host writes
 *    the approved contents to `data/v2-sessions/<id>/.instruction-baseline/`,
 *    mounted read-only, and the runner restores any difference and leaves the
 *    agent's version in the session folder's `.instruction-proposals/`. The
 *    next spawn turns those into held copies and cards. Without this a
 *    long-lived container would load an edit at its next turn.
 *  - Files in the session folder itself (`/workspace/CLAUDE.md`, ...) are
 *    never approved: Claude Code reads CLAUDE.md files above its working
 *    directory, so any there is cleared without a card.
 *
 * Approve writes the held content into the file and the baseline (which also
 * reaches running containers through the snapshot) and restarts the group
 * once it is idle; reject (or expiry) drops the held copy, and a reject also
 * keeps the same content from raising another card for a day.
 *
 * First sight — a file with no baseline yet — adopts what is there (trust on
 * first use), so an existing install sees no change in behaviour. Host-side
 * writers that are themselves the owner acting (the webchat instructions
 * editor, a template restamp, the model settings writer) record the new
 * baseline as they write; the host's own settings reconcile at spawn is
 * folded into the baseline before comparing.
 *
 * Files are read and replaced through an AnchoredDir: a symlink, FIFO or
 * directory the agent planted under one of these names — or in place of a
 * directory above one — is refused, never followed, and cleared so the
 * approved content can go back.
 */
import { audit } from '../../audit.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { INSTRUCTION_CHANGE_ACTION, instructionChange, parsePayload } from './guard.js';
import {
  digest,
  dropHeld,
  fileSpec,
  heldPath,
  putContent,
  readJson,
  recordRejected,
  saveBaseline,
  type Held,
} from './store.js';

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
    // The same content is reverted without a new card for a while.
    recordRejected(payload.agentGroupId, String(payload.fileId), String(payload.sha256));
  } catch (err) {
    log.warn('Could not drop a rejected held instruction change', { approvalId: approval.approval_id, err });
  }
});
