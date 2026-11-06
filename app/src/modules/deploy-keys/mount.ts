/**
 * The container mount for a group's deploy-key view: read-only, at
 * /run/nanoclaw-ssh, for every agent (empty until it has a key). Called from
 * buildMounts.
 */
import type { VolumeMount } from '../../providers/provider-container-registry.js';
import { CONTAINER_SSH_DIR, viewDirFor } from './view.js';

export function deployKeyMount(agentGroupId: string): VolumeMount | null {
  const dir = viewDirFor(agentGroupId);
  if (!dir) return null;
  return {
    hostPath: dir,
    containerPath: CONTAINER_SSH_DIR,
    readonly: true,
    mountClass: 'group-state',
    scope: agentGroupId,
  };
}
