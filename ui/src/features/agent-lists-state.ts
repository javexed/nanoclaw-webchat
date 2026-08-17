// ── Agent picker / secret list state ────────────────────────────────────────
// Bridge refs for the three agent-side list islands: the two "which agents"
// checklists and the per-agent secret list. All three are still fed by
// agents.ts, which shapes the rows and copies them here.
import { ref } from 'vue';

/** Unwired, non-archived agents offered when adding to an existing room. */
export const addAgentCandidates = ref<any[]>([]);
/** Non-archived agents offered by the room-create form. */
export const createAgentCandidates = ref<any[]>([]);
/**
 * Whether ANY agent exists, archived or not.
 *
 * Separate from createAgentCandidates because the imperative version keyed its
 * empty note off state.allAgents.length, not off the filtered list — so with
 * every agent archived it rendered an empty <ul> and no note. That is arguably
 * a bug, but harmonising it is a behaviour change and this phase does not make
 * those; the flag reproduces it exactly.
 */
export const createAgentAnyExist = ref(false);

/**
 * Secret rows, already flattened. The imperative version built shared rows and
 * per-member personal rows from one local row() helper and appended both to the
 * same <ul>; the component sees a single list because that is what the DOM was.
 * `scope` is carried through untouched — it is the argument removeToolSecret
 * needs, not something the template renders.
 */
export const agentSecretRows = ref<
  Array<{ key: string; host: string; personal: boolean; ownerLabel: string; scope: unknown; sec: unknown }>
>([]);

/**
 * Deploy keys for the open agent, already shaped.
 *
 * `meta` is composed by the renderer because it was one text node in the
 * imperative row; `key` is the untouched API object, which is what the delete
 * call takes.
 */
export const agentKeyRows = ref<
  Array<{ name: string; meta: string; publicKey: string; key: unknown }>
>([]);

/** Env var NAMES for the open agent — values are never sent to the client. */
export const agentEnvNames = ref<string[]>([]);
/** Names whose delete is in flight. */
export const agentEnvDeleting = ref<Set<string>>(new Set());
