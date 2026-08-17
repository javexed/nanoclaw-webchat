// ── Journey timeline state ──────────────────────────────────────────────────
// Bridge refs for the JourneyList island, plus the filter itself.
//
// The filter used to exist TWICE — a const object in legacy.js and this mirror
// of it, kept in step by hand. It is one binding now, so the island reads the
// same object views.ts mutates and there is nothing to sync.
import { ref } from 'vue';

/** Every event loaded so far, oldest page first — 'Load more' appends. */
export const journeyEvents = ref<any[]>([]);
/** 'loading' | 'error' | 'empty' | 'ready'. */
export const journeyPhase = ref<'loading' | 'error' | 'empty' | 'ready'>('loading');
/** The active journey filter. Reassigned wholesale so the island re-derives. */
export const journeyFilter = ref<{ agent: string; kind: string; skill: string }>({ agent: '', kind: '', skill: '' });
