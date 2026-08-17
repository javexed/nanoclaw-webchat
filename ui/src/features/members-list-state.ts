// ── Members list view state ─────────────────────────────────────────────────
// Bridge refs for the MembersList island: the roster and the search filter,
// both still legacy module state. Synced by paintMembersList().
import { ref } from 'vue';

export const members = ref<any[]>([]);
export const membersFilter = ref('');

/**
 * A–Z toggle for the members roster, restored from the session.
 *
 * The sessionStorage read is the POINT, not decoration: it was the `let`'s
 * initialiser in legacy.js, and dropping it silently turned a remembered
 * preference into a per-reload default. The boot-order guard caught it as a
 * missing storage read at event 39.
 */
export const usersSortAz = ref(sessionStorage.getItem('webchat:usersSortAz') === '1');
