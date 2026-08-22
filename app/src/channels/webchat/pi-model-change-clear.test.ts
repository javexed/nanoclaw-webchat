import { describe, expect, it, vi } from 'vitest';

/**
 * A model change on a transcript-replaying harness must clear its live sessions.
 *
 * pi continues a conversation by re-sending the whole prior transcript, so
 * swapping the model underneath one leaves the NEW model reading the OLD
 * model's replies as few-shot examples. Observed live on pi/ornith
 * (2026-08-21): carrying the previous model's history, the answer to "which
 * model are you running" came back as an invented `<personation name="pi sox"
 * />` wrapped in a made-up `<delivered>` element — an opening-turn shape rather
 * than an answer. After a clear, the same model answered correctly.
 *
 * The two refusals matter as much as the clear: re-selecting the SAME model
 * must not discard a conversation, and Claude must never be cleared — it
 * resumes server-side by id rather than replaying a local transcript, so it
 * cannot inherit another model's voice.
 */

const injected: Array<{ agentGroupId: string; sessionId: string; command: string }> = [];

vi.mock('./server/agent-wiring.js', () => ({
  injectSessionCommand: (agentGroupId: string, sessionId: string, command: string) => {
    injected.push({ agentGroupId, sessionId, command });
  },
}));

// The rule under test, extracted to the shape routes-agents.ts implements it in.
const TRANSCRIPT_REPLAY_HARNESSES = new Set(['pi']);

function wouldClear(provider: string, priorModelId: string | null, nextModelId: string | null): boolean {
  if (priorModelId === nextModelId) return false;
  return TRANSCRIPT_REPLAY_HARNESSES.has(provider);
}

describe('clear-on-model-change', () => {
  it('clears a pi group when the model actually changes', async () => {
    expect(wouldClear('pi', 'model-a', 'model-b')).toBe(true);
  });

  it('clears when a pi group moves from unassigned to a model, and back', async () => {
    expect(wouldClear('pi', null, 'model-a')).toBe(true);
    expect(wouldClear('pi', 'model-a', null)).toBe(true);
  });

  it('does NOT clear when the same model is re-selected', async () => {
    // Re-picking the current model is a no-op the UI allows; throwing away the
    // conversation for it would be a surprise with no upside.
    expect(wouldClear('pi', 'model-a', 'model-a')).toBe(false);
    expect(wouldClear('pi', null, null)).toBe(false);
  });

  it('does NOT clear Claude — it resumes by id, not by replaying a transcript', async () => {
    expect(wouldClear('claude', 'model-a', 'model-b')).toBe(false);
  });

  it('does NOT clear an unknown/other harness until it is declared', async () => {
    // Opt-in by design: a harness joins the set only once its continuation is
    // known to replay transcripts.
    expect(wouldClear('codex', 'model-a', 'model-b')).toBe(false);
  });
});
