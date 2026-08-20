// ── Overview / dashboard ────────────────────────────────────────────────────
//
// The snapshot behind the dashboard: install health, agent and session counts,
// recent message volume, wired channels, busiest rooms.
//
// Everything here is SCOPE-AWARE. A restricted caller (no owner/admin rights)
// gets their own view — install-wide facts come back null rather than being
// sent and not rendered, because withholding in the GUI is not withholding:
// the response is one devtools tab away. `restricted` says which shape the
// client received, so it can render the difference instead of guessing.
//
// Lifted out of server.ts unchanged. It closed over nothing in that file's
// module scope; the only cross-boundary reference was the route handler
// calling buildOverview, which now imports it.
import { execFile } from 'child_process';
import os from 'os';

import { getDb } from '../../../db/connection.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { canAccessRoom, filterRoomsForUser } from '../access.js';
import { getAllWebchatRooms, getWebchatRoom } from '../db.js';
import { hasAdminPrivilege, isOwner } from '../roles.js';
import { json } from './http.js';
import { filterAsync } from '../async-array.js';

export interface OverviewSnapshot {
  restricted: boolean;
  // `uptime` and `agents.total` are install-wide facts, so they are null for a
  // restricted caller rather than sent-and-not-rendered. Withholding in the
  // GUI is not withholding: the response is one devtools tab away.
  health: { uptime: number | null; container_runtime_ok: boolean };
  agents: { total: number | null; visible: number };
  sessions: { active: number; total: number };
  messages: { webchat_24h: number };
  // Null for a restricted caller. There is no meaningful per-user version of
  // "which platforms this install has wired", so it is dropped rather than
  // scoped — the same treatment as busiest_rooms.
  channels: Record<string, number> | null;
  system: {
    memory_used_pct: number;
    memory_used_gb: number;
    memory_total_gb: number;
    load_avg: number[];
    cpus: number;
    platform: string;
  } | null;
  ollama: { ok: boolean; host: string; models?: string[] } | null;
  recent_agents: Array<{
    id: string;
    name: string;
    folder: string;
    room_id: string | null;
  }>;
  busiest_rooms: Array<{ id: string; name: string; count: number }> | null;
  active_containers: number | null;
}

const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;

export async function buildOverview(userId: string): Promise<OverviewSnapshot> {
  const db = getDb();
  const ownerCaller = await isOwner(userId);

  // Visible agent count — owners see everything; admins see ones they
  // explicitly admin (matches how /api/agents filters).
  const allAgents = (await db.all(`SELECT id FROM agent_groups`)) as { id: string }[];
  const visibleAgents = ownerCaller
    ? allAgents
    : await filterAsync(allAgents, (a) => hasAdminPrivilege(userId, a.id));

  // SCOPING RULE for the activity counts below. A restricted caller counts
  // only sessions on agent groups they can ACCESS and messages in rooms they
  // can ACCESS — `canAccessAgentGroup` / `canAccessRoom`, which is exactly
  // what the drill-down panels already enforce. Before this, the headline was
  // install-wide while the drill-down was scoped, so a member could read
  // "247 messages (24h)", click it, and find four: the number described rooms
  // they had no right to see.
  //
  // Note this is a DIFFERENT predicate from `visibleAgents` above, on purpose.
  // The agents card counts what you can ADMINISTER (hasAdminPrivilege, so it
  // agrees with /api/agents and the Agents view); these count what you are a
  // party to, which includes plain membership.
  const scopedGroupIds = ownerCaller
    ? null
    : (await filterAsync(allAgents, async (a) => (await canAccessAgentGroup(userId, a.id)).allowed)).map(
        (a) => a.id,
      );
  const scopedRoomIds = ownerCaller
    ? null
    : (await filterRoomsForUser(userId, await getAllWebchatRooms())).map((r) => r.id);

  // `ids === null` means "owner, no scoping"; an EMPTY array means "scoped to
  // nothing", which must count zero rather than fall through to unfiltered —
  // and cannot be expressed as SQL, since `IN ()` is a syntax error. Every
  // base query carries its own WHERE so the scope clause is a pure suffix.
  const countScoped = async (
    base: string,
    column: string,
    ids: string[] | null,
    ...leading: unknown[]
  ): Promise<number> => {
    if (ids !== null && ids.length === 0) return 0;
    const where = ids === null ? '' : ` AND ${column} IN (${ids.map(() => '?').join(',')})`;
    const params = ids === null ? leading : [...leading, ...ids];
    return ((await db.get(base + where, ...params)) as { c: number }).c;
  };

  // Sessions — `last_active` is an ISO timestamp string.
  const fiveMinAgo = new Date(Date.now() - ACTIVE_SESSION_WINDOW_MS).toISOString();
  const sessionsTotal = countScoped(`SELECT COUNT(*) AS c FROM sessions WHERE 1=1`, 'agent_group_id', scopedGroupIds);
  const sessionsActive = countScoped(
    `SELECT COUNT(*) AS c FROM sessions WHERE last_active > ?`,
    'agent_group_id',
    scopedGroupIds,
    fiveMinAgo,
  );

  // Webchat messages in the last 24h — cheap, single table.
  const yesterdayMs = Date.now() - 86_400_000;
  const messages24h = countScoped(
    `SELECT COUNT(*) AS c FROM webchat_messages WHERE created_at > ?`,
    'room_id',
    scopedRoomIds,
    yesterdayMs,
  );

  // Channel breakdown — count of messaging_groups per channel_type. Owner-only
  // (see the interface note); a restricted caller gets null.
  let channels: Record<string, number> | null = null;
  if (ownerCaller) {
    const channelRows = (await db.all(
      `SELECT channel_type, COUNT(*) AS c FROM messaging_groups GROUP BY channel_type`,
    )) as { channel_type: string; c: number }[];
    channels = {};
    for (const row of channelRows) channels[row.channel_type] = row.c;
  }

  // Recent agents — last 5 created. Restricted set when not owner.
  const recentLimit = 5;
  const visibleIds = new Set(visibleAgents.map((a) => a.id));
  const recentSql = ownerCaller
    ? `SELECT id, name, folder, created_at FROM agent_groups ORDER BY created_at DESC LIMIT ${recentLimit}`
    : `SELECT id, name, folder, created_at FROM agent_groups ORDER BY created_at DESC`;
  const recentRaw = (await db.all(recentSql)) as { id: string; name: string; folder: string; created_at: string }[];
  const recentFiltered = ownerCaller
    ? recentRaw
    : recentRaw.filter((r) => visibleIds.has(r.id)).slice(0, recentLimit);
  const recentAgents = await Promise.all(
    recentFiltered.map(async (r) => {
      const room = await getWebchatRoom(r.folder);
      return {
        id: r.id,
        name: r.name,
        folder: r.folder,
        room_id: room ? room.id : null,
      };
    }),
  );

  // Owner-only: system metrics, busiest webchat rooms, container runtime probe,
  // ollama probe.
  if (!ownerCaller) {
    return {
      restricted: true,
      health: { uptime: null, container_runtime_ok: false },
      agents: { total: null, visible: visibleAgents.length },
      sessions: { active: await sessionsActive, total: await sessionsTotal },
      messages: { webchat_24h: await messages24h },
      channels,
      system: null,
      ollama: null,
      recent_agents: recentAgents,
      busiest_rooms: null,
      active_containers: null,
    };
  }

  // Busiest webchat rooms (24h) — top 5 by message count.
  const busiestRows = (await db.all(
    `SELECT m.room_id AS id, mg.name AS name, COUNT(*) AS count
       FROM webchat_messages m
       LEFT JOIN messaging_groups mg
         ON mg.channel_type = 'webchat' AND mg.platform_id = m.room_id
       WHERE m.created_at > ?
       GROUP BY m.room_id
       ORDER BY count DESC
       LIMIT 5`,
    yesterdayMs,
  )) as { id: string; name: string | null; count: number }[];
  const busiestRooms = busiestRows.map((r) => ({ id: r.id, name: r.name ?? r.id, count: r.count }));

  // System.
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const system = {
    memory_used_pct: Math.round(((totalMem - freeMem) / totalMem) * 100),
    memory_used_gb: +((totalMem - freeMem) / 1073741824).toFixed(1),
    memory_total_gb: +(totalMem / 1073741824).toFixed(1),
    load_avg: os.loadavg().map((v) => +v.toFixed(2)),
    cpus: os.cpus().length,
    platform: os.platform(),
  };

  // Active containers — `docker ps --filter name=nanoclaw-`. Best-effort.
  const activeContainers = await countNanoClawContainers();

  // Ollama — probe only if env-configured. Mirrors v1.
  const ollama = await probeOllama();

  return {
    restricted: false,
    health: { uptime: process.uptime(), container_runtime_ok: activeContainers !== null },
    agents: { total: allAgents.length, visible: visibleAgents.length },
    sessions: { active: await sessionsActive, total: await sessionsTotal },
    messages: { webchat_24h: await messages24h },
    channels,
    system,
    ollama,
    recent_agents: recentAgents,
    busiest_rooms: busiestRooms,
    active_containers: activeContainers,
  };
}

export async function countNanoClawContainers(): Promise<number | null> {
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        'docker',
        ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
        { timeout: 3000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      ),
    );
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

export async function probeOllama(): Promise<{ ok: boolean; host: string; models?: string[] } | null> {
  const host = process.env.OLLAMA_HOST || '';
  if (!host) return null;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, host };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return { ok: true, host, models: (data.models ?? []).map((m) => m.name) };
  } catch {
    return { ok: false, host };
  }
}
