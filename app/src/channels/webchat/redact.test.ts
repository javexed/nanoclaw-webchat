/**
 * Redaction tests — every pattern in `redact.ts` should match its target
 * shape and pass benign-looking content through unchanged — in particular,
 * CONN_PASSWORD must leave benign URLs alone.
 */
import { describe, it, expect } from 'vitest';

import { redactMessageContent, redactSensitiveData } from './redact.js';

describe('redactSensitiveData — sensitive patterns', () => {
  it.each([
    ['Anthropic key', `sk-ant-api03-${'A'.repeat(95)}`, 'ANTHROPIC_KEY'],
    ['Anthropic OAuth', `sk-ant-oat01-${'A'.repeat(60)}`, 'ANTHROPIC_TOKEN'],
    ['generic sk- key', `sk-${'A'.repeat(40)}`, 'API_KEY'],
    ['GitHub token', `ghp_${'A'.repeat(40)}`, 'GITHUB_TOKEN'],
    ['GitHub PAT', `github_pat_${'A'.repeat(30)}`, 'GITHUB_PAT'],
    ['AWS access key', 'AKIA' + 'A'.repeat(16), 'AWS_KEY'],
    ['Slack token', 'xoxb-12345-67890-abcdef', 'SLACK_TOKEN'],
  ])('redacts %s', (_label, secret, marker) => {
    const out = redactSensitiveData(`my key is ${secret} please`);
    expect(out).toContain(marker);
    expect(out).not.toContain(secret);
  });

  it('redacts a PEM private key block', async () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK\n-----END RSA PRIVATE KEY-----`;
    const out = redactSensitiveData(`see\n${pem}\nend`);
    expect(out).toContain('PRIVATE_KEY');
    expect(out).not.toContain('MIIEpAIBAAK');
  });

  it('redacts ENV-style secrets', async () => {
    const out = redactSensitiveData(`API_KEY=supersecretvalue123`);
    expect(out).toContain('ENV_SECRET');
    expect(out).not.toContain('supersecretvalue123');
  });

  it('redacts a connection-string password and preserves the host', async () => {
    const out = redactSensitiveData('postgres://alice:hunter2pw@db.example.com:5432/app');
    expect(out).toContain('CONN_PASSWORD');
    expect(out).not.toContain('hunter2pw');
    // Regression guard: the broader PASSWORD pattern used to greedy-match
    // the bracketed CONN_PASSWORD output and swallow the host portion.
    expect(out).toContain('db.example.com');
  });
});

describe('redactSensitiveData — false-positive guards', () => {
  it('passes a plain English sentence through unchanged', async () => {
    const text = 'This is a regular sentence with a colon: and an at-sign @ but nothing secret.';
    expect(redactSensitiveData(text)).toBe(text);
  });

  it('does not mangle a markdown URL whose path looks like a credential', async () => {
    // The CONN_PASSWORD pattern used to match `://x/path:secret-thing@host`.
    // After the Batch-1 anchor (no `/` in user/password segments), benign
    // path-with-colon-and-at URLs survive untouched.
    const url = 'https://example.com/docs/section:overview@2025/intro';
    expect(redactSensitiveData(`see ${url} for details`)).toContain(url);
  });

  it('does not match a hex commit sha', async () => {
    const text = 'Cherry-picked commit deadbeef1234567890abcdef1234567890abcdef';
    expect(redactSensitiveData(text)).toBe(text);
  });

  it('leaves variable references alone in key=value secrets', () => {
    const cmd = [
      'az deployment group create --name AppDeployment \\',
      '  --parameters dbPassword="$DB_PASSWORD" hashSalt="$HASH_SALT" \\',
      '               containerRegistryPassword="$ACR_PASSWORD" \\',
      '               openidConnectClientSecret="${OIDC_SECRET}"',
    ].join('\n');
    expect(redactSensitiveData(cmd)).toBe(cmd);
    for (const t of [
      'API_KEY=$env:API_KEY',
      'TOKEN=%GITHUB_TOKEN%',
      'SECRET={{ client_secret }}',
      'password: <your-password>',
      'password=$DB_PASSWORD',
      'DB_PASSWORD=$(az keyvault secret show --name db)',
    ])
      expect(redactSensitiveData(t)).toBe(t);
  });

  it('still masks a literal value next to a variable', () => {
    const out = redactSensitiveData('dbPassword="Hunter2Hunter2" hashSalt="$HASH_SALT" password=$ecretValue!');
    expect(out).not.toContain('Hunter2Hunter2');
    expect(out).toContain('hashSalt="$HASH_SALT"');
    expect(out).not.toContain('$ecretValue!');
  });

  it('preserves a full message when nothing matches', async () => {
    const text = 'Hello world — completely innocuous content with no secrets.';
    expect(redactSensitiveData(text)).toBe(text);
  });
});

describe('redactSensitiveData — masking shape', () => {
  it('keeps prefix + suffix for high-entropy keys (bare, no token: prefix)', async () => {
    // Note: a leading `token:` would let the broader SECRET rule re-mask the
    // bracketed output. Tested bare to verify the per-pattern keep config.
    const key = `sk-ant-api03-${'X'.repeat(95)}AAAA`;
    const out = redactSensitiveData(`my key is ${key} please`);
    // ANTHROPIC_KEY keeps prefix=14, suffix=4 — shape `[ANTHROPIC_KEY:<head>****<tail>]`
    expect(out).toMatch(/\[ANTHROPIC_KEY:sk-ant-api03-X\*+AAAA\]/);
  });
});

describe('redactMessageContent', () => {
  it('keeps a JSON card parseable when a value inside it is redacted', () => {
    const card = JSON.stringify({
      skillName: 'ansible-become-false-needs-both-keys',
      description: 'Stop a play failing with "sudo: a password is required" at the group level',
    });
    const out = redactMessageContent(card);
    const parsed = JSON.parse(out) as { skillName: string; description: string };
    expect(parsed.skillName).toBe('ansible-become-false-needs-both-keys');
    expect(parsed.description).toBe(redactSensitiveData('Stop a play failing with "sudo: a password is required" at the group level'));
  });

  it('redacts secrets inside JSON values, and plain text as before', () => {
    const key = 'sk-ant-api03-' + 'a'.repeat(40);
    expect(redactMessageContent(JSON.stringify({ text: `key ${key}` }))).not.toContain(key);
    expect(redactMessageContent(`key ${key}`)).toBe(redactSensitiveData(`key ${key}`));
    // Not JSON after all: redacted as text.
    expect(redactMessageContent(`{ not json ${key}`)).toBe(redactSensitiveData(`{ not json ${key}`));
  });
});
