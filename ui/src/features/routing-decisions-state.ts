// ── Routing decisions view state ────────────────────────────────────────────
// Bridge refs for the RoutingDecisions island. routing.ts owns the fetch
// and the per-profile filtering; this module holds only what the list renders.
import { ref } from 'vue';

/** The already-filtered, already-sliced decision rows for the open profile. */
export const decisions = ref<any[]>([]);
/** Which of the three terminal states the list is in. One field, so rows from a
 *  previous profile cannot sit above an error line. */
export const decisionsPhase = ref<'rows' | 'empty' | 'error'>('rows');
/** Router profile name, shown in the empty message. */
export const decisionsRouter = ref('auto');
