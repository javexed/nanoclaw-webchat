/**
 * Grok credential status.
 *
 * The states are not symmetric with Claude's, and that asymmetry is the point:
 * a file-backed credential can EXIST and be expired, which is a different fix
 * (re-run the login) from never having connected (install, then log in). The
 * wizard renders those differently, so the probe has to distinguish them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-status-'));
let available = true;

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: TMP,
}));
vi.mock('./providers.js', () => ({ grokAvailable: () => available }));

const { grokStatus } = await import('./grok-status.js');

const credFile = path.join(TMP, 'grok', 'credentials.json');
const write = (body: unknown) => {
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, typeof body === 'string' ? body : JSON.stringify(body));
};

beforeEach(async () => {
  available = true;
  fs.rmSync(path.join(TMP, 'grok'), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('grokStatus', () => {
  it('reports not-installed without touching the filesystem', async () => {
    available = false;
    write({ email: 'x@y.z', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    // Even with a valid credential on disk, an uninstalled provider is not connectable.
    expect(grokStatus()).toEqual({ connected: false, available: false });
  });

  it('reports installed-but-never-authenticated when no file exists', async () => {
    expect(grokStatus()).toEqual({ connected: false, available: true });
  });

  it('reports connected, with the account and expiry', async () => {
    const expiresAt = new Date(Date.now() + 6 * 3600_000).toISOString();
    write({ email: 'someone@example.com', expiresAt });
    expect(grokStatus()).toMatchObject({
      connected: true,
      available: true,
      email: 'someone@example.com',
      expiresAt,
    });
  });

  it('distinguishes EXPIRED from never-connected', async () => {
    write({ email: 'someone@example.com', expiresAt: new Date(Date.now() - 1000).toISOString() });
    const s = grokStatus();
    expect(s.connected).toBe(false);
    expect(s.expired).toBe(true);
    // The account still shows, so the card can say whose login lapsed.
    expect(s.email).toBe('someone@example.com');
  });

  it('treats an unparseable expiry as expired rather than claiming connected', async () => {
    write({ email: 'x@y.z', expiresAt: 'whenever' });
    expect(grokStatus()).toMatchObject({ connected: false, expired: true });
  });

  it('degrades on a corrupt file instead of throwing into a status response', async () => {
    write('{not json');
    expect(grokStatus()).toEqual({ connected: false, available: true });
  });

  it('never returns the tokens themselves', async () => {
    write({
      email: 'x@y.z',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accessToken: 'access-SECRET',
      refreshToken: 'refresh-SECRET',
    });
    const serialized = JSON.stringify(grokStatus());
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toMatch(/accessToken|refreshToken/);
  });
});
