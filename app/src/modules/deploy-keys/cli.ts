/**
 * `ncl deploy-keys migrate`: move private keys out of agent folders into the
 * host store (migrate.ts). Host only: an agent never runs it.
 */
import { registerResource } from '../../cli/crud.js';
import { formatPlan, migrateKeys, type MigrationResult } from './migrate.js';

let dryRunShown = true;

registerResource({
  name: 'deploy-key',
  plural: 'deploy-keys',
  table: 'agent_groups',
  description: 'SSH deploy keys held on the host for agents.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    migrate: {
      access: 'open',
      hostOnly: true,
      description:
        'Move private keys out of agent folders into the host store.\n\n' +
        'Finds private keys in every agent folder (skipping dependency trees and fixtures), imports each ' +
        'with its target when the agent’s .ssh/config names one (or, for a key NanoClaw made, its comment), marks every ' +
        'one exposed (rotate it in Admin), backs the originals up to a 0600 tarball in the store, and ' +
        'removes them from the folder. --dry-run lists what would move. --trust-targets records the ' +
        'targets found as an install admin’s, so a name that resolves to a private address stays reachable.',
      args: [
        { name: 'dry_run', type: 'boolean', description: 'List what would move; change nothing.', default: false },
        {
          name: 'trust_targets',
          type: 'boolean',
          description: 'Record found targets as set by an install admin.',
          default: false,
        },
      ],
      examples: ['ncl deploy-keys migrate --dry-run', 'ncl deploy-keys migrate --trust-targets'],
      handler: async (args) => {
        const dryRun = args.dry_run === true;
        dryRunShown = dryRun;
        const r = await migrateKeys({ dryRun, trustTargets: args.trust_targets === true });
        if (!dryRun) {
          const { refreshAfterMigration } = await import('./index.js');
          for (const p of r.plans) await refreshAfterMigration(p.agentGroupId);
        }
        return r;
      },
      formatHuman: (data) => formatPlan(data as MigrationResult, dryRunShown),
    },
  },
});
