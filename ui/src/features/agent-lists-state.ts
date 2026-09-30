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
 * Whether ANY agent exists, archived or not. The empty note keys off this, not
 * the filtered list, so with every agent archived the list is empty and has no note.
 */
export const createAgentAnyExist = ref(false);

/**
 * Secret rows (shared and per-member personal), flattened into one list.
 * `scope` is carried through for removeToolSecret; the template never renders it.
 */
export type SecretReach = 'mine' | 'agent' | 'workspace' | 'other';
export const agentSecretRows = ref<
  Array<{
    key: string;
    host: string;
    /** Who the row reaches — the section it renders under. */
    reach: SecretReach;
    /** For another person's row: whose. */
    ownerLabel: string;
    /** Same host is served from a nearer scope for the viewer. */
    note: string;
    canRemove: boolean;
    scope: unknown;
    sec: unknown;
  }>
>([]);
/** One line: what the viewer's own turns send, per host. */
export const agentSecretEffective = ref('');

/**
 * Deploy keys for the open agent, already shaped. `key` is the untouched API
 * object, which is what the delete call takes.
 */
export const agentKeyRows = ref<
  Array<{ name: string; meta: string; publicKey: string; key: unknown }>
>([]);

/** Env var NAMES for the open agent — values are never sent to the client. */
export const agentEnvNames = ref<string[]>([]);
/** Names whose delete is in flight. */
export const agentEnvDeleting = ref<Set<string>>(new Set());
