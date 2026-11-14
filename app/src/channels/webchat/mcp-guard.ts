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
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerApprovalHandler, requestApproval } from '../../modules/approvals/primitive.js';
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
  createHash('sha256').update(`${agentGroupId}\n${serverId}\n${c.name}\n${canonical(c.args)}`).digest('hex');

const grants = new Map<string, number>();
const pending = new Map<string, number>();

export type Decision = 'allow' | 'approved' | 'held' | 'refused';

/**
 * What happens to one call: allowed (no approval needed), approved (a grant
 * is used up), or held (a card is raised, or already waits).
 */
export async function decide(
  agentGroupId: string,
  server: WebchatMcpServer,
  c: ToolCall,
  now = Date.now(),
): Promise<{ decision: Decision; note?: string }> {
  if (!approvalTools(server).includes(c.name)) return { decision: 'allow' };
  const key = callKey(agentGroupId, server.id, c);
  const until = grants.get(key);
  if (until !== undefined && until > now) {
    grants.delete(key);
    return { decision: 'approved' };
  }
  if ((pending.get(key) ?? 0) > now)
    return { decision: 'held', note: `${c.name} is waiting for an owner's approval already. Do not call it again until you are told the result.` };
  const args = JSON.stringify(c.args, null, 2);
  if (args.length > CARD_ARGS_MAX)
    return {
      decision: 'refused',
      note: `${c.name} needs an owner's approval, and its arguments are too long to show on a card (${args.length} characters, at most ${CARD_ARGS_MAX}). Use smaller arguments.`,
    };
  const raised = await raiseCard(agentGroupId, server, c, key, args);
  if (!raised) return { decision: 'refused', note: `${c.name} needs an owner's approval, and no card could be raised (no active session).` };
  pending.set(key, now + PENDING_MS);
  return {
    decision: 'held',
    note: `${c.name} needs an owner's approval; a card was sent. You will be told the result: once approved, call it again with exactly the same arguments.`,
  };
}

async function raiseCard(
  agentGroupId: string,
  server: WebchatMcpServer,
  c: ToolCall,
  key: string,
  args: string,
): Promise<boolean> {
  const sessions = await getSessionsByAgentGroup(agentGroupId);
  const session = sessions.sort((a, b) => String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')))[0];
  if (!session) return false;
  const agentName = (await getAgentGroup(agentGroupId))?.name ?? agentGroupId;
  await requestApproval({
    session,
    agentName,
    action: MCP_TOOL_ACTION,
    payload: { key, serverId: server.id, server: server.name, tool: c.name },
    title: `${server.name}: ${c.name}`,
    question: `"${agentName}" wants to call ${c.name} on ${server.name}:\n\`\`\`json\n${args}\n\`\`\``,
  });
  return true;
}

registerApprovalHandler(MCP_TOOL_ACTION, async ({ payload, notify }) => {
  const key = String(payload.key ?? '');
  if (!key) return;
  pending.delete(key);
  grants.set(key, Date.now() + GRANT_MS);
  await notify(
    `Approved: call ${String(payload.tool)} on ${String(payload.server)} again with exactly the same arguments (within an hour).`,
  );
});

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
