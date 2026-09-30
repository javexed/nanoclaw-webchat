import { describe, expect, it } from 'vitest';

import { classifyRounds, profileFromVerdict, type ProbeRound } from './model-probe.js';

const reached: ProbeRound = { calledTool: true, answeredInText: false };
const answered: ProbeRound = { calledTool: false, answeredInText: true };

describe('classifyRounds', () => {
  it('returns null when no round produced a verdict', () => {
    // An unreachable endpoint must never be recorded as a behavioural finding.
    expect(classifyRounds([])).toBeNull();
  });

  it('calls a model disciplined when it mostly just answers', () => {
    const v = classifyRounds([answered, answered, reached])!;
    expect(v.disciplined).toBe(true);
    expect(v.reachedForTool).toBe(1);
  });

  it('calls a model undisciplined when it mostly reaches for a tool', () => {
    const v = classifyRounds([reached, reached, answered])!;
    expect(v.disciplined).toBe(false);
  });

  it('treats an even split as undisciplined — the safer read', () => {
    // Half the time reaching for a shell to answer arithmetic is not a model
    // to hand the lighter harness to.
    const v = classifyRounds([reached, answered])!;
    expect(v.disciplined).toBe(false);
  });

  it('does not let one lucky round decide', () => {
    // One round still yields a verdict, though the caller asks for three.
    expect(classifyRounds([answered])!.disciplined).toBe(true);
    expect(classifyRounds([reached])!.disciplined).toBe(false);
  });
});

describe('profileFromVerdict', () => {
  it('cuts a looping model off sooner', () => {
    const p = profileFromVerdict(classifyRounds([reached, reached, answered])!);
    expect(p.noopCapThreshold).toBe(2);
  });

  it('leaves a disciplined model on the default threshold', () => {
    const p = profileFromVerdict(classifyRounds([answered, answered, answered])!);
    expect(p.noopCapThreshold).toBe(3);
  });

  it('switches nothing it did not measure', () => {
    // Only the loop cutoff is set; tools/thinking stay absent (default applies).
    const p = profileFromVerdict(classifyRounds([reached, answered, answered])!);
    expect(p.tools).toBeUndefined();
    expect(p.thinking).toBeUndefined();
    expect(p.messageTool).toBeUndefined();
  });

  it('records what it saw, so the cached entry can be judged later', () => {
    const p = profileFromVerdict(classifyRounds([reached, answered, answered])!);
    expect(p.notes).toContain('1/3');
  });
});
