/**
 * Per-user token-usage rollup — computed entirely from the overlay-owned
 * `webchat_messages` store, so it needs no core changes, no provider hooks, and
 * no container rebuild, and it covers every provider (Claude, OpenCode, …).
 *
 * IMPORTANT: these are ESTIMATES, not billing-exact figures. Real provider token
 * counts live in the container's provider stream and would have to be threaded
 * through the poll-loop + host delivery (core). Here we approximate from message
 * content length (~4 chars/token) and attribute:
 *   - a user message's tokens → that user (input),
 *   - an agent message's tokens → the user who most recently spoke in that room
 *     before it (output; the turn's trigger).
 * So it excludes system prompts, tool I/O, reasoning, and retries — it's a proxy
 * for per-user VOLUME, not an invoice. Every surfaced number is labelled "~".
 */
import { getDb } from '../../db/connection.js';
import { getAgentsForWebchatRoom, getEffectiveModelForAgent } from './db.js';

/** Rough token estimate for a chunk of text (~4 chars/token for English prose). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

export interface UserUsage {
  user: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number; // agent replies attributed to this user
  lastActiveMs: number;
}

export interface UsageRollup {
  sinceMs: number;
  estimated: true; // always — see the file header
  totals: { users: number; turns: number; tokens: number };
  perUser: UserUsage[]; // sorted by totalTokens desc
  perDay: Array<{ day: string; tokens: number }>; // UTC yyyy-mm-dd, ascending
  byModel: Array<{ model: string; tokens: number }>; // via room→agent current model
}

interface Row {
  room_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: string;
  created_at: number;
}

/**
 * Compute the usage rollup over messages since `sinceMs`. Walks each room in
 * time order so an agent reply can be attributed to the user who triggered it.
 */
export function computeUsageRollup(sinceMs: number): UsageRollup {
  const rows = getDb()
    .prepare(
      `SELECT room_id, sender, sender_type, content, message_type, created_at
         FROM webchat_messages
        WHERE created_at >= ?
          AND message_type IN ('text', 'file')
        ORDER BY room_id, created_at`,
    )
    .all(sinceMs) as Row[];

  const users = new Map<string, UserUsage>();
  const perDay = new Map<string, number>();
  const roomTokens = new Map<string, number>(); // room → tokens, for the model split
  const lastUserByRoom = new Map<string, string>();

  const bumpUser = (user: string, ts: number): UserUsage => {
    let u = users.get(user);
    if (!u) {
      u = { user, inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, lastActiveMs: 0 };
      users.set(user, u);
    }
    if (ts > u.lastActiveMs) u.lastActiveMs = ts;
    return u;
  };
  const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

  for (const r of rows) {
    const tok = estimateTokens(r.content || '');
    if (tok <= 0) continue;
    perDay.set(dayKey(r.created_at), (perDay.get(dayKey(r.created_at)) ?? 0) + tok);
    roomTokens.set(r.room_id, (roomTokens.get(r.room_id) ?? 0) + tok);

    if (r.sender_type === 'user') {
      const u = bumpUser(r.sender, r.created_at);
      u.inputTokens += tok;
      u.totalTokens += tok;
      lastUserByRoom.set(r.room_id, r.sender);
    } else if (r.sender_type === 'agent') {
      // Attribute the reply to whoever last spoke in this room (its trigger).
      const trigger = lastUserByRoom.get(r.room_id);
      if (!trigger) continue; // agent-first / unattributable — skip
      const u = bumpUser(trigger, r.created_at);
      u.outputTokens += tok;
      u.totalTokens += tok;
      u.turns += 1;
    }
    // a2a / system rows fall through (not attributed to a human).
  }

  // Rough model split: attribute each room's tokens to that room's agent's
  // CURRENT effective model (historical model isn't in the message store).
  const byModel = new Map<string, number>();
  for (const [roomId, tokens] of roomTokens) {
    let model = 'unknown';
    try {
      const agentId = getAgentsForWebchatRoom(roomId)[0]?.id;
      if (agentId) {
        const m = getEffectiveModelForAgent(agentId);
        model = m ? `${m.kind}:${m.model_id}` : 'claude (default)';
      }
    } catch {
      /* leave as unknown */
    }
    byModel.set(model, (byModel.get(model) ?? 0) + tokens);
  }

  const perUser = [...users.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    sinceMs,
    estimated: true,
    totals: {
      users: perUser.length,
      turns: perUser.reduce((s, u) => s + u.turns, 0),
      tokens: perUser.reduce((s, u) => s + u.totalTokens, 0),
    },
    perUser,
    perDay: [...perDay.entries()].map(([day, tokens]) => ({ day, tokens })).sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...byModel.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens),
  };
}
