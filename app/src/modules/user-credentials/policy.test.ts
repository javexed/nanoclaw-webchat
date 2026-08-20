/**
 * Credential policy per provider.
 *
 * This exists because the mapping had been re-derived at five call sites and the
 * copies disagreed — a Grok room consulted allowClaudeOauth, so enabling member
 * credentials for Grok did nothing while enabling Claude's silently switched
 * Grok on. Every provider is asserted explicitly, so adding one cannot half-land
 * again.
 */
import { describe, expect, it } from 'vitest';

import { apiKeyAllowedFor, credentialName, oauthAllowedFor, providerLabel } from './policy.js';
import type { CredentialsConfig } from '../../channels/webchat/db.js';

/** Every flag ON, so a false result can only come from the mapping. */
const allOn: CredentialsConfig = {
  defaultMode: 'optional',
  allowAnthropicKey: true,
  allowClaudeOauth: true,
  allowOpenaiKey: true,
  allowCodexOauth: true,
  allowGrokOauth: true,
};
const off = (patch: Partial<CredentialsConfig>): CredentialsConfig => ({ ...allOn, ...patch });

describe('each provider reads its OWN flags', () => {
  it('claude', () => {
    expect(oauthAllowedFor('claude', allOn)).toBe(true);
    expect(apiKeyAllowedFor('claude', allOn)).toBe(true);
    expect(oauthAllowedFor('claude', off({ allowClaudeOauth: false }))).toBe(false);
    expect(apiKeyAllowedFor('claude', off({ allowAnthropicKey: false }))).toBe(false);
  });

  it('codex', () => {
    expect(oauthAllowedFor('codex', allOn)).toBe(true);
    expect(apiKeyAllowedFor('codex', allOn)).toBe(true);
    expect(oauthAllowedFor('codex', off({ allowCodexOauth: false }))).toBe(false);
    expect(apiKeyAllowedFor('codex', off({ allowOpenaiKey: false }))).toBe(false);
  });

  it('grok', () => {
    expect(oauthAllowedFor('grok', allOn)).toBe(true);
    expect(oauthAllowedFor('grok', off({ allowGrokOauth: false }))).toBe(false);
  });
});

describe('no provider is affected by another provider’s flags', () => {
  it('turning Claude off leaves Codex and Grok alone', () => {
    const cfg = off({ allowClaudeOauth: false, allowAnthropicKey: false });
    expect(oauthAllowedFor('codex', cfg)).toBe(true);
    expect(oauthAllowedFor('grok', cfg)).toBe(true);
  });

  it('turning Codex off leaves Claude and Grok alone', () => {
    const cfg = off({ allowCodexOauth: false, allowOpenaiKey: false });
    expect(oauthAllowedFor('claude', cfg)).toBe(true);
    expect(oauthAllowedFor('grok', cfg)).toBe(true);
  });

  it('turning Grok off leaves Claude and Codex alone — the bug this replaced', () => {
    const cfg = off({ allowGrokOauth: false });
    expect(oauthAllowedFor('claude', cfg)).toBe(true);
    expect(oauthAllowedFor('codex', cfg)).toBe(true);
  });

  it('enabling ONLY Claude does not switch Grok on', () => {
    // The precise failure the old ternary produced: grok fell through to
    // allowClaudeOauth, so a Claude allowance leaked into Grok rooms.
    const cfg: CredentialsConfig = {
      defaultMode: 'optional',
      allowAnthropicKey: true,
      allowClaudeOauth: true,
      allowOpenaiKey: false,
      allowCodexOauth: false,
      allowGrokOauth: false,
    };
    expect(oauthAllowedFor('grok', cfg)).toBe(false);
  });
});

describe('Grok has no API-key path at all', () => {
  it('is false even with every flag on — there is no flag that could enable it', () => {
    expect(apiKeyAllowedFor('grok', allOn)).toBe(false);
  });
});

describe('naming', () => {
  it('labels each provider as a member would recognise it', () => {
    expect(providerLabel('claude')).toBe('Claude');
    expect(providerLabel('codex')).toBe('Codex (ChatGPT)');
    expect(providerLabel('grok')).toBe('Grok');
  });

  it('names what the member is asked to connect', () => {
    expect(credentialName('claude')).toBe('Anthropic key');
    expect(credentialName('codex')).toBe('Codex credential');
    expect(credentialName('grok')).toBe('Grok subscription');
  });

  it('an unknown provider falls back to claude rather than throwing', () => {
    expect(oauthAllowedFor('mystery', allOn)).toBe(true);
    expect(providerLabel('mystery')).toBe('Claude');
  });
});
