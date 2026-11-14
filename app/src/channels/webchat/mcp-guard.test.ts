/**
 * MCP calls through the relay: tools that need approval are held for a card,
 * an approval lets exactly that call through once, other tools pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cards = vi.hoisted(() => ({
  raised: [] as Array<Record<string, unknown>>,
  handlers: new Map<string, Function>(),
  resolved: [] as Function[],
  /** Which sessions have a running container, by id (the rest are idle). */
  running: new Set<string>(),
}));
vi.mock('../../modules/approvals/primitive.js', () => ({
  requestApproval: async (o: Record<string, unknown>) => void cards.raised.push(o),
  registerApprovalHandler: (action: string, h: Function) => void cards.handlers.set(action, h),
  registerApprovalResolvedHandler: (h: Function) => void cards.resolved.push(h),
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: async (g: string) =>
    g === 'ag-none'
      ? []
      : [
          { id: 's-old', last_active: '2026-01-01', status: 'active' },
          { id: 's-new', last_active: '2026-02-01', status: 'active' },
          { id: 's-closed', last_active: '2026-03-01', status: 'closed' },
        ],
}));
vi.mock('../../container-runner.js', () => ({ isContainerRunning: (id: string) => cards.running.has(id) }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: async () => ({ name: 'QA Agent' }) }));
vi.mock('../../audit.js', () => ({ audit: () => undefined }));

const { __resetMcpGuardForTest, callKey, decide, decideAll, MCP_TOOL_ACTION, toolCalls } =
  await import('./mcp-guard.js');

const server = { id: 'srv', name: 'Tosca', approval_tools: JSON.stringify(['check_in_all']) } as never;
const call = (name: string, args: unknown = { a: 1, b: 2 }) => ({ id: 7, name, args });

beforeEach(() => {
  __resetMcpGuardForTest();
  cards.raised.length = 0;
  cards.running.clear();
});

const approve = async (payload: unknown) => cards.handlers.get(MCP_TOOL_ACTION)!({ payload, notify: vi.fn() });
const reject = async (payload: unknown) => {
  for (const h of cards.resolved)
    await h({ approval: { action: MCP_TOOL_ACTION, payload: JSON.stringify(payload) }, outcome: 'reject' });
};

describe('toolCalls', () => {
  it('finds tools/call in one message or a batch, nothing else', () => {
    expect(
      toolCalls({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: { q: 1 } } }),
    ).toEqual([{ id: 1, name: 'x', args: { q: 1 } }]);
    expect(
      toolCalls([
        { method: 'tools/list', id: 1 },
        { method: 'tools/call', id: 2, params: { name: 'y' } },
      ]),
    ).toEqual([{ id: 2, name: 'y', args: {} }]);
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
    expect(cards.raised[0]).toMatchObject({
      action: MCP_TOOL_ACTION,
      title: 'Tosca: check_in_all',
      session: { id: 's-new' },
    });
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

describe('fixes: reject, batches, rooms', () => {
  it('a rejected card clears the wait, so the next call raises a fresh card', async () => {
    await decide('ag', server, call('check_in_all'));
    await reject(cards.raised[0]!.payload);
    const again = await decide('ag', server, call('check_in_all'));
    expect(again.note).toMatch(/a card was sent/);
    expect(cards.raised).toHaveLength(2);
  });

  it("a held batch keeps an approved call's grant for the retry", async () => {
    await decide('ag', server, call('check_in_all'));
    await approve(cards.raised[0]!.payload);
    const other = { id: 'srv', name: 'Tosca', approval_tools: JSON.stringify(['check_in_all', 'wipe']) } as never;
    const both = await decideAll('ag', other, [call('check_in_all'), call('wipe')]);
    expect(both.map((d) => d.decision)).toEqual(['approved', 'held']);
    // The batch did not run, so the grant is still there for the call alone.
    expect(await decide('ag', other, call('check_in_all'))).toEqual({ decision: 'approved' });
  });

  it('identical held calls in one batch raise one card', async () => {
    const d = await decideAll('ag', server, [call('check_in_all'), call('check_in_all')]);
    expect(d.map((x) => x.decision)).toEqual(['held', 'held']);
    expect(cards.raised).toHaveLength(1);
  });

  it('the card goes to the one running session, with the arguments', async () => {
    cards.running.add('s-old');
    await decide('ag', server, call('check_in_all'));
    expect(cards.raised[0]).toMatchObject({ session: { id: 's-old' } });
    expect(String(cards.raised[0]!.question)).toMatch(/```json/);
  });

  it('with several running sessions the caller is unknown: newest room, arguments withheld', async () => {
    cards.running.add('s-old');
    cards.running.add('s-new');
    await decide('ag', server, call('check_in_all', { secret: 'from another room' }));
    expect(cards.raised[0]).toMatchObject({ session: { id: 's-new' } });
    expect(String(cards.raised[0]!.question)).not.toMatch(/from another room/);
    expect(String(cards.raised[0]!.question)).toMatch(/more than one room/);
  });
});
