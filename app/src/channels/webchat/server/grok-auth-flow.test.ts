/**
 * Grok device-login flow.
 *
 * The parts worth pinning are the ones a live login would only reveal at the
 * worst moment: scraping the code out of human-facing output, the single-flight
 * guard that stops two tabs driving one credential file, and the promise that a
 * temp directory holding a refresh token never outlives the flow.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-flow-'));
let available = true;

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: TMP,
}));
vi.mock('./providers.js', () => ({ grokAvailable: () => available }));

const { __resetGrokLoginState, credentialsFromCliAuth, getGrokLoginProgress, parseDevicePrompt, startGrokLogin } =
  await import('./grok-auth-flow.js');

beforeEach(async () => {
  available = true;
  __resetGrokLoginState();
});
afterEach(() => __resetGrokLoginState());

describe('parseDevicePrompt', () => {
  const real = `
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=H9N6-4KX3

Confirm this code in your browser:

  H9N6-4KX3
`;

  it('pulls the URL and code out of the CLI banner', async () => {
    expect(parseDevicePrompt(real)).toEqual({
      verificationUrl: 'https://accounts.x.ai/oauth2/device?user_code=H9N6-4KX3',
      userCode: 'H9N6-4KX3',
    });
  });

  it('survives ANSI colouring, which a real terminal adds', async () => {
    const coloured = '\x1b[36mhttps://accounts.x.ai/oauth2/device?user_code=AAAA-BBBB\x1b[0m';
    expect(parseDevicePrompt(coloured).userCode).toBe('AAAA-BBBB');
  });

  it('prefers the code embedded in the URL, so the two always agree', async () => {
    const mixed = 'https://accounts.x.ai/oauth2/device?user_code=AAAA-BBBB\nstray ZZZZ-YYYY';
    expect(parseDevicePrompt(mixed).userCode).toBe('AAAA-BBBB');
  });

  it('finds a standalone code when no URL has been printed yet', async () => {
    expect(parseDevicePrompt('Confirm this code:\n\n  QQQQ-1234\n').userCode).toBe('QQQQ-1234');
  });

  it('returns nothing rather than guessing on unrelated output', async () => {
    expect(parseDevicePrompt('Downloading grok 1.0.5...')).toEqual({});
  });

  it('trims trailing punctuation off a URL', async () => {
    expect(parseDevicePrompt('see https://accounts.x.ai/oauth2/device?user_code=AB12-CD34.').verificationUrl).toBe(
      'https://accounts.x.ai/oauth2/device?user_code=AB12-CD34',
    );
  });
});

describe('credentialsFromCliAuth', () => {
  const cli = {
    'https://auth.x.ai::client-9': {
      key: 'access-XYZ',
      refresh_token: 'refresh-SECRET',
      expires_at: '2026-08-19T05:11:24.793Z',
      create_time: '2026-08-18T23:11:24.793Z',
      oidc_issuer: 'https://auth.x.ai',
      oidc_client_id: 'client-9',
      email: 'someone@example.com',
      user_id: 'uid-9',
    },
  };

  it('converts a real-shaped auth.json', async () => {
    expect(credentialsFromCliAuth(cli)).toMatchObject({
      accessToken: 'access-XYZ',
      refreshToken: 'refresh-SECRET',
      issuer: 'https://auth.x.ai',
      clientId: 'client-9',
      email: 'someone@example.com',
      userId: 'uid-9',
    });
  });

  it('carries create_time rather than synthesising it', async () => {
    // The CLI refuses a materialised credential without it — see grok-auth.ts.
    expect(credentialsFromCliAuth(cli)!.createdAt).toBe('2026-08-18T23:11:24.793Z');
  });

  it('returns null for a file with no usable session', async () => {
    expect(credentialsFromCliAuth({})).toBeNull();
    expect(credentialsFromCliAuth({ 'x::y': { key: 'only-access' } })).toBeNull();
  });
});

describe('starting a login', () => {
  it('refuses when the provider is not installed, and starts nothing', async () => {
    available = false;
    expect(startGrokLogin()).toEqual({ started: false, error: 'not-installed' });
    expect(getGrokLoginProgress().running).toBe(false);
  });

  it('is single-flight — a second tab cannot drive a second login', async () => {
    expect(startGrokLogin().started).toBe(true);
    expect(startGrokLogin()).toEqual({ started: false, error: 'already-running' });
  });

  it('reports pending immediately, before any code has been scraped', async () => {
    startGrokLogin();
    const p = getGrokLoginProgress();
    expect(p.running).toBe(true);
    expect(p.outcome).toBe('pending');
    expect(p.userCode).toBeNull();
    // A countdown exists from the start, so the panel never renders an empty timer.
    expect(p.expiresInMs).toBeGreaterThan(0);
  });

  it('never reports the process handle or the temp directory to a client', async () => {
    startGrokLogin();
    const keys = Object.keys(getGrokLoginProgress());
    expect(keys).not.toContain('proc');
    expect(keys).not.toContain('tmpDir');
    expect(keys).not.toContain('timer');
  });

  it('cleans the temp directory up on reset, since it holds a refresh token', async () => {
    startGrokLogin();
    const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('grok-wizard-login-'));
    expect(before.length).toBeGreaterThan(0);
    __resetGrokLoginState();
    const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('grok-wizard-login-'));
    expect(after.length).toBe(0);
  });
});
