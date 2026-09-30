import type Database from 'better-sqlite3';
import type { Migration } from './index.js';
import { addColumnIfMissing } from '../add-column-if-missing.js';

/**
 * MCP hardening columns on webchat_mcp_servers (all JSON, all nullable):
 *
 *   health        {status:'ok'|'down'|'auth'|'drift', at, reason?, toolCount?}
 *                 — last sweep re-probe result (remote servers only).
 *   pinned_tools  {hash, at, tools:[{name,description}]}
 *                 — the tool surface approved at attach time; the sweep
 *                 re-hashes against it (rug-pull detection).
 *   drift         {at, added:[], removed:[], changed:[]}
 *                 — set when a re-probe hash mismatches; cleared by re-approve.
 *   enabled_tools string[] — tool allowlist for this server (null = all).
 *   auth          {kind:'bearer'|'oauth', token?, oauth?:{...}}
 *                 — credentials held HOST-side for the relay to inject; never
 *                 materialized into container.json.
 */
export const moduleMcpHardening: Migration = {
  // PRAGMA/table_info is sqlite's vocabulary, not the portable driver's.
  sqliteOnly: true,
  version: 202,
  name: 'webchat-mcp-hardening',
  up(db: Database.Database) {
    for (const col of ['health', 'pinned_tools', 'drift', 'enabled_tools', 'auth']) {
      addColumnIfMissing(db, 'webchat_mcp_servers', `${col} TEXT`);
    }
    // Per-assignment relay token: the container-side indirection credential for
    // the MCP auth relay. Scoped to ONE (agent group, server) pair — the real
    // secret stays host-side in webchat_mcp_servers.auth.
    addColumnIfMissing(db, 'webchat_agent_mcp_servers', `relay_token TEXT`);
  },
};
