/**
 * The device-code half of a Grok re-auth notice.
 *
 * The property that matters is that this never makes things worse. A notice
 * without a code still reaches its reader; a prompter that hangs, spawns a
 * second login, or throws would cost more than the code is worth.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startGrokLogin = vi.fn<() => { started: boolean; error?: string }>();
let progress: Record<string, unknown> = {
  running: true,
  outcome: null,
  verificationUrl: null,
  userCode: null,
  startedAt: 0,
  finishedAt: null,
  error: null,
  expiresInMs: null,
};

vi.mock('./grok-auth-flow.js', () => ({
  startGrokLogin: () => startGrokLogin(),
  getGrokLoginProgress: () => progress,
}));
vi.mock('../../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { __devicePromptForTest: devicePrompt, registerGrokReauthPrompter } = await import('./grok-reauth-prompter.js');

const withCode = {
  running: true,
  outcome: null,
  verificationUrl: 'https://x.ai/device',
  userCode: 'ABCD-1234',
  startedAt: 0,
  finishedAt: null,
  error: null,
  expiresInMs: 15 * 60_000,
};

beforeEach(() => {
  startGrokLogin.mockReset();
  startGrokLogin.mockReturnValue({ started: true });
  progress = { ...withCode };
});

describe('devicePrompt', () => {
  it('returns the URL, code and validity once the CLI prints them', async () => {
    await expect(devicePrompt()).resolves.toEqual({
      verificationUrl: 'https://x.ai/device',
      userCode: 'ABCD-1234',
      expiresInMs: 15 * 60_000,
    });
  });

  it('reports on a login that is already running rather than starting a second', async () => {
    // Two device codes for one outage would invalidate each other, so
    // already-running is a success path, not a failure.
    startGrokLogin.mockReturnValue({ started: false, error: 'already-running' });
    await expect(devicePrompt()).resolves.toMatchObject({ userCode: 'ABCD-1234' });
  });

  it('gives up quietly when Grok is not installed', async () => {
    startGrokLogin.mockReturnValue({ started: false, error: 'not-installed' });
    await expect(devicePrompt()).resolves.toBeNull();
  });

  it('gives up when the login ends without ever printing a code', async () => {
    progress = { ...withCode, running: false, outcome: 'failed', verificationUrl: null, userCode: null };
    await expect(devicePrompt()).resolves.toBeNull();
  });
});

describe('registerGrokReauthPrompter', () => {
  it('reports false when the Grok payload is absent', async () => {
    // This tree has no src/providers/grok-reauth.ts unless /add-grok has run,
    // which is the normal case and must not throw.
    await expect(registerGrokReauthPrompter()).resolves.toBe(false);
  });
});
