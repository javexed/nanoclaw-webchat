// ── Provider availability probes ─────────────────────────────────────────────
// "Is this harness installed?" for each optional coding-agent stack. All three
// answer the same way — the provider registers a container config when its
// install skill has run — so they live together.
//
// Separated from server.ts for the same reason as http.ts: the install routes
// need them, and a route module importing from server.ts would cycle.
import { listProviderContainerConfigNames } from '../../../providers/provider-container-registry.js';

/** Auto-detect: the Codex provider is installed when it's registered a container config. */
export function codexAvailable(): boolean {
  return listProviderContainerConfigNames().includes('codex');
}
/** The OpenCode harness is installed when its provider registered a container config. */
export function opencodeAvailable(): boolean {
  return listProviderContainerConfigNames().includes('opencode');
}
/** The pi harness (add-pi-stack) — same registration test. */
export function piAvailable(): boolean {
  return listProviderContainerConfigNames().includes('pi');
}
