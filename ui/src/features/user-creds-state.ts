// ── Per-member credential state ─────────────────────────────────────────────
// The user-credentials panel and its OAuth mint flow, which live in two modules:
// members.ts owns the panel, modals.ts owns the mint dialog and the popup it
// waits on; both read this state.
import { ref } from 'vue';

/** Provider the panel is showing. Defaults to 'claude' — the workspace's
 *  primary — not to empty; an empty default renders a provider-less panel. */
export const userCredsProvider = ref('claude');
/** The panel's rendered shape (`offered`, `connected`, `provider`, `oauthAllowed`,
 *  `apiOffered` and the two label words), or null when there is nothing to offer. */
export const userCredsState = ref<Record<string, unknown> | null>(null);
/** Whether THIS member has a credential connected. A flag, not a list. */
export const userCredsConnected = ref(false);
/** The in-flight OAuth attempt: correlates the popup's callback with the dialog. */
export const userCredsOauthSessionId = ref<string | null>(null);
/** 'member' or 'workspace' — whose credential the mint is for. Defaults to
 *  'member', which is the flow the panel opens in. */
export const userCredsOauthTarget = ref<string>('member');
/** The element to refocus when the dialog closes — a live reference, not an id. */
export const userCredsOauthReturnFocus = ref<HTMLElement | null>(null);

/** Provider vocabulary for the panel and the mint dialog. Here, not in
 *  members.ts: modals.ts needs it too, and modals→members would close a cycle. */
export function userCredsWords(provider?: string) {
  // Grok has no key path at all — a subscription is the only way in — so
  // keyWord/keyPlaceholder are placeholders the key UI never reaches.
  if (provider === 'grok')
    return { name: 'Grok', subWord: 'SuperGrok or X Premium+ subscription', keyWord: 'xAI key', keyPlaceholder: '' };
  return provider === 'codex'
    ? { name: 'Codex', subWord: 'ChatGPT subscription', keyWord: 'OpenAI key', keyPlaceholder: 'sk-…' }
    : { name: 'Claude', subWord: 'Claude subscription', keyWord: 'Anthropic key', keyPlaceholder: 'sk-ant-…' };
}
