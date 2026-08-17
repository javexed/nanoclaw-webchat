// ── Router roster view state ────────────────────────────────────────────────
// Bridge refs for the RouterRoster island. routing.ts still owns the fetch and
// the classifier split; this holds only what the list renders.
import { ref } from 'vue';

/** The router's endpoint — the toggle registers against it. */
export const rosterEndpoint = ref('');
/** Assignable models, classifier excluded. */
export const rosterSelectable = ref<string[]>([]);
/**
 * The classifier, if the router reports one. Served by the router but
 * infrastructure — "never a route target" — so it is listed under a separate,
 * non-selectable System group rather than with a +/- toggle among the
 * assignable models.
 */
export const rosterSystem = ref<string[]>([]);
/** true when the router did not answer, or answered with no models at all. */
export const rosterUnreachable = ref(true);
