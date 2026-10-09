import { randomUUID } from 'crypto';

import type Database from 'better-sqlite3';

// `import type` keeps this a type-only edge so the trunk → skill →
// trunk-types cycle is erased at runtime; otherwise the cycle would
// load with `Migration` undefined for the brief window it imports back.
import type { Migration } from '../../db/migrations/index.js';
import { addColumnIfMissing } from '../../db/add-column-if-missing.js';

// Every migration here is `sqliteOnly` (raw PRAGMA/DDL): the sqlite-only side of
// upstream's Migration union.

/**
 * Webchat module schema (initial).
 *
 *   - webchat_rooms: dropped again by `webchat-drop-rooms` (rooms are
 *     `messaging_groups WHERE channel_type='webchat'`); kept so the migration
 *     chain stays replayable.
 *   - webchat_messages: the PWA's per-room history, mirroring agent traffic so
 *     the PWA has a single view (distinct from inbound.db / outbound.db).
 *   - webchat_push_subscriptions: Web Push endpoints keyed by user identity.
 */
export const moduleWebchat: Migration = {
  sqliteOnly: true,
  version: 100,
  name: 'webchat-initial',
  up(db: Database.Database) {
    // IF NOT EXISTS: a remove that skipped REMOVE.md's DROP TABLE block leaves
    // the tables without their schema_version row, so re-install must not throw.
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_rooms (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webchat_messages (
        id            TEXT PRIMARY KEY,
        room_id       TEXT NOT NULL REFERENCES webchat_rooms(id) ON DELETE CASCADE,
        sender        TEXT NOT NULL,
        sender_type   TEXT NOT NULL DEFAULT 'user',
        content       TEXT NOT NULL,
        message_type  TEXT NOT NULL DEFAULT 'text',
        file_meta     TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_messages_room
        ON webchat_messages(room_id, created_at);

      CREATE TABLE IF NOT EXISTS webchat_push_subscriptions (
        endpoint    TEXT PRIMARY KEY,
        identity    TEXT NOT NULL,
        keys_json   TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_push_identity
        ON webchat_push_subscriptions(identity);
    `);
  },
};

/**
 * Drop `webchat_rooms`: `messaging_groups WHERE channel_type='webchat'` becomes
 * the single source of rooms, and `webchat_messages.room_id` a plain
 * `platform_id` string with no FK (`deleteWebchatRoom` cascades in app code).
 * Backfills rooms missing from messaging_groups (the install-time room predates
 * any wiring), then rebuilds webchat_messages, since SQLite can't drop an FK in place.
 */
export const moduleWebchatDropRooms: Migration = {
  sqliteOnly: true,
  version: 101,
  name: 'webchat-drop-rooms',
  up(db: Database.Database) {
    // Defensive against reordering: webchat-initial normally runs first.
    const hasRooms = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='webchat_rooms'`).get();
    if (!hasRooms) return;

    // 1. Backfill rooms that lack a messaging_groups row.
    const orphans = db
      .prepare(
        `SELECT wr.id, wr.name, wr.created_at FROM webchat_rooms wr
         WHERE NOT EXISTS (
           SELECT 1 FROM messaging_groups mg
           WHERE mg.channel_type='webchat' AND mg.platform_id=wr.id
         )`,
      )
      .all() as { id: string; name: string; created_at: number }[];
    // `instance` (NOT NULL) comes from upstream migration 016; a baseline
    // without it (tests) gets it backfilled to channel_type by a later 016.
    const hasInstance = (db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'instance',
    );
    const insertMg = db.prepare(
      hasInstance
        ? `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
           VALUES (?, 'webchat', 'webchat', ?, ?, 1, 'public', ?)`
        : `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
           VALUES (?, 'webchat', ?, ?, 1, 'public', ?)`,
    );
    for (const row of orphans) {
      insertMg.run(randomUUID(), row.id, row.name, new Date(row.created_at).toISOString());
    }

    // 2. Recreate webchat_messages without the FK to webchat_rooms.
    db.exec(`
      CREATE TABLE webchat_messages_new (
        id            TEXT PRIMARY KEY,
        room_id       TEXT NOT NULL,
        sender        TEXT NOT NULL,
        sender_type   TEXT NOT NULL DEFAULT 'user',
        content       TEXT NOT NULL,
        message_type  TEXT NOT NULL DEFAULT 'text',
        file_meta     TEXT,
        created_at    INTEGER NOT NULL
      );
      INSERT INTO webchat_messages_new
        (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
        SELECT id, room_id, sender, sender_type, content, message_type, file_meta, created_at
        FROM webchat_messages;
      DROP TABLE webchat_messages;
      ALTER TABLE webchat_messages_new RENAME TO webchat_messages;
      CREATE INDEX idx_webchat_messages_room
        ON webchat_messages(room_id, created_at);
    `);

    // 3. Drop the legacy table.
    db.exec(`DROP TABLE webchat_rooms;`);
  },
};

/**
 * Per-room "prime" agent: answers every message that doesn't @-mention another
 * wired agent. Implemented purely as engage_pattern rewrites
 * (`recomputeEngagePatterns`, server/agent-wiring.ts).
 *
 * Webchat `room_id` columns are `messaging_groups.platform_id` with no FK;
 * deleteWebchatRoom cascades in app code. Later tables follow this convention.
 */
export const moduleWebchatRoomPrimes: Migration = {
  sqliteOnly: true,
  version: 102,
  name: 'webchat-room-primes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_primes (
        room_id        TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );
    `);
  },
};

/**
 * Model registry. `webchat_models.kind` selects the backend ('anthropic' pins a
 * model_id on the OneCLI Anthropic credential; 'ollama' points the Anthropic SDK
 * at <endpoint>/v1/messages); `credential_ref` names a OneCLI secret for keyed kinds.
 *
 * `webchat_agent_models` is 1:1 (PK agent_group_id). No FK to webchat_models so
 * delete-model can show the impact list and cascade in JS.
 */
export const moduleWebchatModels: Migration = {
  sqliteOnly: true,
  version: 103,
  name: 'webchat-models',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_models (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        endpoint        TEXT,
        model_id        TEXT NOT NULL,
        credential_ref  TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webchat_agent_models (
        agent_group_id  TEXT PRIMARY KEY,
        model_id        TEXT NOT NULL,
        assigned_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_agent_models_model
        ON webchat_agent_models(model_id);
    `);
  },
};

/**
 * Per-room settings row; later migrations add columns to it. `engage_default`
 * is not consulted for routing: `recomputeEngagePatterns` makes every un-primed
 * wiring mention-only.
 */
export const moduleWebchatRoomSettings: Migration = {
  sqliteOnly: true,
  version: 105,
  name: 'webchat-room-settings',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_settings (
        room_id        TEXT PRIMARY KEY,
        engage_default TEXT NOT NULL DEFAULT 'broadcast',
        updated_at     INTEGER NOT NULL
      );
    `);
  },
};

/**
 * Webchat-side index of approvals delivered to a webchat inbox (written in
 * `deliver()`), because trunk's `requestApproval` leaves
 * `pending_approvals.channel_type`/`platform_id` unset. `/api/approvals/pending`
 * JOINs on approval_id; rows are never pruned — the JOIN's
 * `pa.status = 'pending'` filters stale ones.
 */
export const moduleWebchatActivityLog: Migration = {
  sqliteOnly: true,
  version: 211,
  name: 'webchat-activity-log',
  up(db: Database.Database) {
    // Durable copy of the agent activity feed (the container's status_events is
    // wiped each turn). `detail` holds a reasoning row's full block. Rows arrive
    // redacted twice (the feed's choke point and sendStatus). Pruned to 30 days.
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_activity_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id     TEXT NOT NULL,
        agent_name  TEXT,
        kind        TEXT NOT NULL,
        text        TEXT,
        detail      TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_activity_room_time
        ON webchat_activity_log (room_id, created_at);
    `);
  },
};

export const moduleWebchatApprovalsIndex: Migration = {
  sqliteOnly: true,
  version: 104,
  name: 'webchat-approvals-index',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_approvals_index (
        approval_id   TEXT PRIMARY KEY,
        platform_id   TEXT NOT NULL,
        recorded_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_approvals_platform
        ON webchat_approvals_index(platform_id);
    `);
  },
};

/**
 * Per-user room archive (a sidebar hint; the room still routes). Split into
 * global archives + per-user hides by `webchat-archive-split`.
 * Webchat `user_id` columns hold the trusted auth-time id (`webchat:<scheme>:<id>`).
 */
export const moduleWebchatUserArchives: Migration = {
  sqliteOnly: true,
  version: 105,
  name: 'webchat-user-archives',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_user_room_archives (
        user_id     TEXT NOT NULL,
        room_id     TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY (user_id, room_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_user_archives_user
        ON webchat_user_room_archives(user_id);
    `);
  },
};

/**
 * Split archive into `webchat_room_archives` (global, owner/admin-set; a
 * collapsed sidebar section, still routes) and `webchat_user_room_hides`
 * (per-user, renamed from webchat_user_room_archives). Existing per-user rows
 * become one global row per room (earliest archived_at, archived_by NULL) and
 * hides start empty — they recorded archive intent, not hide intent.
 * Forward-only: the two kinds of archive can't be separated again.
 */
export const moduleWebchatArchiveSplit: Migration = {
  sqliteOnly: true,
  version: 106,
  name: 'webchat-archive-split',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_archives (
        room_id      TEXT PRIMARY KEY,
        archived_at  TEXT NOT NULL,
        archived_by  TEXT
      );
    `);

    // Defensive against reordering: version 105 normally created it.
    const hasLegacy = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='webchat_user_room_archives'`)
      .get();
    if (!hasLegacy) return;

    db.exec(`
      INSERT OR IGNORE INTO webchat_room_archives (room_id, archived_at, archived_by)
        SELECT room_id, MIN(archived_at), NULL
          FROM webchat_user_room_archives
         GROUP BY room_id;

      ALTER TABLE webchat_user_room_archives RENAME TO webchat_user_room_hides;
      DROP INDEX IF EXISTS idx_webchat_user_archives_user;
      CREATE INDEX IF NOT EXISTS idx_webchat_user_hides_user
        ON webchat_user_room_hides(user_id);

      DELETE FROM webchat_user_room_hides;
    `);
  },
};

/**
 * Widen `webchat_approvals_index`'s PK to `(approval_id, platform_id)`: fan-out
 * gives every reachable approver a card with the same approval_id. SQLite can't
 * change a PK in place, so the table is rebuilt (rows kept).
 */
export const moduleWebchatApprovalsIndexFanout: Migration = {
  sqliteOnly: true,
  version: 107,
  name: 'webchat-approvals-index-fanout',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE webchat_approvals_index_new (
        approval_id   TEXT NOT NULL,
        platform_id   TEXT NOT NULL,
        recorded_at   INTEGER NOT NULL,
        PRIMARY KEY (approval_id, platform_id)
      );
      INSERT INTO webchat_approvals_index_new (approval_id, platform_id, recorded_at)
        SELECT approval_id, platform_id, recorded_at FROM webchat_approvals_index;
      DROP TABLE webchat_approvals_index;
      ALTER TABLE webchat_approvals_index_new RENAME TO webchat_approvals_index;
      CREATE INDEX IF NOT EXISTS idx_webchat_approvals_platform
        ON webchat_approvals_index(platform_id);
    `);
  },
};

/**
 * Full-text search over message content (FTS5). An external-content virtual
 * table mirrors webchat_messages.content (no duplicate storage), kept in sync
 * by INSERT/DELETE/UPDATE triggers. Existing rows are backfilled on first run.
 * Powers GET /api/search. FTS5 is compiled into the bundled SQLite.
 */
export const moduleWebchatMessageFts: Migration = {
  sqliteOnly: true,
  version: 110,
  name: 'webchat-message-fts',
  up(db: Database.Database) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS webchat_messages_fts
        USING fts5(content, content='webchat_messages', content_rowid='rowid');

      CREATE TRIGGER IF NOT EXISTS webchat_messages_fts_ai AFTER INSERT ON webchat_messages BEGIN
        INSERT INTO webchat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS webchat_messages_fts_ad AFTER DELETE ON webchat_messages BEGIN
        INSERT INTO webchat_messages_fts(webchat_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS webchat_messages_fts_au AFTER UPDATE ON webchat_messages BEGIN
        INSERT INTO webchat_messages_fts(webchat_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO webchat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      INSERT INTO webchat_messages_fts(rowid, content)
        SELECT rowid, content FROM webchat_messages;
    `);
  },
};

/**
 * Agent lifecycle status: active | paused | archived (the router gates
 * engagement on it). Plain TEXT, validated in setAgentStatus
 * (src/db/agent-groups.ts); defaults to 'active'.
 */
export const moduleWebchatAgentStatus: Migration = {
  sqliteOnly: true,
  version: 111,
  name: 'agent-status',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    `);
  },
};

/**
 * Per-user "last read" marker, so unread survives time away and is shared
 * across the user's devices. `last_read_at` is the newest message `created_at`
 * seen; a room is unread when a newer message exists (or no row and any
 * message). Advanced on join, on a message in the open room, and on own sends.
 */
export const moduleWebchatRoomReads: Migration = {
  sqliteOnly: true,
  version: 112,
  name: 'webchat-room-reads',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_reads (
        user_id      TEXT NOT NULL,
        room_id      TEXT NOT NULL,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_room_reads_user
        ON webchat_room_reads(user_id);
    `);
  },
};

/**
 * UserCreds: per-room credential mode.
 *   disabled (default) — one shared session/agent; no per-member sessions.
 *   optional           — members with a connected key get their own per-member
 *                        session billed to them; others use the shared agent.
 *   required           — every member must connect their own key.
 * Secure-by-default: rooms start 'disabled' until an admin opts in.
 */
export const moduleWebchatRoomCredentialMode: Migration = {
  sqliteOnly: true,
  version: 108,
  name: 'webchat-room-credential-mode',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE webchat_room_settings ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'disabled';
    `);
  },
};

/**
 * UserCreds OAuth: per-room toggle allowing members to connect a Claude *subscription*
 * (OAuth) token, orthogonal to `credential_mode` (which governs API-key UserCreds).
 * Off by default — a room never accepts OAuth tokens until an owner/admin opts
 * in. See docs/webchat/user-credentials.md §9.
 */
export const moduleWebchatRoomOauthAllowed: Migration = {
  sqliteOnly: true,
  version: 109,
  name: 'webchat-room-oauth-allowed',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE webchat_room_settings ADD COLUMN oauth_allowed INTEGER NOT NULL DEFAULT 0;
    `);
  },
};

/**
 * Per-user @-mention handle. `user_id` is the canonical webchat user id
 * (e.g. `webchat:tailscale:foo@bar.com`); `handle` is the lowercase slug others
 * type to @-mention them (`@alice`), UNIQUE so a handle resolves to one user.
 * Defaults to a slug of the display name on first connect (see ensureWebchatUserHandle).
 */
export const moduleWebchatUserHandles: Migration = {
  sqliteOnly: true,
  version: 113,
  name: 'webchat-user-handles',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_user_handles (
        user_id    TEXT PRIMARY KEY,
        handle     TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_user_handles_handle
        ON webchat_user_handles(handle);
    `);
  },
};

/**
 * Per-user room pins: lifted into a sticky group above the activity-sorted
 * sidebar. Keyed on user_id, so pins follow the user across devices.
 */
export const moduleWebchatRoomPins: Migration = {
  sqliteOnly: true,
  version: 114,
  name: 'webchat-room-pins',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_pins (
        user_id   TEXT NOT NULL,
        room_id   TEXT NOT NULL,
        pinned_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_room_pins_user
        ON webchat_room_pins(user_id);
    `);
  },
};

/**
 * Workspace credentials policy. `webchat_settings` (singleton id=1) holds the
 * accepted user-credential types ({API key | OAuth} × {Claude | Codex}) and the
 * default room mode; `credential_mode_override` NULL = inherit it.
 *
 * Behavior-preserving: optional/required rooms keep their mode as an override,
 * and `allow_claude_oauth` seeds to 1 if any room had `oauth_allowed` on.
 * Anthropic types default on; Codex off (inert until the provider is installed).
 */
export const moduleWebchatCredentialsConfig: Migration = {
  sqliteOnly: true,
  version: 115,
  name: 'webchat-credentials-config',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_settings (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        default_credential_mode TEXT    NOT NULL DEFAULT 'disabled',
        allow_anthropic_key     INTEGER NOT NULL DEFAULT 1,
        allow_claude_oauth      INTEGER NOT NULL DEFAULT 0,
        allow_openai_key        INTEGER NOT NULL DEFAULT 0,
        allow_codex_oauth       INTEGER NOT NULL DEFAULT 0,
        updated_at              INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO webchat_settings (id, allow_claude_oauth, updated_at)
        VALUES (
          1,
          (SELECT CASE WHEN EXISTS (SELECT 1 FROM webchat_room_settings WHERE oauth_allowed = 1) THEN 1 ELSE 0 END),
          0
        );
      ALTER TABLE webchat_room_settings ADD COLUMN credential_mode_override TEXT;
      UPDATE webchat_room_settings
         SET credential_mode_override = credential_mode
       WHERE credential_mode IN ('optional', 'required');
    `);
  },
};

/**
 * Per-room threads. A webchat "thread" maps to an agent session via `thread_id`
 * (the session key), so each thread is an isolated conversation. See
 * docs/webchat/threads.md.
 *
 *   - `webchat_threads` is the thread registry; `thread_id` becomes
 *     `session.thread_id` for that room. Ids: 'main' (implicit default),
 *     'agent:<folder>' (per-agent lane), or a uuid (manual topic thread).
 *   - `webchat_messages.thread_id` partitions history per thread; the column
 *     default 'main' migrates all existing rows into each room's main thread
 *     with no data loss and no visible change.
 *   - `webchat_thread_reads` widens the per-room read marker to per-thread;
 *     existing `webchat_room_reads` rows seed the 'main' thread marker.
 */
export const moduleWebchatThreads: Migration = {
  sqliteOnly: true,
  version: 116,
  name: 'webchat-threads',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_threads (
        room_id    TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        title      TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'topic',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS webchat_thread_reads (
        user_id      TEXT NOT NULL,
        room_id      TEXT NOT NULL,
        thread_id    TEXT NOT NULL,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room_id, thread_id)
      );
    `);
    // ADD COLUMN is not idempotent — guard it so a re-run (or a partial prior
    // apply) doesn't throw "duplicate column name".
    addColumnIfMissing(db, 'webchat_messages', `thread_id TEXT NOT NULL DEFAULT 'main'`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webchat_messages_thread
        ON webchat_messages(room_id, thread_id, created_at);
    `);
    // Seed per-thread read markers from existing per-room markers (→ 'main').
    db.exec(`
      INSERT OR IGNORE INTO webchat_thread_reads (user_id, room_id, thread_id, last_read_at)
        SELECT user_id, room_id, 'main', last_read_at FROM webchat_room_reads;
    `);
    // Per-room auto-thread setting (confirm-first per-agent lanes). NULL = unset
    // → effective default is "on for multi-agent rooms" (computed at read).
    addColumnIfMissing(db, 'webchat_room_settings', `auto_thread INTEGER`);
  },
};

/**
 * Per-thread "engaged agents" set from a retired feature; dropped again by
 * webchat-drop-thread-engaged. Kept so the ordered migration list stays intact.
 */
export const moduleWebchatThreadEngaged: Migration = {
  sqliteOnly: true,
  version: 117,
  name: 'webchat-thread-engaged',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_thread_engaged (
        room_id        TEXT NOT NULL,
        thread_id      TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        engaged_at     INTEGER NOT NULL,
        PRIMARY KEY (room_id, thread_id, agent_group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_engaged_thread
        ON webchat_thread_engaged(room_id, thread_id);
    `);
  },
};

/**
 * Per-user drag order for pinned rooms. Existing pins are backfilled 0-indexed
 * by pinned_at (oldest first), room_id breaking ties so the order is deterministic.
 */
export const moduleWebchatRoomPinOrder: Migration = {
  sqliteOnly: true,
  version: 116,
  name: 'webchat-room-pin-order',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE webchat_room_pins ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      UPDATE webchat_room_pins
         SET position = (
           SELECT COUNT(*) FROM webchat_room_pins p2
            WHERE p2.user_id = webchat_room_pins.user_id
              AND (p2.pinned_at < webchat_room_pins.pinned_at
                   OR (p2.pinned_at = webchat_room_pins.pinned_at
                       AND p2.room_id < webchat_room_pins.room_id))
         );
    `);
  },
};

/**
 * Thread context sync (pull/push). Adds:
 *   - webchat_messages.origin — NULL = native message; 'pulled' = copied in from
 *     main; 'pushed' = copied up from a thread. Lets push select only native
 *     thread messages (skip the pulled-in prefix) and the client mark imports.
 *   - webchat_thread_sync — per-thread high-water marks so pull/push are
 *     incremental (each sync appends only the source delta; no duplicates).
 * See docs/webchat/threads.md §8.
 */
export const moduleWebchatThreadContextSync: Migration = {
  sqliteOnly: true,
  version: 118,
  name: 'webchat-thread-context-sync',
  up(db: Database.Database) {
    // ADD COLUMN isn't idempotent — guard against a partial prior apply.
    addColumnIfMissing(db, 'webchat_messages', `origin TEXT`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_thread_sync (
        room_id            TEXT NOT NULL,
        thread_id          TEXT NOT NULL,
        last_pulled_src_ts INTEGER NOT NULL DEFAULT 0,
        last_pushed_src_ts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_id, thread_id)
      );
    `);
  },
};

/**
 * MCP server registry, like webchat_models but with a many-to-many assignment
 * (`webchat_agent_mcp_servers`, no FK: delete-server cascades in JS after
 * showing the impact list). `transport` is 'stdio' (command/args/env, spawned
 * in the agent's container) or 'http' (url/headers; older rows may say 'sse').
 * args/env/headers are JSON text, like container_configs.mcp_servers.
 *
 * Assign/unassign upserts/deletes ONE key, container_configs.mcp_servers[name],
 * never recomputes the whole map: `ncl groups config add-mcp-server` writes the
 * same column, and a recompute would wipe its servers.
 */
export const moduleWebchatMcpServers: Migration = {
  sqliteOnly: true,
  version: 119,
  name: 'webchat-mcp-servers',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_mcp_servers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        transport     TEXT NOT NULL,
        command       TEXT,
        args          TEXT,
        env           TEXT,
        url           TEXT,
        headers       TEXT,
        instructions  TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webchat_agent_mcp_servers (
        agent_group_id  TEXT NOT NULL,
        mcp_server_id   TEXT NOT NULL,
        assigned_at     INTEGER NOT NULL,
        PRIMARY KEY (agent_group_id, mcp_server_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_agent_mcp_servers_server
        ON webchat_agent_mcp_servers(mcp_server_id);
    `);
  },
};

/**
 * First-run setup wizard: 0 = not finished (auto-opens for the owner),
 * 1 = finished/dismissed. Owner-only to flip; re-openable from Settings.
 */
export const moduleWebchatOnboarding: Migration = {
  sqliteOnly: true,
  version: 123,
  name: 'webchat-onboarding',
  up(db: Database.Database) {
    // ADD COLUMN isn't idempotent — guard against a re-run / partial prior apply.
    if (addColumnIfMissing(db, 'webchat_settings', `onboarding_complete INTEGER NOT NULL DEFAULT 0`)) {
      // An upgrade with agent groups already set up must never get the
      // first-run wizard; 0 is right only for a fresh install. Row id=1 is
      // seeded by an earlier migration.
      const alreadyConfigured = (db.prepare('SELECT COUNT(*) AS n FROM agent_groups').get() as { n: number }).n > 0;
      if (alreadyConfigured) {
        db.exec(`UPDATE webchat_settings SET onboarding_complete = 1 WHERE id = 1`);
      }
    }
  },
};

/**
 * Voice-dictation transcript cleanup — which roster model (webchat_models.id)
 * tidies raw dictation text. NULL = no cleanup (raw transcript). Lives on the
 * webchat_settings singleton: one workspace-wide choice, owner-set.
 */
export const moduleWebchatStt: Migration = {
  sqliteOnly: true,
  version: 124,
  name: 'webchat-stt',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `stt_cleanup_model_id TEXT`);
  },
};

/**
 * Bearer-token opt-out. WEBCHAT_TOKEN keeps a LAN-exposed install closed until
 * claimed, but a shared secret is weaker than identity auth; once Tailscale or a
 * trusted proxy / SSO is live the owner may retire it (auth.ts then ignores the
 * .env value). Only offered while another method is active, so it can never
 * leave no way in. 0 = bearer honored (default), 1 = bearer inert.
 */
export const moduleWebchatBearerAuth: Migration = {
  sqliteOnly: true,
  version: 130,
  name: 'webchat-bearer-auth',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `bearer_token_disabled INTEGER NOT NULL DEFAULT 0`);
  },
};

/**
 * MCP + skills-marketplace switch. Both are code-execution surfaces (MCP wires
 * arbitrary servers; the skills marketplace imports code from git), so they are
 * OFF by default on a fresh install; an owner turns them on from the setup
 * wizard or Settings. Off hides the MCP + Skills tabs AND makes the server 403
 * their endpoints (DOM + server, per the admin-surface rule). 1 = disabled
 * (fresh default), 0 = enabled.
 */
export const moduleWebchatMarketplaceToggle: Migration = {
  sqliteOnly: true,
  version: 131,
  name: 'webchat-marketplace-toggle',
  up(db: Database.Database) {
    // The guard keeps any existing column's value; only fresh DBs get DEFAULT 1.
    addColumnIfMissing(db, 'webchat_settings', `marketplace_disabled INTEGER NOT NULL DEFAULT 1`);
  },
};

/**
 * Fleet credential isolation. NULL = follow `CREDENTIAL_ISOLATION` in .env;
 * 0/1 = an explicit Settings choice, which wins. Nullable on purpose: "not
 * chosen" must differ from "chosen off", or the env var would be silently lost
 * the first time the settings row is written for another reason.
 */
export const moduleWebchatCredentialIsolation: Migration = {
  sqliteOnly: true,
  version: 205,
  name: 'webchat-credential-isolation',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `credential_isolation INTEGER`);
  },
};

/**
 * One-shot "first Tailscale login becomes owner". The bearer bootstrap identity
 * grabs the owner slot during the wizard, so a later Tailscale login would land
 * as a non-owner. When the operator opts in (wizard: "I'll use Tailscale"), this
 * flag makes auth.ts promote the FIRST tailscale identity to owner, then clears
 * itself. 0 = off (default), 1 = armed.
 */
export const moduleWebchatTailscaleOwner: Migration = {
  sqliteOnly: true,
  version: 132,
  name: 'webchat-tailscale-owner',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `promote_first_tailscale_owner INTEGER NOT NULL DEFAULT 0`);
  },
};

/**
 * Read aloud, owner-set for the whole workspace so everyone in a shared room
 * sees the same speaker controls. 0 = off (default), 1 = on for every authed user.
 */
export const moduleWebchatReadAloud: Migration = {
  sqliteOnly: true,
  version: 133,
  name: 'webchat-read-aloud',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `read_aloud_enabled INTEGER NOT NULL DEFAULT 0`);
  },
};

/**
 * Custom transcript-cleanup prompt for voice dictation. NULL = the built-in
 * default in stt.ts. Owner-edited from Settings → Features → Voice dictation —
 * the place to teach the tidy pass domain words ("NanoClaw", not "Nano-clot").
 */
export const moduleWebchatSttPrompt: Migration = {
  sqliteOnly: true,
  version: 134,
  name: 'webchat-stt-prompt',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `stt_cleanup_prompt TEXT`);
  },
};

/**
 * Approval pre-judge (fork): optional LLM triage tier in front of human
 * approvals. Two settings columns, both defaulting to OFF: the roster model
 * that judges (NULL = feature off) and the JSON array of opted-in action
 * names (NULL/empty = nothing pre-judged even with a model set). See
 * src/modules/approvals/prejudge.ts.
 */
export const moduleWebchatApprovalPrejudge: Migration = {
  sqliteOnly: true,
  version: 207,
  name: 'webchat-approval-prejudge',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `approval_prejudge_model_id TEXT`);
    addColumnIfMissing(db, 'webchat_settings', `approval_prejudge_actions TEXT`);
  },
};

/**
 * Workspace DEFAULT model (webchat_models.id, ollama kind) inherited at spawn by
 * every claude-family agent without its own assignment; written by the wizard's
 * "default engine = Ollama". NULL = unassigned agents use the Anthropic credential.
 */
export const moduleWebchatDefaultModel: Migration = {
  sqliteOnly: true,
  version: 125,
  name: 'webchat-default-model',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `default_model_id TEXT`);
  },
};

/**
 * Editable registry of well-known skill collections (the Skills tab's catalog
 * sources). Seeded with the two curated defaults; global admins manage the
 * list from Settings. Each row is a GitHub repo location with one skill
 * folder per entry under `dir`.
 */
export const moduleWebchatSkillSources: Migration = {
  sqliteOnly: true,
  version: 120,
  name: 'webchat-skill-sources',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_skill_sources (
        id         TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        owner      TEXT NOT NULL,
        repo       TEXT NOT NULL,
        branch     TEXT NOT NULL,
        dir        TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    const seed = db.prepare(
      `INSERT OR IGNORE INTO webchat_skill_sources (id, label, owner, repo, branch, dir, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    seed.run('anthropic', 'Anthropic (official)', 'anthropics', 'skills', 'main', 'skills', now);
    seed.run('superpowers', 'Superpowers (community)', 'obra', 'superpowers', 'main', 'skills', now);
  },
};

/**
 * Two-tier trust for skill collections: `official` marks curated, first-party
 * sources (Anthropic) that get a direct-add UX; everything else — Superpowers
 * and any admin-added collection — is community (review link + confirm gate).
 */
export const moduleWebchatSkillSourcesOfficial: Migration = {
  sqliteOnly: true,
  version: 121,
  name: 'webchat-skill-sources-official',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_skill_sources', 'official INTEGER NOT NULL DEFAULT 0');
    db.prepare("UPDATE webchat_skill_sources SET official = 1 WHERE id = 'anthropic'").run();
  },
};

// Records which CODE-WIRED built-in sources (the awesomeskill.ai marketplace)
// an owner has switched off, so they can be removed from the pool like any GitHub
// collection. Absence = enabled; a row = disabled.
export const moduleWebchatDisabledBuiltins: Migration = {
  sqliteOnly: true,
  version: 122,
  name: 'webchat-disabled-builtins',
  up(db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS webchat_disabled_sources (id TEXT PRIMARY KEY)');
  },
};

/**
 * Audit syslog forwarder target — one TEXT column, empty/NULL = forwarding
 * off. A URL (udp://host:514, tcp://host:601, tls://host:6514), validated at
 * the route; the DB stores whatever the owner last applied so a restart
 * re-establishes the forwarder without re-configuration.
 */
export const moduleWebchatAuditSyslog: Migration = {
  sqliteOnly: true,
  version: 208,
  name: 'webchat-audit-syslog',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'webchat_settings', `audit_syslog_target TEXT`);
  },
};

/**
 * Approval triage record: what the pre-judge concluded about ONE approval, so
 * the card can explain why it asks. Its own table because `pending_approvals`
 * is upstream's; a row, not a map, because re-renders read it too.
 *
 * `tier` (unscreened / heuristic / model / unavailable) keeps "no chips" from
 * reading as "screened, nothing found". `flags` (model) and `heuristic_flags`
 * (never-list) are kept apart so the card can show a disagreement.
 */
export const moduleWebchatApprovalTriage: Migration = {
  sqliteOnly: true,
  version: 209,
  name: 'webchat-approval-triage',
  up(db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS webchat_approval_triage (
      approval_id     TEXT PRIMARY KEY,
      tier            TEXT NOT NULL,
      reason          TEXT NOT NULL DEFAULT '',
      flags           TEXT NOT NULL DEFAULT '[]',
      heuristic_flags TEXT NOT NULL DEFAULT '[]',
      reversible      TEXT NOT NULL DEFAULT 'unknown',
      created_at      INTEGER NOT NULL
    )`);
  },
};

/**
 * Template sources: GitHub repos to fetch agent templates from (upstream has
 * one fixed registry URL), so an operator's own template repo works too.
 * Seeded with the public registry as official=1; added rows are community
 * (official=0), as with skill sources.
 */
export const moduleWebchatTemplateSources: Migration = {
  sqliteOnly: true,
  version: 210,
  name: 'webchat-template-sources',
  up(db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS webchat_template_sources (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      owner      TEXT NOT NULL,
      repo       TEXT NOT NULL,
      branch     TEXT NOT NULL DEFAULT 'main',
      official   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    db.prepare(
      `INSERT OR IGNORE INTO webchat_template_sources (id, label, owner, repo, branch, official, created_at)
       VALUES ('nanoclaw-templates', 'NanoClaw templates', 'nanocoai', 'nanoclaw-templates', 'main', 1, ?)`,
    ).run(Date.now());
  },
};

/**
 * Runner machines + placements. A machine is a developer laptop that
 * connected to /ws/runner as a signed-in person; it is `pending` until an
 * owner/global admin approves the pairing card, and
 * a pairing binds ONE user to ONE machine fingerprint. A placement assigns an
 * agent group to an approved machine, whose laptop tools its agent then uses.
 * `slots_json` is unused since the laptop container was retired (always '{}').
 */
export const moduleWebchatRunners: Migration = {
  // Portable: plain DDL, no PRAGMA. The runner dedupes by name, so the
  // IF NOT EXISTS guards are belt-and-braces rather than the mechanism.
  version: 211,
  name: 'webchat-runners',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_runner_machines (
        fingerprint    TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        hostname       TEXT NOT NULL DEFAULT '',
        os             TEXT NOT NULL DEFAULT '',
        arch           TEXT NOT NULL DEFAULT '',
        runner_version TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revoked')),
        approval_id    TEXT,
        approved_by    TEXT,
        approved_at    INTEGER,
        revoked_by     TEXT,
        revoked_at     INTEGER,
        first_seen     INTEGER NOT NULL,
        last_seen      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_runner_machines_user ON webchat_runner_machines(user_id);
      CREATE TABLE IF NOT EXISTS webchat_runner_placements (
        agent_group_id TEXT PRIMARY KEY,
        fingerprint    TEXT NOT NULL REFERENCES webchat_runner_machines(fingerprint) ON DELETE CASCADE,
        slots_json     TEXT NOT NULL DEFAULT '{}',
        created_by     TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_runner_placements_fp ON webchat_runner_placements(fingerprint);
    `);
  },
};

/**
 * Where the retired laptop container's agent image came from. Nothing reads
 * or writes these columns any more; the migration stays so the schema history
 * of existing installs is unchanged.
 */
export const moduleWebchatRunnerImage: Migration = {
  // Portable, no column-exists guard: schema_version dedupes by name, and
  // webchat-settings exists before any module-file migration.
  version: 212,
  name: 'webchat-runner-image',
  async up(db) {
    await db.exec(`ALTER TABLE webchat_settings ADD COLUMN runner_image_ref TEXT;`);
    await db.exec(`ALTER TABLE webchat_settings ADD COLUMN runner_image_policy TEXT;`);
  },
};

/**
 * The install-wide egress allowlist (`webchat_settings` singleton; the
 * `runner_` name dates from when only placed agents used it). JSON array of
 * host patterns; NULL = the built-in default list (egress-policy.ts). Enforced
 * by central's egress filter for agents whose network mode is 'host-only'.
 */
export const moduleWebchatRunnerEgress: Migration = {
  version: 213,
  name: 'webchat-runner-egress',
  async up(db) {
    await db.exec(`ALTER TABLE webchat_settings ADD COLUMN runner_egress_allowlist TEXT;`);
  },
};

/**
 * The VS Code extension's sign-in overrides, as set in Admin → Sign-in
 * (install-wide, `webchat_settings` singleton). JSON object; NULL = derive
 * everything from the install's OIDC settings (runner-client-config.ts).
 */
export const moduleWebchatRunnerClient: Migration = {
  version: 215,
  name: 'webchat-runner-client',
  async up(db) {
    await db.exec(`ALTER TABLE webchat_settings ADD COLUMN runner_client_config TEXT;`);
  },
};

/**
 * Sign-ins (signins.ts): browser sessions from "Sign in with Microsoft", and
 * explicit links between one person's identities. A session row holds the
 * SHA-256 of the cookie token, never the token, and the VERIFIED identity the
 * sign-in produced (links are applied on each request, so an unlink is
 * immediate). Version 216: 215 is taken by the runner client settings.
 */
export const moduleWebchatSignins: Migration = {
  version: 216,
  name: 'webchat-signins',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_signin_sessions (
        token_hash    TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        display_name  TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        last_used_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_signin_sessions_user ON webchat_signin_sessions(user_id);
      CREATE TABLE IF NOT EXISTS webchat_identity_links (
        alias_user_id    TEXT PRIMARY KEY,
        primary_user_id  TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_identity_links_primary ON webchat_identity_links(primary_user_id);
    `);
  },
};

/**
 * Hosts one agent may reach on top of the install allowlist (egress-policy.ts):
 * one row per agent, a JSON array of host patterns. No row = none of its own.
 * Read only while the agent's mode is Allowlist.
 */
export const moduleWebchatAgentEgressHosts: Migration = {
  version: 217,
  name: 'webchat-agent-egress-hosts',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_agent_egress_hosts (
        agent_group_id  TEXT PRIMARY KEY,
        hosts           TEXT NOT NULL,
        updated_at      INTEGER NOT NULL
      );
    `);
  },
};

/**
 * Audit log retention as set in Admin → Audit log (webchat_settings
 * singleton). JSON {days, maxMb}; NULL = the environment's (src/audit.ts:
 * NANOCLAW_AUDIT_KEEP_DAYS / NANOCLAW_AUDIT_MAX_MB, default 90 days / 200 MB).
 */
export const moduleWebchatAuditRetention: Migration = {
  version: 218,
  name: 'webchat-audit-retention',
  async up(db) {
    await db.exec(`ALTER TABLE webchat_settings ADD COLUMN audit_retention TEXT;`);
  },
};

/**
 * A runner machine's public key (runner-ws.ts): Ed25519, SPKI DER in base64.
 * The extension proves it holds the private half on every connect. NULL = not
 * bound yet: a machine approved before keys existed binds the key it presents
 * on its next connect, and revoking a machine clears it.
 */
export const moduleWebchatRunnerMachineKey: Migration = {
  version: 219,
  name: 'webchat-runner-machine-key',
  async up(db) {
    await db.exec(`ALTER TABLE webchat_runner_machines ADD COLUMN public_key TEXT;`);
  },
};

/**
 * Which runner machines may still connect without a key: only those paired
 * before keys existed (unkeyed and not revoked when this runs). Binding a key
 * or revoking clears it, so a machine revoked and approved again must bring
 * one; before this, a revoke (which clears the key) reopened keyless entry.
 */
export const moduleWebchatRunnerKeylessAllowed: Migration = {
  version: 221,
  name: 'webchat-runner-keyless-allowed',
  async up(db) {
    await db.exec(`
      ALTER TABLE webchat_runner_machines ADD COLUMN keyless_allowed INTEGER NOT NULL DEFAULT 0;
      UPDATE webchat_runner_machines SET keyless_allowed = 1 WHERE public_key IS NULL AND status != 'revoked';
    `);
  },
};

/**
 * How a group placed on a runner machine runs there. 'container' (every
 * placement before this): its agent container runs on the machine. 'tools':
 * the agent runs on central and uses the project on the machine through the
 * laptop tools the extension serves; tools_token authenticates the agent's
 * container to central's tools endpoint for that group.
 */
export const moduleWebchatRunnerPlacementMode: Migration = {
  version: 222,
  name: 'webchat-runner-placement-mode',
  async up(db) {
    await db.exec(`
      ALTER TABLE webchat_runner_placements ADD COLUMN mode TEXT NOT NULL DEFAULT 'container';
      ALTER TABLE webchat_runner_placements ADD COLUMN tools_token TEXT;
    `);
  },
};

/** The retired per-thread engaged-agents set (webchat-thread-engaged): nothing reads or writes it. */
export const moduleWebchatDropThreadEngaged: Migration = {
  version: 220,
  name: 'webchat-drop-thread-engaged',
  async up(db) {
    await db.exec(`
      DROP INDEX IF EXISTS idx_webchat_engaged_thread;
      DROP TABLE IF EXISTS webchat_thread_engaged;
    `);
  },
};

/** Fit context to GPU: new Ollama registrations get a variant with the largest window that stays on the GPU. Off by default (the UI offers it per add). */
export const moduleWebchatFitContext: Migration = {
  version: 223,
  name: 'webchat-fit-context',
  async up(db) {
    await db.exec(`ALTER TABLE webchat_settings ADD COLUMN fit_context_to_gpu INTEGER NOT NULL DEFAULT 0;`);
  },
};

/**
 * One row per agent turn (turn-traces.ts): the thinking bubble's activity —
 * tools, reasoning, notes, the harness and model it ran on — kept after the
 * live feed is wiped, so a reply's Thoughts survive a reload. `message_id` is
 * the turn's first reply (where the client shows the disclosure);
 * `message_ids` is every message the turn delivered, as a JSON array. The two
 * settings columns are NULL until changed: recording on, kept 90 days.
 */
export const moduleWebchatTurnTraces: Migration = {
  version: 224,
  name: 'webchat-turn-traces',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_turn_traces (
        id              TEXT PRIMARY KEY,
        room_id         TEXT NOT NULL,
        thread_id       TEXT NOT NULL DEFAULT 'main',
        message_id      TEXT NOT NULL,
        message_ids     TEXT NOT NULL,
        agent_group_id  TEXT,
        agent_name      TEXT,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER,
        outcome         TEXT NOT NULL,
        provider        TEXT,
        model           TEXT,
        endpoint_host   TEXT,
        trace_json      TEXT NOT NULL,
        size            INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_webchat_turn_traces_message ON webchat_turn_traces (message_id);
      CREATE INDEX IF NOT EXISTS idx_webchat_turn_traces_room ON webchat_turn_traces (room_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_webchat_turn_traces_started ON webchat_turn_traces (started_at);
      ALTER TABLE webchat_settings ADD COLUMN turn_traces_enabled INTEGER;
      ALTER TABLE webchat_settings ADD COLUMN turn_trace_days INTEGER;
    `);
  },
};

/**
 * The stable user id of a message's human sender. Deleting a message matches
 * on it rather than on `sender`, a display name two users can share. Rows from
 * before it stay NULL: a display name cannot be mapped back to one user.
 */
export const moduleWebchatMessageSenderUserId: Migration = {
  version: 225,
  name: 'webchat-message-sender-user-id',
  async up(db) {
    await db.exec(`ALTER TABLE webchat_messages ADD COLUMN sender_user_id TEXT;`);
  },
};
