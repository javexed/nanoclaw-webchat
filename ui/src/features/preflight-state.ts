// ── Preflight self-test state ───────────────────────────────────────────────
// Bridge refs for the Preflight island; settings.ts runs the probe.
import { ref } from 'vue';

/** 'running' | 'message' | 'checks' — the three things this element ever shows. */
export const preflightPhase = ref<'running' | 'message' | 'checks'>('running');
/** Text for the running/error/empty states. */
export const preflightMessage = ref('');
/** One row per check, already shaped. */
export const preflightChecks = ref<any[]>([]);
