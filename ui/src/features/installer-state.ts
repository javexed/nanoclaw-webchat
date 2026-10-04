// ── Installer state ─────────────────────────────────────────────────────────
// One "is this install running?" flag per installable stack, plus the two
// pollers that watch a run in progress. Flags, not one enum: more than one
// install can be mid-run. Each gates re-entry for both its panel and the wizard.
import { ref } from 'vue';

/**
 * One flag for the four harness installs (codex, opencode, pi, grok): each
 * rebuilds the agent image and restarts the host, so two at once is never
 * right. The per-harness names below are aliases of the same ref.
 */
export const harnessInstallActive = ref(false);
export const codexInstallActive = harnessInstallActive;
export const opencodeInstallActive = harnessInstallActive;
export const routingInstallActive = ref(false);
export const sttInstallActive = ref(false);
export const ttsInstallActive = ref(false);
export const tailscaleInstallActive = ref(false);
export const cloudflaredInstallActive = ref(false);

/**
 * Pending setTimeout handles while a poll is in flight, else null. Re-armed
 * after each response, so a slow server cannot stack overlapping requests.
 */
export const ollamaPullPoller = ref<ReturnType<typeof setTimeout> | null>(null);
export const opencodeGatePoll = ref<ReturnType<typeof setTimeout> | null>(null);
/**
 * The gate as the SERVER reports it ('running'), rather than as this tab
 * remembers it — which is what makes it survive a page reload.
 */
export const opencodeGateFromServer = ref(false);

/**
 * One line of progress for a chain install: which step, of how many, and for
 * how long — the image rebuild is silent for minutes, so the elapsed time is
 * what shows it is not hung.
 */
export function installProgressLine(st: {
  stepIndex?: number;
  stepCount?: number;
  stepLabel?: string | null;
  startedAt?: number | null;
}): string {
  const step = st.stepCount ? `Step ${st.stepIndex} of ${st.stepCount}` : 'Installing';
  const label = st.stepLabel ? ` — ${st.stepLabel}` : '';
  const secs = st.startedAt ? Math.max(0, Math.round((Date.now() - st.startedAt) / 1000)) : 0;
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return `${step}${label} · ${elapsed}`;
}
