// ── Agent detail view state ─────────────────────────────────────────────────
// Bridge refs for the two agent-detail islands: the rooms this agent is wired
// to, and its live sessions. Both are still fetched and owned by agents.ts,
// which copies into these refs; the islands read only from here.
import { ref } from 'vue';

/** Rooms this agent is assigned to, as /api/agents/:id/rooms returns them. */
export const wiredRooms = ref<any[]>([]);
/** Whether the caller may unassign rooms — hides the per-row remove button. */
export const canManageRooms = ref(false);

/** One row of /api/agents/:id/sessions. */
export const sessions = ref<any[]>([]);
/**
 * The session list is asynchronous and has three non-row states — loading, a
 * fetch failure, and genuinely empty. The imperative version distinguished them
 * by writing three different innerHTML strings; as a ref it is one field the
 * template switches on, which is also what stops a stale "Loading…" row from
 * surviving a failed fetch.
 */
export const sessionsPhase = ref<'loading' | 'error' | 'ready'>('loading');
/** Message for the error phase — already plain text, escaped by the binding. */
export const sessionsError = ref('');

/** Snapshot of the detail form when it opened — Save stays disabled until an
 *  edit actually diverges from this. */
export const agentDetailBaseline = ref<any>(null);
/** Rooms the open agent is wired to. */
export const agentDetailRooms = ref<any[]>([]);
/** Agents wired to the open ROOM — the room detail's mirror of the above. */
export const roomDetailWiredAgents = ref<any[]>([]);
/** Include archived agents in the list? Pickers and the map never do. */
export const showArchivedAgents = ref(false);
/** How many archived agents exist — drives the toggle's count + visibility. */
export const archivedAgentsCount = ref(0);
/** setInterval handle ticking the thinking bubbles' elapsed labels, else null.
 *  An interval here, unlike the installers' re-arming timeouts. */
export const turnElapsedTimer = ref<ReturnType<typeof setInterval> | null>(null);
