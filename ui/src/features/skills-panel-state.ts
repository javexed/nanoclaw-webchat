// ── Skills panel view state ─────────────────────────────────────────────────
// Bridge refs for the skills-side islands. skills.ts still owns the fetches and
// copies into these.
import { ref } from 'vue';

/** /api/skills/duplicates rows — a name plus the agents that each learned it. */
export const skillDuplicates = ref<any[]>([]);

/** One agent's own scoped skills, as the agent detail pane receives them. */
export const agentScopedSkills = ref<any[]>([]);
/**
 * Rows whose promote button is mid-request.
 *
 * The imperative version disabled the clicked BUTTON directly and re-enabled it
 * on failure. There is no clicked element to hold onto once the row is a vnode,
 * and disabling by identity is what keeps a double-click from promoting twice —
 * so the pending set is state. Keyed by skill name, which is what the endpoint
 * takes.
 */
export const promotingSkills = ref<Set<string>>(new Set());

/**
 * Skill collections shown in Settings, already shaped.
 *
 * `kind` distinguishes the two row types the one template renders: 'source' is
 * an editable GitHub collection, 'builtin' a marketplace entry. `raw` carries
 * the record the callbacks need — it is never rendered.
 */
export const skillSources = ref<
  Array<{ key: string; kind: 'source' | 'builtin'; origin: any; meta: string; disabled: boolean; raw: any }>
>([]);

/** One row of the skills registry, already shaped. */
export interface SkillRow {
  key: string;
  name: string;
  desc: string;
  /** The provenance pill: a scope/built-in/imported literal, or an origin. */
  badge: { kind: 'scope' | 'shipped' | 'imported'; text: string } | { kind: 'origin'; origin: any };
  /** Scoped rows carry BOTH a scope pill and their origin badge when recorded. */
  extraOrigin: any | null;
  source: string;
  agentGroupId?: string;
  agentName?: string;
  /** Lower-cased "name description", what the filter matches against. */
  search: string;
}

export interface SkillSection {
  key: string;
  label: string;
  roomName: string | null;
  rows: SkillRow[];
}

export const skillSections = ref<SkillSection[]>([]);
/** 'loading' | 'empty' | 'ready' — the registry's three list-level states. */
export const skillsPhase = ref<'loading' | 'empty' | 'ready'>('loading');
/** Lower-cased filter box contents. An active filter OWNS section expansion. */
export const skillsFilter = ref('');
/** Section keys currently expanded, when no filter is active. */
export const skillsOpenSections = ref<Set<string>>(new Set());
/** Skill name → true when its source repo has newer commits. */
export const skillUpdates = ref<Record<string, boolean>>({});
/** Skill names whose Update request is in flight. */
export const skillUpdating = ref<Set<string>>(new Set());

/** One learned-skill draft awaiting review. */
export const skillDrafts = ref<any[]>([]);
/**
 * Draft id → the undo countdown currently replacing its actions.
 *
 * armUndo held this in the DOM by swapping the actions element's children. As
 * state it survives a re-render, which the imperative version could not manage —
 * it froze the element's width to stop the row jumping instead.
 */
export const draftUndo = ref<Record<string, { label: string; width: string; commit: () => void }>>({});
/** Drafts whose Keep is mid-flight; a re-render must not resurrect a live Keep. */
export const draftsReviewing = ref<Set<string>>(new Set());

/** The marketplace pool's rows for the open trust tier. */
export const skillPool = ref<any[]>([]);
/** 'loading' | 'error' | 'empty' | 'ready' — the pool's four list-level states. */
export const skillPoolPhase = ref<'loading' | 'error' | 'empty' | 'ready'>('loading');
/** The wait/empty copy differs when a search is active, so the query rides along. */
export const skillPoolQuery = ref('');
/** Community tier shows a Review link; Anthropic tier does not. */
export const skillPoolCommunity = ref(false);

/** Skill suggestions for the agent-create form, derived from its prompt text. */
export const skillSuggestions = ref<any[]>([]);

/** Room-skills rows, already shaped and ordered: proposed, then learned, then archived. */
export const roomSkillRows = ref<any[]>([]);
/** Draft id → its undo countdown, same shape as draftUndo but for this list. */
export const roomSkillUndo = ref<Record<string, { label: string; width: string; commit: () => void }>>({});
/** Draft ids whose Keep is mid-flight. */
export const roomSkillsReviewing = ref<Set<string>>(new Set());

/** In-transcript draft cards: id → its undo countdown. */
export const cardUndo = ref<Record<string, { label: string; width: string; commit: () => void }>>({});
/** In-transcript draft cards whose Keep is mid-flight. */
export const cardReviewing = ref<Set<string>>(new Set());
