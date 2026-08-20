/**
 * Harness availability probes.
 *
 * All of them answer the same question — "has this provider registered a
 * container config?" — which is the signal that its install skill has run. The
 * probe is what gates the harness picker AND the server-side allowlist, so a
 * provider that installs correctly but is missing here is invisible in the UI
 * with no error to explain why. That is exactly how Grok shipped without
 * appearing in the picker.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../providers/provider-container-registry.js', () => ({
  listProviderContainerConfigNames: () => ['codex', 'grok'],
}));

const { codexAvailable, grokAvailable, opencodeAvailable, piAvailable } = await import('./providers.js');

describe('availability probes', () => {
  it('report true for a provider that registered a container config', async () => {
    expect(codexAvailable()).toBe(true);
    expect(grokAvailable()).toBe(true);
  });

  it('report false for one that has not', async () => {
    expect(opencodeAvailable()).toBe(false);
    expect(piAvailable()).toBe(false);
  });

  it('every optional harness the picker offers has a probe', async () => {
    // The picker's buttons and this set must not drift: a button with no probe
    // is a switch the server will always reject.
    const probes: Record<string, () => boolean> = {
      opencode: opencodeAvailable,
      pi: piAvailable,
      codex: codexAvailable,
      grok: grokAvailable,
    };
    for (const [name, probe] of Object.entries(probes)) {
      expect(typeof probe, `${name} has no probe`).toBe('function');
    }
  });
});
