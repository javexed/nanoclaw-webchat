// ── Per-member credential state ─────────────────────────────────────────────
// The user-credentials panel and its OAuth mint flow, which live in two modules:
// members.ts owns the panel, modals.ts owns the mint dialog and the popup it
// waits on. They were legacy.js `let`s reached through get/set pairs on BOTH
// bridges — the classic shape for a value with two readers and no home.
import { ref } from 'vue';

/** Provider the panel is showing. Defaults to 'claude' — the workspace's
 *  primary — not to empty; an empty default renders a provider-less panel. */
export const userCredsProvider = ref('claude');
/**
 * The panel's rendered shape, or null when there is nothing to offer.
 *
 * Typed from the two places that assign it, not guessed: an object carrying
 * `offered`, `connected`, `provider`, `oauthAllowed`, `apiOffered` and the two
 * label words. My first guess was a state-machine string and the compiler said
 * otherwise — the fourth interface in this project to be corrected by the code
 * it describes.
 */
export const userCredsState = ref<Record<string, unknown> | null>(null);
/** Whether THIS member has a credential connected. A flag, not a list. */
export const userCredsConnected = ref(false);
/**
 * The in-flight OAuth attempt. sessionId correlates the popup's callback with
 * the dialog that opened it; target names the provider; returnFocus is the
 * element to restore focus to when the popup closes, which is why it is a live
 * element reference and not an id.
 */
export const userCredsOauthSessionId = ref<string | null>(null);
/** 'member' or 'workspace' — whose credential the mint is for. Defaults to
 *  'member', which is the flow the panel opens in. */
export const userCredsOauthTarget = ref<string>('member');
export const userCredsOauthReturnFocus = ref<HTMLElement | null>(null);

/**
 * Provider vocabulary for the panel and the mint dialog.
 *
 * Lives here rather than in members.ts because modals.ts needs it too, and
 * modals→members would close a cycle (members already imports modals). A leaf
 * module both can import is what let the bridge entry go.
 */
export function userCredsWords(provider?: string) {
  return provider === 'codex'
    ? { name: 'Codex', subWord: 'ChatGPT subscription', keyWord: 'OpenAI key', keyPlaceholder: 'sk-…' }
    : { name: 'Claude', subWord: 'Claude subscription', keyWord: 'Anthropic key', keyPlaceholder: 'sk-ant-…' };
}
