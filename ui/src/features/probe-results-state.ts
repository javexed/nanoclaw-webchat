// ── Model probe results state ───────────────────────────────────────────────
// Bridge refs for the ProbeResults island. legacy.js still runs the probe and
// owns the summary line; this is the model checklist only.
import { ref } from 'vue';

/** One row per advertised model: the id and its default display name. */
export const probeRows = ref<Array<{ modelId: string; name: string }>>([]);
/** Pre-check when the endpoint advertises exactly one model. */
export const probeSingle = ref(false);
/** Empty-state copy — differs when the endpoint is credential-gated. */
export const probeEmptyNote = ref('');
