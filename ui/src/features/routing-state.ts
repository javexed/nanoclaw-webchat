// ── Routing state ───────────────────────────────────────────────────────────
// Values about the routing install that several modules read and one writes.
import { ref } from 'vue';

/**
 * The classifier model id, or null before the routing probe has answered.
 * Infrastructure: the models list and host cards section it under "System",
 * and need it before rendering or it flashes as selectable.
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
