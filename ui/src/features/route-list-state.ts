// ── Route list state ────────────────────────────────────────────────────────
// Bridge refs for the RouteList island. legacy.js still owns routingDraft and
// the detail pane; these mirror what the list renders.
import { ref } from 'vue';

/** Routes in draft order — the order IS the match order. */
export const routeRows = ref<any[]>([]);
/** The route name that runs when nothing else matches. */
export const routeDefaultName = ref('');
/** Index of the open route, or -1. Only highlights while the detail is open. */
export const routeSelectedIdx = ref(-1);

/** Capabilities the router offers to route but that no route covers yet. */
export const routeSuggestions = ref<any[]>([]);
/**
 * Capabilities whose Create is in flight.
 *
 * The imperative version disabled the button element directly and re-enabled it
 * on failure; a save that succeeds re-fetches and the row disappears on its own.
 */
export const routeSuggestBusy = ref<Set<string>>(new Set());
