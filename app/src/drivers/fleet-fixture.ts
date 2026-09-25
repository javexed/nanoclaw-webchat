// A stand-in local driver for the fleet tests: records what the fleet
// delegated to it and runs nothing.
import type { SessionDriver } from './types.js';

export function fakeLocalDriver(): SessionDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    kind: 'docker',
    capabilities: () => {
      calls.push('capabilities');
      return {
        isolationTiers: ['container'],
        admissionEnforced: true,
        networkPolicy: 'topology',
        encryptedVolumes: false,
        unrealized: [],
        sharedNetworkNamespace: false,
        auxiliaryContainers: false,
        imageBuild: true,
      };
    },
    ensureReady: async () => {
      calls.push('ensureReady');
    },
    prepare: async (spec) => {
      calls.push(`prepare:${spec.key.agentGroupId}`);
      return {
        key: spec.key,
        name: 'local',
        start: async () => {},
        status: async () => ({ phase: 'running' }),
        stop: async () => {},
        execSpec: () => ({ bin: 'x', argsTty: [], argsPlain: [] }),
      };
    },
    listSessions: async () => {
      calls.push('listSessions');
      return [];
    },
    watchSessions: () => {
      calls.push('watchSessions');
      return { stop: () => {} };
    },
    reapResidue: async () => {
      calls.push('reapResidue');
    },
  };
}
