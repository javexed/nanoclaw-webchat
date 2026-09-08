import { describe, expect, it } from 'vitest';

import { type ObservedCall, callMatches, describeExpected, matchCalls } from './match.js';

/**
 * The matcher decides pass or fail for every eval, so its rules are the thing
 * worth pinning: a mode that is subtly too lax reports green while an agent
 * regresses, which is worse than having no harness at all.
 */

const call = (tool: string, target: string | null = null): ObservedCall => ({ tool, target });

// A real turn, as the status feed recorded it during the pi work.
const REAL_TURN: ObservedCall[] = [
  call('write', '/workspace/agent/hello.sh'),
  call('bash', 'chmod +x /workspace/agent/hello.sh'),
];

describe('callMatches', () => {
  it('matches on tool alone when no target is asserted', async () => {
    expect(callMatches(call('bash', 'anything'), { tool: 'bash' })).toBe(true);
  });

  it('requires the exact target when one is given', async () => {
    expect(callMatches(call('write', '/a/b.sh'), { tool: 'write', target: '/a/b.sh' })).toBe(true);
    expect(callMatches(call('write', '/a/c.sh'), { tool: 'write', target: '/a/b.sh' })).toBe(false);
  });

  it('supports a pattern, for targets with an unstable prefix', async () => {
    // Session ids and temp dirs move between runs; the filename does not.
    expect(callMatches(call('write', '/tmp/x9f2/report.md'), { tool: 'write', targetPattern: 'report\\.md$' })).toBe(
      true,
    );
  });

  it('never matches a null target against a pattern', async () => {
    expect(callMatches(call('bash', null), { tool: 'bash', targetPattern: '.*' })).toBe(false);
  });

  it('treats an unparseable pattern as no-match rather than throwing', async () => {
    // A case-authoring mistake must not take the rest of the suite with it.
    expect(callMatches(call('write', 'x'), { tool: 'write', targetPattern: '([' })).toBe(false);
  });

  it('does not match across different tools', async () => {
    expect(callMatches(call('bash', 'x'), { tool: 'write', target: 'x' })).toBe(false);
  });
});

describe('matchCalls — ordered_subset (the default)', () => {
  it('passes when the expected calls appear in order', async () => {
    const r = matchCalls(REAL_TURN, [{ tool: 'write' }, { tool: 'bash' }], 'ordered_subset');
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it('tolerates extra calls between the expected ones', async () => {
    // An agent adding a reasonable verification step should not fail a case.
    const observed = [call('write', '/a.sh'), call('read', '/a.sh'), call('bash', 'chmod +x /a.sh')];
    expect(matchCalls(observed, [{ tool: 'write' }, { tool: 'bash' }], 'ordered_subset').passed).toBe(true);
  });

  it('fails when the order is wrong', async () => {
    // chmod-then-write is a different behaviour from write-then-chmod.
    const r = matchCalls(REAL_TURN, [{ tool: 'bash' }, { tool: 'write' }], 'ordered_subset');
    expect(r.passed).toBe(false);
    expect(r.missing.map((m) => m.tool)).toEqual(['write']);
  });

  it('needs a repeated call for a repeated expectation', async () => {
    // Consuming the match prevents one call satisfying two expectations.
    expect(matchCalls([call('write')], [{ tool: 'write' }, { tool: 'write' }], 'ordered_subset').passed).toBe(false);
    expect(
      matchCalls([call('write'), call('write')], [{ tool: 'write' }, { tool: 'write' }], 'ordered_subset').passed,
    ).toBe(true);
  });
});

describe('matchCalls — the stricter and looser modes', () => {
  it('exact rejects extra calls, ordered_subset accepts them', async () => {
    const observed = [...REAL_TURN, call('bash', 'ls')];
    const expected = [{ tool: 'write' }, { tool: 'bash' }];
    expect(matchCalls(observed, expected, 'exact').passed).toBe(false);
    expect(matchCalls(observed, expected, 'ordered_subset').passed).toBe(true);
  });

  it('subset ignores order', async () => {
    expect(matchCalls(REAL_TURN, [{ tool: 'bash' }, { tool: 'write' }], 'subset').passed).toBe(true);
  });

  it('contains_any passes on one hit and fails on none', async () => {
    // For "did it use SOME search tool", where which one is not the point.
    expect(matchCalls(REAL_TURN, [{ tool: 'grep' }, { tool: 'bash' }], 'contains_any').passed).toBe(true);
    expect(matchCalls(REAL_TURN, [{ tool: 'grep' }, { tool: 'find' }], 'contains_any').passed).toBe(false);
  });

  it('scores partial credit even when the case fails', async () => {
    // The number is for tracking drift across runs; the pass bar is still 1.0.
    const r = matchCalls(REAL_TURN, [{ tool: 'write' }, { tool: 'grep' }], 'subset');
    expect(r.score).toBe(0.5);
    expect(r.passed).toBe(false);
  });
});

describe('matchCalls — edges', () => {
  it('an empty expectation passes under a subset mode, and scores 1', async () => {
    // Under `exact` this is instead an assertion that nothing was called — see
    // the empty-expectation block below.
    expect(matchCalls(REAL_TURN, [], 'ordered_subset')).toEqual({
      matched: 0,
      total: 0,
      score: 1,
      passed: true,
      missing: [],
    });
  });

  it('a turn that called nothing fails a case that expected something', async () => {
    // The most important regression shape: the agent stopped acting entirely.
    const r = matchCalls([], [{ tool: 'write' }], 'ordered_subset');
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.missing).toHaveLength(1);
  });
});

describe('describeExpected', () => {
  it('renders each expectation shape for the failure line', async () => {
    expect(describeExpected({ tool: 'bash' })).toBe('bash(*)');
    expect(describeExpected({ tool: 'write', target: '/a.sh' })).toBe('write(/a.sh)');
    expect(describeExpected({ tool: 'write', targetPattern: 'a\\.sh$' })).toBe('write(/a\\.sh$/)');
  });
});

describe('an empty expectation', () => {
  // "Just answer the question" is a real case: a local model that reaches for
  // bash to compute 2+2 has regressed in the opposite direction from one that
  // forgets to use tools, and both shipped this month.
  it('under exact, demands the agent used no tools at all', async () => {
    expect(matchCalls([], [], 'exact').passed).toBe(true);
    expect(matchCalls([{ tool: 'Bash', target: 'echo $((2+2))' }], [], 'exact').passed).toBe(false);
  });

  it('under every other mode, has nothing to assert and passes', async () => {
    for (const mode of ['ordered_subset', 'subset', 'contains_any'] as const) {
      expect(matchCalls([{ tool: 'Bash', target: 'ls' }], [], mode).passed).toBe(true);
    }
  });
});

describe('tool-name casing', () => {
  // Same turn, two providers: Claude reports `Write`/`Bash`, pi reports
  // `write`/`bash`. One case has to grade both.
  it('matches across providers that case the same tool differently', async () => {
    const expected = [{ tool: 'Write', targetPattern: 'hello\\.sh' }];
    expect(matchCalls([{ tool: 'write', target: '/workspace/agent/hello.sh' }], expected).passed).toBe(true);
    expect(matchCalls([{ tool: 'Write', target: '/workspace/agent/hello.sh' }], expected).passed).toBe(true);
  });

  it('still distinguishes genuinely different tools', async () => {
    expect(matchCalls([{ tool: 'Read', target: '/a' }], [{ tool: 'Write' }]).passed).toBe(false);
  });
});

describe('toolPattern — a step more than one tool can legitimately do', () => {
  // The case that forced this: "overwrite hello.sh". On a fresh workspace the
  // agent writes the file; when it already exists it edits it instead. Both are
  // correct, and demanding `write` scored a correct run 0.50.
  const OVERWRITE = [{ toolPattern: 'write|edit', targetPattern: 'hello\\.sh' }];

  it('accepts either tool for the same step', async () => {
    for (const tool of ['write', 'edit', 'Write', 'Edit']) {
      expect(matchCalls([{ tool, target: '/workspace/agent/hello.sh' }], OVERWRITE).passed).toBe(true);
    }
  });

  it('still rejects a tool the pattern does not name', async () => {
    expect(matchCalls([{ tool: 'read', target: '/workspace/agent/hello.sh' }], OVERWRITE).passed).toBe(false);
  });

  it('matches the WHOLE tool name, so a short pattern cannot match a longer tool', async () => {
    // Unanchored, `read` would accept `thread_create`. Tool names are a closed
    // vocabulary; partial matching is never what an author meant.
    expect(matchCalls([{ tool: 'thread_create', target: null }], [{ toolPattern: 'read' }]).passed).toBe(false);
    expect(matchCalls([{ tool: 'read', target: null }], [{ toolPattern: 'read' }]).passed).toBe(true);
  });

  it('still applies the target constraint', async () => {
    expect(matchCalls([{ tool: 'edit', target: '/workspace/agent/other.sh' }], OVERWRITE).passed).toBe(false);
  });

  it('takes precedence over an exact tool given alongside it', async () => {
    expect(matchCalls([{ tool: 'edit', target: null }], [{ tool: 'write', toolPattern: 'write|edit' }]).passed).toBe(
      true,
    );
  });

  it('treats an unparseable pattern as no match rather than throwing', async () => {
    expect(matchCalls([{ tool: 'write', target: null }], [{ toolPattern: '(unclosed' }]).passed).toBe(false);
  });

  it('fails an expectation that names no tool at all', async () => {
    // Matching everything would silently pass a case asserting nothing.
    expect(matchCalls([{ tool: 'write', target: null }], [{ targetPattern: 'hello' }]).passed).toBe(false);
  });

  it('describes itself as a pattern in the failure output', async () => {
    expect(describeExpected({ toolPattern: 'write|edit', targetPattern: 'hello\\.sh' })).toBe(
      '/write|edit/(/hello\\.sh/)',
    );
  });
});

describe('forbidden calls', () => {
  const answered: ObservedCall[] = [{ tool: 'message', target: 'pi-soak' }];

  it('passes when nothing forbidden appears', () => {
    const r = matchCalls(answered, [], 'subset', [{ tool: 'bash' }]);
    expect(r.passed).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('fails when a forbidden call appears, and names it', () => {
    const observed: ObservedCall[] = [...answered, { tool: 'bash', target: 'echo 4' }];
    const r = matchCalls(observed, [], 'subset', [{ tool: 'bash' }]);
    expect(r.passed).toBe(false);
    expect(r.violations).toEqual([{ tool: 'bash', target: 'echo 4' }]);
  });

  it('matches forbidden tool names case-insensitively, like expectations do', () => {
    const r = matchCalls([{ tool: 'Bash', target: 'ls' }], [], 'subset', [{ tool: 'bash' }]);
    expect(r.passed).toBe(false);
  });

  it('fails even when every expectation was met', () => {
    const observed: ObservedCall[] = [
      { tool: 'write', target: 'hello.sh' },
      { tool: 'bash', target: 'rm -rf /' },
    ];
    const r = matchCalls(observed, [{ tool: 'write' }], 'subset', [{ tool: 'bash' }]);
    expect(r.score).toBe(1); // the expectation genuinely matched…
    expect(r.passed).toBe(false); // …and the case still fails
  });

  it('does not ban the delivery tool the answer legitimately uses', () => {
    // The whole point of the rewrite: answering via `message` is correct, so a
    // ban list aimed at shell/file tools must leave it alone.
    const r = matchCalls(answered, [], 'subset', [{ tool: 'bash' }, { tool: 'write' }]);
    expect(r.passed).toBe(true);
  });

  it('an entry naming no tool at all bans nothing, rather than banning everything', () => {
    const r = matchCalls(answered, [], 'subset', [{ target: 'whatever' }]);
    expect(r.passed).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('is inert when no forbidden list is given', () => {
    expect(matchCalls([{ tool: 'bash', target: 'x' }], [], 'subset').passed).toBe(true);
  });
});

describe('forbidden + toolPattern', () => {
  it('bans a family of tools in one entry', () => {
    // The ban list wanted to be a pattern all along; it was five exact names
    // only because toolPattern was unmerged at the time.
    const observed: ObservedCall[] = [{ tool: 'bash', target: 'echo 4' }];
    const r = matchCalls(observed, [], 'subset', [{ toolPattern: 'bash|write|edit|read|echo' }]);
    expect(r.passed).toBe(false);
    expect(r.violations).toEqual(observed);
  });

  it('still lets the delivery tool through', () => {
    const r = matchCalls([{ tool: 'message', target: 'pi-soak' }], [], 'subset', [
      { toolPattern: 'bash|write|edit|read|echo' },
    ]);
    expect(r.passed).toBe(true);
  });

  it('anchors the pattern, so `read` does not ban `thread`', () => {
    const r = matchCalls([{ tool: 'thread', target: null }], [], 'subset', [{ toolPattern: 'read' }]);
    expect(r.passed).toBe(true);
  });
});
