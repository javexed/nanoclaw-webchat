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
    // The behaviour was measured as intermittent at roughly 1 run in 3, so a
    // single sample is close to a coin toss. One round still yields a verdict,
    // but the caller asks for three; this pins the arithmetic either way.
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
    // The sweep justified exactly one knob. A probe that also flipped tools or
    // thinking would be guessing with extra steps, so those must stay absent
    // and let the documented default apply.
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
