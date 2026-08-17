// ── Reachability state ──────────────────────────────────────────────────────
// Bridge refs for the Reachability island. legacy.js still runs the probe and
// owns the panel element; this is the verdict it paints.
import { ref } from 'vue';

/** 'checking' while the probe runs, then 'error' or 'outcome'. */
export const reachPhase = ref<'checking' | 'error' | 'outcome'>('checking');
/** Message for the error phase. */
export const reachError = ref('');
/** Verdict line, plus the copy-paste fix when there is one. */
export const reachOutcome = ref<{ warn: boolean; label: string; detail: string; fix: string } | null>(null);
