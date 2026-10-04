import { describe, expect, it } from 'vitest';
import {
  authHeader,
  helloFrame,
  nextBackoff,
  replyFor,
  scopesFor,
  secureOrigin,
  refusalHeaders,
  tokenClaimsSummary,
  upgradeRefusal,
  wsUrl,
} from './protocol.js';

describe('protocol', () => {
  it('derives the runner socket URL from the server origin', () => {
    expect(wsUrl('https://app.azurewebsites.net')).toBe('wss://app.azurewebsites.net/ws/runner');
    expect(wsUrl('http://127.0.0.1:3200/some/path?x=1')).toBe('ws://127.0.0.1:3200/ws/runner');
  });
  it('hello carries v=1 and the machine; pings are answered with pongs carrying t', () => {
    const m = { fingerprint: 'f', hostname: 'h', os: 'win32', arch: 'x64', runner: 'vscode-0.1.0' };
    expect(helloFrame(m)).toEqual({ type: 'hello', v: 1, machine: m });
    expect(replyFor({ type: 'ping', t: 42 })).toEqual({ type: 'pong', t: 42 });
    expect(replyFor({ type: 'welcome' })).toBeNull();
  });
  it('backoff doubles from 1s and caps at 30s', () => {
    expect(nextBackoff(1000)).toBe(2000);
    expect(nextBackoff(16000)).toBe(30000);
    expect(nextBackoff(30000)).toBe(30000);
    expect(nextBackoff(0)).toBe(2000);
  });
  it('scopes name our API scope plus tenant/client pseudo-scopes only when given', () => {
    expect(scopesFor('api://c4ea', '8529', 'nat1')).toEqual([
      'api://c4ea/user_impersonation',
      'VSCODE_TENANT:8529',
      'VSCODE_CLIENT_ID:nat1',
    ]);
    expect(scopesFor('api://c4ea/', '', undefined)).toEqual(['api://c4ea/user_impersonation']);
  });
});

describe('authHeader', () => {
  it('sends the bearer when there is one, and nothing under network sign-in', () => {
    expect(authHeader('abc')).toEqual({ Authorization: 'Bearer abc' });
    expect(authHeader('')).toEqual({});
  });
});

describe('secureOrigin', () => {
  it('accepts TLS origins and loopback, refuses plain http anywhere else', () => {
    for (const u of [
      'https://app.azurewebsites.net',
      'wss://app.example.test/ws',
      'http://127.0.0.1:3200',
      'http://localhost:3100/x',
      'http://[::1]:3100',
      'ws://localhost:1',
    ]) {
      expect(secureOrigin(u)).toBe(true);
    }
    for (const u of [
      'http://nanoclaw.example.test',
      'http://192.0.2.10:3100',
      'ws://198.51.100.2',
      'http://127.0.0.1.example.test',
      'http://localhost.example.test',
      'ftp://localhost',
      'not a url',
      '',
    ]) {
      expect(secureOrigin(u)).toBe(false);
    }
  });
});

describe('upgradeRefusal', () => {
  it("names App Service's IP restriction, and the token otherwise", () => {
    expect(upgradeRefusal(403, 'Ip Forbidden', '20.1.2.3')).toMatch(/network address \(20\.1\.2\.3\)/);
    expect(upgradeRefusal(403, 'Ip Forbidden')).toMatch(/network address;/);
    expect(upgradeRefusal(403, 'Forbidden')).toBe('server refused the token (HTTP 403)');
    expect(upgradeRefusal(401, 'Unauthorized')).toBe('server refused the token (HTTP 401)');
  });
});

describe('refusal diagnostics', () => {
  it('summarises who a token is for, never the token', () => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b({ alg: 'RS256' })}.${b({ aud: 'api://app', azp: 'client-1', ver: '2.0', scp: 'user_impersonation', exp: 0, upn: 'x' })}.sig`;
    const s = tokenClaimsSummary(token);
    expect(s).toBe('aud=api://app azp=client-1 ver=2.0 scp=user_impersonation exp=1970-01-01T00:00:00.000Z');
    expect(s).not.toMatch(/sig|upn/);
    expect(tokenClaimsSummary('')).toBe('no token');
    expect(tokenClaimsSummary('garbage')).toBe('token not readable');
  });

  it('names the headers that identify the refusing layer', () => {
    expect(refusalHeaders({ server: 'nginx', 'content-type': 'text/html' })).toBe('server: nginx');
    expect(refusalHeaders({})).toBe('no identifying headers');
  });
});
