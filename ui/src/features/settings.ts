// ── Settings ─────────────────────────────────────────────────────────────────
// The settings overlay: opening/closing it, the section renderers it owns, and
// the preference load/save round-trip.
//
// The section renderers that belong to another feature (skills sources, MCP,
// credentials, TTS/STT install) deliberately stay with that feature and are
// called from here — the overlay is a host, not an owner.
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { removeToolSecret, toolSecretUrl } from './agents.js';
import { permsMyUserId } from './perms-list-state.js';
import { myCredGroups, myCredSaving } from './my-credentials-state.js';
import { preflightChecks, preflightMessage, preflightPhase } from './preflight-state.js';
import PrejudgeActions from './PrejudgeActions.vue';
import MyCredentials from './MyCredentials.vue';
import Preflight from './Preflight.vue';
import { bearerConfirmTimer, sttChosenBackend } from './settings-state.js';
import { codexInstallActive, opencodeInstallActive } from './installer-state.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { pollRoutingInstall, pollSttInstall, pollTtsInstall, renderRoutingInstallProgress, runCodexInstall, runOpencodeInstall, runRoutingInstall, runSttInstall, runTtsInstall } from './installers.js';
import { sttPopulateModelSelect } from './models.js';
import { cancelDictation, getSttConfig, getTtsReadAloudEnabled, isDictationActive, loadTtsConfig, setSttConfig, setTtsReadAloudEnabled, stopTts } from './voice.js';
import { createApp, nextTick } from 'vue';
import PrejudgeModelOptions from './PrejudgeModelOptions.vue';
import { prejudgeModelOptions, prejudgeRows } from './prejudge-state.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideSettingsDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface SettingsDeps {
  toggleBearerToken: (a0?: any) => any;
  updateUserCredsBanner: (a0?: any) => any;
}

const deps = {} as SettingsDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideSettingsDeps(provided: Partial<SettingsDeps>): void {
  Object.assign(deps, provided);
}

const DEFAULTS = { theme: 'dark', font: 'medium', sendKey: 'enter', notifications: true,
};

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('nanoclaw-settings') || '{}');
    delete raw.readAloud;
    delete raw.readAloudRooms; // short-lived per-room experiment
    delete raw.readAloudDefault; // moved to the workspace (owner-set) setting
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings?: any) {
  localStorage.setItem('nanoclaw-settings', JSON.stringify(settings));
}

export function applySettings() {
  document.documentElement.setAttribute('data-theme', state.settings!.theme);
  document.documentElement.setAttribute('data-font', state.settings!.font);
  // Update meta theme-color for mobile browsers
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
    if (surface) meta.setAttribute('content', surface);
  }
}

export function renderSettingsModal() {
  // Theme buttons
  document.querySelectorAll('#theme-options .setting-option').forEach((btn) => {
    btn!.classList.toggle('active', (btn as HTMLElement).dataset.value === state.settings!.theme);
  });
  // Font buttons
  document.querySelectorAll('#font-options .setting-option').forEach((btn) => {
    btn!.classList.toggle('active', (btn as HTMLElement).dataset.value === state.settings!.font);
  });
  // Send key buttons
  document.querySelectorAll('#send-options .setting-option').forEach((btn) => {
    btn!.classList.toggle('active', (btn as HTMLElement).dataset.value === state.settings!.sendKey);
  });
  // Notifications
  $<HTMLInputElement>('#notif-toggle')!.checked = state.settings!.notifications;

}

let credConfigWired = false;

export async function renderCredentialsSettings() {
  const section = $('#settings-credentials');
  if (!section) return;
  let cfg;
  try {
    const r = await authFetch('/api/webchat/credentials-config');
    if (!r.ok) {
      section.hidden = true;
      return;
    }
    cfg = await r.json();
  } catch {
    section.hidden = true;
    return;
  }
  if (!cfg.canEdit) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  document.querySelectorAll('#cred-default-mode .setting-option').forEach((btn) => {
    btn!.classList.toggle('active', (btn as HTMLElement).dataset.value === cfg.defaultMode);
  });
  // Allowed providers — pill toggles (multi-select). "on" = accept BOTH a key
  // and a subscription for that provider. Displayed with AND (not OR) so the
  // pill can't read "on" while one half (e.g. OAuth) is actually off — that
  // mismatch hid the "Connect to <provider>" (OAuth) action even though the
  // pill looked enabled (allowClaudeOauth defaults off, allowAnthropicKey on).
  const providerOn = {
    claude: !!(cfg.allowAnthropicKey && cfg.allowClaudeOauth),
    codex: !!(cfg.allowOpenaiKey && cfg.allowCodexOauth),
    // One flag, not an AND: Grok has no API-key path, so there is no second
    // half that could be off while the pill reads on.
    grok: !!cfg.allowGrokOauth,
  } as Record<string, any>;
  // Greyed-but-clickable when unavailable, so a click can explain why (rather
  // than a native `disabled` button that swallows the click). Claude is always
  // available; Codex needs its provider installed.
  const providerAvailable = {
    claude: true,
    codex: !!cfg.codexAvailable,
    grok: !!cfg.grokAvailable,
  } as Record<string, any>;
  document.querySelectorAll('#cred-providers .setting-option').forEach((btn) => {
    const p = (btn as HTMLElement).dataset.provider ?? '';
    btn!.classList.toggle('active', !!providerOn[p]);
    btn!.classList.toggle('is-unavailable', !providerAvailable[p]);
  });

  // Codex install-row: Install button when the provider isn't in the agent image,
  // green ✓ badge once it is — same install-row pattern as Auto routing / Read
  // aloud. Install runs the wizard's two-phase build→restart flow (runCodexInstall).
  // Leave the button alone mid-install so its spinner isn't clobbered by a re-render.
  const codexRow = $('#settings-codex-install');
  if (codexRow) codexRow.hidden = false;
  const codexInstallBtn = $('#codex-install-btn');
  const codexBadge = $('#codex-installed-badge');
  if (codexInstallBtn && !codexInstallActive.value) codexInstallBtn.hidden = !!cfg.codexAvailable;
  if (codexBadge) codexBadge.hidden = !cfg.codexAvailable;

  // OpenCode harness install-row — same install-row pattern as Codex, driven by the
  // opencodeAvailable flag on the credentials-config payload. Leave the button alone
  // mid-install so its spinner isn't clobbered by a re-render.
  const opencodeRow = $('#settings-opencode-install');
  if (opencodeRow) opencodeRow.hidden = false;
  const opencodeInstallBtn = $('#opencode-install-btn');
  const opencodeBadge = $('#opencode-installed-badge');
  if (opencodeInstallBtn && !opencodeInstallActive.value) opencodeInstallBtn.hidden = !!cfg.opencodeAvailable;
  if (opencodeBadge) opencodeBadge.hidden = !cfg.opencodeAvailable;

  // pi harness install-row — same pattern, driven by piAvailable. The shared
  // opencodeInstallActive.value flag serializes harness installs (both rebuild the image).
  const piRow = $('#settings-pi-install');
  if (piRow) piRow.hidden = false;
  const piInstallBtn = $('#pi-install-btn');
  const piBadge = $('#pi-installed-badge');
  if (piInstallBtn && !opencodeInstallActive.value) piInstallBtn.hidden = !!cfg.piAvailable;
  if (piBadge) piBadge.hidden = !cfg.piAvailable;

  // Grok install-row — same pattern, driven by grokAvailable. Shares
  // opencodeInstallActive with the other harness installs: all of them rebuild the
  // agent image, so they must not run concurrently.
  const grokRow = $('#settings-grok-install');
  if (grokRow) grokRow.hidden = false;
  const grokInstallBtn = $('#grok-install-btn');
  const grokBadge = $('#grok-installed-badge');
  if (grokInstallBtn && !opencodeInstallActive.value) grokInstallBtn.hidden = !!cfg.grokAvailable;
  if (grokBadge) grokBadge.hidden = !cfg.grokAvailable;

  if (credConfigWired) return;
  credConfigWired = true;
  $('#codex-install-btn')?.addEventListener('click', () => runCodexInstall(CODEX_SETTINGS_ELS));
  $('#opencode-install-btn')?.addEventListener('click', () => runOpencodeInstall(OPENCODE_SETTINGS_ELS));
  $('#pi-install-btn')?.addEventListener('click', () => runOpencodeInstall(PI_SETTINGS_ELS));
  $('#grok-install-btn')?.addEventListener('click', () => runOpencodeInstall(GROK_SETTINGS_ELS));
  const putConfig = async (patch: any) => {
    const r = await authFetch('/api/webchat/credentials-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Failed to save: ' + (err.error || r.statusText), { kind: 'error' });
      renderCredentialsSettings(); // resync to server truth
      return false;
    }
    return true;
  };
  document.querySelectorAll('#cred-default-mode .setting-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (await putConfig({ defaultMode: (btn as HTMLElement).dataset.value })) {
        document
          .querySelectorAll('#cred-default-mode .setting-option')
          .forEach((b) => b.classList.toggle('active', b === btn));
        // The effective mode for the open room may have changed — refresh its
        // credential banner so the connect controls appear/disappear at once.
        if (state.currentRoom) deps.updateUserCredsBanner(state.currentRoom);
      }
    });
  });
  // Each provider pill toggles its key + subscription flags together. An
  // unavailable pill explains how to enable it instead of toggling.
  const PROVIDER_FLAGS = {
    claude: ['allowAnthropicKey', 'allowClaudeOauth'],
    codex: ['allowOpenaiKey', 'allowCodexOauth'],
  } as Record<string, string[]>;
  const PROVIDER_UNAVAILABLE = {
    codex: 'Codex isn’t installed yet — use “Install Codex…” above to add it.',
    claude: 'Claude isn’t available in this workspace.',
  } as Record<string, string>;
  document.querySelectorAll('#cred-providers .setting-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = (btn as HTMLElement).dataset.provider ?? '';
      if (btn.classList.contains('is-unavailable')) {
        showToast(PROVIDER_UNAVAILABLE[p] || 'This provider isn’t available yet.', { kind: 'info', timeout: 9000 });
        return;
      }
      const [keyFlag, oauthFlag] = PROVIDER_FLAGS[p] || [];
      if (!keyFlag) return;
      const on = !btn.classList.contains('active'); // flipping to this state
      if (await putConfig({ [keyFlag]: on, [oauthFlag]: on })) {
        btn!.classList.toggle('active', on);
        // Reflect the policy change in the open chat's credential banner right
        // away (show/hide "Connect to <provider>") instead of waiting for the
        // next room open — the gap that made enabling OAuth look like a no-op.
        if (state.currentRoom) deps.updateUserCredsBanner(state.currentRoom);
      }
    });
  });
}

let accessBearerWired = false;

let accessHttpsWired = false;

export async function renderAccessSettings() {
  const section = $('#settings-access');
  if (!section) return;
  let info = null;
  try {
    const r = await authFetch('/api/webchat/auth');
    if (r.ok) info = await r.json();
  } catch {
    info = null;
  }
  section.hidden = !info;
  if (!info) return;

  const btn = $('#access-bearer-btn')!;
  if (!accessBearerWired) {
    accessBearerWired = true;
    btn?.addEventListener('click', () => deps.toggleBearerToken(btn.dataset.want === 'enable'));
  }
  // Reset any half-finished confirm from a previous open.
  clearTimeout(bearerConfirmTimer.value ?? undefined);
  btn.dataset.confirming = '';

  // Install-row idiom (like Auto routing): state lives in the badge, the
  // explanation in its tooltip — no standing prose.
  const badge = $('#access-bearer-badge')!;
  const setBadge = (text?: any, title?: any) => {
    badge.hidden = false;
    badge.textContent = text;
    badge.title = title;
  };
  if (!info.bearerConfigured) {
    btn!.hidden = true;
    setBadge('Not set', 'No bearer token is configured — access is controlled by your other auth method.');
  } else if (info.bearerActive && info.canDisableBearer) {
    btn!.hidden = false;
    btn.dataset.want = 'disable';
    btn!.textContent = 'Disable';
    setBadge('Active', 'You also have Tailscale or SSO, so the shared bearer token is no longer needed.');
  } else if (info.bearerActive) {
    btn!.hidden = true;
    setBadge('Required', 'Required for access. Set up Tailscale or SSO to retire this shared token.');
  } else {
    btn!.hidden = false;
    btn.dataset.want = 'enable';
    btn!.textContent = 'Re-enable';
    setBadge('Disabled', 'Access is via Tailscale or SSO. The token in .env is ignored until re-enabled.');
  }

  renderHttpsSettings();
}

export async function renderHttpsSettings() {
  const row = $<HTMLElement>('#access-https-row');
  const hint = $<HTMLInputElement>('#access-https-hint');
  const btn = ($('#access-https-btn')!) as HTMLInputElement;
  if (!row || !hint || !btn) return;
  if (!accessHttpsWired) {
    accessHttpsWired = true;
    btn.addEventListener('click', () => enableTailscaleHttps());
  }
  let state = null;
  try {
    const r = await authFetch('/api/webchat/tailscale-https');
    if (r.ok) state = await r.json();
  } catch {
    state = null;
  }
  // Nothing to offer until Tailscale is up on the host.
  if (!state || !state.available) {
    row.hidden = true;
    hint!.hidden = true;
    return;
  }
  row.hidden = false;
  const badge = $('#access-https-badge')!;
  hint!.hidden = true; // prose only for errors (written by enableTailscaleHttps)
  if (state.active) {
    btn!.hidden = true;
    badge.hidden = false;
    // Both flavors (serve / native cert) are tailnet-scoped — the tooltip
    // carries the URL + scope instead of standing prose.
    badge.title = `${state.url || 'HTTPS via Tailscale'} — only reachable over your tailnet.`;
  } else {
    badge.hidden = true;
    btn!.hidden = false;
    (btn as HTMLButtonElement)!.disabled = false;
    btn!.textContent = 'Enable';
    btn.title = 'Serve over Tailscale with a real certificate — enables PWA install, push, and voice.';
  }
}

const CODEX_SETTINGS_ELS = { btn: '#codex-install-btn', log: '#codex-install-log', progress: '#codex-install-progress' } as Record<string, string>;

const OPENCODE_SETTINGS_ELS = {
  btn: '#opencode-install-btn',
  log: '#opencode-install-log',
  progress: '#opencode-install-progress',
} as Record<string, string>;

const GROK_SETTINGS_ELS = {
  btn: '#grok-install-btn',
  log: '#grok-install-log',
  progress: '#grok-install-progress',
  url: '/api/grok/install',
  name: 'Grok',
  doneMsg: 'Grok installed — sign in with a device code under Credentials.',
} as Record<string, string>;

const PI_SETTINGS_ELS = {
  btn: '#pi-install-btn',
  log: '#pi-install-log',
  progress: '#pi-install-progress',
  url: '/api/pi/install',
  name: 'pi',
  doneMsg: 'pi installed — switch an agent to it under Agent → Harness.',
} as Record<string, string>;

/**
 * About — what this install is actually running.
 *
 * Nothing reported that before. The nanoclaw version was readable only from
 * package.json on the box, and the webchat overlay had no version at all: this
 * repo's versions.json is a build input that never ships, and the install's own
 * versions.json is nanoclaw's onecli/agent pins — a different file with the
 * same name. install.sh now stamps `.webchat-provenance.json`, which is where
 * the webchat rows come from.
 *
 * Read-only by design. Both components update through git against a customised
 * tree, so there is no honest one-click here — the hint under the rows says so
 * rather than implying a button is coming.
 *
 * Gated by the endpoint, not a role flag: /api/system/versions is anyAdmin, so
 * a 403 hides the section the same way the other probe-gated sections work.
 */
export async function renderAboutSettings(): Promise<void> {
  const section = $('#settings-about');
  if (!section) return;
  let v: any = null;
  try {
    const res = await authFetch('/api/system/versions');
    if (res.ok) v = await res.json();
  } catch {
    v = null;
  }
  if (!v) {
    section.hidden = true;
    return;
  }
  const short = (sha: unknown) => (typeof sha === 'string' && sha ? sha.slice(0, 12) : null);
  // A dirty tree is NOT the commit it names, so say so rather than printing a
  // SHA the operator cannot reconcile with what is running. This still applies
  // to WEBCHAT's ref, which records whether the source repo was clean when the
  // release was composed. It no longer applies to nanoclaw's: that tree is
  // modified by construction, so the flag was true on every working install.
  // What replaces it is the composition row below, which compares the payload
  // on disk against what the composition actually wrote.
  const withDirty = (sha: string | null, dirty: boolean | null) =>
    sha ? sha + (dirty ? ' (modified)' : '') : null;

  const c = v.composition;
  const composition = !c
    ? 'not recorded — reinstall to enable'
    : c.matches
      ? `matches composed release (${c.checked} files)`
      : `${c.drifted.length} of ${c.checked} files changed since install: ` +
        c.drifted.slice(0, 6).join(', ') +
        (c.drifted.length > 6 ? `, +${c.drifted.length - 6} more` : '');

  const rows: Array<[string, string | null]> = [
    ['nanoclaw', v.nanoclaw?.version ?? null],
    ['nanoclaw commit', short(v.nanoclaw?.commit)],
    ['composition', composition],
    ['webchat', v.webchat ? withDirty(short(v.webchat.ref), v.webchat.dirty) : 'unknown — reinstall to stamp'],
    ['webchat composed', v.webchat?.composedAt ? String(v.webchat.composedAt).replace('T', ' ').replace('+00:00', ' UTC') : null],
    ['upstream pin', short(v.webchat?.upstreamRef)],
    ['seam pin', short(v.webchat?.seamRef)],
  ];
  for (const [k, val] of Object.entries(v.components ?? {})) rows.push([k, String(val)]);

  const dl = $('#about-rows')!;
  dl.textContent = '';
  for (const [k, val] of rows) {
    if (!val) continue; // omit what this install cannot know rather than printing "null"
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    // textContent, never innerHTML: an agent-image digest is attacker-adjacent
    // data from a registry and has no business being parsed as markup.
    dd.textContent = val;
    dl.append(dt, dd);
  }
  section.hidden = false;
}

let auditWired = false;

/**
 * Audit section — owner-only, gated by the endpoint like every other
 * probe-gated section (403 → no surface). The status line is DATA, not
 * standing prose: delivery counts and the last error, or nothing. The
 * what/why copy lives behind the ⓘ per DESIGN.md.
 */
export async function renderAuditSettings(): Promise<void> {
  const section = $('#settings-audit');
  if (!section) return;
  let info: any = null;
  try {
    const res = await authFetch('/api/webchat/audit-syslog');
    if (res.ok) info = await res.json();
  } catch {
    info = null;
  }
  if (!info) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const input = $<HTMLInputElement>('#audit-syslog-target');
  // Don't clobber a half-typed edit on a background re-render.
  if (input && document.activeElement !== input) input.value = info.target || '';

  const statusEl = $('#audit-syslog-status');
  if (statusEl) {
    const st = info.status || {};
    if (!info.target) {
      statusEl.hidden = true;
    } else {
      const parts = [];
      parts.push(`${st.sentCount ?? 0} sent`);
      if (st.lastSentAt) parts.push(`last ${new Date(st.lastSentAt).toLocaleTimeString()}`);
      if (st.droppedCount) parts.push(`${st.droppedCount} dropped`);
      if (st.lastError && (!st.lastSentAt || st.lastErrorAt > st.lastSentAt)) parts.push(`error: ${st.lastError}`);
      statusEl.textContent = parts.join(' · ');
      statusEl.hidden = false;
    }
  }

  if (auditWired) return;
  auditWired = true;
  $<HTMLButtonElement>('#audit-syslog-apply')?.addEventListener('click', async () => {
    const target = ($<HTMLInputElement>('#audit-syslog-target')?.value || '').trim();
    const r = await authFetch('/api/webchat/audit-syslog', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ target }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Audit forwarding not changed: ' + (err.error || r.statusText), { kind: 'error' });
      return;
    }
    showToast(target ? 'Audit forwarding on — the change was recorded to both collectors' : 'Audit forwarding off', {
      kind: 'success',
    });
    void renderAuditSettings(); // pick up the fresh status (incl. the config event's delivery)
  });
}

/**
 * Backup section — owner-only, and until now the ONE section in Settings that
 * started visible with no gate at all. Every other section ships `hidden` in
 * the markup and reveals itself only after its own capability probe passes,
 * so they fail closed; this one failed open and showed a member three buttons
 * that could only ever 403 (`/api/system/export` and `/api/system/import`
 * both carry `guards: ['owner']`).
 *
 * `state.isOwnerView` is the same signal the secrets, skill-sources and
 * prejudge sections use, so this stays consistent with its neighbours rather
 * than adding a fourth way to ask the same question.
 */
export function renderBackupSettings(): void {
  const section = $('#settings-backup');
  if (!section) return;
  section.hidden = !state.isOwnerView;
}

/**
 * Hide the "Features" column when every feature inside it is hidden.
 *
 * The column is a heading plus four independently-gated sections (TTS, STT,
 * auto-learn, credential isolation). Gate the column on a role and it breaks
 * for whoever holds a role the column doesn't model — a global admin sees
 * auto-learn and credential isolation but is not an owner. So derive it from
 * the children instead: the column is worth showing iff something is in it.
 *
 * Runs after the async gates settle. Each child render hides itself on a 403
 * that we cannot observe synchronously, so calling this inline with
 * openSettings would always see the pre-fetch state.
 */
function syncFeaturesColumn(): void {
  const col = $('#settings-features-col');
  if (!col) return;
  const anyVisible = [...col.querySelectorAll('.settings-feature')].some((e) => !e.hasAttribute('hidden'));
  col.hidden = !anyVisible;
}

// Settings is YOUR settings now: appearance, your own credentials, and the two
// speech features. Everything that configures the installation moved to the
// Admin view — see features/admin.ts for why, and for the renderers that went
// with it. Adding an operator control back here is almost always a mistake;
// it belongs in an Admin group.
export function openSettings() {
  renderSettingsModal();
  void Promise.allSettled([renderTtsSetupSettings(), renderSttSetupSettings()]).then(syncFeaturesColumn);
  void renderMyCredentials();
  $('#settings-overlay')!.hidden = false;
  // Focus trap
  const modal = $('#settings-overlay .modal')!;
  const focusable = modal.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
  if (focusable.length) (focusable[0] as HTMLElement).focus();
}

export function closeSettings() {
  $('#settings-overlay')!.hidden = true;
}

let ttsInstallWired = false;

export async function renderTtsSetupSettings() {
  const section = $('#settings-tts');
  if (!section) return;
  const btn = ($('#tts-install-btn')!) as HTMLInputElement;
  const badge = $('#tts-installed-badge')!;
  const progress = $('#tts-install-progress')!;
  if (!ttsInstallWired) {
    ttsInstallWired = true;
    btn.addEventListener('click', () => runTtsInstall());
    // Voice picker: save is workspace-wide (env-persisted, no restart), then a
    // short sample plays so you hear what you picked.
    $('#tts-voice-select')?.addEventListener('change', async () => {
      const voice = $<HTMLInputElement>('#tts-voice-select')!.value;
      const r = await authFetch('/api/tts/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showToast('Failed to save voice: ' + (err.error || r.statusText), { kind: 'error' });
        renderTtsSetupSettings();
        return;
      }
      showToast('Voice saved', { kind: 'success' });
      try {
        const sample = await authFetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'This is how I sound.', voice }),
        });
        if (sample.ok) {
          const blob = await sample.blob();
          void new Audio(URL.createObjectURL(blob)).play();
        }
      } catch {
        /* preview is best-effort */
      }
    });
  }
  let st = null;
  try {
    const res = await authFetch('/api/webchat/tts/install');
    if (res.ok) st = await res.json();
  } catch {
    st = null;
  }
  if (!st) {
    // Non-owner: the whole block is the owner's control surface now that the
    // switch applies workspace-wide.
    section.hidden = true;
    return;
  }
  section.hidden = false;
  // Switch shows the workspace truth (fetched at boot; re-fetch is cheap).
  await loadTtsConfig();
  const readAloudToggle = $<HTMLInputElement>('#tts-readaloud-toggle');
  if (readAloudToggle) readAloudToggle.checked = getTtsReadAloudEnabled();
  const desc = $('#tts-setup-desc');
  if (st.installed) {
    btn!.hidden = true;
    badge.hidden = false;
    if (desc) desc.hidden = true;
    progress.hidden = !st.running;
    if (st.running) pollTtsInstall();
    // Voice picker — needs the backend up (voices proxy 502s otherwise).
    try {
      const [voicesRes, cfgRes] = await Promise.all([authFetch('/api/tts/voices'), authFetch('/api/tts/config')]);
      if (voicesRes.ok) {
        const { voices } = await voicesRes.json();
        const cfg = cfgRes.ok ? await cfgRes.json() : {};
        const select = ($('#tts-voice-select')) as HTMLInputElement;
        if (select && Array.isArray(voices) && voices.length) {
          select.innerHTML = '';
          for (const v of voices) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            select.appendChild(opt);
          }
          if (cfg.voice) select.value = cfg.voice;
          if (cfg.model) {
            const label = $('#tts-voice-label');
            if (label) label.textContent = `Voice (${cfg.model.charAt(0).toUpperCase()}${cfg.model.slice(1)})`;
          }
          $('#tts-voice-group')!.hidden = false;
        }
      }
    } catch {
      /* picker stays hidden — the feature works regardless */
    }
    return;
  }
  badge.hidden = true;
  $('#tts-voice-group')!.hidden = true;
  btn!.hidden = !st.installerPresent;
  // Prereq hint (the only prose this block is allowed): explain the hidden
  // Install button instead of leaving a silent dead row.
  if (desc) {
    desc.hidden = false;
    if (st.installerPresent) {
      desc.textContent = 'Using each device’s built-in voices.';
    } else {
      desc.textContent =
        'Server voices need the add-webchat-tts skill, which isn\u2019t in this install — re-run install-webchat.sh to add it. Device voices still work.';
    }
  }
  if (st.running) {
    pollTtsInstall();
  } else {
    (btn as HTMLButtonElement)!.disabled = false;
    btn!.textContent = 'Install local voices';
    btn.title = 'Run a local Kokoro voice model (~330MB, no cloud, no key). Without it the control uses your device voices.';
  }
}

let sttInstallWired = false;

let sttLastState: any = null; // last /api/webchat/stt/install snapshot (render + change guard)

export async function renderSttSetupSettings() {
  const section = $('#settings-stt')!;
  if (!section) return;
  let st = null;
  try {
    const res = await authFetch('/api/webchat/stt/install');
    if (res.ok) st = await res.json();
  } catch {
    st = null;
  }
  if (!st) {
    section.hidden = true; // non-owner: no install surface at all
    return;
  }
  sttLastState = st;
  section.hidden = false;
  const btn = ($('#stt-install-btn')!) as HTMLInputElement;
  const badge = $('#stt-installed-badge')!;
  const progress = $('#stt-install-progress')!;
  const desc = $('#stt-setup-desc')!;
  if (!sttInstallWired) {
    sttInstallWired = true;
    document.querySelectorAll('#stt-backend-mode .setting-option').forEach((b) => {
      b.addEventListener('click', () => {
        // dataset.value is string|undefined; every button in this group carries
        // data-value, so the fallback is unreachable in practice — but assigning
        // undefined would blank the choice rather than leave it, which is worse
        // than falling back to the declared default.
        sttChosenBackend.value = (b as HTMLElement).dataset.value ?? 'local';
        renderSttSetupSettings();
      });
    });
    btn?.addEventListener('click', () => {
      runSttInstall({ provider: 'local', model: $<HTMLInputElement>('#stt-model-select')?.value || undefined });
    });
    // Workspace Off/On — mirrors Read aloud: owner flips the mic for everyone.
    document.querySelectorAll('#stt-enabled-mode .setting-option').forEach((b) => {
      b.addEventListener('click', async () => {
        const on = (b as HTMLElement).dataset.value === 'on';
        const r = await authFetch('/api/stt/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: on }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          showToast('Failed to save: ' + (err.error || r.statusText), { kind: 'error' });
          return;
        }
        document.querySelectorAll('#stt-enabled-mode .setting-option')
          .forEach((x: any) => x.classList.toggle('active', x === b));
        const mic = $('#mic-btn');
        if (mic) mic.hidden = !on;
        if (!on && isDictationActive()) cancelDictation();
        showToast(on ? 'Voice dictation on for everyone' : 'Voice dictation off for everyone');
      });
    });
    // Installed + local: picking a different model re-runs the installer for it
    // (downloads if new, restarts the container) with the usual progress log.
    $('#stt-model-select')?.addEventListener('change', () => {
      if (!sttLastState?.installed || sttLastState.provider !== 'local') return;
      const model = $<HTMLInputElement>('#stt-model-select')!.value;
      if (!model || model === sttLastState.model) return;
      showToast(`Switching to ${model}…`, { kind: 'info' });
      runSttInstall({ provider: 'local', model });
    });
    $('#stt-connect-btn')?.addEventListener('click', () => {
      const key = ($<HTMLInputElement>('#stt-api-key')?.value || '').trim();
      if (!key) {
        showToast('Enter the ElevenLabs API key first', { kind: 'error' });
        return;
      }
      runSttInstall({ provider: 'elevenlabs', apiKey: key });
      $<HTMLInputElement>('#stt-api-key')!.value = '';
    });
    // Cleanup-prompt editor: Edit… disclosure → textarea + Save / Reset.
    $('#stt-prompt-edit')?.addEventListener('click', () => {
      const editor = $('#stt-prompt-editor')!;
      const open = editor.hidden;
      editor.hidden = !open;
      $('#stt-prompt-edit')!.setAttribute('aria-expanded', String(open));
      if (open) $('#stt-prompt-text')!.focus();
    });
    $('#stt-prompt-save')?.addEventListener('click', async () => {
      const value = $<HTMLInputElement>('#stt-prompt-text')!.value.trim();
      const r = await authFetch('/api/stt/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cleanupPrompt: value || null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        showToast('Failed to save: ' + (body.error || r.statusText), { kind: 'error' });
        return;
      }
      $('#stt-prompt-editor')!.hidden = true;
      $('#stt-prompt-edit')!.setAttribute('aria-expanded', 'false');
      showToast(body.cleanupPrompt ? 'Cleanup prompt saved' : 'Cleanup prompt reset to default', { kind: 'success' });
      renderSttSetupSettings();
    });
    $('#stt-prompt-reset')?.addEventListener('click', async () => {
      const r = await authFetch('/api/stt/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cleanupPrompt: null }),
      });
      if (!r.ok) {
        showToast('Failed to reset', { kind: 'error' });
        return;
      }
      $('#stt-prompt-editor')!.hidden = true;
      $('#stt-prompt-edit')!.setAttribute('aria-expanded', 'false');
      showToast('Cleanup prompt reset to default', { kind: 'success' });
      renderSttSetupSettings();
    });
    $<HTMLSelectElement>('#stt-cleanup-select')?.addEventListener('change', async () => {
      const value = $<HTMLInputElement>('#stt-cleanup-select')!.value || null;
      const r = await authFetch('/api/stt/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cleanupModelId: value }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showToast('Failed to save: ' + (err.error || r.statusText), { kind: 'error' });
        renderSttSetupSettings(); // resync to server truth
        return;
      }
      setSttConfig({ ...getSttConfig(), cleanup: value !== null, cleanupModelId: value });
      showToast(value ? 'Cleanup model saved' : 'Cleanup turned off', { kind: 'success' });
    });
  }
  if (st.installed) {
    badge.hidden = false;
    btn!.hidden = true;
    $('#stt-backend-group')!.hidden = true;
    $('#stt-key-group')!.hidden = true;
    $('#stt-enabled-group')!.hidden = false;
    document.querySelectorAll('#stt-enabled-mode .setting-option').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.value === (st.enabled ? 'on' : 'off'));
    });
    // Local backend: the model stays visible and switchable after install.
    const localModel = st.provider === 'local' && st.installerPresent;
    $('#stt-model-group')!.hidden = !localModel;
    if (localModel) {
      sttPopulateModelSelect(st);
      const label = $('#stt-model-label');
      if (label) label.textContent = 'Model (Whisper)';
    }
    if (desc) desc.hidden = true;
    progress.hidden = !st.running;
    if (st.running) pollSttInstall();
    // Cleanup model applies whichever backend transcribes.
    try {
      const cfg = await (await authFetch('/api/stt/config')).json();
      if (cfg.canEdit) {
        await renderSttCleanupSelect(cfg);
        // Prompt editor: prefill with the effective prompt; Reset only shows
        // when a custom prompt is stored.
        $('#stt-prompt-row')!.hidden = false;
        $<HTMLInputElement>('#stt-prompt-text')!.value = cfg.cleanupPrompt || cfg.defaultCleanupPrompt || '';
        $('#stt-prompt-reset')!.hidden = !cfg.cleanupPrompt;
      }
    } catch {
      /* cleanup select stays as-is */
    }
    return;
  }
  badge.hidden = true;
  $('#stt-enabled-group')!.hidden = true;
  $('#stt-cleanup-group')!.hidden = true;
  $('#stt-prompt-row')!.hidden = true;
  $('#stt-prompt-editor')!.hidden = true;
  $('#stt-backend-group')!.hidden = false;
  // Prereq hint (the only prose allowed here): explain a hidden Install button.
  if (desc) {
    desc.hidden = st.installerPresent || sttChosenBackend.value !== 'local';
    if (!st.installerPresent) {
      desc.textContent =
        'The local backend needs the add-webchat-dictation skill, which isn’t in this install — re-run install-webchat.sh to add it, or use ElevenLabs.';
    }
  }
  sttRenderBackendChoice(st);
  if (st.running) {
    pollSttInstall();
  } else if (btn) {
    (btn as HTMLButtonElement)!.disabled = false;
    btn!.textContent = 'Install';
    btn.title = 'Run whisper.cpp locally with the selected model — no cloud, no key. Model download sized to this machine.';
  }
}

let prejudgeOptionsApp: any = null;

function mountPrejudgeModelOptions(): void {
  if (prejudgeOptionsApp) return;
  const host = $('#prejudge-model-select');
  if (!host) return;
  prejudgeOptionsApp = createApp(PrejudgeModelOptions);
  prejudgeOptionsApp.mount(host);
}

// Exported now that the Admin view owns this block — it was private while
// openSettings was its only caller.
export async function renderPrejudgeSettings() {
  const section = $('#settings-prejudge')!;
  if (!section) return;
  section.hidden = !state.isOwnerView;
  if (!state.isOwnerView) return;
  let cfg = null;
  try {
    const r = await authFetch('/api/approvals/prejudge');
    if (r.ok) cfg = await r.json();
  } catch {}
  if (!cfg) {
    section.hidden = true; // endpoint 403'd or failed — no surface
    return;
  }
  const sel = ($('#prejudge-model-select')!) as HTMLInputElement;
  // Rebuild the options every open — the roster may have changed. Only
  // models the PUT accepts are listed: anthropic kind (OneCLI-proxied), or
  // a local kind with an endpoint.
  let options: Array<{ id: string; label: string }> = [];
  try {
    const models = await (await authFetch('/api/models')).json();
    options = models
      .filter(
        (m: any) =>
          m.kind === 'anthropic' || ((m.kind === 'ollama' || m.kind === 'openai-compatible') && m.endpoint),
      )
      .map((m: any) => ({ id: m.id, label: `${m.name} (${m.model_id})` }));
  } catch {
    /* roster unavailable — Off still renders */
  }
  prejudgeModelOptions.value = options;
  mountPrejudgeModelOptions();
  // The options render a tick after the ref is set, and the assignment below
  // selects one of them. Assigning first would select nothing and then read
  // back as "the stored judge left the roster", clearing a working config.
  await nextTick();
  (sel as HTMLInputElement).value = cfg.modelId || '';
  if ((sel as HTMLInputElement).value !== (cfg.modelId || '')) (sel as HTMLInputElement).value = ''; // stored judge left the roster
  renderPrejudgeActions(cfg);
  sel.onchange = async () => {
    try {
      const out = await apiJson('/api/approvals/prejudge', {
        method: 'PUT',
        body: { modelId: (sel as HTMLInputElement).value || null },
      });
      showToast(sel.value ? 'Approval pre-judge on' : 'Approval pre-judge off', { kind: 'success' });
      renderPrejudgeActions(out);
    } catch (err) {
      showToast('Could not save: ' + ((err as any)?.message || err), { kind: 'error' });
      renderPrejudgeSettings();
    }
  };
}

let routingInstallWired = false;

export async function renderRoutingSetup() {
  const section = $('#routing-setup')!;
  let st;
  try {
    const res = await authFetch('/api/router/install');
    if (!res.ok) { section.hidden = true; return; } // 403 (non-owner) etc. → no surface
    st = await res.json();
  } catch {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const btn = ($('#routing-install-btn')!) as HTMLInputElement;
  const desc = $('#routing-setup-desc')!;
  const badge = $('#routing-installed-badge')!;
  const progress = $('#routing-install-progress')!;

  if (!routingInstallWired) {
    routingInstallWired = true;
    btn.addEventListener('click', runRoutingInstall);
  }

  // "Busy" = the install chain is running OR the classifier model is still
  // downloading. Either way, show the progress surfaces and keep polling.
  const pulling = Boolean(st.pull && st.pull.status === 'pulling');
  const busy = st.running || pulling;

  // Already scaffolded → green ✓ Installed (badge title points at the Auto
  // routing tab). Keep the pull bar visible if the classifier model is still
  // coming down.
  if (st.installed) {
    btn!.hidden = true;
    desc.hidden = true;
    badge.hidden = false;
    if (busy) {
      progress.hidden = false;
      renderRoutingInstallProgress(st);
      pollRoutingInstall();
    } else {
      progress.hidden = true;
    }
    return;
  }
  badge.hidden = true;
  btn!.hidden = false;
  btn!.textContent = busy ? 'Installing…' : 'Install';
  // The Install flow sets up the LiteLLM router first if it's missing, so the
  // button stays live either way.
  (btn as HTMLButtonElement)!.disabled = busy;
  desc.hidden = true;
  if (busy) {
    progress.hidden = false;
    renderRoutingInstallProgress(st);
    pollRoutingInstall(); // resume streaming if a reopen happened mid-install
  } else {
    progress.hidden = true;
  }
}

// Push setup is operational, not conversational — it must NOT write to the chat
// transcript (see DESIGN.md §4). Step-by-step progress goes to the console;
// only outcomes surface, and only for an explicit user action (the Settings
// toggle, interactive=true) via toast. The silent auto-resubscribe on reload
// stays quiet on success and logs failures to the console.
export async function enableWebPush({ interactive = false }: { interactive?: boolean } = {}): Promise<void> {
  const fail = (msg: string, err?: unknown) => {
    console.warn('[push]', msg, err ?? '');
    if (interactive) showToast(msg, { kind: 'error' });
  };
  try {
    if (!('serviceWorker' in navigator)) return fail('Notifications aren’t supported in this browser');
    if (!('PushManager' in window)) {
      console.warn('[push] PushManager unavailable');
      if (interactive) {
        showToast('To enable notifications on iOS, add this app to your home screen and open it from there', {
          kind: 'info',
          timeout: 6000,
        });
      }
      return;
    }
    console.log('[push] fetching VAPID key');
    const keyRes = await authFetch('/api/push/vapid-public');
    if (!keyRes.ok) return fail('Couldn’t enable notifications — the server has no push key');
    const { key } = await keyRes.json();
    if (!key) return fail('Couldn’t enable notifications — the server has no push key');

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      console.log('[push] subscribing');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    } else {
      console.log('[push] reusing existing subscription');
    }

    const res = await authFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) return fail('Couldn’t save your notification subscription');
    console.log('[push] subscribed', sub.endpoint.slice(-24));
    if (interactive) showToast('Notifications enabled', { kind: 'success' });
  } catch (err) {
    fail('Couldn’t enable notifications', err);
  }
}

async function disableWebPush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await authFetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
      console.log('[push] unsubscribed');
    }
  } catch (err) {
    console.error('[push] unsubscribe failed:', err);
  }
}

function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// The settings surface: the panel toggles, theme and font controls.
//
// One function per GROUP of blocks, each called from the line its group
// started on. Blocks with an executing statement between them cannot share a
// function: a single call at the first block moves the later ones ahead of
// whatever ran in between, which the boot-order trace catches.

export function wireSettingsPanel1(): void {
  $('#settings-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('#settings-overlay')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#settings-overlay')?.hidden) closeSettings();
  });
}

export function wireSettingsPanel2(): void {
  document.querySelectorAll<HTMLElement>('#theme-options .setting-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.settings) state.settings.theme = btn.dataset.value as never;
      if (state.settings) saveSettings(state.settings);
      applySettings();
      renderSettingsModal();
    });
  });
  document.querySelectorAll<HTMLElement>('#font-options .setting-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.settings) state.settings.font = btn.dataset.value as never;
      if (state.settings) saveSettings(state.settings);
      applySettings();
      renderSettingsModal();
    });
  });
  document.querySelectorAll<HTMLElement>('#send-options .setting-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.settings) state.settings.sendKey = btn.dataset.value as never;
      if (state.settings) saveSettings(state.settings);
      renderSettingsModal();
    });
  });
  const readAloud = $<HTMLInputElement>('#tts-readaloud-toggle');
  readAloud?.addEventListener('change', async () => {
    const on = readAloud.checked;
    // Same contract as the credential-isolation toggle beside it: disabled
    // while saving, and a failed save REVERTS the switch — a toggle showing a
    // state the server refused is a lie with a UI.
    readAloud.disabled = true;
    try {
      const r = await authFetch('/api/tts/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readAloud: on }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        readAloud.checked = !on;
        showToast('Failed to save: ' + (err.error || r.statusText), { kind: 'error' });
        return;
      }
      setTtsReadAloudEnabled(on);
      if (!on) stopTts();
      showToast(
        on ? 'Read aloud on for everyone — hover an agent reply for the speaker' : 'Read aloud off for everyone',
      );
    } finally {
      readAloud.disabled = false;
    }
  });
  const notifToggle = $<HTMLInputElement>('#notif-toggle');
  notifToggle?.addEventListener('change', async () => {
    if (notifToggle.checked) {
      if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          notifToggle.checked = false;
          if (state.settings) state.settings.notifications = false;
          if (state.settings) saveSettings(state.settings);
          showToast('Notifications need browser permission to turn on', { kind: 'info' });
          return;
        }
      }
      await enableWebPush({ interactive: true });
    } else {
      await disableWebPush();
    }
    if (state.settings) state.settings.notifications = notifToggle.checked;
    if (state.settings) saveSettings(state.settings);
  });
}

export async function enableTailscaleHttps() {
  const hint = $<HTMLInputElement>('#access-https-hint');
  const btn = $<HTMLButtonElement>('#access-https-btn');
  (btn as HTMLButtonElement)!.disabled = true;
  btn!.textContent = 'Enabling…';
  try {
    const r = await authFetch('/api/webchat/tailscale-https', {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) {
      showToast('HTTPS enabled over Tailscale', { kind: 'success' });
    } else {
      const parts = [data.error, data.hint].filter(Boolean).join(' ');
      showToast(data.error || 'Could not enable HTTPS', { kind: 'error', timeout: 9000 });
      if (parts) {
        hint!.hidden = false;
        hint!.innerHTML = data.hintUrl
          ? `${esc(parts)} <a href="${esc(data.hintUrl)}" target="_blank" rel="noopener">Open admin console</a>`
          : esc(parts);
      }
    }
  } catch {
    showToast('Connection failed', { kind: 'error' });
  } finally {
    renderHttpsSettings();
  }
}

/** Populate the cleanup select from the roster (owner path of /api/stt/config). */
export async function renderSttCleanupSelect(cfg: any) {
  const group = $('#stt-cleanup-group');
  const select = $<HTMLSelectElement>('#stt-cleanup-select');
  if (!group || !select) return;
  group.hidden = false;
  try {
    const models = await (await authFetch('/api/models')).json();
    select.innerHTML = '<option value="">None — raw transcript</option>';
    for (const m of models) {
      if ((m.kind !== 'ollama' && m.kind !== 'openai-compatible') || !m.endpoint) continue;
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.model_id})`;
      select.appendChild(opt);
    }
    select.value = cfg.cleanupModelId || '';
  } catch {
    /* leave the None option */
  }
}

/** Show/hide the pre-install pickers for the chosen backend. */
export function sttRenderBackendChoice(st: any) {
  document
    .querySelectorAll('#stt-backend-mode .setting-option')
    .forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.value === sttChosenBackend.value));
  const local = sttChosenBackend.value === 'local';
  $('#stt-model-group')!.hidden = !local || !st.installerPresent;
  $('#stt-install-btn')!.hidden = !local || !st.installerPresent;
  $('#stt-key-group')!.hidden = local;
  if (local) sttPopulateModelSelect(st);
}

export async function renderSelfTest() {
  const section = $('#settings-selftest');
  if (!section) return;
  let ok = false;
  try {
    ok = (await authFetch('/api/workspace-credential')).ok;
  } catch {
    ok = false;
  }
  section.hidden = !ok;
  if (!ok || selftestWired) return;
  selftestWired = true;
  const btn = $<HTMLElement>('#selftest-run-btn');
  const out = $<HTMLElement>('#selftest-results');

  function mountPreflight() {
    if (preflightApp) return;
    if (!out) return;
    preflightApp = createApp(Preflight, {
      onCopy: async (text: any) => {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          showToast('Copy failed — select the text manually.', { kind: 'error' });
          return false;
        }
      },
    });
    preflightApp.mount(out);
  }

  btn?.addEventListener('click', async () => {
    (btn as HTMLButtonElement)!.disabled = true;
    const orig = btn.textContent;
    btn!.textContent = 'Running…';
    out!.hidden = false;
    // The wait line, the error and the rows all landed in this one element by
    // three different routes; they are one island's phases now.
    preflightMessage.value = 'Running checks (this may spin a probe container)…';
    preflightPhase.value = 'running';
    mountPreflight();
    try {
      const res = await authFetch('/api/webchat/preflight');
      const data = await res.json();
      if (!res.ok) {
        preflightMessage.value = data.error || res.statusText;
        preflightPhase.value = 'message';
        return;
      }
      const checks = data.checks || [];
      if (!checks.length) {
        preflightMessage.value = 'No checks ran.';
        preflightPhase.value = 'message';
        return;
      }
      preflightChecks.value = checks.map((c: any) => ({
        status: c.status,
        head: `${PREFLIGHT_ICON[c.status] || '•'} ${c.label} — ${c.detail}`,
        fix: c.fix || '',
      }));
      preflightPhase.value = 'checks';
    } catch (err) {
      preflightMessage.value = String((err as any)?.message || err);
      preflightPhase.value = 'message';
    } finally {
      (btn as HTMLButtonElement)!.disabled = false;
      btn!.textContent = orig;
    }
  });
}

export function renderCredentialIsolation(feats: any) {
  const box = $('#settings-credential-isolation');
  if (!box) return;
  box.hidden = !feats.canEdit;
  if (!feats.canEdit) return;
  const toggle = $<HTMLInputElement>('#credential-isolation-toggle');
  toggle!.checked = feats.credentialIsolationEffective === true;
  const envNote = $<HTMLInputElement>('#credential-isolation-env');
  const following = feats.credentialIsolation === null || feats.credentialIsolation === undefined;
  envNote!.hidden = !following;
  if (following) envNote!.textContent = 'Following CREDENTIAL_ISOLATION in .env';
  if (toggle!.dataset.wired) return;
  toggle!.dataset.wired = '1';
  toggle!.addEventListener('change', async () => {
    const want = toggle!.checked;
    toggle!.disabled = true;
    try {
      const r = await authFetch('/api/webchat/features', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
        body: JSON.stringify({ credentialIsolation: want }),
      });
      if (!r.ok) throw new Error('save failed');
      envNote!.hidden = true;
      // Applied per spawn, so running agents keep their current scope until they
      // next start — say so rather than implying it took effect everywhere now.
      showToast(want ? 'Credential isolation on — applies as agents restart' : 'Credential isolation off');
    } catch {
      toggle!.checked = !want;
      showToast('Could not change credential isolation', { kind: 'error' });
    } finally {
      toggle!.disabled = false;
    }
  });
}

export function mountPrejudgeActions() {
  if (prejudgeApp) return;
  const host = $('#prejudge-actions-list');
  if (!host) return;
  prejudgeApp = createApp(PrejudgeActions, {
    onToggle: async (cb: any) => {
      // Disabled rows can never contribute — the never-list is enforced by the
      // selector, not by trusting the rendered checked state.
      const next = [...$('#prejudge-actions-list')!.querySelectorAll('input:not(:disabled):checked')].map(
        (el) => (el as HTMLElement).dataset.action,
      );
      try {
        await apiJson('/api/approvals/prejudge', { method: 'PUT', body: { actions: next } });
        showToast('Approval pre-judge saved', { kind: 'success' });
      } catch (err) {
        cb.checked = !cb.checked;
        showToast('Could not save: ' + ((err as any)?.message || err), { kind: 'error' });
      }
    },
  });
  prejudgeApp.mount(host);
}

export function renderPrejudgeActions(cfg: any) {
  const group = $('#prejudge-actions-group');
  if (!group || !$('#prejudge-actions-list')) return;
  group.hidden = !cfg.modelId;
  if (!cfg.modelId) return;
  const never = new Set(cfg.neverList?.actions || []);
  const opted = new Set(cfg.actions || []);
  // Everything a handler is registered for, plus the never-list (shown
  // disabled) and anything already opted in on an older install.
  const actions = [...new Set([...(cfg.knownActions || []), ...never, ...opted])].sort();
  prejudgeRows.value = actions.map((action) => ({
    action,
    // A never-listed action renders UNCHECKED even if it was opted in before
    // the list grew — the server would refuse it anyway.
    checked: opted.has(action) && !never.has(action),
    never: never.has(action),
  }));
  mountPrejudgeActions();
}

export function mountMyCredentials() {
  if (myCredsApp) return;
  const host = $('#my-credentials-list');
  if (!host) return;
  myCredsApp = createApp(MyCredentials, {
    onRemove: async (group: any, sec: any) => {
      await removeToolSecret({ agentGroupId: group.agentGroupId, userId: permsMyUserId.value }, sec, null);
      await renderMyCredentials();
    },
    onAdd: async (group: any, hostPattern: any, value: any, fields: any) => {
      if (!hostPattern || !value) {
        showToast('Host and value are required', { kind: 'error' });
        return;
      }
      const scope = { agentGroupId: group.agentGroupId, userId: permsMyUserId.value };
      myCredSaving.value = new Set(myCredSaving.value).add(group.agentGroupId);
      try {
        const r = await authFetch(toolSecretUrl(scope), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
          body: JSON.stringify({ hostPattern, value }),
        });
        if (!r.ok) {
          showToast((await r.json().catch(() => ({}))).error || 'Could not add secret', { kind: 'error' });
          return;
        }
        // Clear the uncontrolled fields directly, as before — the list
        // re-renders next, but these inputs are not keyed by their contents.
        for (const el of fields) el.value = '';
        showToast(`Added ${hostPattern}`);
        await renderMyCredentials();
      } catch {
        showToast('Could not add secret', { kind: 'error' });
      } finally {
        const next = new Set(myCredSaving.value);
        next.delete(group.agentGroupId);
        myCredSaving.value = next;
      }
    },
  });
  myCredsApp.mount(host);
}

export async function renderMyCredentials() {
  const section = $('#settings-my-credentials');
  if (!section) return;
  let groups = [];
  try {
    const r = await authFetch('/api/tool-secrets/mine');
    if (r.ok) groups = (await r.json()).groups || [];
  } catch {
    groups = [];
  }
  // Nothing to manage until you have connected credentials somewhere — show
  // nothing at all rather than an empty panel explaining itself.
  section.hidden = groups.length === 0;
  if (!groups.length) return;

  if (!$('#my-credentials-list')) return;
  myCredGroups.value = groups;
  mountMyCredentials();
}

// Module state that came across with the panels above.
let preflightApp: any = null;
let selftestWired = false;
const PREFLIGHT_ICON: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✕', info: '•' };
let prejudgeApp: any = null;
let myCredsApp: any = null;
