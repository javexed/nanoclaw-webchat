// ── Permissions view state ──────────────────────────────────────────────────
// Bridge refs for the three permissions islands. Every one of these is still
// owned by legacy module state; the render functions in members.ts and perms.ts
// copy into these refs, and the islands read only from here.
//
// `usersError` exists because refreshPermissions() used to write an error <li>
// straight into #perms-user-list with innerHTML. That element is now owned by a
// Vue app, and an innerHTML write behind Vue's back is not a cosmetic problem:
// the vnode tree still describes the rows it thinks are there, so the next
// patch reconciles against DOM that no longer matches and can leave the error
// message stranded or remove the wrong node. Routing the failure through state
// keeps one writer.
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
