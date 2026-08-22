/**
 * Approval pre-judge — fail-safe behavior tests.
 *
 * The contract under test: the ONLY path that auto-approves is a configured
 * model + explicit action opt-in + a clean `{"verdict":"approve"}` response.
 * Everything else — feature off, not opted in, never-list, timeout, non-200,
 * garbage output, non-approve verdicts, resolver crash — falls through to a
 * human. All deps are injected; no DB, no network.
 */
import { describe, expect, it, vi } from 'vitest';

import type { WebchatModel } from '../../channels/webchat/db.js';
import type { PendingApproval, Session } from '../../types.js';
import {
  buildApprovalTriageView,
  heuristicFlags,
  isNeverAutoApprovable,
  isUsableJudgeModel,
  maybePrejudgeApproval,
  NEVER_AUTO_APPROVE_ACTIONS,
  parseFlags,
  parseVerdict,
  prejudgeApproval,
  redactForPrompt,
  TRIAGE_FLAGS,
} from './prejudge.js';

const MODEL: WebchatModel = {
  id: 'm1',
  name: 'Local judge',
  kind: 'ollama',
  endpoint: 'http://10.0.0.10:11434',
  model_id: 'llama3.2',
  credential_ref: null,
  created_at: 0,
};

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approval_id: 'appr-1',
    session_id: 'sess-1',
    request_id: 'appr-1',
    action: 'cli_command',
    payload: JSON.stringify({ frame: { command: 'tasks create', args: { name: 'daily digest' } } }),
    created_at: new Date().toISOString(),
    agent_group_id: 'ag-1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: 'CLI: tasks create',
    // Required as of the upstream in this bump (d66ee113, migration 021): a
    // resolved card keeps the text it was approved on instead of re-rendering
    // from live state. Only valid WITH this pin — hence same PR.
    question: '*Agent:* ag-1\n*Action:* tasks create',
    options_json: '[]',
    approver_user_id: null,
    instance: null,
    ...overrides,
  };
}

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function baseDeps(fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
  return {
    fetchFn,
    getModelId: () => 'm1',
    getActions: () => ['cli_command'],
    getModel: (id: string) => (id === 'm1' ? MODEL : undefined),
  };
}

describe('parseVerdict', () => {
  it('approves only an exact approve verdict', async () => {
    expect(parseVerdict('{"verdict":"approve","reason":"routine"}')).toMatchObject({
      verdict: 'approve',
      reason: 'routine',
    });
  });

  it('strips a single code fence', async () => {
    expect(parseVerdict('```json\n{"verdict":"approve","reason":"ok"}\n```').verdict).toBe('approve');
  });

  it('escalates on garbage, prose, and truncation', async () => {
    for (const bad of ['sure, go ahead!', '{"verdict":"appro', '', '42', 'null', '"approve"']) {
      expect(parseVerdict(bad).verdict).toBe('escalate');
    }
  });

  it('has NO auto-deny: deny/reject verdicts escalate', async () => {
    expect(parseVerdict('{"verdict":"deny","reason":"bad"}').verdict).toBe('escalate');
    expect(parseVerdict('{"verdict":"reject","reason":"bad"}').verdict).toBe('escalate');
  });
});

describe('never-list', () => {
  it('blocks credential, package, and MCP actions outright', async () => {
    for (const action of ['onecli_credential', 'install_packages', 'add_mcp_server']) {
      expect(isNeverAutoApprovable(action, '{}')).toBe(true);
    }
  });

  it('blocks privilege- and config-shaped payloads for any action', async () => {
    expect(isNeverAutoApprovable('cli_command', '{"command":"roles grant --role admin"}')).toBe(true);
    expect(isNeverAutoApprovable('cli_command', '{"command":"groups config update"}')).toBe(true);
    expect(isNeverAutoApprovable('cli_command', '{"args":{"cli_scope":"global"}}')).toBe(true);
    expect(isNeverAutoApprovable('cli_command', '{"command":"tasks create"}')).toBe(false);
  });

  it('wins over an explicit opt-in', async () => {
    const fetchFn = vi.fn();
    const deps = { ...baseDeps(fetchFn), getActions: () => ['install_packages'] };
    const result = await prejudgeApproval(makeApproval({ action: 'install_packages' }), undefined, deps);
    expect(result.verdict).toBe('escalate');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('prejudgeApproval fail-safe', () => {
  it('escalates when no model is configured', async () => {
    const fetchFn = vi.fn();
    const result = await prejudgeApproval(makeApproval(), undefined, { ...baseDeps(fetchFn), getModelId: () => null });
    expect(result.verdict).toBe('escalate');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('escalates when the action is not opted in', async () => {
    const fetchFn = vi.fn();
    const result = await prejudgeApproval(makeApproval(), undefined, { ...baseDeps(fetchFn), getActions: () => [] });
    expect(result.verdict).toBe('escalate');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('escalates a targeted approval (approver_user_id set)', async () => {
    const fetchFn = vi.fn();
    const result = await prejudgeApproval(
      makeApproval({ approver_user_id: 'webchat:owner' }),
      undefined,
      baseDeps(fetchFn),
    );
    expect(result.verdict).toBe('escalate');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('escalates when the configured model is gone or missing its endpoint', async () => {
    const fetchFn = vi.fn();
    const gone = await prejudgeApproval(makeApproval(), undefined, {
      ...baseDeps(fetchFn),
      getModel: () => undefined,
    });
    expect(gone.verdict).toBe('escalate');
    // An endpoint-kind model without an endpoint is unusable — only the
    // anthropic kind (OneCLI-proxied) may have a NULL endpoint.
    const noEndpoint = await prejudgeApproval(makeApproval(), undefined, {
      ...baseDeps(fetchFn),
      getModel: () => ({ ...MODEL, endpoint: null }),
    });
    expect(noEndpoint.verdict).toBe('escalate');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('escalates on timeout', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const result = await prejudgeApproval(makeApproval(), undefined, baseDeps(fetchFn));
    expect(result.verdict).toBe('escalate');
  });

  it('escalates on non-200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
    const result = await prejudgeApproval(makeApproval(), undefined, baseDeps(fetchFn));
    expect(result.verdict).toBe('escalate');
    expect(result.reason).toContain('503');
  });

  it('escalates on garbage model output', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse('LGTM, approved!!'));
    const result = await prejudgeApproval(makeApproval(), undefined, baseDeps(fetchFn));
    expect(result.verdict).toBe('escalate');
  });

  it('approves on a clean approve verdict', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse('{"verdict":"approve","reason":"routine task"}'));
    const result = await prejudgeApproval(makeApproval(), 'Agent wants to run: ncl tasks create', baseDeps(fetchFn));
    expect(result).toMatchObject({ verdict: 'approve', reason: 'routine task' });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://10.0.0.10:11434/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('redacts secret-shaped content from the prompt', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse('{"verdict":"approve","reason":"ok"}'));
    const approval = makeApproval({
      payload: JSON.stringify({
        key: 'sk-ant-api03-' + 'a'.repeat(88),
        header: 'Bearer super-secret-token-value',
        proxy: 'aoc_1234567890abcdef',
      }),
    });
    await prejudgeApproval(approval, 'uses TOKEN=verysecretvalue', baseDeps(fetchFn));
    const body = (fetchFn.mock.calls[0][1] as RequestInit).body as string;
    expect(body).not.toContain('a'.repeat(88));
    expect(body).not.toContain('super-secret-token-value');
    expect(body).not.toContain('aoc_1234567890abcdef');
    expect(body).not.toContain('verysecretvalue');
  });
});

// ── Anthropic-kind judge (endpoint NULL — routed via the OneCLI proxy) ──
const ANTHROPIC_MODEL: WebchatModel = {
  ...MODEL,
  id: 'm-claude',
  name: 'Claude judge',
  kind: 'anthropic',
  endpoint: null,
  model_id: 'claude-haiku-4-5',
};

function anthropicDeps(anthropicFn: (call: unknown) => Promise<string>) {
  const fetchFn = vi.fn(); // must never fire on the anthropic path
  return {
    fetchFn,
    anthropicFn,
    getModelId: () => 'm-claude',
    getActions: () => ['cli_command'],
    getModel: (id: string) => (id === 'm-claude' ? ANTHROPIC_MODEL : undefined),
  };
}

describe('anthropic-kind judge', () => {
  it('approves on a clean verdict, passing the rubric + Claude model id (no fetch)', async () => {
    const anthropicFn = vi.fn().mockResolvedValue('{"verdict":"approve","reason":"routine task"}');
    const deps = anthropicDeps(anthropicFn);
    const result = await prejudgeApproval(makeApproval(), 'Agent wants to run: ncl tasks create', deps);
    expect(result).toMatchObject({ verdict: 'approve', reason: 'routine task' });
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(anthropicFn).toHaveBeenCalledTimes(1);
    const call = anthropicFn.mock.calls[0][0] as {
      model: string;
      system: string;
      user: string;
      maxTokens: number;
      timeoutMs: number;
    };
    expect(call.model).toBe('claude-haiku-4-5');
    expect(call.system).toContain('escalate is always safe');
    expect(call.user).toContain('Action: cli_command');
    expect(call.maxTokens).toBeGreaterThan(0);
    expect(call.timeoutMs).toBe(10_000);
  });

  it('escalates on a non-approve verdict', async () => {
    const result = await prejudgeApproval(
      makeApproval(),
      undefined,
      anthropicDeps(vi.fn().mockResolvedValue('{"verdict":"escalate","reason":"unusual"}')),
    );
    expect(result.verdict).toBe('escalate');
  });

  it('escalates on timeout / any throw from the proxied call', async () => {
    const result = await prejudgeApproval(
      makeApproval(),
      undefined,
      anthropicDeps(vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))),
    );
    expect(result.verdict).toBe('escalate');
  });

  it('escalates on empty or garbage content', async () => {
    for (const bad of ['', '   ', 'Sure thing, approved!']) {
      const result = await prejudgeApproval(makeApproval(), undefined, anthropicDeps(vi.fn().mockResolvedValue(bad)));
      expect(result.verdict).toBe('escalate');
    }
  });

  it('redacts secret-shaped content before it reaches the judge', async () => {
    const anthropicFn = vi.fn().mockResolvedValue('{"verdict":"approve","reason":"ok"}');
    const approval = makeApproval({
      payload: JSON.stringify({ header: 'Bearer super-secret-token-value', proxy: 'aoc_1234567890abcdef' }),
    });
    await prejudgeApproval(approval, 'uses TOKEN=verysecretvalue', anthropicDeps(anthropicFn));
    const call = anthropicFn.mock.calls[0][0] as { user: string };
    expect(call.user).not.toContain('super-secret-token-value');
    expect(call.user).not.toContain('aoc_1234567890abcdef');
    expect(call.user).not.toContain('verysecretvalue');
  });
});

// The single kind gate shared by the runtime consult and the PUT validation
// (server.ts imports it) — anthropic qualifies without an endpoint; the
// local kinds require one.
describe('isUsableJudgeModel', () => {
  it('accepts anthropic-kind models with or without an endpoint', async () => {
    expect(isUsableJudgeModel(ANTHROPIC_MODEL)).toBe(true);
    expect(isUsableJudgeModel({ ...ANTHROPIC_MODEL, endpoint: 'http://127.0.0.1:4000' })).toBe(true);
  });

  it('accepts ollama / openai-compatible models only with an endpoint', async () => {
    expect(isUsableJudgeModel(MODEL)).toBe(true);
    expect(isUsableJudgeModel({ ...MODEL, kind: 'openai-compatible' })).toBe(true);
    expect(isUsableJudgeModel({ ...MODEL, endpoint: null })).toBe(false);
    expect(isUsableJudgeModel({ ...MODEL, kind: 'openai-compatible', endpoint: '' })).toBe(false);
  });

  it('rejects a missing model', async () => {
    expect(isUsableJudgeModel(undefined)).toBe(false);
  });
});

describe('redactForPrompt', () => {
  it('masks bearer, OneCLI, and MCP relay tokens on top of the webchat layer', async () => {
    const out = redactForPrompt('Authorization: Bearer abcdef123456 x aoc_abcdefgh123 y mcr_abcdefgh123');
    expect(out).not.toContain('abcdef123456');
    expect(out).not.toContain('aoc_abcdefgh123');
    expect(out).not.toContain('mcr_abcdefgh123');
  });
});

describe('maybePrejudgeApproval wiring', () => {
  it('is a silent no-op when the feature is off', async () => {
    const fetchFn = vi.fn();
    const getApproval = vi.fn();
    const resolve = vi.fn();
    const handled = await maybePrejudgeApproval('appr-1', SESSION, undefined, {
      ...baseDeps(fetchFn),
      getModelId: () => null,
      getApproval,
      resolve,
    });
    expect(handled).toBe(false);
    expect(getApproval).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('is a silent no-op for actions that are not opted in', async () => {
    const fetchFn = vi.fn();
    const resolve = vi.fn();
    const handled = await maybePrejudgeApproval('appr-1', SESSION, undefined, {
      ...baseDeps(fetchFn),
      getActions: () => ['create_agent'],
      getApproval: () => makeApproval(),
      resolve,
    });
    expect(handled).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('on approve: resolves through the human dispatch path, notifies, returns true', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse('{"verdict":"approve","reason":"routine task"}'));
    const resolve = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const approval = makeApproval();
    const handled = await maybePrejudgeApproval('appr-1', SESSION, 'run ncl tasks create', {
      ...baseDeps(fetchFn),
      getApproval: () => approval,
      resolve,
      notify,
    });
    expect(handled).toBe(true);
    expect(resolve).toHaveBeenCalledWith(approval, 'prejudge:m1');
    expect(notify).toHaveBeenCalledWith(SESSION, 'Auto-approved (pre-judge): routine task');
  });

  it('on escalate: returns false and never touches the resolver', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse('nope'));
    const resolve = vi.fn();
    const handled = await maybePrejudgeApproval('appr-1', SESSION, undefined, {
      ...baseDeps(fetchFn),
      getApproval: () => makeApproval(),
      resolve,
    });
    expect(handled).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('fails safe (returns false) when the resolver itself throws', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse('{"verdict":"approve","reason":"ok"}'));
    const resolve = vi.fn().mockRejectedValue(new Error('boom'));
    const handled = await maybePrejudgeApproval('appr-1', SESSION, undefined, {
      ...baseDeps(fetchFn),
      getApproval: () => makeApproval(),
      resolve,
      notify: vi.fn(),
    });
    expect(handled).toBe(false);
  });
});

// ── Triage description (what the card shows) ────────────────────────────────
//
// The rule these all serve: describing a request must never change the decision
// about it, and an ABSENCE of description must never look like a clean bill.

describe('triage flags', () => {
  it('maps every never-list ACTION to a flag, so the two cannot drift', async () => {
    for (const action of NEVER_AUTO_APPROVE_ACTIONS) {
      expect(heuristicFlags(action, '{}'), `${action} has no flag`).not.toHaveLength(0);
    }
  });

  it('maps every never-list PAYLOAD shape to a flag', async () => {
    const shapes = [
      'cli_scope',
      'roles grant',
      'roles revoke',
      'config add-package',
      'config remove-mcp-server',
      'config update',
    ];
    for (const shape of shapes) {
      expect(heuristicFlags('cli_command', JSON.stringify({ frame: shape })), shape).not.toHaveLength(0);
    }
  });

  it('says nothing about an ordinary request', async () => {
    expect(heuristicFlags('cli_command', JSON.stringify({ frame: 'tasks create' }))).toEqual([]);
  });

  it('drops values outside the closed vocabulary', async () => {
    expect(parseFlags(['credentials', 'catastrophic', 'HIGH RISK', 7, null])).toEqual(['credentials']);
    expect(parseFlags('credentials')).toEqual([]);
    expect(parseFlags(undefined)).toEqual([]);
  });

  it('accepts every documented flag, case-insensitively', async () => {
    expect(parseFlags(TRIAGE_FLAGS.map((f) => f.toUpperCase()))).toEqual([...TRIAGE_FLAGS]);
  });
});

describe('parseVerdict — flags never affect the verdict', () => {
  it('reads flags and reversibility alongside an approve', async () => {
    const r = parseVerdict('{"verdict":"approve","reason":"routine","flags":["outbound"],"reversible":"yes"}');
    expect(r.verdict).toBe('approve');
    expect(r.flags).toEqual(['outbound']);
    expect(r.reversible).toBe('yes');
  });

  it('keeps the approve when flags are garbage', async () => {
    const r = parseVerdict('{"verdict":"approve","reason":"routine","flags":"not-an-array","reversible":42}');
    expect(r.verdict).toBe('approve');
    expect(r.flags).toEqual([]);
    expect(r.reversible).toBe('unknown');
  });

  it('keeps the escalate when flags look reassuring', async () => {
    const r = parseVerdict('{"verdict":"escalate","reason":"unsure","flags":[],"reversible":"yes"}');
    expect(r.verdict).toBe('escalate');
  });
});

describe('triage tiers', () => {
  const tierFor = async (deps: Parameters<typeof prejudgeApproval>[2], approval = makeApproval()) =>
    (await prejudgeApproval(approval, undefined, deps)).tier;

  it('is unscreened when the feature is off or the action is not opted in', async () => {
    expect(await tierFor({ getModelId: () => null })).toBe('unscreened');
    expect(await tierFor({ getModelId: () => 'm1', getActions: () => [] })).toBe('unscreened');
  });

  it('is heuristic when the never-list decided, with the flag attached', async () => {
    const r = await prejudgeApproval(makeApproval({ action: 'install_packages' }), undefined, {
      getModelId: () => 'm1',
      getActions: () => ['install_packages'],
      getModel: () => MODEL,
    });
    expect(r.tier).toBe('heuristic');
    expect(r.heuristic).toContain('install');
  });

  it('is unavailable — not "clean" — when the model cannot be reached', async () => {
    const r = await prejudgeApproval(makeApproval(), undefined, {
      ...baseDeps(() => Promise.reject(new Error('down'))),
    });
    expect(r.tier).toBe('unavailable');
    expect(r.verdict).toBe('escalate');
  });

  it('carries the never-list flags even on an unscreened result', async () => {
    const r = await prejudgeApproval(makeApproval({ action: 'onecli_credential' }), undefined, {
      getModelId: () => null,
    });
    expect(r.tier).toBe('unscreened');
    expect(r.heuristic).toEqual(['credentials']);
  });
});

describe('buildApprovalTriageView', () => {
  const payload = JSON.stringify({ frame: 'roles grant' });

  it('reports unscreened when nothing was recorded, and still derives the never-list flags', async () => {
    const v = await buildApprovalTriageView('appr-x', 'cli_command', payload, { getTriage: () => undefined });
    expect(v.tier).toBe('unscreened');
    expect(v.heuristic).toEqual(['permissions']);
    expect(v.flags).toEqual([]);
  });

  it('recomputes heuristics live rather than trusting the stored copy', async () => {
    const v = await buildApprovalTriageView('appr-x', 'cli_command', payload, {
      getTriage: () => ({
        tier: 'model',
        reason: 'grants a role',
        flags: ['permissions'],
        heuristicFlags: [], // stale record from before the never-list covered this
        reversible: 'no',
      }),
    });
    expect(v.heuristic).toEqual(['permissions']);
    expect(v.reason).toBe('grants a role');
    expect(v.reversible).toBe('no');
  });

  it('drops stored flags outside the vocabulary', async () => {
    const v = await buildApprovalTriageView('appr-x', 'cli_command', '{}', {
      getTriage: () => ({
        tier: 'model',
        reason: '',
        flags: ['credentials', 'apocalyptic'],
        heuristicFlags: [],
        reversible: 'unknown',
      }),
    });
    expect(v.flags).toEqual(['credentials']);
  });
});

describe('maybePrejudgeApproval records the triage', () => {
  it('stores the escalation reason the card needs', async () => {
    const stored: Array<{ id: string; tier: string; reason: string }> = [];
    const ok = await maybePrejudgeApproval('appr-1', SESSION, undefined, {
      ...baseDeps(() =>
        Promise.resolve(okResponse('{"verdict":"escalate","reason":"touches a secret","flags":["credentials"]}')),
      ),
      getApproval: () => makeApproval(),
      storeTriage: (id, t) => stored.push({ id, tier: t.tier, reason: t.reason }),
    });
    expect(ok).toBe(false);
    expect(stored).toEqual([{ id: 'appr-1', tier: 'model', reason: 'touches a secret' }]);
  });

  it('still delivers to a human when the triage write throws', async () => {
    const ok = await maybePrejudgeApproval('appr-1', SESSION, undefined, {
      ...baseDeps(() => Promise.resolve(okResponse('{"verdict":"escalate","reason":"nope"}'))),
      getApproval: () => makeApproval(),
      storeTriage: () => {
        throw new Error('disk full');
      },
    });
    expect(ok).toBe(false);
  });
});
