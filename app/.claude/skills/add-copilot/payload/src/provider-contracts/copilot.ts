import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract, PROVIDER_HOST_CONTRACT_SEAM_VERSION } from './registry.js';

registerProviderHostContract('copilot', {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  stateVolumes: CLAUDE_COMPATIBLE_HOST_SURFACES.stateVolumes.map((volume) => ({
    ...volume,
    directory: '.copilot-shared',
  })),
  // Every Copilot service host lives under githubcopilot.com (the licensed API
  // host per plan, its telemetry and proxy hosts), so the domain covers them;
  // the registry expands it to the apex and its subdomains. api.github.com is
  // excluded: model domains are auto-approved host-wide, and the device-login
  // token is only scoped to /copilot_internal/user there.
  modelDomains: ['githubcopilot.com', 'copilot-proxy.githubusercontent.com'],
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
