/**
 * MCP calls through the relay: tools that need approval are held for a card,
 * an approval lets exactly that call through once, other tools pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cards = vi.hoisted(() => ({ raised: [] as Array<Record<string, unknown>>, handlers: new Map<string, Function>() }));
vi.mock('../../modules/approvals/primitive.js', () => ({
  requestApproval: async (o: Record<string, unknown>) => void cards.raised.push(o),
  registerApprovalHandler: (action: string, h: Function) => void cards.handlers.set(action, h),
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: async (g: string) =>
    g === 'ag-none' ? [] : [{ id: 's-old', last_active: '2026-01-01' }, { id: 's-new', last_active: '2026-02-01' }],
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: async () => ({ name: 'QA Agent' }) }));
vi.mock('../../audit.js', () => ({ audit: () => undefined }));

const { __resetMcpGuardForTest, callKey, decide, MCP_TOOL_ACTION, toolCalls } = await import('./mcp-guard.js');

const server = { id: 'srv', name: 'Tosca', approval_tools: JSON.stringify(['check_in_all']) } as never;
const call = (name: string, args: unknown = { a: 1, b: 2 }) => ({ id: 7, name, args });

beforeEach(() => {
  __resetMcpGuardForTest();
  cards.raised.length = 0;
});

describe('toolCalls', () => {
  it('finds tools/call in one message or a batch, nothing else', () => {
    expect(toolCalls({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: { q: 1 } } })).toEqual([
      { id: 1, name: 'x', args: { q: 1 } },
    ]);
    expect(toolCalls([{ method: 'tools/list', id: 1 }, { method: 'tools/call', id: 2, params: { name: 'y' } }])).toEqual([
      { id: 2, name: 'y', args: {} },
    ]);
    expect(toolCalls({ method: 'initialize' })).toEqual([]);
  });

  it('keys a call by its arguments, whatever their order', () => {
    expect(callKey('ag', 'srv', call('t', { a: 1, b: 2 }))).toBe(callKey('ag', 'srv', call('t', { b: 2, a: 1 })));
    expect(callKey('ag', 'srv', call('t', { a: 1 }))).not.toBe(callKey('ag', 'srv', call('t', { a: 2 })));
  });
});

describe('decide', () => {
  it('lets tools that need no approval through', async () => {
    expect(await decide('ag', server, call('explain_test_case'))).toEqual({ decision: 'allow' });
    expect(cards.raised).toEqual([]);
  });

  it('holds a tool that needs approval: one card, in the newest session, until approved', async () => {
    const first = await decide('ag', server, call('check_in_all'));
    expect(first.decision).toBe('held');
    expect(cards.raised).toHaveLength(1);
    expect(cards.raised[0]).toMatchObject({ action: MCP_TOOL_ACTION, title: 'Tosca: check_in_all', session: { id: 's-new' } });
    expect((await decide('ag', server, call('check_in_all'))).note).toMatch(/waiting for an owner's approval already/);
    expect(cards.raised).toHaveLength(1);

    const notify = vi.fn();
    await cards.handlers.get(MCP_TOOL_ACTION)!({ payload: cards.raised[0]!.payload, notify });
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Approved: call check_in_all on Tosca again/));
    // The approved call runs once; other arguments, or a second run, need a new card.
    expect((await decide('ag', server, call('check_in_all', { a: 9 }))).decision).toBe('held');
    expect(await decide('ag', server, call('check_in_all'))).toEqual({ decision: 'approved' });
    expect((await decide('ag', server, call('check_in_all'))).decision).toBe('held');
  });

  it('refuses when no card can be raised or the arguments are too long to show', async () => {
    expect((await decide('ag-none', server, call('check_in_all'))).decision).toBe('refused');
    expect((await decide('ag', server, call('check_in_all', { blob: 'x'.repeat(3000) }))).decision).toBe('refused');
  });
});
