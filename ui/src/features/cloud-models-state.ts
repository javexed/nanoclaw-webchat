// Cloud models the router serves (GET /api/models/cloud `models`). They sit on
// the router's port like Auto routing's backends, but are selectable models:
// models.ts isRouterBackendModel keeps them in the list and the picker.
// Reactive: the list can render before this is loaded (it is after a reload).
import { reactive } from 'vue';

export const cloudModelNames = reactive(new Set<string>());
/** Which provider serves each of them ("Cohere"): the Models list shows that, not the router's address. */
export const cloudModelProviders = reactive(new Map<string, string>());

/**
 * The provider a cloud model runs at ("Cohere"), or null for any other model.
 * Its endpoint is the local router that fronts it, which says nothing useful.
 */
export function cloudProviderOf(model: { kind?: string; model_id?: string }): string | null {
  if (model.kind !== 'openai-compatible' || !model.model_id || !cloudModelNames.has(model.model_id)) return null;
  return cloudModelProviders.get(model.model_id) ?? 'Cloud';
}
