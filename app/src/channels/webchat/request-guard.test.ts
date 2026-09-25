import type { IncomingMessage } from 'http';
import os from 'os';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tailscale-serve.js', () => ({
  getTailscaleServeState: async () => ({ available: true, active: true, url: 'https://node-1.example.ts.net' }),
}));

const { __resetRequestGuardForTest, hostAllowed, originAllowed } = await import('./request-guard.js');

const req = (headers: Record<string, string>): IncomingMessage =>
  ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;

beforeEach(() => __resetRequestGuardForTest());

describe('hostAllowed', () => {
  it("accepts this server's own names and any IP literal", async () => {
    for (const host of [
      'localhost:3100',
      '127.0.0.1:3100',
      '[::1]:3100',
      '10.0.0.5:3100',
      `${os.hostname()}:3100`,
      'node-1.example.ts.net',
      'node-1:3100',
    ])
      expect(await hostAllowed(req({ host }), {}), host).toBe(true);
  });

  it('refuses a name that only points here (DNS rebinding)', async () => {
    expect(await hostAllowed(req({ host: 'attacker.example:3100' }), {})).toBe(false);
    expect(await hostAllowed(req({ host: 'other-node.example.ts.net' }), {})).toBe(false);
    expect(await hostAllowed(req({}), {})).toBe(false);
  });

  it('takes WEBCHAT_PUBLIC_URL and WEBCHAT_ALLOWED_HOSTS, and * turns it off', async () => {
    const env = { WEBCHAT_PUBLIC_URL: 'https://chat.example.com', WEBCHAT_ALLOWED_HOSTS: 'tunnel.example.org' };
    expect(await hostAllowed(req({ host: 'chat.example.com' }), env)).toBe(true);
    expect(await hostAllowed(req({ host: 'tunnel.example.org' }), env)).toBe(true);
    expect(await hostAllowed(req({ host: 'attacker.example' }), env)).toBe(false);
    expect(await hostAllowed(req({ host: 'attacker.example' }), { WEBCHAT_ALLOWED_HOSTS: '*' })).toBe(true);
  });
});

describe('originAllowed', () => {
  it('accepts no Origin, and one matching the Host or the forwarded host', () => {
    expect(originAllowed(req({ host: 'localhost:3100' }))).toBe(true);
    expect(originAllowed(req({ host: 'localhost:3100', origin: 'http://localhost:3100' }))).toBe(true);
    expect(
      originAllowed(
        req({ host: '127.0.0.1:3100', origin: 'https://chat.example.com', 'x-forwarded-host': 'chat.example.com' }),
      ),
    ).toBe(true);
  });

  it('refuses a cross-site Origin', () => {
    expect(originAllowed(req({ host: '127.0.0.1:3100', origin: 'https://attacker.example' }))).toBe(false);
    expect(originAllowed(req({ host: '127.0.0.1:3100', origin: 'null' }))).toBe(false);
  });
});
