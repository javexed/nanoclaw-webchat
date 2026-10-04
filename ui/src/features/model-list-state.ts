// ── Model list view state ────────────────────────────────────────────────────
// The ModelList island renders rows pre-shaped by renderModels(): models.ts
// imports the SFC, so the SFC importing models.ts back for its label helpers
// would form a module cycle.
import { ref } from 'vue';

export interface ModelRow {
  id: string;
  badgeKind: string;
  badgeText: string;
  title: string;
  host: string | null;
  /** The Ollama host whose health check this row shows, or null. */
  healthKey: string | null;
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
/** A–Z toggle, restored from the session; without the read the preference is per-reload. */
export const modelSortAz = ref(sessionStorage.getItem('webchat:modelSortAz') === '1');
