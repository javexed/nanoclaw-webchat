import type { Migration } from './index.js';

/**
 * An UNSET network mode now means the allowlist (channels/webchat/egress-policy.ts),
 * where it used to mean open. A group that exists today was set up under the
 * old meaning — its model server, package feeds and MCP hosts were reachable —
 * so it keeps that: 'open', stored explicitly. Groups created from here on
 * start on the allowlist. A group with no container_configs row yet gets one
 * (upstream's boot backfill would otherwise create it unset, i.e. filtered).
 *
 * Registered after module-container-egress (app-manifest.txt order), which
 * adds the column this writes. Portable: plain SQL, the timestamp comes from
 * the process.
 */
export const moduleEgressExistingOpen: Migration = {
  version: 214,
  name: 'webchat-egress-existing-open',
  async up(db) {
    const now = new Date().toISOString();
    await db.exec(`UPDATE container_configs SET egress = 'open' WHERE egress IS NULL`);
    await db.exec(`
      INSERT INTO container_configs (agent_group_id, egress, updated_at)
      SELECT id, 'open', '${now}' FROM agent_groups
      WHERE id NOT IN (SELECT agent_group_id FROM container_configs)
    `);
  },
};
