/**
 * The runner's 165000-token auto-compact default is sized for 200K-context
 * models; the fleet pins much larger ones, so it can force compaction at a
 * fraction of capacity and thrash. This makes the window operator-settable —
 * and, crucially, keeps it OFF unless the operator sets it, so no existing
 * install changes behaviour on upgrade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const AG = 'ag-cw';

async function envFor(agentGroupId = AG): Promise<Record<string, string>> {
  const { resolveContainerEnv } = await import('../../container-runtime.js');
  return resolveContainerEnv(agentGroupId, null);
}

beforeEach(async () => {
  vi.resetModules();
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
});

afterEach(async () => {
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  vi.resetModules();
});

describe('auto-compact window', () => {
  it('contributes nothing when the operator has not set it', async () => {
    // The whole point: an install that never sets this must keep the runner's
    // own default, not inherit a value we invented.
    vi.doMock('../../db/container-configs.js', () => ({ getContainerConfig: () => ({ provider: 'claude' }) }));
    await import('./index.js');
    expect(await envFor()).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });

  it('forwards the operator value to a claude group', async () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '900000';
    vi.doMock('../../db/container-configs.js', () => ({ getContainerConfig: () => ({ provider: 'claude' }) }));
    await import('./index.js');
    expect((await envFor()).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('900000');
  });

  it('leaves non-claude providers alone', async () => {
    // opencode / ollama / codex configure their own limits; handing them a
    // Claude-specific variable is noise at best.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '900000';
    vi.doMock('../../db/container-configs.js', () => ({ getContainerConfig: () => ({ provider: 'codex' }) }));
    await import('./index.js');
    expect(await envFor()).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });

  it('defaults to claude when the group has no config row', async () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '900000';
    vi.doMock('../../db/container-configs.js', () => ({ getContainerConfig: () => undefined }));
    await import('./index.js');
    expect((await envFor()).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('900000');
  });
});
