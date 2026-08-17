// ── Full-view state ─────────────────────────────────────────────────────────
// The view stack and what each full-screen view remembers.
//
// Mixed on purpose: values that get REASSIGNED are refs, because an imported
// binding cannot be reassigned from another module; collections mutated IN
// PLACE stay plain consts and need no .value. None of these is read by an
// island — journeyFilter, the one that is, lives in journey-state.ts.
import { ref } from 'vue';

/** Is the Admin view open? */
export const adminActive = ref(false);
/** Is the help overlay open? */
export const helpActive = ref(false);
/** Is the Manage view open? */
export const manageActive = ref(false);
/** Active Manage tab — the header's shared sort icon acts on whichever it is. */
export const manageTab = ref('agents');
/** Last topology payload, or null before the first fetch. */
export const topoData = ref<any>(null);

/**
 * "roomId|agentId" for currently-wired pairs.
 *
 * A ref, not a bare Set: refreshMatrix REPLACES it wholesale from the topology
 * payload, and an imported const cannot be reassigned. It is also mutated in
 * place when a single cell toggles — both patterns are real, which is why my
 * first pass called it in-place-only and the compiler disagreed.
 */
export const matrixWired = ref(new Set<string>());
/** The open full views, innermost last: [{ name, teardown }]. Pushed and popped,
 *  never replaced, so closing one runs exactly its own teardown. */
export const viewStack: Array<{ name: string; teardown: () => void }> = [];
