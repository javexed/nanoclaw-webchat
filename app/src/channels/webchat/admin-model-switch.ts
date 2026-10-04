// A model switch an agent's admin asked for needs no approval card.
//
// An agent switching its own model runs `ncl groups config update --model`,
// which holds for approval like any agent CLI write. When the people asking
// for it in the room are admins of that agent (owner, global admin, or admin of
// its group), the card only asks them to confirm what they just said. This
// approval intercept resolves it as approved by that admin instead, through
// the same path a click takes, so no card is delivered. Only when it is plainly
// what they asked for: the latest message (the one that started the turn) is
// an admin's and names the target (a distinctive part of its id, like "opus" or
// "qwen3", or the display name it is registered under), and the target is a
// registered model or an Anthropic model id. Saying "model" alone is not enough:
// "use a better model" does not say which, and the agent may have been talked
// into a particular one by something it read. Anything else — another
// command, any change besides the model, another group, a non-admin anywhere in
// the thread's recent messages, a turn not started by such a message (a switch
// the agent came to by itself, or was talked into by what it read), or no record
// of who asked (after a restart) — falls through to the card.
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getPendingApproval } from '../../db/sessions.js';
import { log } from '../../log.js';
import { hasAdminPrivilege } from '../../modules/permissions/db/user-roles.js';
import { resolveApprovalAsApproved } from '../../modules/approvals/response-handler.js';
import type { Session } from '../../types.js';
import { getWebchatThread, listWebchatModels, sessionKeyToThread, threadToSessionKey } from './db.js';

/** How far back "who asked" looks: the people who wrote in the thread this recently. */
export const ASKED_WINDOW_MS = 10 * 60 * 1000;

/** Args the dispatcher fills in (the group, three ways) plus the model: nothing else may change. */
const MODEL_ONLY_ARGS = new Set(['id', 'agent_group_id', 'group', 'model']);

type Entry = { userId: string; at: number; text: string };
const recent = new Map<string, Entry[]>();
const keyOf = (roomId: string, sessionThread: string | null): string => `${roomId}\u0000${sessionThread ?? ''}`;
/** Only the start of a message is kept: enough to see whether it speaks of the switch. */
const KEPT_TEXT = 500;
/** Threads with nothing recent are dropped once the map is this big. */
const PRUNE_AT = 256;

/** A person wrote in a room's thread (the thread as a session keys it: null for main). */
export function noteHumanMessage(
  roomId: string,
  sessionThread: string | null,
  userId: string,
  text = '',
  at = Date.now(),
): void {
  const key = keyOf(roomId, sessionThread);
  const kept = (recent.get(key) ?? []).filter((e) => at - e.at < ASKED_WINDOW_MS);
  kept.push({ userId, at, text: text.slice(0, KEPT_TEXT) });
  recent.set(key, kept);
  if (recent.size > PRUNE_AT)
    for (const [k, v] of recent) if (!v.some((e) => at - e.at < ASKED_WINDOW_MS)) recent.delete(k);
}

/**
 * The latest message within the window from one of `askers`: in a shared
 * session every recent writer is one of them (or there is a card), so it is
 * the latest message; in a per-member session, that member's latest.
 */
function latestFrom(roomId: string, sessionThread: string | null, askers: string[], now = Date.now()): Entry | null {
  const entries = (recent.get(keyOf(roomId, sessionThread)) ?? []).filter(
    (e) => now - e.at < ASKED_WINDOW_MS && askers.includes(e.userId),
  );
  return entries[entries.length - 1] ?? null;
}

/** Parts of a model id or name too common to say which model was meant. */
const GENERIC = new Set([
  'claude',
  'model',
  'models',
  'latest',
  'chat',
  'instruct',
  'preview',
  'default',
  'local',
  'cloud',
  'thinking',
]);

function distinctiveTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length >= 4 && /[a-z]/.test(w) && !GENERIC.has(w));
}

function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

/**
 * Does this message name the switch's target: a distinctive part of the model
 * id ("opus", "qwen3"), or the display name it is registered under? The word
 * "model" alone, or "claude", does not say which model was meant.
 */
export function asksForModel(text: string, model: string, displayNames: string[] = []): boolean {
  const t = text.toLowerCase();
  if (distinctiveTokens(model).some((w) => mentions(t, w))) return true;
  for (const name of displayNames) {
    const full = name.trim().toLowerCase();
    if (full.length >= 3 && !GENERIC.has(full) && mentions(t, full)) return true;
    if (distinctiveTokens(name).some((w) => mentions(t, w))) return true;
  }
  return false;
}

/** The display names a target is registered under (none for a bare Anthropic id). */
async function registeredNames(model: string): Promise<string[]> {
  return (await listWebchatModels().catch(() => [])).filter((m) => m.model_id === model).map((m) => m.name);
}

/** A target the switch may name without a card: a registered model, or an Anthropic model id. */
function knownTarget(model: string, names: string[]): boolean {
  return /^claude-[a-z0-9.-]+(\[1m\])?$/.test(model) || names.length > 0;
}

/** Who wrote in the thread within the window. */
export function recentSenders(roomId: string, sessionThread: string | null, now = Date.now()): string[] {
  const entries = (recent.get(keyOf(roomId, sessionThread)) ?? []).filter((e) => now - e.at < ASKED_WINDOW_MS);
  return [...new Set(entries.map((e) => e.userId))];
}

/**
 * Who asked, for a session: everyone who wrote in its thread lately — or, for a
 * per-member session (`<userId>::<thread>`, or a bare user id in older rows),
 * which only that member's messages reach, that member if they wrote lately.
 */
async function askersFor(roomId: string, sessionKey: string | null): Promise<string[]> {
  const thread = threadToSessionKey(await sessionKeyToThread(sessionKey, roomId));
  const senders = recentSenders(roomId, thread);
  let member: string | null = null;
  if (sessionKey?.includes('::')) member = sessionKey.slice(0, sessionKey.lastIndexOf('::'));
  else if (sessionKey && !(await getWebchatThread(roomId, sessionKey))) member = sessionKey;
  if (!member) return senders;
  return senders.includes(member) ? [member] : [];
}

/** The approval intercept: true when it approved the switch, so no card is sent. */
export async function approveAdminModelSwitch(approvalId: string, session: Session): Promise<boolean> {
  const approval = await getPendingApproval(approvalId);
  if (!approval || approval.action !== 'cli_command') return false;
  let frame: { command?: unknown; args?: Record<string, unknown> } | undefined;
  try {
    frame = (JSON.parse(approval.payload) as { frame?: typeof frame }).frame;
  } catch {
    return false;
  }
  const args = frame?.args ?? {};
  if (frame?.command !== 'groups-config-update') return false;
  if (typeof args.model !== 'string' || !args.model.trim()) return false;
  if (!Object.keys(args).every((k) => MODEL_ONLY_ARGS.has(k))) return false;
  const group = session.agent_group_id;
  if (['id', 'agent_group_id', 'group'].some((k) => args[k] !== undefined && args[k] !== group)) return false;

  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg || mg.channel_type !== 'webchat') return false;
  const askers = await askersFor(mg.platform_id, session.thread_id);
  if (!askers.length) return false;
  for (const userId of askers) if (!(await hasAdminPrivilege(userId, group))) return false;
  // The turn was started by an admin asking for this: the latest message is
  // theirs and names the target. Not a switch the agent reached by itself.
  const thread = threadToSessionKey(await sessionKeyToThread(session.thread_id, mg.platform_id));
  const latest = latestFrom(mg.platform_id, thread, askers);
  const names = await registeredNames(args.model);
  if (!knownTarget(args.model, names)) return false;
  if (!latest || !asksForModel(latest.text, args.model, names)) return false;

  log.info('Model switch approved for the admin who asked', {
    approvalId,
    agentGroupId: group,
    model: args.model,
    approvedAs: latest.userId,
  });
  await resolveApprovalAsApproved(approval, latest.userId);
  return true;
}

export function __resetForTest(): void {
  recent.clear();
}
