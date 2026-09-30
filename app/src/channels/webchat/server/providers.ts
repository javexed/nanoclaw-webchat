// ── Provider availability probes ─────────────────────────────────────────────
// "Is this harness installed?" for each optional coding-agent stack. All of them
// answer the same way — the provider registers a container config when its
// install skill has run — so they live together.
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
/** The Grok harness (add-grok) — same registration test. */
export function grokAvailable(): boolean {
  return listProviderContainerConfigNames().includes('grok');
}

/**
 * Every non-default harness this install can actually run. The one list every
 * call site consults, so the picker and room creation cannot disagree.
 */
export function availableProviders(): string[] {
  return [
    ...(opencodeAvailable() ? ['opencode'] : []),
    ...(piAvailable() ? ['pi'] : []),
    ...(codexAvailable() ? ['codex'] : []),
    ...(grokAvailable() ? ['grok'] : []),
  ];
}
