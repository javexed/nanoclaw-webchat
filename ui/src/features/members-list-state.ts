// ── Members list view state ─────────────────────────────────────────────────
// Refs for the MembersList island: the roster and the search filter.
import { ref } from 'vue';

export const members = ref<any[]>([]);
export const membersFilter = ref('');

/** A–Z toggle for the members roster, restored from the session. The storage
 *  read is part of boot order (check-boot-order.sh), not decoration. */
export const usersSortAz = ref(sessionStorage.getItem('webchat:usersSortAz') === '1');
