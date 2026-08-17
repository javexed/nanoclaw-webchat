// ── Routing state ───────────────────────────────────────────────────────────
// Values about the routing install that several modules read and one writes.
//
// These were module-scope `let`s in legacy.js, reached through get/set pairs on
// three separate dep bridges (Routing, Models, OllamaCards). A shared binding
// removes all six entries and the OllamaCards bridge with them: the bridges
// existed to expose the variable, not to invert any dependency.
import { ref } from 'vue';

/**
 * The classifier model id, or null before the routing probe has answered.
 *
 * Infrastructure, never selectable: the models list and the Ollama host cards
 * both section it under "System" rather than offering it as a choice, and both
 * need it before they render or it flashes as selectable first.
 */
export const routingClassifierModel = ref<string | null>(null);

/** Is the routing skill installed and reachable? Gates the whole panel. */
export const routingAvailable = ref(false);
/** Which router the server returned config for — it decides, not the client. */
export const routingCurrentRouter = ref<string | null>(null);
/** The editable config: {routes:[…], live:{…}, default_route}. Null until loaded. */
export const routingDraft = ref<any>(null);
/** {endpoint, models} for the Router models section. */
export const routingRouterInfo = ref<any>(null);
/** Open route's index, or -1 for "new route being drafted" — see openRouteDetail. */
export const selectedRouteIdx = ref<number | null>(null);
