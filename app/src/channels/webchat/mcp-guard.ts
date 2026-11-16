/**
 * MCP tool calls through the relay (mcp-relay.ts): every call is audited, and
 * a call to a tool an owner marked "needs approval" (approval_tools on the
 * server) is held for a card in the agent's room.
 *
 * A held call is answered at once with a tool error that says so; nothing
 * blocks while the card waits. Approving grants exactly that call (same tool,
 * same arguments) once, for an hour, and tells the agent to call it again;
 * rejecting tells the agent no (the approvals module does that). Grants live
 * in memory: one approved but not yet used before a restart asks again.
 */
import { createHash } from 'crypto';

import { audit } from '../../audit.js';
import { isContainerRunning } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import {
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  requestApproval,
} from '../../modules/approvals/primitive.js';
import { approvalTools, type WebchatMcpServer } from './mcp-registry.js';

export const MCP_TOOL_ACTION = 'mcp_tool_call';
const GRANT_MS = 60 * 60_000;
const PENDING_MS = 30 * 60_000;
/** Arguments shown on the card, at most; a longer call is refused rather than shown in part. */
const CARD_ARGS_MAX = 2500;

export interface ToolCall {
  id: unknown;
  name: string;
  args: unknown;
}

/** The tools/call requests in a JSON-RPC body (one message or a batch). */
export function toolCalls(body: unknown): ToolCall[] {
  const msgs = Array.isArray(body) ? body : [body];
  const out: ToolCall[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const r = m as { method?: unknown; id?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (r.method !== 'tools/call' || typeof r.params?.name !== 'string') continue;
    out.push({ id: r.id, name: r.params.name, args: r.params.arguments ?? {} });
  }
  return out;
}

/** Key order must not matter: the same call spelled differently is the same call. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

export const callKey = (agentGroupId: string, serverId: string, c: ToolCall): string =>
  createHash('sha256')
    .update(`${agentGroupId}\n${serverId}\n${c.name}\n${canonical(c.args)}`)
    .digest('hex');

const grants = new Map<string, number>();
const pending = new Map<string, number>();

export type Decision = 'allow' | 'approved' | 'held' | 'refused';

type Outcome = { decision: Decision; note?: string };

/** One call, decided alone (a batch of one). */
export async function decide(
  agentGroupId: string,
  server: WebchatMcpServer,
  c: ToolCall,
  now = Date.now(),
): Promise<Outcome> {
  return (await decideAll(agentGroupId, server, [c], now))[0]!;
}

/**
 * What happens to each call of one request: allowed (no approval needed),
 * approved (a grant is used up), held (a card is raised, or already waits) or
 * refused. Decided in two passes so a request that is held as a whole has no
 * side effects on its other calls: a grant is used only when the request will
 * actually run, and identical held calls in one request raise one card.
 */
export async function decideAll(
  agentGroupId: string,
  server: WebchatMcpServer,
  calls: ToolCall[],
  now = Date.now(),
): Promise<Outcome[]> {
  ensureMcpGuardHandlers();
  const gated = approvalTools(server);
  // Pass 1: look, don't touch.
  const looks = calls.map((c) => {
    if (!gated.includes(c.name)) return { kind: 'allow' as const };
    const key = callKey(agentGroupId, server.id, c);
    if ((grants.get(key) ?? 0) > now) return { kind: 'grant' as const, key };
    if ((pending.get(key) ?? 0) > now) return { kind: 'pending' as const, key };
    const args = JSON.stringify(c.args, null, 2);
    if (args.length > CARD_ARGS_MAX) return { kind: 'too-long' as const, key, args };
    return { kind: 'card' as const, key, args };
  });
  const runs = looks.every((l) => l.kind === 'allow' || l.kind === 'grant');
  // Pass 2: act. A request that runs uses its grants; one that is held raises
  // its cards (once per distinct call) and leaves its grants for the retry.
  const raised = new Map<string, boolean>();
  const out: Outcome[] = [];
  for (const [i, l] of looks.entries()) {
    const c = calls[i]!;
    if (l.kind === 'allow') out.push({ decision: 'allow' });
    else if (l.kind === 'grant') {
      if (runs) grants.delete(l.key);
      out.push({ decision: 'approved' });
    } else if (l.kind === 'pending')
      out.push({
        decision: 'held',
        note: `${c.name} is waiting for an owner's approval already. Do not call it again until you are told the result.`,
      });
    else if (l.kind === 'too-long')
      out.push({
        decision: 'refused',
        note: `${c.name} needs an owner's approval, and its arguments are too long to show on a card (${l.args.length} characters, at most ${CARD_ARGS_MAX}). Use smaller arguments.`,
      });
    else {
      let ok = raised.get(l.key);
      if (ok === undefined) {
        ok = await raiseCard(agentGroupId, server, c, l.key, l.args);
        raised.set(l.key, ok);
        if (ok) pending.set(l.key, now + PENDING_MS);
      }
      out.push(
        ok
          ? {
              decision: 'held',
              note: `${c.name} needs an owner's approval; a card was sent. You will be told the result: once approved, call it again with exactly the same arguments.`,
            }
          : {
              decision: 'refused',
              note: `${c.name} needs an owner's approval, and no card could be raised (no active session).`,
            },
      );
    }
  }
  return out;
}

/**
 * The card goes to the room of the session making the call. The relay token
 * names the agent group, not the session, so the caller is inferred: the one
 * session with a live container. When several run at once the caller is
 * unknown — the card goes to the most recently active one WITHOUT the
 * arguments, since they may belong to a conversation in another room.
 */
async function raiseCard(
  agentGroupId: string,
  server: WebchatMcpServer,
  c: ToolCall,
  key: string,
  args: string,
): Promise<boolean> {
  const sessions = (await getSessionsByAgentGroup(agentGroupId))
    .filter((x) => x.status === 'active')
    .sort((a, b) => String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')));
  const running = sessions.filter((x) => isContainerRunning(x.id));
  const session = running.length === 1 ? running[0] : (running[0] ?? sessions[0]);
  if (!session) return false;
  const showArgs = running.length === 1 || (running.length === 0 && sessions.length === 1);
  const agentName = (await getAgentGroup(agentGroupId))?.name ?? agentGroupId;
  await requestApproval({
    session,
    agentName,
    action: MCP_TOOL_ACTION,
    payload: { key, serverId: server.id, server: server.name, tool: c.name },
    title: `${server.name}: ${c.name}`,
    question: showArgs
      ? `"${agentName}" wants to call ${c.name} on ${server.name}:\n\`\`\`json\n${args}\n\`\`\``
      : `"${agentName}" wants to call ${c.name} on ${server.name}. It is active in more than one room, so the arguments are not shown here.`,
  });
  return true;
}

/**
 * The approval handlers, registered once: when the relay starts (so a card
 * raised before a restart can still be answered) and before any decision.
 * Not at import time — the approvals module may still be initialising then
 * (an import cycle through the relay), and registering would throw.
 */
let registered = false;
export function ensureMcpGuardHandlers(): void {
  if (registered) return;
  registered = true;
  registerApprovalHandler(MCP_TOOL_ACTION, async ({ payload, notify }) => {
    const key = String(payload.key ?? '');
    if (!key) return;
    pending.delete(key);
    grants.set(key, Date.now() + GRANT_MS);
    await notify(
      `Approved: call ${String(payload.tool)} on ${String(payload.server)} again with exactly the same arguments (within an hour).`,
    );
  });

  // A rejected (or expired) card clears its wait, so the next identical call
  // raises a fresh card instead of being told to wait for a decision already made.
  registerApprovalResolvedHandler(({ approval, outcome }) => {
    if (approval.action !== MCP_TOOL_ACTION || outcome !== 'reject') return;
    try {
      const key = String((JSON.parse(approval.payload) as { key?: unknown }).key ?? '');
      if (key) pending.delete(key);
    } catch {
      /* malformed payload: the wait simply lapses after PENDING_MS */
    }
  });
}

/** One audit entry per call: who, which server and tool, and what happened to it. */
export function auditCall(agentGroupId: string, server: WebchatMcpServer, c: ToolCall, outcome: string): void {
  audit({
    type: 'mcp.tool-call',
    actor: `agent-group:${agentGroupId}`,
    effect: outcome === 'held' || outcome === 'refused' ? 'deny' : 'allow',
    detail: { server: server.name, serverId: server.id, tool: c.name, outcome },
  });
}

/** A JSON-RPC tool result that tells the agent why its call did not run. */
export function heldResult(id: unknown, text: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text }], isError: true } };
}

export function __resetMcpGuardForTest(): void {
  grants.clear();
  pending.clear();
  log.debug('mcp-guard reset');
}
