// ── Journey timeline state ──────────────────────────────────────────────────
// Bridge refs for the JourneyList island, plus the filter itself: one binding,
// so the island reads the same object views.ts mutates.
import { ref } from 'vue';

/** Every event loaded so far, oldest page first — 'Load more' appends. */
export const journeyEvents = ref<any[]>([]);
/** 'loading' | 'error' | 'empty' | 'ready'. */
export const journeyPhase = ref<'loading' | 'error' | 'empty' | 'ready'>('loading');
/** The active journey filter. Reassigned wholesale so the island re-derives. */
export const journeyFilter = ref<{ agent: string; kind: string; skill: string }>({ agent: '', kind: '', skill: '' });
