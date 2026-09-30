// ── Permissions view state ──────────────────────────────────────────────────
// Refs for the three permissions islands, written by members.ts and perms.ts.
// Failures go through `usersError`, never innerHTML into the island's element:
// a write behind Vue's back desyncs the vnode tree from the DOM.
import { ref } from 'vue';

/** /api/users, verbatim. */
export const permsUsers = ref<any[]>([]);
/** /api/agents, verbatim — the columns of the per-group matrix. */
export const permsAgents = ref<any[]>([]);
/** Lower-cased search box contents. */
export const permsUserFilter = ref('');
/** true = flat A–Z; false = the tiered you/owners/admins/rest order. */
export const permsSortAz = ref(false);
/** Selected row, drives both the .active class and which detail is shown. */
export const permsSelectedUserId = ref<string | null>(null);
/** My own user id — drives the YOU tag and the top tier of the sort. */
export const permsMyUserId = ref<string | null>(null);
/** Set when the users fetch fails; replaces the whole list when non-empty. */
export const usersError = ref('');
/** The user whose detail pane is open. Null hides the toggles and matrix. */
export const permsDetailUser = ref<any>(null);

/** Is the permissions screen open? */
export const permsActive = ref(false);
/** Has the user hand-edited the channel field in the create form? Stops the
 *  derived value from overwriting a deliberate edit. */
export const permsCreateChannelTouched = ref(false);
