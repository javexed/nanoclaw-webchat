// ── Wiring matrix state ─────────────────────────────────────────────────────
// Bridge refs for the WiringMatrix island. views.ts still fetches the topology
// and owns matrixWired (the edge set the cell clicks mutate).
import { ref } from 'vue';

export const matrixRooms = ref<any[]>([]);
export const matrixAgents = ref<any[]>([]);
/** "roomId|agentId" for every wired pair — the same key shape legacy uses. */
export const matrixEdges = ref<Set<string>>(new Set());
