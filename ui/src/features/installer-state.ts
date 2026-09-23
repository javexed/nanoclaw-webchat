// ── Installer state ─────────────────────────────────────────────────────────
// One "is this install running?" flag per installable stack, plus the two
// pollers that watch a run in progress.
//
// Flags, not a single enum: the panels are independent and more than one can be
// mid-install. They gate re-entry (a second click must not start a second run)
// and drive each panel's busy affordance, which is why every one is read by the
// panel that owns it AND by the wizard that can start the same install.
import { ref } from 'vue';

/**
 * One flag for the four harness installs (codex, opencode, pi, grok): each
 * rebuilds the agent image and restarts the host, so two at once is never
 * right. The two older names are the same ref — readers that gate a row on
 * "is a harness installing?" keep working, and now mean it for all four.
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
 * Pending setTimeout handles while a poll is in flight, else null.
 *
 * setTimeout, not setInterval: both poll by re-arming after each response, so a
 * slow server cannot stack overlapping requests the way a fixed interval would.
 * Typing them as interval handles compiled but was wrong about the mechanism.
 */
export const ollamaPullPoller = ref<ReturnType<typeof setTimeout> | null>(null);
export const opencodeGatePoll = ref<ReturnType<typeof setTimeout> | null>(null);
/**
 * The gate as the SERVER reports it ('running'), rather than as this tab
 * remembers it — which is what makes it survive a page reload.
 */
export const opencodeGateFromServer = ref(false);
