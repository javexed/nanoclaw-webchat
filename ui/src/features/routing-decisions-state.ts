// ── Routing decisions view state ────────────────────────────────────────────
// Bridge refs for the RoutingDecisions island. routing.ts still owns the fetch
// and the per-profile filtering; this module holds only what the list renders.
import { ref } from 'vue';

/** The already-filtered, already-sliced decision rows for the open profile. */
export const decisions = ref<any[]>([]);
/**
 * Which of the three terminal states the list is in.
 *
 * The imperative version expressed these as three different innerHTML writes
 * into the same element, which is why a failure mid-render could leave rows from
 * the previous profile sitting above an error line. One field cannot do that.
 */
export const decisionsPhase = ref<'rows' | 'empty' | 'error'>('rows');
/** Router profile name, shown in the empty message. */
export const decisionsRouter = ref('auto');
