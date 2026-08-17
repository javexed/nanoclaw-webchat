// ── Model list view state ────────────────────────────────────────────────────
// The ModelList island renders a pre-shaped VIEW MODEL rather than raw model
// records. renderModels() does the shaping.
//
// That is not decoration: models.ts imports the SFC, so if the SFC imported
// models.ts back for isRouterBackendModel / modelKindLabel / modelDisplayParts
// the two would form a module cycle. Shaping at the mount site keeps the
// component pure and the graph acyclic — the same reason server/mcp-registry.ts
// exists on the server side.
import { ref } from 'vue';

export interface ModelRow {
  id: string;
  badgeKind: string;
  badgeText: string;
  title: string;
  host: string | null;
  hint: string | null;
  uses: number;
  active: boolean;
}

export const modelRows = ref<ModelRow[]>([]);

/** The model roster, verbatim from /api/models. */
export const allModels = ref<any[]>([]);
/** Last endpoint probe: { kind, endpoint, models, … }. */
export const lastProbeResult = ref<any>(null);
/** The model whose detail pane is open, or null. */
export const selectedModelId = ref<string | null>(null);
/** A–Z toggle, restored from the session — the read was the `let`'s
 *  initialiser, and dropping it makes the preference per-reload. */
export const modelSortAz = ref(sessionStorage.getItem('webchat:modelSortAz') === '1');
