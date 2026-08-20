/**
 * What a workspace accepts from a member, per provider.
 *
 * ONE definition, because this mapping had been re-derived at every call site
 * and the copies disagreed. The failure mode is quiet and specific: a Grok room
 * consulted `allowClaudeOauth`, so enabling member credentials for Grok did
 * nothing while enabling them for Claude silently switched Grok on. A provider
 * that reads another provider's flag is not a missing feature — it is the wrong
 * answer, delivered confidently.
 */
import type { CredentialsConfig } from '../../channels/webchat/db.js';

/** Does the workspace accept member SUBSCRIPTIONS (OAuth) for this provider? */
export function oauthAllowedFor(provider: string, cfg: CredentialsConfig): boolean {
  if (provider === 'codex') return cfg.allowCodexOauth;
  if (provider === 'grok') return cfg.allowGrokOauth;
  return cfg.allowClaudeOauth;
}

/**
 * Does it accept member API KEYS?
 *
 * Never for Grok: xAI's CLI authenticates with a subscription and exposes no
 * key path, so this is false by construction rather than by configuration —
 * there is no flag that could turn it on.
 */
export function apiKeyAllowedFor(provider: string, cfg: CredentialsConfig): boolean {
  if (provider === 'codex') return cfg.allowOpenaiKey;
  if (provider === 'grok') return false;
  return cfg.allowAnthropicKey;
}

/** How a provider is named to a member in guidance text. */
export function providerLabel(provider: string): string {
  if (provider === 'codex') return 'Codex (ChatGPT)';
  if (provider === 'grok') return 'Grok';
  return 'Claude';
}

/** What the member is asked to connect, for decline guidance. */
export function credentialName(provider: string): string {
  if (provider === 'codex') return 'Codex credential';
  if (provider === 'grok') return 'Grok subscription';
  return 'Anthropic key';
}
