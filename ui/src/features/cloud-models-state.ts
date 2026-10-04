// Cloud models the router serves (GET /api/models/cloud `models`). They sit on
// the router's port like Auto routing's backends, but are selectable models:
// models.ts isRouterBackendModel keeps them in the list and the picker.
// Reactive: the list can render before this is loaded (it is after a reload).
import { reactive } from 'vue';

export const cloudModelNames = reactive(new Set<string>());
