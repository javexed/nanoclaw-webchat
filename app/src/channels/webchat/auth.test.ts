/**
 * Auth tests — bearer token gating, loopback auto-pass, IPv4-mapped IPv6
 * handling, trusted-proxy IP gating, and the Batch-1 minimum-token-length
 * startup gate.
 *
 * Auth.ts reads env vars at module load (`WEBCHAT_TOKEN`, `WEBCHAT_TAILSCALE`,
 * `WEBCHAT_TRUSTED_PROXY_IPS`). Tests use `vi.resetModules()` + dynamic
 * imports so each scenario boots auth.ts with its own env snapshot.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import type { IncomingMessage } from 'http';

// Each test resets modules to load auth.ts with a fresh env snapshot. That
// also resets the `db/connection.js` module instance, so the DB has to be
// re-initialised inside loadAuthWithEnv against the FRESH module instance —
// importing initTestDb at the top of this file gives us the wrong (already-
// closed) connection module after reset.

// Minimal IncomingMessage fake — the auth path only reads `socket.remoteAddress`
// and `headers`, so we don't need a real HTTP server.
function fakeReq(
  opts: {
    remoteAddress?: string;
    headers?: Record<string, string | string[] | undefined>;
  } = {},
): IncomingMessage {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    headers: opts.headers ?? {},
  } as unknown as IncomingMessage;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  // Close whichever connection module is currently loaded, then drop the
  // module cache so the next test starts clean.
  try {
    const conn = await import('../../db/connection.js');
    await conn.closeDb();
  } catch {
    // ignore
  }
  vi.resetModules();
});

async function loadAuthWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  vi.resetModules();
  // Init the FRESH connection module so getDb() works inside the freshly
  // loaded auth.ts/roles.ts.
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  // permissions module is optional — without `user_roles`, role helpers
  // degrade to "trust authenticated" and don't INSERT.
  return await import('./auth.js');
}

describe('assertBearerTokenStrength', () => {
  it('passes when no token is set (other auth modes)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: '' });
    expect(() => auth.assertBearerTokenStrength()).not.toThrow();
  });

  it('passes for a 24-char token (the minimum)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: 'a'.repeat(24) });
    expect(() => auth.assertBearerTokenStrength()).not.toThrow();
  });

  it('throws for a 23-char token (just below minimum)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: 'a'.repeat(23) });
    expect(() => auth.assertBearerTokenStrength()).toThrow(/at least 24/);
  });

  it('throws for a trivially short token', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: 'hunter2' });
    expect(() => auth.assertBearerTokenStrength()).toThrow();
  });
});

describe('getAuthManagementInfo — loopback (Localhost only)', () => {
  it('reports loopback when WEBCHAT_HOST is unset (defaults to 127.0.0.1)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_HOST: undefined });
    expect((await auth.getAuthManagementInfo()).loopback).toBe(true);
  });

  it('reports loopback for loopback bind hosts', async () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) {
      const auth = await loadAuthWithEnv({ WEBCHAT_HOST: host });
      expect((await auth.getAuthManagementInfo()).loopback).toBe(true);
    }
  });

  it('reports NOT loopback when bound to all interfaces (0.0.0.0)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_HOST: '0.0.0.0' });
    expect((await auth.getAuthManagementInfo()).loopback).toBe(false);
  });
});

describe('authenticateRequest — bearer', () => {
  const TOKEN = 'a'.repeat(32);

  it('accepts a matching Authorization Bearer header', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: TOKEN });
    const req = fakeReq({
      remoteAddress: '203.0.113.5',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('bearer');
  });

  it('accepts a bearer subprotocol on the WS upgrade', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: TOKEN });
    const req = fakeReq({
      remoteAddress: '203.0.113.5',
      headers: { 'sec-websocket-protocol': `bearer.${TOKEN}` },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('bearer');
  });

  it('rejects a wrong token (timing-safe compare returns false)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: TOKEN });
    const req = fakeReq({
      remoteAddress: '203.0.113.5',
      headers: { authorization: `Bearer wrong-token-of-the-same-length-aaaa` },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });

  it('rejects when no token sent and not on loopback', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: TOKEN });
    const req = fakeReq({ remoteAddress: '203.0.113.5' });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });
});

describe('loopbackVisitorWithoutSignIn — who is sent to the tailnet address', () => {
  const local = (headers: Record<string, string> = {}) =>
    fakeReq({ remoteAddress: '127.0.0.1', headers: { host: 'localhost:3101', ...headers } });

  it('a localhost browser that cannot be signed in, on a Tailscale install', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true', WEBCHAT_TOKEN: '' });
    expect(await auth.loopbackVisitorWithoutSignIn(local())).toBe(true);
  });

  it("never Serve's own requests (they carry the identity header), so no redirect loop", async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true', WEBCHAT_TOKEN: '' });
    expect(await auth.loopbackVisitorWithoutSignIn(local({ 'tailscale-user-login': 'jane@example.com' }))).toBe(false);
  });

  it('never a proxy forwarding a visitor under a public name, nor a non-loopback caller', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true', WEBCHAT_TOKEN: '' });
    expect(await auth.loopbackVisitorWithoutSignIn(local({ host: 'chat.example.com' }))).toBe(false);
    expect(
      await auth.loopbackVisitorWithoutSignIn(
        fakeReq({ remoteAddress: '203.0.113.7', headers: { host: 'localhost:3101' } }),
      ),
    ).toBe(false);
  });

  it('never when the visitor IS signed in (bearer), nor on an install without Tailscale sign-in', async () => {
    const token = 'a'.repeat(32);
    const withBearer = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true', WEBCHAT_TOKEN: token });
    expect(await withBearer.loopbackVisitorWithoutSignIn(local({ authorization: `Bearer ${token}` }))).toBe(false);
    const localhostOnly = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: '', WEBCHAT_TOKEN: '' });
    expect(await localhostOnly.loopbackVisitorWithoutSignIn(local())).toBe(false);
  });
});

describe('authenticateRequest — loopback bypass', () => {
  it('auto-passes loopback when no explicit auth is configured', async () => {
    const auth = await loadAuthWithEnv({});
    const req = fakeReq({ remoteAddress: '127.0.0.1' });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('localhost');
  });

  it('treats IPv4-mapped IPv6 (::ffff:127.0.0.1) as loopback', async () => {
    const auth = await loadAuthWithEnv({});
    const req = fakeReq({ remoteAddress: '::ffff:127.0.0.1' });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('localhost');
  });

  it('treats ::1 as loopback', async () => {
    const auth = await loadAuthWithEnv({});
    const req = fakeReq({ remoteAddress: '::1' });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
  });

  it('DISABLES loopback bypass when WEBCHAT_TOKEN is set', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: 'a'.repeat(32) });
    const req = fakeReq({ remoteAddress: '127.0.0.1' });
    const result = await auth.authenticateRequest(req);
    // No bearer presented — must reject even though it's loopback.
    expect(result.ok).toBe(false);
  });

  it('DISABLES loopback bypass when tailscale is enabled', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    const req = fakeReq({ remoteAddress: '127.0.0.1' });
    const result = await auth.authenticateRequest(req);
    // Tailscale whois on 127.0.0.1 returns nothing — and loopback is disabled.
    expect(result.ok).toBe(false);
  });
});

describe('tailscaleServeIdentity — serve HTTPS header, loopback-gated', () => {
  it('returns the login when the header arrives on loopback', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    const req = fakeReq({ remoteAddress: '127.0.0.1', headers: { 'tailscale-user-login': 'alice@github' } });
    expect(auth.tailscaleServeIdentity(req, '127.0.0.1')).toBe('alice@github');
  });

  it('rejects the header from a non-loopback source (spoof guard)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    // A LAN attacker hitting :PORT directly and forging the header must NOT be trusted.
    const req = fakeReq({ remoteAddress: '10.0.0.10', headers: { 'tailscale-user-login': 'attacker@evil' } });
    expect(auth.tailscaleServeIdentity(req, '10.0.0.10')).toBeNull();
  });

  it('returns null on loopback when the header is absent', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    expect(auth.tailscaleServeIdentity(fakeReq({ remoteAddress: '127.0.0.1' }), '127.0.0.1')).toBeNull();
  });
});

describe('authenticateRequest — tailscale serve header path', () => {
  it('authenticates a loopback serve request as the same webchat:tailscale id whois mints', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    const req = fakeReq({ remoteAddress: '127.0.0.1', headers: { 'tailscale-user-login': 'Alice@Github' } });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('tailscale');
      // Same normalization as the whois path → identity continuity across http→https.
      expect(result.userId).toBe('webchat:tailscale:alice@github');
    }
  });

  it('does NOT trust the serve header from a non-loopback IP (falls through to reject)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    const req = fakeReq({ remoteAddress: '10.0.0.10', headers: { 'tailscale-user-login': 'attacker@evil' } });
    const result = await auth.authenticateRequest(req);
    // whois on a LAN IP returns nothing (no tailscale binary in tests) → Unauthorized.
    expect(result.ok).toBe(false);
  });

  it('ignores the serve header entirely when WEBCHAT_TAILSCALE is off', async () => {
    const auth = await loadAuthWithEnv({});
    const req = fakeReq({ remoteAddress: '127.0.0.1', headers: { 'tailscale-user-login': 'alice@github' } });
    const result = await auth.authenticateRequest(req);
    // No tailscale mode + no other explicit auth → plain loopback auto-pass, not a tailscale id.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('localhost');
  });
});

describe('authenticateRequest — trusted proxy header', () => {
  it('accepts a header from a configured proxy IP', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
    });
    const req = fakeReq({
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-user': 'alice@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('proxy-header');
      expect(result.userId).toContain('alice');
    }
  });

  it('rejects a header from a NON-trusted source IP', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
    });
    const req = fakeReq({
      remoteAddress: '203.0.113.99',
      headers: { 'x-forwarded-user': 'attacker@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });

  it('accepts via CIDR match', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.0/24',
    });
    const req = fakeReq({
      remoteAddress: '10.0.0.42',
      headers: { 'x-forwarded-user': 'bob@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
  });

  it('rejects a CIDR-out-of-range source', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.0/24',
    });
    const req = fakeReq({
      remoteAddress: '10.0.1.1',
      headers: { 'x-forwarded-user': 'bob@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });

  // The mode selects the IP gate, NOT which headers are understood. An
  // explicit IP list used to read only TRUSTED_PROXY_HEADER, so hardening
  // `auto` → a specific IP silently 401'd every EasyAuth login.
  it('accepts an Azure EasyAuth header pair from a configured proxy IP', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
    });
    const req = fakeReq({
      remoteAddress: '10.0.0.5',
      headers: {
        'x-ms-client-principal-name': 'Carol.Smith@example.com',
        'x-ms-client-principal': 'eyJjbGFpbXMiOltdfQ==',
      },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('proxy-header');
      // Same id the `auto` mode mints, so roles survive the tightening.
      expect(result.userId).toBe('webchat:carol.smith@example.com');
    }
  });

  it('accepts a Cloudflare Access header pair from a configured proxy IP', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
    });
    const req = fakeReq({
      remoteAddress: '10.0.0.5',
      headers: {
        'cf-access-authenticated-user-email': 'dave@example.com',
        'cf-access-jwt-assertion': 'header.payload.sig',
      },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe('webchat:dave@example.com');
  });

  it('rejects an EasyAuth header pair from an untrusted source IP', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
    });
    const req = fakeReq({
      remoteAddress: '192.168.0.200',
      headers: {
        'x-ms-client-principal-name': 'attacker@example.com',
        'x-ms-client-principal': 'eyJjbGFpbXMiOltdfQ==',
      },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });

  it('rejects an empty identity header rather than minting a handle-less id', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
    });
    const req = fakeReq({
      remoteAddress: '10.0.0.5',
      headers: {
        'x-ms-client-principal-name': '',
        'x-ms-client-principal': 'eyJjbGFpbXMiOltdfQ==',
      },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });

  it('still honours the configured header when no platform pair is present', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-custom-user',
    });
    const req = fakeReq({
      remoteAddress: '10.0.0.5',
      headers: { 'x-custom-user': 'erin@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe('webchat:erin@example.com');
  });
});

describe('canonicalizeWebchatUserId', () => {
  it('folds an SSO/proxy webchat id to the lowercased form the auth layer mints', async () => {
    const auth = await import('./auth.js');
    // Mirrors the proxy-header path: webchat:${normalizeId(identity)}
    expect(auth.canonicalizeWebchatUserId('webchat:Sam@Example.com')).toBe('webchat:sam@example.com');
  });

  it('preserves the tailscale infix while folding the handle', async () => {
    const auth = await import('./auth.js');
    expect(auth.canonicalizeWebchatUserId('webchat:tailscale:Alice@Tailnet.TS.net')).toBe(
      'webchat:tailscale:alice@tailnet.ts.net',
    );
  });

  it('replaces disallowed characters with hyphens (matching normalizeId)', async () => {
    const auth = await import('./auth.js');
    expect(auth.canonicalizeWebchatUserId('webchat:User Name!')).toBe('webchat:user-name-');
  });

  it('leaves non-webchat ids untouched (other channels own their handles)', async () => {
    const auth = await import('./auth.js');
    expect(auth.canonicalizeWebchatUserId('slack:U012AB')).toBe('slack:U012AB');
    expect(auth.canonicalizeWebchatUserId('discord:Sam#1234')).toBe('discord:Sam#1234');
  });

  it('is idempotent and leaves fixed ids (owner/local-owner) stable', async () => {
    const auth = await import('./auth.js');
    expect(auth.canonicalizeWebchatUserId('webchat:owner')).toBe('webchat:owner');
    expect(auth.canonicalizeWebchatUserId('webchat:local-owner')).toBe('webchat:local-owner');
    const once = auth.canonicalizeWebchatUserId('webchat:Sam@Example.com');
    expect(auth.canonicalizeWebchatUserId(once)).toBe(once);
  });
});

describe('tailscaleReprobeDue — re-probe cadence (pure)', () => {
  it('re-probes eagerly while down/unknown (>= 10s), not before', async () => {
    const auth = await import('./auth.js');
    // Unknown (never probed) and explicitly-down both use the eager interval.
    expect(auth.tailscaleReprobeDue(null, 0, 9_999)).toBe(false);
    expect(auth.tailscaleReprobeDue(null, 0, 10_000)).toBe(true);
    expect(auth.tailscaleReprobeDue(false, 100_000, 109_999)).toBe(false);
    expect(auth.tailscaleReprobeDue(false, 100_000, 110_000)).toBe(true);
  });

  it('re-probes lazily once up (>= 60s), not before', async () => {
    const auth = await import('./auth.js');
    expect(auth.tailscaleReprobeDue(true, 100_000, 159_999)).toBe(false);
    expect(auth.tailscaleReprobeDue(true, 100_000, 160_000)).toBe(true);
  });
});

describe('probeTailscaleHealth — cached flag tracks the probe result', () => {
  it('self-heals false → true when tailscale appears (the "added later" case)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    // Boot probe: binary absent → healthy false (this is the bug's starting state).
    await auth.probeTailscaleHealth(async () => ({ ok: false, notInstalled: true }));
    expect((await auth.getAuthInfo()).tailscaleHealthy).toBe(false);
    // Operator installs tailscale; a later probe must flip the flag without a restart.
    await auth.probeTailscaleHealth(async () => ({ ok: true, notInstalled: false }));
    expect((await auth.getAuthInfo()).tailscaleHealthy).toBe(true);
  });

  it('flips true → false when a probe later fails (tailscaled down)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    await auth.probeTailscaleHealth(async () => ({ ok: true, notInstalled: false }));
    expect((await auth.getAuthInfo()).tailscaleHealthy).toBe(true);
    await auth.probeTailscaleHealth(async () => ({ ok: false, notInstalled: false }));
    expect((await auth.getAuthInfo()).tailscaleHealthy).toBe(false);
  });

  it('detects host presence even when WEBCHAT_TAILSCALE is off, but keeps auth gated', async () => {
    const auth = await loadAuthWithEnv({});
    let ran = false;
    await auth.probeTailscaleHealth(async () => {
      ran = true;
      return { ok: true, notInstalled: false };
    });
    // Detection runs regardless of the auth flag — that's the wizard fix.
    expect(ran).toBe(true);
    // Pre-auth login hint stays gated: tailscale isn't an enabled method here.
    expect((await auth.getAuthInfo()).tailscaleHealthy).toBe(false);
    // But the owner-facing management view sees the real running tailnet, so the
    // wizard's Tailscale step can offer to enable it.
    expect((await auth.getAuthManagementInfo()).tailscale.healthy).toBe(true);
    expect((await auth.getAuthManagementInfo()).tailscale.enabled).toBe(false);
  });

  it('collapses concurrent callers onto one in-flight probe', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    let calls = 0;
    const runner = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, notInstalled: false };
    };
    await Promise.all([auth.probeTailscaleHealth(runner), auth.probeTailscaleHealth(runner)]);
    expect(calls).toBe(1);
    expect((await auth.getAuthInfo()).tailscaleHealthy).toBe(true);
  });
});

// ── OIDC ──────────────────────────────────────────────────────────────────
//
// A real RSA keypair, a stubbed JWKS endpoint, and tokens minted in-test. No
// network, no Azure. Every case also runs with NO other auth method configured,
// so a refused token lands on 401 rather than being rescued by a fallback —
// which is what makes each refusal observable.
describe('authenticateRequest — OIDC bearer / EasyAuth id token', () => {
  const ISS = 'https://login.microsoftonline.com/test-tenant/v2.0';
  const AUD = 'test-audience-client-id';
  const JWKS_URI = 'https://jwks.test/keys';
  const KID_A = 'kid-a';
  const KID_B = 'kid-b';
  const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwkOf = (k: typeof keyA, kid: string) => ({
    ...(k.publicKey.export({ format: 'jwk' }) as object),
    kid,
    alg: 'RS256',
    use: 'sig',
  });

  const b64u = (x: string | Buffer): string => Buffer.from(x).toString('base64url');
  const nowS = () => Math.floor(Date.now() / 1000);
  const baseClaims = () => ({
    iss: ISS,
    aud: AUD,
    exp: nowS() + 3600,
    nbf: nowS() - 60,
    preferred_username: 'Jane.Doe@Example.com',
    name: 'Jane Doe',
    oid: '00000000-0000-0000-0000-000000000001',
  });

  function mint(
    claims: Record<string, unknown>,
    opts: { alg?: string; kid?: string | null; key?: typeof keyA; hsSecret?: string } = {},
  ): string {
    const header: Record<string, unknown> = { alg: opts.alg ?? 'RS256', typ: 'JWT' };
    if (opts.kid !== null) header.kid = opts.kid ?? KID_A;
    const h = b64u(JSON.stringify(header));
    const p = b64u(JSON.stringify(claims));
    let sig = 'x'; // non-empty so the token still LOOKS like a JWT and reaches the verifier
    if (header.alg === 'RS256')
      sig = b64u(cryptoSign('sha256', Buffer.from(`${h}.${p}`), (opts.key ?? keyA).privateKey));
    else if (header.alg === 'HS256')
      sig = b64u(
        createHmac('sha256', opts.hsSecret ?? '')
          .update(`${h}.${p}`)
          .digest(),
      );
    return `${h}.${p}.${sig}`;
  }

  let servedKeys: unknown[] = [];
  // Count through the mock's own recorder: a closure counter inside the impl goes
  // blind the moment a test swaps the impl with mockRejectedValue(...).
  const calls = (): number => (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
  const OIDC_ONLY = {
    WEBCHAT_TOKEN: '',
    WEBCHAT_TAILSCALE: '',
    WEBCHAT_TRUSTED_PROXY_IPS: '',
    WEBCHAT_OIDC_ISSUER: ISS,
    WEBCHAT_OIDC_AUDIENCE: AUD,
    WEBCHAT_OIDC_JWKS_URI: JWKS_URI,
  };

  beforeEach(() => {
    servedKeys = [jwkOf(keyA, KID_A)];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) !== JWKS_URI) throw new Error(`unexpected fetch: ${String(url)}`);
        return { ok: true, status: 200, json: async () => ({ keys: servedKeys }) };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const bearer = (token: string, ip = '203.0.113.7') =>
    fakeReq({ remoteAddress: ip, headers: { authorization: `Bearer ${token}` } });

  it('accepts a valid RS256 token as a Bearer and mints the same id the proxy path would', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    const r = await auth.authenticateRequest(bearer(mint(baseClaims())));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe('oidc');
      // normalizeId lowercases: the row EasyAuth's header path created for this person.
      expect(r.userId).toBe('webchat:jane.doe@example.com');
      expect(r.displayName).toBe('Jane Doe');
    }
    expect(calls()).toBe(1);
  });

  it('accepts the same token forwarded by EasyAuth in x-ms-token-aad-id-token', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    const req = fakeReq({ remoteAddress: '203.0.113.7', headers: { 'x-ms-token-aad-id-token': mint(baseClaims()) } });
    const r = await auth.authenticateRequest(req);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toBe('oidc');
  });

  it('refuses alg=none', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    expect((await auth.authenticateRequest(bearer(mint(baseClaims(), { alg: 'none' })))).ok).toBe(false);
  });

  it('refuses HS256 signed with the public key as the HMAC secret (algorithm confusion)', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    const pubPem = keyA.publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const t = mint(baseClaims(), { alg: 'HS256', hsSecret: pubPem });
    expect((await auth.authenticateRequest(bearer(t))).ok).toBe(false);
  });

  it('refuses a token signed by a key that is not in the JWKS', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    // kid claims to be A, but the signature is B's
    expect((await auth.authenticateRequest(bearer(mint(baseClaims(), { key: keyB })))).ok).toBe(false);
  });

  it('refuses wrong iss, wrong aud, expired exp, and future nbf — each independently', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    const cases: Array<Record<string, unknown>> = [
      { ...baseClaims(), iss: 'https://login.microsoftonline.com/other-tenant/v2.0' },
      { ...baseClaims(), aud: 'some-other-app' },
      { ...baseClaims(), exp: nowS() - 600 },
      { ...baseClaims(), nbf: nowS() + 600 },
    ];
    for (const c of cases) expect((await auth.authenticateRequest(bearer(mint(c)))).ok).toBe(false);
  });

  it('accepts aud given as an array that contains the audience', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    const r = await auth.authenticateRequest(bearer(mint({ ...baseClaims(), aud: ['other', AUD] })));
    expect(r.ok).toBe(true);
  });

  it('tolerates clock skew inside the window, not outside it', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    expect((await auth.authenticateRequest(bearer(mint({ ...baseClaims(), exp: nowS() - 60 })))).ok).toBe(true);
    expect((await auth.authenticateRequest(bearer(mint({ ...baseClaims(), exp: nowS() - 180 })))).ok).toBe(false);
  });

  it('falls back through the claim order preferred_username → upn → email, and refuses with none', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    const noPref = { ...baseClaims() } as Record<string, unknown>;
    delete noPref.preferred_username;
    let r = await auth.authenticateRequest(bearer(mint({ ...noPref, upn: 'Upn.User@Example.com' })));
    expect(r.ok && r.userId).toBe('webchat:upn.user@example.com');
    r = await auth.authenticateRequest(bearer(mint({ ...noPref, email: 'Mail.User@Example.com' })));
    expect(r.ok && r.userId).toBe('webchat:mail.user@example.com');
    expect((await auth.authenticateRequest(bearer(mint(noPref)))).ok).toBe(false);
  });

  it('a JWT-shaped string that is not a JWT falls through without crashing (and is refused when nothing else applies)', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    expect((await auth.authenticateRequest(bearer('not.a.jwt'))).ok).toBe(false);
  });

  it('an unknown kid triggers one fetch, not a refetch storm, and is refused', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    expect((await auth.authenticateRequest(bearer(mint(baseClaims(), { kid: 'nobody-knows-me' })))).ok).toBe(false);
    // First lookup fetched; the miss must NOT refetch inside the rate-limit window.
    expect(calls()).toBe(1);
  });

  it('survives key rotation: a new kid is picked up once the refetch window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-09-14T12:00:00Z');
    vi.setSystemTime(t0);
    const auth = await loadAuthWithEnv(OIDC_ONLY);

    // Warm the cache with key A.
    expect((await auth.authenticateRequest(bearer(mint(baseClaims())))).ok).toBe(true);
    expect(calls()).toBe(1);

    // Entra rotates: JWKS now serves B only; a token signed by B arrives immediately.
    servedKeys = [jwkOf(keyB, KID_B)];
    const tokenB = () => mint(baseClaims(), { kid: KID_B, key: keyB });
    expect((await auth.authenticateRequest(bearer(tokenB()))).ok).toBe(false); // inside the 60s rate limit
    expect(calls()).toBe(1);

    // 61 seconds later the unknown kid is allowed to refetch — and B verifies.
    vi.setSystemTime(new Date(t0.getTime() + 61_000));
    expect((await auth.authenticateRequest(bearer(tokenB()))).ok).toBe(true);
    expect(calls()).toBe(2);
  });

  it('a persistent JWKS outage refuses without crashing and costs ONE fetch per window, not one per request', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('jwks down'));
    for (let i = 0; i < 4; i++) expect((await auth.authenticateRequest(bearer(mint(baseClaims())))).ok).toBe(false);
    expect(calls()).toBe(1);
  });

  it('a transient JWKS failure self-heals once the refetch window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-09-14T12:00:00Z');
    vi.setSystemTime(t0);
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('blip'));
    expect((await auth.authenticateRequest(bearer(mint(baseClaims())))).ok).toBe(false);
    expect(calls()).toBe(1);
    // Still inside the window: no new attempt, still refused.
    vi.setSystemTime(new Date(t0.getTime() + 30_000));
    expect((await auth.authenticateRequest(bearer(mint(baseClaims())))).ok).toBe(false);
    expect(calls()).toBe(1);
    // Past it: one fetch, and it works.
    vi.setSystemTime(new Date(t0.getTime() + 61_000));
    expect((await auth.authenticateRequest(bearer(mint(baseClaims())))).ok).toBe(true);
    expect(calls()).toBe(2);
  });

  it('serves cached keys through a JWKS outage once the TTL has lapsed (stale beats none)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-09-14T12:00:00Z');
    vi.setSystemTime(t0);
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    expect((await auth.authenticateRequest(bearer(mint(baseClaims())))).ok).toBe(true);
    // Two hours on: TTL lapsed, refresh attempted and FAILS — the old keys must still verify.
    vi.setSystemTime(new Date(t0.getTime() + 2 * 3_600_000));
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('jwks down'));
    expect((await auth.authenticateRequest(bearer(mint(baseClaims())))).ok).toBe(true);
    expect(calls()).toBe(2);
  });

  it('is inert when only partially configured (issuer without audience)', async () => {
    const auth = await loadAuthWithEnv({ ...OIDC_ONLY, WEBCHAT_OIDC_AUDIENCE: '' });
    // Nothing explicit is configured, so the loopback auto-pass applies — proving
    // the token was never consulted (a consulted-and-refused token would 401).
    const r = await auth.authenticateRequest(bearer(mint(baseClaims()), '127.0.0.1'));
    expect(r.ok && r.source).toBe('localhost');
    expect(calls()).toBe(0);
    expect(await auth.hasExplicitAuth()).toBe(false);
  });

  it('counts as an explicit auth method, so OIDC-only does not leave the loopback auto-pass armed', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    expect(await auth.hasExplicitAuth()).toBe(true);
    const r = await auth.authenticateRequest(fakeReq({ remoteAddress: '127.0.0.1' }));
    expect(r.ok).toBe(false);
  });

  it('a bad token still lets a trusted proxy header authenticate (fall-through is the designed fallback)', async () => {
    const auth = await loadAuthWithEnv({ ...OIDC_ONLY, WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5' });
    const req = fakeReq({
      remoteAddress: '10.0.0.5',
      headers: {
        'x-ms-token-aad-id-token': mint({ ...baseClaims(), exp: nowS() - 9999 }), // lapsed
        'x-ms-client-principal-name': 'Jane.Doe@Example.com',
        'x-ms-client-principal': 'eyJjbGFpbXMiOltdfQ==',
      },
    });
    const r = await auth.authenticateRequest(req);
    expect(r.ok && r.source).toBe('proxy-header');
    expect(r.ok && r.userId).toBe('webchat:jane.doe@example.com'); // same person, same row
  });
  it('names the reason for every refusal, and never the token', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    const why = async (tok: string) => {
      const r = await auth.verifyOidcTokenDetailed(tok);
      return r.ok ? 'ok' : r.reason;
    };
    expect(await why('not.a.jwt')).toBe('malformed');
    expect(await why(mint(baseClaims(), { alg: 'none' }))).toBe('alg');
    expect(await why(mint(baseClaims(), { kid: 'retired-key' }))).toBe('unknown-kid');
    expect(await why(mint(baseClaims(), { key: keyB }))).toBe('bad-signature');
    expect(await why(mint({ ...baseClaims(), exp: nowS() - 3 * 86_400 }))).toBe('expired');
    expect(await why(mint({ ...baseClaims(), nbf: nowS() + 600 }))).toBe('not-yet-valid');
    expect(await why(mint({ ...baseClaims(), iss: 'https://login.microsoftonline.com/other/v2.0' }))).toBe('issuer');
    expect(await why(mint({ ...baseClaims(), aud: 'someone-else' }))).toBe('audience');
    const anon = { ...baseClaims() } as Record<string, unknown>;
    delete anon.preferred_username;
    expect(await why(mint(anon))).toBe('no-identity');
    expect(await why(mint(baseClaims()))).toBe('ok');
  });

  it('reports how long an expired token has been dead — the stale-token-store tell', async () => {
    const auth = await loadAuthWithEnv(OIDC_ONLY);
    const r = await auth.verifyOidcTokenDetailed(mint({ ...baseClaims(), exp: nowS() - 3 * 86_400 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('expired');
      expect(r.expiredForS).toBeGreaterThanOrEqual(3 * 86_400 - 5);
    }
  });

  it('is inert-by-reason when not configured', async () => {
    const auth = await loadAuthWithEnv({ ...OIDC_ONLY, WEBCHAT_OIDC_AUDIENCE: '' });
    const r = await auth.verifyOidcTokenDetailed(mint(baseClaims()));
    expect(!r.ok && r.reason).toBe('disabled');
  });
  it('marks a fall-through caused by an EXPIRED token with hint=token-stale, and only then', async () => {
    const auth = await loadAuthWithEnv({ ...OIDC_ONLY, WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5' });
    const viaProxy = (token: string) =>
      fakeReq({
        remoteAddress: '10.0.0.5',
        headers: {
          'x-ms-token-aad-id-token': token,
          'x-ms-client-principal-name': 'Jane.Doe@Example.com',
          'x-ms-client-principal': 'eyJjbGFpbXMiOltdfQ==',
        },
      });
    // Expired → the header carries the request → hint set.
    let r = await auth.authenticateRequest(viaProxy(mint({ ...baseClaims(), exp: nowS() - 5 * 3600 })));
    expect(r.ok && r.source).toBe('proxy-header');
    expect(r.ok && r.hint).toBe('token-stale');
    // Fresh → verified → no hint.
    r = await auth.authenticateRequest(viaProxy(mint(baseClaims())));
    expect(r.ok && r.source).toBe('oidc');
    expect(r.ok && r.hint).toBeUndefined();
    // Wrong audience is misconfiguration, not staleness — refreshing would not help, so no hint.
    r = await auth.authenticateRequest(viaProxy(mint({ ...baseClaims(), aud: 'someone-else' })));
    expect(r.ok && r.source).toBe('proxy-header');
    expect(r.ok && r.hint).toBeUndefined();
  });
});

describe('OIDC — any provider', () => {
  const ISS = 'https://sso.example.org/realms/main';
  const AUD = 'nanoclaw';
  const JWKS_URI = 'https://sso.example.org/realms/main/certs';
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64u = (x: string | Buffer): string => Buffer.from(x).toString('base64url');
  const nowS = () => Math.floor(Date.now() / 1000);
  const claims = (extra: Record<string, unknown> = {}) => ({
    iss: ISS,
    aud: AUD,
    exp: nowS() + 3600,
    sub: 'f3a1',
    email: 'Sam@Example.org',
    email_verified: true,
    preferred_username: 'sammy',
    name: 'Sam',
    ...extra,
  });
  function mint(
    c: Record<string, unknown>,
    alg: 'ES256' | 'RS256' = 'ES256',
    kid = alg === 'ES256' ? 'ec1' : 'rsa1',
  ): string {
    const h = b64u(JSON.stringify({ alg, kid, typ: 'JWT' }));
    const p = b64u(JSON.stringify(c));
    const data = Buffer.from(`${h}.${p}`);
    const sig =
      alg === 'ES256'
        ? cryptoSign('sha256', data, { key: ec.privateKey, dsaEncoding: 'ieee-p1363' })
        : cryptoSign('sha256', data, rsa.privateKey);
    return `${h}.${p}.${b64u(sig)}`;
  }
  const ENV = {
    WEBCHAT_TOKEN: '',
    WEBCHAT_TAILSCALE: '',
    WEBCHAT_TRUSTED_PROXY_IPS: '',
    WEBCHAT_OIDC_PROVIDER: 'other',
    WEBCHAT_OIDC_NAME: 'Keycloak',
    WEBCHAT_OIDC_ISSUER: ISS,
    WEBCHAT_OIDC_AUDIENCE: AUD,
    WEBCHAT_OIDC_JWKS_URI: JWKS_URI,
    WEBCHAT_OIDC_AUTHORIZE_URL: `${ISS}/auth`,
    WEBCHAT_OIDC_TOKEN_URL: `${ISS}/token`,
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) !== JWKS_URI) throw new Error(`unexpected fetch: ${String(url)}`);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            keys: [
              { ...(ec.publicKey.export({ format: 'jwk' }) as object), kid: 'ec1', use: 'sig' },
              { ...(rsa.publicKey.export({ format: 'jwk' }) as object), kid: 'rsa1', use: 'sig' },
            ],
          }),
        };
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('verifies ES256 and RS256, and signs in by the verified email', async () => {
    const auth = await loadAuthWithEnv(ENV);
    for (const alg of ['ES256', 'RS256'] as const) {
      const r = await auth.verifyOidcTokenDetailed(mint(claims(), alg));
      expect(r.ok && r.identity).toEqual({ identity: 'Sam@Example.org', displayName: 'Sam' });
    }
    expect(auth.getAuthInfo).toBeDefined();
    expect((await auth.getAuthInfo()).oidcName).toBe('Keycloak');
    expect(auth.oidcLoginEnabled()).toBe(true);
  });

  it('refuses an unverified or missing email — never the free-form preferred_username', async () => {
    const auth = await loadAuthWithEnv(ENV);
    for (const c of [
      claims({ email_verified: false }),
      claims({ email_verified: undefined }),
      claims({ email: undefined }),
    ]) {
      const r = await auth.verifyOidcTokenDetailed(mint(c));
      expect(!r.ok && r.reason).toBe('no-identity');
    }
    // Some providers send the flag as a string.
    expect((await auth.verifyOidcTokenDetailed(mint(claims({ email_verified: 'true' })))).ok).toBe(true);
  });

  it("pins the algorithm to the key's type: an ES256 header on an RSA key is refused", async () => {
    const auth = await loadAuthWithEnv(ENV);
    const t = mint(claims(), 'RS256');
    const [, p, s] = t.split('.');
    const forged = `${b64u(JSON.stringify({ alg: 'ES256', kid: 'rsa1' }))}.${p}.${s}`;
    const r = await auth.verifyOidcTokenDetailed(forged);
    expect(!r.ok && r.reason).toBe('alg');
  });
});

describe('Tailscale and the trusted proxy apply without a restart', () => {
  it('reads WEBCHAT_TRUSTED_PROXY_* and WEBCHAT_TAILSCALE on every request', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: '', WEBCHAT_TAILSCALE: '', WEBCHAT_TRUSTED_PROXY_IPS: '' });
    const viaProxy = fakeReq({ remoteAddress: '10.0.0.5', headers: { 'x-auth-user': 'kim@example.org' } });
    expect((await auth.authenticateRequest(viaProxy)).ok).toBe(false);
    vi.stubEnv('WEBCHAT_TRUSTED_PROXY_IPS', '10.0.0.0/24');
    vi.stubEnv('WEBCHAT_TRUSTED_PROXY_HEADER', 'x-auth-user');
    const r = await auth.authenticateRequest(viaProxy);
    expect(r.ok && r.userId).toBe('webchat:kim@example.org');
    expect((await auth.getAuthInfo()).methods.proxy).toBe(true);
    vi.stubEnv('WEBCHAT_TRUSTED_PROXY_IPS', '');
    expect((await auth.authenticateRequest(viaProxy)).ok).toBe(false);
    expect((await auth.getAuthInfo()).methods.tailscale).toBe(false);
    vi.stubEnv('WEBCHAT_TAILSCALE', 'true');
    expect((await auth.getAuthInfo()).methods.tailscale).toBe(true);
  });
});
