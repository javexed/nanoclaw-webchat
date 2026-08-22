// ── Setup wizard ─────────────────────────────────────────────────────────────
// The first-run flow: pick an engine, probe/pull a local model, choose how the
// console is reached from outside (Tailscale / Cloudflare / bearer token), and
// create the first agent. Also owns the wizard's slice of the settings panel.
//
// 42 functions, but only 8 are public — the rest are steps and helpers nothing
// outside the flow has any business calling. Keeping that boundary narrow is
// most of the value of pulling this out of legacy.js at all.
//
// DEPENDENCY INJECTION for the handful of legacy helpers this still reaches
// back to, same as features/thinking. legacy.js imports THIS module, so
// importing back would form a cycle through a module with top-level side
// effects. legacy calls provideWizardDeps() once at startup. These become
// ordinary imports as the remaining features come out.
import { $, lucide, lucideEl, esc } from '../core/dom.js';
import { applyMarketplaceNav } from './thinking.js';
import {
  cloudflaredInstallActive,
  codexInstallActive,
  opencodeGateFromServer,
  opencodeGatePoll,
  opencodeInstallActive,
  tailscaleInstallActive,
} from './installer-state.js';
import { state } from '../core/state.js';
import { createApp, nextTick } from 'vue';
import WizardOllamaModels from './WizardOllamaModels.vue';
import { wizardOllamaModels, wizardOllamaSelected } from './wizard-state.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson, setAuthToken } from '../core/api.js';
// Voice is already a module — these are ordinary imports, not injection.
import { getTtsReadAloudEnabled, setTtsReadAloudEnabled, stopTts } from './voice.js';
// Injected until phase 1e; now that installers is a module these are ordinary
// imports. Each extraction turns a slice of the injection back into real edges.
import {
  pollTtsInstall,
  runTtsInstall,
  runSttInstall,
  pollSttInstall,
  runCodexInstall,
  runOpencodeInstall,
  GROK_WIZARD_ELS,
} from './installers.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideWizardDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface WizardDeps {
  applyLearningMaster: () => any;
  closeSettings: () => any;
  fetchAgents: () => any;
  joinRoom: (roomId?: any, roomName?: any) => any;
  openOauthMintModal: (a0?: any) => any;
}

const deps = {} as WizardDeps;

/** Wire the legacy helpers this module calls. Call once, before the wizard opens. */
export function provideWizardDeps(provided: Partial<WizardDeps>): void {
  Object.assign(deps, provided);
}

// The default engine/login is set in the wizard now, not here. Admin-gated: the
// admin-only GET /api/workspace-credential 403s for non-admins, so the button
// only appears for those who can actually run setup.
let wizardBtnWired = false;

export async function renderSettingsWizardButton() {
  const wizardSection = $('#settings-wizard');
  if (!wizardSection) return;
  let ok = false;
  try {
    ok = (await authFetch('/api/workspace-credential')).ok;
  } catch {
    ok = false;
  }
  wizardSection.hidden = !ok;
  if (!ok || wizardBtnWired) return;
  wizardBtnWired = true;
  $('#wizard-open-btn')?.addEventListener('click', () => {
    deps.closeSettings();
    openWizard();
  });
}

const WIZARD_STEPS = 3;

let wizardStep = 0;

let wizardWired = false;

let wizardOllamaProbe: any = null; // last successful Ollama probe { kind, endpoint, models }

let wizardEngine = 'claude'; // default (fallback) engine chosen in step 0

let wizardCodexAvailable = false;

let wizardCred: any = null; // last /api/workspace-credential snapshot — gates step-0 Next

export async function renderWizardOpencodeInstall() {
  const row = $('#wizard-opencode-install-row');
  const hint = $('#wizard-opencode-hint');
  if (!row) return;
  const ollamaConnected = !($('#wizard-ollama-connected')?.hidden ?? true);
  if (!ollamaConnected) {
    row.hidden = true;
    if (hint) hint.hidden = true;
    return;
  }
  let installed = false;
  let running = false;
  try {
    const st = await (await authFetch('/api/opencode/install')).json();
    installed = !!st.installed;
    running = !!st.running;
  } catch {
    /* endpoint absent on an older host → just show the install button */
  }
  const badge = $('#wizard-opencode-installed-badge');
  const btn = $('#wizard-opencode-install')!;
  row.hidden = false;
  if (hint) hint.hidden = installed;
  if (badge) badge.hidden = !installed;
  if (btn && !opencodeInstallActive.value) btn.hidden = installed;
  // Gate Next/Finish from server truth so a page reload mid-install can't slip
  // past the client flag; re-poll while it's still running so the gate lifts on
  // its own once the install + restart settle.
  opencodeGateFromServer.value = running;
  refreshWizardNextGate();
  if (running) {
    clearTimeout(opencodeGatePoll.value ?? undefined);
    opencodeGatePoll.value = setTimeout(renderWizardOpencodeInstall, 3000);
  }
}

function buildWizardDots() {
  const dots = $('#wizard-dots');
  if (!dots) return;
  dots.innerHTML = '';
  for (let i = 0; i < WIZARD_STEPS; i++) {
    const d = document.createElement('span');
    d.className = 'wizard-dot';
    dots.appendChild(d);
  }
}

export async function refreshWizardCredState() {
  let s;
  try {
    const r = await authFetch('/api/workspace-credential');
    if (!r.ok) return;
    s = await r.json();
  } catch {
    return; // non-fatal — controls stay as-is
  }
  wizardCred = s;
  wizardCodexAvailable = !!s.codexAvailable;
  const credWord = (t?: any) => (t === 'oauth_token' ? 'subscription' : 'API key');

  // Every engine row carries an at-a-glance readiness chip in the same three
  // states — not connected / not installed → ✓ connected — so step 0 reads as
  // one mental model: pick an engine, finish its inline setup, Next unlocks.
  const claudeChip = $('#wizard-chip-claude');
  if (claudeChip) {
    claudeChip.hidden = false;
    claudeChip.textContent = s.connected ? '✓ connected' : 'not connected';
    claudeChip.classList.toggle('ok', !!s.connected);
  }
  $('#wizard-claude-connect')!.hidden = !!s.connected;
  $('#wizard-claude-connected')!.hidden = !s.connected;
  if (s.connected)
    $('#wizard-claude-connected-text')!.textContent = s.external
      ? 'Claude connected'
      : `Claude connected — ${credWord(s.credType)}`;
  // An externally-managed credential (OneCLI vault / setup) isn't the webchat's to
  // revoke — hide Disconnect so the card doesn't offer an action that can't run.
  $('#wizard-claude-disconnect')!.hidden = !!s.external;

  const codexChip = $('#wizard-chip-codex');
  if (codexChip) {
    codexChip.hidden = false;
    codexChip.textContent = s.codex?.connected
      ? '✓ connected'
      : wizardCodexAvailable
        ? 'not connected'
        : 'not installed';
    codexChip.classList.toggle('ok', !!s.codex?.connected);
  }
  // The Codex radio is always selectable (no dead-end grey): selecting it opens
  // this engine's body, which shows the one-click install first when the provider
  // isn't present, then the connect controls once it is. Next stays gated until
  // it reaches ✓ connected (wizardEngineConnected + the readiness line below).
  const codexInstallRow = $('#wizard-codex-install-row');
  if (codexInstallRow && !codexInstallActive.value) codexInstallRow.hidden = wizardCodexAvailable;
  $('#wizard-codex-connect')!.hidden = !wizardCodexAvailable || !!s.codex?.connected;
  $('#wizard-codex-connected')!.hidden = !s.codex?.connected;
  if (s.codex?.connected)
    $('#wizard-codex-connected-text')!.textContent = s.codex.external
      ? 'Codex connected'
      : `Codex connected — ${credWord(s.codex.credType)}`;
  const codexDisconnect = $('#wizard-codex-disconnect');
  if (codexDisconnect) codexDisconnect.hidden = !!s.codex?.external;

  // Grok's card is narrower than Claude's and Codex's by design: subscription
  // only, so there is no key path and no credWord() choice to report. Three
  // states like the others, plus a fourth the file-backed credential makes
  // possible — a login that EXISTS but has expired, which is a different fix
  // (re-run the login) from never having connected.
  const grokChip = $('#wizard-chip-grok');
  const grok = s.grok;
  if (grokChip) {
    grokChip.hidden = false;
    grokChip.textContent = grok?.connected
      ? '✓ connected'
      : !grok?.available
        ? 'not installed'
        : grok?.expired
          ? 'expired'
          : 'not connected';
    grokChip.classList.toggle('ok', !!grok?.connected);
  }
  // Mirrors Codex: offer the one-click install while the provider is absent, and
  // the connect controls only once it is present. `installed` comes from the same
  // status payload the chip reads, so the row disappears as soon as the install
  // chain finishes and the host comes back.
  // grokStatus() calls this field `available`, not `installed` — the
  // /api/workspace-credential/grok ROUTE adds an `installed` key, but the wizard
  // state does not go through that route. Reading the wrong key made this
  // `undefined !== false` -> true -> row hidden, so a clean install showed "not
  // installed" with no way to act on it. Default to NOT-installed when the field
  // is missing: a spurious install row is recoverable, a hidden one is a dead end.
  const grokInstalled = grok?.available === true;
  const grokInstallRow = $('#wizard-grok-install-row');
  if (grokInstallRow && !opencodeInstallActive.value) grokInstallRow.hidden = grokInstalled;
  $('#wizard-grok-connect')!.hidden = !grokInstalled || !!grok?.connected;
  $('#wizard-grok-connected')!.hidden = !grok?.connected;
  const grokStatusLine = $('#wizard-grok-status');
  if (grokStatusLine) {
    // Only the EXPIRED case gets prose. "Not installed" is already said by the
    // chip, and the other engines do not explain themselves proactively either —
    // acting on an uninstalled harness is what surfaces the reason, from the
    // server, at the moment it matters.
    const why = grok?.available && grok?.expired ? 'That Grok sign-in has expired. Sign in again to refresh it.' : '';
    grokStatusLine.textContent = why;
    grokStatusLine.hidden = !why;
  }
  if (grok?.connected)
    $('#wizard-grok-connected-text')!.textContent = grok.email
      ? `Grok connected — ${grok.email}`
      : 'Grok connected — subscription';

  // An Ollama model is the workspace default only when the default row's kind is
  // 'ollama' — authoritative, so the chip/card never claims "set" for a Claude/Codex
  // default. Same three-state idiom as Claude: no model → ✓ <model>, with a
  // Change action mirroring Disconnect.
  const ollamaSet = s.defaultModelKind === 'ollama' && !!s.defaultModelId;
  const ollamaModel = s.defaultModelModelId || s.defaultModelName;
  const ollamaChip = $('#wizard-chip-ollama');
  if (ollamaChip) {
    ollamaChip.hidden = false;
    ollamaChip.textContent = ollamaSet ? `✓ ${ollamaModel}` : 'no model';
    ollamaChip.classList.toggle('ok', ollamaSet);
  }
  const ollamaCard = $('#wizard-ollama-connected');
  const ollamaSetup = $('#wizard-ollama-setup');
  if (ollamaCard && ollamaSetup) {
    ollamaCard.hidden = !ollamaSet;
    ollamaSetup.hidden = ollamaSet;
    if (ollamaSet) $('#wizard-ollama-connected-text')!.textContent = `${ollamaModel} · default`;
  }
  // Once a local model is the default, offer the OpenCode harness (it follows small
  // models far better than the built-in one). Hidden again if Ollama isn't the default.
  void renderWizardOpencodeInstall();
}

async function wizardCheckLocalOllama() {
  try {
    const r = await authFetch('/api/ollama/local');
    if (!r.ok) return;
    const st = await r.json();
    if (st.reachable) {
      const url = $('#wizard-ollama-url') as HTMLInputElement;
      if (url && !(url as HTMLInputElement).value) (url as HTMLInputElement).value = 'http://localhost:11434';
      $('#wizard-ollama-install-row')!.hidden = true;
      $('#wizard-ollama-dl-row')!.hidden = false;
      void wizardLoadRecommendation();
      void wizardReattachPull(); // resume a pull that a page reload orphaned
    } else {
      $('#wizard-ollama-install-row')!.hidden = !st.canInstall;
    }
  } catch {
    /* leave defaults */
  }
}

// Follow a pull to completion: drive the progress bar + status, disable the
// download button while it runs, refresh the model radios on success. Shared
// by a fresh download and reattach-after-reload.
async function wizardFollowPull(host?: any, model?: any) {
  const btn = $('#wizard-ollama-dl')!;
  const bar = $('#wizard-ollama-pull-bar')!;
  const done = wizardBusy(btn, 'Downloading…');
  bar.hidden = false;
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const { pulls } = await (await authFetch('/api/ollama/pulls')).json();
      const job = (pulls || []).find((j: any) => j.model === model && j.host === host);
      if (!job) continue;
      const pct = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;
      (bar.querySelector('span') as HTMLElement | null)!.style.width = pct + '%';
      wizardSetStatus('#wizard-ollama-dl-status', `${job.detail || 'downloading…'} (${pct}%)`, null);
      if (job.status === 'success') {
        bar.hidden = true;
        wizardSetStatus('#wizard-ollama-dl-status', `${model} downloaded — setting it as the default…`, 'ok');
        // A pull is a deliberate "I want this model" — probe, then set it as the
        // workspace default so Next unlocks without a separate pick step.
        const probed = await wizardProbeOllama();
        if (probed && (probed.models || []).some((m: any) => String(m) === model)) {
          wizardOllamaSelected.value = model;
          await wizardSelectOllamaModel(model);
          wizardSetStatus('#wizard-ollama-dl-status', `${model} downloaded and set as the workspace default.`, 'ok');
        } else {
          wizardSetStatus('#wizard-ollama-dl-status', `${model} downloaded — pick it above to set the default.`, 'ok');
        }
        return;
      }
      if (job.status === 'error') {
        bar.hidden = true;
        return wizardSetStatus('#wizard-ollama-dl-status', job.error || 'Pull failed.', 'err');
      }
    }
  } finally {
    done();
  }
}

// Probe the Ollama endpoint and render one radio per model. No pre-selection:
// picking a radio IS choosing the workspace default (wizardSelectOllamaModel),
// so an unselected list reads honestly as "no default yet". Returns the probe
// body, or null on failure.
let wizardOllamaApp: any = null;

function mountWizardOllamaModels(): void {
  if (wizardOllamaApp) return;
  const host = $('#wizard-ollama-list');
  if (!host) return;
  wizardOllamaApp = createApp(WizardOllamaModels);
  wizardOllamaApp.mount(host);
}

async function wizardProbeOllama() {
  const url = ($<HTMLInputElement>('#wizard-ollama-url')?.value || '').trim() || 'http://localhost:11434';
  const btn = $('#wizard-ollama-probe')!;
  const done = wizardBusy(btn, 'Probing…');
  $('#wizard-ollama-status')!.hidden = true; // stale result out of the way while probing
  try {
    const r = await authFetch('/api/models/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      wizardSetStatus('#wizard-ollama-status', body.error || `Probe failed (${r.status}).`, 'err');
      return null;
    }
    if (!body.kind || !(body.models || []).length) {
      wizardSetStatus('#wizard-ollama-status', body.reason || 'No models found at that endpoint.', 'err');
      return null;
    }
    wizardOllamaProbe = body;
    wizardOllamaModels.value = body.models.map((m: any) => String(m));
    mountWizardOllamaModels();
    $('#wizard-ollama-results')!.hidden = false;
    $('#wizard-ollama-dl-row')!.hidden = false;
    void wizardLoadRecommendation();
    // SAY that it worked. This used to clear the status on success, on the
    // reasoning that the radios below speak for themselves — but the radio list
    // is the ONLY success feedback there was, and it renders ~450px down inside
    // a scrollable wizard body. On a short window it lands below the fold, so
    // the button un-busies and nothing visibly changes: reported as "I click
    // Probe and see no feedback that it found anything". Errors always had a
    // line here; success now does too.
    const n = wizardOllamaModels.value.length;
    wizardSetStatus('#wizard-ollama-status', `Found ${n} model${n === 1 ? '' : 's'} at ${body.endpoint || url}`, 'ok');
    // …and show them. nextTick first: the radios mount on the next render, and
    // scrolling before that measures an empty list.
    await nextTick();
    $('#wizard-ollama-results')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return body;
  } finally {
    done();
  }
}

// Register the chosen Ollama model and make it the WORKSPACE DEFAULT — the fallback
// every agent without its own model runs on. Called when a model radio is picked:
// selecting IS the action, no separate button. Reuses an existing roster row for
// the same endpoint+model so repeated selection never spawns duplicates (the
// roster has no uniqueness constraint). Other probed models stay unregistered —
// Manage → Models covers the rest.
export async function wizardSelectOllamaModel(modelId?: any) {
  if (!wizardOllamaProbe || !modelId) return;
  const endpoint = String(wizardOllamaProbe.endpoint || '').replace(/\/+$/, '');
  const host = (() => {
    try {
      return new URL(wizardOllamaProbe.endpoint).host;
    } catch {
      return wizardOllamaProbe.endpoint;
    }
  })();
  wizardSetStatus('#wizard-ollama-status', `Setting ${modelId} as the default…`, null);
  try {
    let id = null;
    try {
      const roster = await (await authFetch('/api/models')).json();
      id =
        (Array.isArray(roster) ? roster : []).find(
          (m) =>
            m.kind === 'ollama' && String(m.endpoint || '').replace(/\/+$/, '') === endpoint && m.model_id === modelId,
        )?.id ?? null;
    } catch {
      /* no roster read — fall through to create */
    }
    if (!id) {
      const r = await authFetch('/api/models/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          models: [
            {
              name: `${host} · ${modelId}`,
              kind: wizardOllamaProbe.kind,
              endpoint: wizardOllamaProbe.endpoint,
              model_id: modelId,
            },
          ],
        }),
      });
      const out = await r.json().catch(() => ({}));
      const created = out.created?.[0];
      if (!r.ok || !created) {
        wizardSetStatus('#wizard-ollama-status', out.error || out.failed?.[0]?.error || 'Add failed.', 'err');
        return;
      }
      id = created.id;
    }
    const dr = await authFetch('/api/workspace-model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: id }),
    });
    if (!dr.ok) {
      const derr = await dr.json().catch(() => ({}));
      wizardSetStatus('#wizard-ollama-status', 'Setting the default failed: ' + (derr.error || dr.statusText), 'err');
      return;
    }
    $('#wizard-ollama-status')!.hidden = true; // the ✓ connected card is the confirmation now
    await refreshWizardCredState(); // swaps the picker for the ✓ <model> · default card
  } catch {
    wizardSetStatus('#wizard-ollama-status', 'Setting the default failed.', 'err');
  }
}

// Clear the Ollama workspace default (mirror of wizardSelectOllamaModel) when the
// operator switches to Claude/Codex — otherwise unassigned claude-family agents
// keep inheriting the local model as their fallback and never run on the engine
// just chosen. No-op unless an Ollama default is actually set.
async function wizardClearOllamaDefault() {
  if (wizardCred?.defaultModelKind !== 'ollama' || !wizardCred?.defaultModelId) return;
  try {
    await authFetch('/api/workspace-model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: null }),
    });
    await refreshWizardCredState(); // reflects the cleared default in wizardCred + the cards
  } catch {
    /* non-fatal — the operator can still finish; the default just lingers */
  }
}

// Fetch a hardware-based model recommendation and prefill the download field.
// Deterministic server-side lookup (no model needed to recommend one). Only
// fills an empty field so it never clobbers what the operator typed.
let wizardRecLoaded = false;

async function wizardLoadRecommendation() {
  if (wizardRecLoaded) return;
  const hint = $('#wizard-ollama-rec');
  const input = $('#wizard-ollama-dl-model') as HTMLInputElement;
  try {
    const r = await authFetch('/api/ollama/recommend');
    if (!r.ok) return;
    const { recommendation: rec, remoteOllama } = await r.json();
    wizardRecLoaded = true;
    if (input && !(input as HTMLInputElement).value) (input as HTMLInputElement).value = rec.model.id;
    if (hint) {
      // Minimal line: model + one-word fit verdict. The full hardware profile
      // (cores / RAM / GPU) lives in the tooltip — no 'Detected:…' dump inline.
      // A remote Ollama in the roster means this host's RAM isn't the limit, so
      // a local "tight fit" isn't a warning — it runs on the remote box.
      const remote = remoteOllama?.present === true;
      const fit = remote ? 'remote Ollama' : rec.tight ? 'tight fit' : rec.basis === 'gpu' ? 'GPU' : 'good fit';
      hint.hidden = false;
      hint.textContent = `Recommended: ${rec.model.id} · ${fit}`;
      hint.title = remote ? `Runs on your remote Ollama (${remoteOllama.endpoint}). ${rec.detected}` : rec.detected;
      hint.classList.toggle('err', !remote && !!rec.tight);
    }
  } catch {
    // No recommendation — fall back to the field's own default on download.
    if (input && !(input as HTMLInputElement).value) (input as HTMLInputElement).value = 'qwen3:1.7b';
  }
}

// A model pull runs server-side and survives a page reload, but the client
// state that drove the progress bar doesn't. On panel open, adopt any pull
// still in flight for the current host and follow it to completion.
async function wizardReattachPull() {
  try {
    const host = ($<HTMLInputElement>('#wizard-ollama-url')?.value || '').trim() || 'http://localhost:11434';
    const { pulls } = await (await authFetch('/api/ollama/pulls')).json();
    const job = (pulls || []).find((j: any) => j.host === host && j.status === 'pulling');
    if (!job) return;
    $<HTMLInputElement>('#wizard-ollama-dl-model')!.value = job.model;
    await wizardFollowPull(host, job.model);
  } catch {
    /* nothing to reattach */
  }
}

function syncWizardEngineBodies() {
  document.querySelectorAll('.wizard-engine-body').forEach((b) => {
    (b as HTMLElement).hidden = (b as HTMLElement).dataset.engine !== wizardEngine;
  });
}

function wizardEngineConnected() {
  const s: any = wizardCred || {};
  if (wizardEngine === 'codex') return !!s.codex?.connected;
  if (wizardEngine === 'grok') return !!s.grok?.connected;
  if (wizardEngine === 'ollama') return !!s.defaultModelId;
  return !!s.connected; // claude (default)
}

function showWizardStep(i?: any) {
  wizardStep = Math.max(0, Math.min(WIZARD_STEPS - 1, i));
  document.querySelectorAll('.wizard-step').forEach((s) => {
    const step = s as HTMLElement;
    step.hidden = Number(step.dataset.step) !== wizardStep;
  });
  if (wizardStep === 0) syncWizardEngineBodies();
  if (wizardStep === 1) void renderWizardAccess();
  if (wizardStep === 2) void renderWizardFeatures();
  document.querySelectorAll('#wizard-dots .wizard-dot').forEach((d, idx) => {
    d.classList.toggle('active', idx === wizardStep);
    d.classList.toggle('done', idx < wizardStep);
  });
  $('#wizard-back')!.hidden = wizardStep === 0;
  const isLast = wizardStep === WIZARD_STEPS - 1;
  // Finish DOES the work (creates the first agent + room from the prefilled
  // fields); Skip closes without creating, for operators wiring agents their
  // own way.
  $('#wizard-next')!.textContent = isLast ? 'Finish' : 'Next';
  refreshWizardNextGate();
}

export function refreshWizardNextGate() {
  const btn = $('#wizard-next')! as HTMLInputElement;
  if (!btn) return;
  if (opencodeInstallActive.value || opencodeGateFromServer.value) {
    (btn as HTMLInputElement).disabled = true;
    btn.dataset.gated = '1';
    btn.textContent = 'Installing OpenCode…';
    btn.title = 'Hang tight — finishing now would interrupt your first message when the harness restarts.';
  } else if (btn.dataset.gated) {
    delete btn.dataset.gated;
    btn.disabled = false;
    btn.title = '';
    btn.textContent = wizardStep === WIZARD_STEPS - 1 ? 'Finish' : 'Next';
  }
}

async function openWizard() {
  wireWizard();
  buildWizardDots();
  showWizardStep(0);
  await refreshWizardCredState();
  $('#wizard-overlay')!.hidden = false;
}

function closeWizard() {
  $('#wizard-overlay')!.hidden = true;
}

async function finishWizard() {
  try {
    await authFetch('/api/webchat/onboarding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complete: true }),
    });
  } catch {
    /* best-effort — closing is more important than persisting the flag */
  }
  wizardStopTsPoll(); // don't keep polling health after the wizard is gone
  closeWizard();
}

export function wizardBusy(btn?: any, busyLabel?: any) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '';
  const spin = document.createElement('span');
  spin.className = 'btn-spinner';
  spin.setAttribute('aria-hidden', 'true');
  btn.appendChild(spin);
  btn.appendChild(document.createTextNode(busyLabel));
  return () => {
    btn.disabled = false;
    btn.textContent = original;
  };
}

function wizardSetStatus(id?: any, text?: any, kind?: any) {
  const el = $(id);
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('err', kind === 'err');
}

// Show the wizard's one-click Enable HTTPS only when tailscaled is up on the
// host and serve isn't already on — otherwise the how-to note (add Tailscale,
// then enable HTTPS in Settings later) is the right guidance.
async function wizardProbeHttps() {
  const row = $('#wizard-https-row');
  if (!row) return;
  let state = null;
  try {
    const r = await authFetch('/api/webchat/tailscale-https');
    if (r.ok) state = await r.json();
  } catch {
    state = null;
  }
  if (state && state.available && !state.active) {
    row.hidden = false;
    wizardSetStatus('#wizard-https-status', '', null);
    $('#wizard-https-status')!.hidden = true;
  } else if (state && state.active) {
    row.hidden = false;
    $('#wizard-https-btn')!.hidden = true;
    // Already-on is the state an operator lands in most often, and the URL is
    // the one thing they actually want from it — the enable path linked it and
    // this one did not, so the common case was the worse one.
    wizardSetStatus('#wizard-https-status', 'HTTPS is already on.', 'ok');
    if (state.url) {
      $('#wizard-https-status')!.innerHTML =
        `HTTPS is on — reach this at <a href="${esc(state.url)}" target="_blank" rel="noopener">${esc(state.url)}</a>`;
    }
  } else {
    row.hidden = true;
  }
}

async function wizardEnableHttps() {
  const btn = $('#wizard-https-btn')! as HTMLInputElement;
  (btn as HTMLInputElement).disabled = true;
  const restore = btn.textContent;
  btn.textContent = 'Enabling…';
  try {
    const r = await authFetch('/api/webchat/tailscale-https', { method: 'POST', headers: { 'X-Webchat-CSRF': '1' } });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) {
      btn.hidden = true;
      wizardSetStatus(
        '#wizard-https-status',
        data.url ? `HTTPS on — reach this at ${data.url}` : 'HTTPS enabled.',
        'ok',
      );
      // A URL the operator is meant to OPEN should be a link, not text to
      // retype. Same escape-then-innerHTML shape as the hintUrl branch below;
      // the host span is a .cred-hint, which is the only anchor theming in the
      // stylesheet, so it picks up --accent-strong + underline for free.
      if (data.url) {
        $('#wizard-https-status')!.innerHTML =
          `HTTPS on — reach this at <a href="${esc(data.url)}" target="_blank" rel="noopener">${esc(data.url)}</a>`;
      }
      showToast('HTTPS enabled over Tailscale', { kind: 'success' });
    } else {
      const msg = [data.error, data.hint].filter(Boolean).join(' ') || 'Could not enable HTTPS';
      wizardSetStatus('#wizard-https-status', msg, 'err');
      // Some failures are external prerequisites the operator must go fix — most
      // commonly "HTTPS certificates not enabled for your tailnet". Render the
      // admin-console link so the fix is one click, not a copy-paste hunt.
      if (data.hintUrl) {
        const el = $('#wizard-https-status')!;
        el.innerHTML = `${esc(msg)} <a href="${esc(data.hintUrl)}" target="_blank" rel="noopener">Open admin console</a>`;
      }
      showToast(data.error || 'Could not enable HTTPS', { kind: 'error', timeout: 9000 });
    }
  } catch {
    wizardSetStatus('#wizard-https-status', 'Connection failed.', 'err');
  } finally {
    btn.disabled = false;
    if (!btn.hidden) btn.textContent = restore;
  }
}

// Step 2 (Access): summarize how this instance is reached + secured, surface the
// one-click Tailscale HTTPS when available, and offer to retire the bootstrap
// bearer token once a stronger method (Tailscale/SSO) can authenticate. Owner-
// only endpoint — a 403 just leaves the neutral "owner-only" line.
// Show the body for the selected access radio (accordion, like step 0). When
// Tailscale is picked, probe for the one-click HTTPS affordance.
function syncWizardAccessBodies() {
  const sel =
    (document.querySelector('input[name="wizard-access"]:checked') as HTMLInputElement | null)?.value || 'bearer';
  document.querySelectorAll('.wizard-engine-body[data-access]').forEach((b) => {
    (b as HTMLElement).hidden = (b as HTMLElement).dataset.access !== sel;
  });
  if (sel === 'tailscale') void wizardProbeHttps();
  // Start/stop the "waiting for Tailscale" poll as the operator opens/leaves it.
  wizardStartTsPollIfNeeded();
}

let wizardTtsWired = false;

const WIZARD_TTS_ELS = { btn: '#wizard-tts-install', log: '#wizard-tts-log', progress: '#wizard-tts-progress' };

let wizardSttWired = false;

let wizardSttBackend = 'local';

const WIZARD_STT_ELS = { btn: '#wizard-stt-install', log: '#wizard-stt-log', progress: '#wizard-stt-log' };

async function renderWizardDictation() {
  const section = $('#wizard-stt-section');
  if (!section) return;
  let st = null;
  try {
    const r = await authFetch('/api/webchat/stt/install');
    if (r.ok) st = await r.json();
  } catch {
    st = null;
  }
  if (!st) {
    section.hidden = true; // non-owner or unavailable — no dictation surface
    return;
  }
  section.hidden = false;
  const enable = $('#wizard-stt-enable') as HTMLInputElement;
  if (enable) (enable as HTMLInputElement).checked = !!st.enabled;
  if (!wizardSttWired) {
    wizardSttWired = true;
    // Enable/disable toggle — the workspace WEBCHAT_STT_ENABLED, like Read Aloud.
    enable?.addEventListener('change', async () => {
      const on = (enable as HTMLInputElement).checked;
      const r = await authFetch('/api/stt/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: on }),
      });
      if (!r.ok) {
        enable.checked = !on;
        showToast('Could not update voice dictation', { kind: 'error' });
        return;
      }
      void renderWizardDictation();
    });
    document.querySelectorAll('#wizard-stt-backend input[type="radio"]').forEach((b) => {
      b.addEventListener('change', () => {
        if (!(b as HTMLInputElement).checked) return;
        wizardSttBackend = (b as HTMLInputElement).value;
        void renderWizardDictation();
      });
    });
    $('#wizard-stt-install')?.addEventListener('click', () =>
      runSttInstall({ provider: 'local' }, WIZARD_STT_ELS, renderWizardDictation),
    );
    $('#wizard-stt-connect')?.addEventListener('click', () => {
      const key = ($<HTMLInputElement>('#wizard-stt-key')?.value || '').trim();
      if (!key) {
        showToast('Enter the ElevenLabs API key first', { kind: 'error' });
        return;
      }
      runSttInstall({ provider: 'elevenlabs', apiKey: key }, WIZARD_STT_ELS, renderWizardDictation);
      $<HTMLInputElement>('#wizard-stt-key')!.value = '';
    });
  }
  // Backend setup only matters once dictation is on (mirrors Read Aloud → voice models).
  const group = $('#wizard-stt-group');
  if (group) group.hidden = !st.enabled;
  if (!st.enabled) return;
  const installed = !!st.installed;
  // Once installed, reflect the live backend; otherwise the operator's pick.
  const backend = installed ? st.provider || wizardSttBackend : wizardSttBackend;
  document.querySelectorAll('#wizard-stt-backend input[type="radio"]').forEach((b) => {
    (b as HTMLInputElement).checked = (b as HTMLInputElement).value === backend;
  });
  const local = backend === 'local';
  const badge = $('#wizard-stt-installed');
  if (badge) badge.hidden = !installed;
  // Provider-specific label: Local runs a model (installed), ElevenLabs is a key (connected).
  const badgeText = $('#wizard-stt-installed-text');
  if (badgeText) badgeText.textContent = local ? 'Whisper installed' : 'ElevenLabs connected';
  // Local + not installed + installer present → the install button; ElevenLabs +
  // not installed → the API-key row. Installed → just the badge.
  const installRow = $('#wizard-stt-install-row');
  if (installRow) installRow.hidden = installed || !local || !st.installerPresent;
  const keyRow = $('#wizard-stt-key-row');
  if (keyRow) keyRow.hidden = installed || local;
  if (st.running) pollSttInstall(WIZARD_STT_ELS, renderWizardDictation);
}

export async function renderWizardFeatures() {
  void renderWizardDictation(); // independent owner surface; renders alongside TTS
  const mkt = $('#wizard-marketplace') as HTMLInputElement;
  if (mkt) mkt.checked = state.marketplaceEnabled === true; // disabled by default — opt-in
  const ttsDefault = $('#wizard-tts-default') as HTMLInputElement;
  if (ttsDefault) (ttsDefault as HTMLInputElement).checked = getTtsReadAloudEnabled();
  if (!wizardTtsWired) {
    wizardTtsWired = true;
    ttsDefault?.addEventListener('change', async () => {
      // Workspace-level (owner-set) — the wizard is an owner surface.
      const on = (ttsDefault as HTMLInputElement).checked;
      try {
        const r = await authFetch('/api/tts/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ readAloud: on }),
        });
        if (!r.ok) throw new Error('save failed');
        setTtsReadAloudEnabled(on);
        if (!on) stopTts();
        renderWizardFeatures(); // reveal / hide the voice-model recommendation
      } catch {
        ttsDefault.checked = !on; // revert so the control never lies about saved state
        showToast('Failed to save Read aloud', { kind: 'error' });
      }
    });
    $('#wizard-tts-install')?.addEventListener('click', () => runTtsInstall(WIZARD_TTS_ELS));
    // Auto-learn — workspace master (owner surface). Instant, no install; toggling
    // The classifier auto-defaults to the agent's own model server-side (or the
    // busy-turn heuristic for Claude agents) — no picker here; override in Settings.
    $('#wizard-autolearn')?.addEventListener('change', async () => {
      const on = $<HTMLInputElement>('#wizard-autolearn')!.checked;
      try {
        const r = await authFetch('/api/learning/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: on }),
        });
        if (!r.ok) throw new Error('save failed');
        state.learningMasterEnabled = on;
        deps.applyLearningMaster();
      } catch {
        $<HTMLInputElement>('#wizard-autolearn')!.checked = !on;
        showToast('Failed to save auto-learn', { kind: 'error' });
      }
    });
  }
  // Reflect current state on (re)render.
  const alBox = $('#wizard-autolearn') as HTMLInputElement;
  if (alBox) alBox.checked = state.learningMasterEnabled;
  const row = $('#wizard-tts-install-row');
  const badge = $('#wizard-tts-installed');
  const progress = $('#wizard-tts-progress');
  const btn = $('#wizard-tts-install') as HTMLInputElement;
  const ttsOn = !!ttsDefault?.checked;
  let st = null;
  try {
    const res = await authFetch('/api/webchat/tts/install');
    if (res.ok) st = await res.json();
  } catch {
    st = null;
  }
  // The voice-model surface only matters once Read Aloud is on — off = device
  // voices, no model needed. Non-owner (no st) = no install surface either way.
  if (!st || !ttsOn) {
    if (row) row.hidden = true;
    if (badge) badge.hidden = true;
    if (progress) progress.hidden = !(st && st.running); // keep a live run visible
    if (st && st.running) pollTtsInstall(WIZARD_TTS_ELS);
    return;
  }
  if (st.installed) {
    if (row) row.hidden = true;
    if (badge) badge.hidden = false;
    if (progress) progress.hidden = !st.running;
    if (btn) btn.textContent = 'Install Kokoro…'; // clear any stale "Installing…"
    if (st.running) pollTtsInstall(WIZARD_TTS_ELS);
    return;
  }
  // Read Aloud on but no model yet → recommend the install.
  if (badge) badge.hidden = true;
  if (row) row.hidden = !st.installerPresent;
  if (st.running) {
    pollTtsInstall(WIZARD_TTS_ELS);
  } else if (btn) {
    btn.disabled = false;
    btn.textContent = 'Install Kokoro…';
  }
}

let wizardAuthInfo: any = null; // last /api/webchat/auth snapshot — gates the Access-step Next

// True once the selected exposure method is actually live: Tailscale signed in,
// or a reverse proxy configured. Bearer is the current method, always valid.
// Re-fetches auth so a just-completed sign-in / restart is picked up immediately.
async function wizardAccessReady() {
  const sel =
    (document.querySelector('input[name="wizard-access"]:checked') as HTMLInputElement | null)?.value || 'bearer';
  // Bearer (the bootstrap default) and Localhost (loopback, auto-owner) need
  // nothing configured to be usable — always ready to advance.
  if (sel === 'bearer' || sel === 'localhost') return true;
  let info = wizardAuthInfo;
  try {
    const r = await authFetch('/api/webchat/auth');
    if (r.ok) {
      info = await r.json();
      wizardAuthInfo = info;
    }
  } catch {
    /* keep the last snapshot */
  }
  if (sel === 'tailscale') return !!(info && info.tailscale && info.tailscale.healthy);
  if (sel === 'sso') return !!(info && info.proxy); // WEBCHAT_TRUSTED_PROXY_IPS configured
  return true;
}

async function runTailscaleInstall() {
  const btn = $('#wizard-ts-install-btn') as HTMLInputElement;
  const log = $('#wizard-ts-install-log')!;
  if (log) {
    log.hidden = false;
    log.textContent = 'Starting…';
  }
  if (btn) {
    (btn as HTMLInputElement).disabled = true;
    btn.textContent = 'Installing…';
  }
  try {
    const res = await authFetch('/api/webchat/tailscale/install', {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      if (log) log.textContent = err.error || 'Install failed to start.';
      showToast(err.error || 'Tailscale install failed', { kind: 'error', timeout: 9000 });
      if (btn) {
        (btn as HTMLInputElement).disabled = false;
        btn.textContent = 'Install Tailscale…';
      }
      return;
    }
    pollTailscaleInstall();
  } catch (err) {
    if (log) log.textContent = 'Install failed: ' + (err as any)?.message;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Install Tailscale…';
    }
  }
}

async function pollTailscaleInstall() {
  if (tailscaleInstallActive.value) return;
  tailscaleInstallActive.value = true;
  const btn = $('#wizard-ts-install-btn') as HTMLInputElement;
  const log = $('#wizard-ts-install-log')!;
  if (log) log.hidden = false;
  if (btn) (btn as HTMLInputElement).disabled = true;
  try {
    for (;;) {
      const st = await (await authFetch('/api/webchat/tailscale/install')).json();
      if (log) {
        log.textContent = (st.lines || []).slice(-14).join('\n') || 'Starting…';
        log.scrollTop = log.scrollHeight;
      }
      if (!st.running) {
        if (st.exitCode === 0) showToast('Tailscale is up — first tailnet sign-in becomes owner', { kind: 'success' });
        else showToast('Tailscale install/sign-in didn’t finish — see the log', { kind: 'error', timeout: 9000 });
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) {
    showToast('Tailscale install error: ' + (err as any)?.message, { kind: 'error' });
  } finally {
    tailscaleInstallActive.value = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Install Tailscale…';
    }
    void renderWizardAccess(); // re-check health → flip to the connected note when up
  }
}

// Cloudflare Tunnel in two explicit steps. Step 1 installs just the cloudflared
// binary (signed apt repo, no token). Step 2 takes the connector token from a
// managed tunnel and `service install`s it — auth is enforced by the tunnel's
// Access policy dashboard-side; the token is the only secret and never persists
// in the field once submitted.
async function runCloudflaredBinaryInstall() {
  const btn = $('#wizard-cf-install-btn');
  const log = $('#wizard-cf-install-log')!;
  if (log) {
    log.hidden = false;
    log.textContent = 'Starting…';
  }
  const done = btn ? wizardBusy(btn, 'Installing…') : null;
  try {
    const res = await authFetch('/api/webchat/cloudflared/install', {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      if (log) log.textContent = err.error || 'Install failed to start.';
      showToast(err.error || 'cloudflared install failed', { kind: 'error', timeout: 9000 });
      done?.();
      return;
    }
    done?.();
    pollCloudflared({ btn: '#wizard-cf-install-btn', success: 'cloudflared installed — paste your tunnel token' });
  } catch (err) {
    if (log) log.textContent = 'Install failed: ' + (err as any)?.message;
    done?.();
  }
}

async function runCloudflaredConnect() {
  const btn = $('#wizard-cf-connect-btn');
  const log = $('#wizard-cf-install-log')!;
  const tokenEl = $('#wizard-cf-token') as HTMLInputElement;
  const token = (tokenEl?.value || '').trim();
  if (!token) {
    showToast('Paste the tunnel token first', { kind: 'error' });
    return;
  }
  if (log) {
    log.hidden = false;
    log.textContent = 'Starting…';
  }
  const done = btn ? wizardBusy(btn, 'Connecting…') : null;
  try {
    const res = await authFetch('/api/webchat/cloudflared/connect', {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      if (log) log.textContent = err.error || 'Connect failed to start.';
      showToast(err.error || 'Cloudflare Tunnel connect failed', { kind: 'error', timeout: 9000 });
      done?.();
      return;
    }
    if (tokenEl) tokenEl.value = ''; // don't leave the secret sitting in the field
    done?.();
    pollCloudflared({ btn: '#wizard-cf-connect-btn', success: 'Cloudflare Tunnel connected' });
  } catch (err) {
    if (log) log.textContent = 'Connect failed: ' + (err as any)?.message;
    done?.();
  }
}

async function pollCloudflared({ btn: btnSel, success }: any) {
  if (cloudflaredInstallActive.value) return;
  cloudflaredInstallActive.value = true;
  const btn = btnSel ? $(btnSel) : null;
  const log = $('#wizard-cf-install-log')!;
  if (log) log.hidden = false;
  const done = btn ? wizardBusy(btn, 'Working…') : null;
  try {
    for (;;) {
      const st = await (await authFetch('/api/webchat/cloudflared')).json();
      if (log) {
        log.textContent = (st.lines || []).slice(-14).join('\n') || 'Starting…';
        log.scrollTop = log.scrollHeight;
      }
      if (!st.running) {
        if (st.exitCode === 0) showToast(success, { kind: 'success' });
        else showToast('cloudflared step didn’t finish — see the log', { kind: 'error', timeout: 9000 });
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) {
    showToast('cloudflared error: ' + (err as any)?.message, { kind: 'error' });
  } finally {
    cloudflaredInstallActive.value = false;
    done?.();
    void renderWizardAccess(); // re-check → advance to the next step / ready note
  }
}

let wizardAccessDefaulted = false;

// Set true once a bearer token is generated in the wizard. The token is written
// to .env immediately, but the host restart that ACTIVATES it is deferred to
// Finish (so the operator can copy the token first).
let wizardBearerPendingRestart = false;

// While the Tailscale option is open and not yet up, poll health so the panel
// flips from "not detected" to the signed-in/owner state on its own once the
// operator runs the install in their terminal — no manual refresh needed.
let wizardTsPoll: any = null;

function wizardStopTsPoll() {
  if (wizardTsPoll) {
    clearInterval(wizardTsPoll);
    wizardTsPoll = null;
  }
}

function wizardStartTsPollIfNeeded() {
  const sel = (document.querySelector('input[name="wizard-access"]:checked') as HTMLInputElement | null)?.value;
  const healthy = !!(wizardAuthInfo && wizardAuthInfo.tailscale && wizardAuthInfo.tailscale.healthy);
  if (sel !== 'tailscale' || healthy) {
    wizardStopTsPoll();
    return;
  }
  if (wizardTsPoll) return; // already polling
  wizardTsPoll = setInterval(async () => {
    try {
      const r = await authFetch('/api/webchat/auth');
      if (!r.ok) return;
      const info = await r.json();
      if (info && info.tailscale && info.tailscale.healthy) {
        wizardStopTsPoll();
        void renderWizardAccess(); // repaint into the up/owner state
      }
    } catch {
      /* transient — keep polling */
    }
  }, 4000);
}

async function renderWizardAccess() {
  const stateEl = $('#wizard-access-state');
  let info = null;
  try {
    const r = await authFetch('/api/webchat/auth');
    if (r.ok) info = await r.json();
  } catch {
    info = null;
  }
  wizardAuthInfo = info;
  // tsHealthy = a tailnet is UP on this host (detection — drives the "✓ up"
  // chip and the install offer). tsAuthActive = tailscale is actually ENABLED
  // as an auth method here. They differ: a host can run Tailscale without it
  // guarding webchat. "Network auth in play" must use tsAuthActive, or a plain
  // localhost install on a Tailscale host mislabels itself as not-loopback.
  const tsHealthy = !!(info && info.tailscale && info.tailscale.healthy);
  const tsAuthActive = !!(info && info.tailscale && info.tailscale.enabled && info.tailscale.healthy);
  const proxyOn = !!(info && info.proxy);
  const bearerOn = !!(info && info.bearerActive);
  // "Localhost only" = bound to loopback with no network auth in play.
  const localhostOnly = !!(info && info.loopback) && !bearerOn && !tsAuthActive && !proxyOn;

  // Per-method chip: active/available at a glance (mirrors step 0).
  const chip = (id?: any, text?: any, ok?: any) => {
    const el = $(id);
    if (!el) return;
    el.hidden = !info;
    el.textContent = text;
    el.classList.toggle('ok', ok);
  };
  chip('#wizard-access-localhost-chip', localhostOnly ? 'active' : 'off', localhostOnly);
  chip('#wizard-access-bearer-chip', bearerOn ? 'active' : 'off', bearerOn);
  chip('#wizard-access-ts-chip', tsHealthy ? '✓ up' : 'not detected', tsHealthy);
  chip('#wizard-access-sso-chip', proxyOn ? '✓ active' : 'not configured', proxyOn);

  // First render of the Access step: preselect the mode that's actually live.
  // Loopback with no network auth → Localhost only; otherwise leave the bootstrap
  // Bearer default. Done once so it never fights a manual pick on re-render.
  if (!wizardAccessDefaulted && info) {
    wizardAccessDefaulted = true;
    if (localhostOnly) {
      const r = document.querySelector('input[name="wizard-access"][value="localhost"]') as HTMLInputElement;
      if (r) r.checked = true;
    }
  }

  // Tailscale body: when it's up there is nothing to say — the chip already
  // reports that. Otherwise offer a one-click install when the host can bring it
  // up (TUN + root), else the helper link.
  const tsHelper = $('#wizard-ts-helper');
  const tsRow = $('#wizard-ts-install-row');
  const tsManual = $('#wizard-ts-manual');
  if (tsHealthy) {
    if (tsHelper) tsHelper.hidden = true;
    if (tsRow) tsRow.hidden = true;
    if (tsManual) tsManual.hidden = true;
  } else {
    let ts = null;
    try {
      const r = await authFetch('/api/webchat/tailscale/install');
      if (r.ok) ts = await r.json();
    } catch {
      ts = null;
    }
    const canInstall = !!(ts && ts.canInstall);
    const tunPresent = !!(ts && ts.tunPresent);
    const isRoot = !!(ts && ts.isRoot);
    // Three distinct "not connected" states, so we never show Proxmox guidance
    // to a plain desktop: (a) TUN+root → one-click install button; (b) TUN but
    // not root (normal non-root host) → run-in-terminal commands; (c) no TUN
    // (unprivileged LXC / restricted container) → the host-side helper.
    if (tsRow) tsRow.hidden = !canInstall;
    if (tsManual) tsManual.hidden = !(!canInstall && tunPresent && !isRoot);
    if (tsHelper) tsHelper.hidden = !(!canInstall && !tunPresent);
    if (canInstall && ts.running) pollTailscaleInstall();
  }

  // Cloudflare Tunnel body: connector service registered → ready note; else offer
  // the token install when we can run it here (Linux + root), otherwise the helper.
  let cf = null;
  try {
    const r = await authFetch('/api/webchat/cloudflared');
    if (r.ok) cf = await r.json();
  } catch {
    cf = null;
  }
  const cfService = !!(cf && cf.serviceInstalled); // connector running
  const cfBinary = !!(cf && cf.installed); // cloudflared present
  const cfCanInstall = !!(cf && cf.canInstall);
  chip('#wizard-access-cf-chip', cfService ? '✓ running' : cfBinary ? 'installed' : 'not set up', cfService);
  const cfReady = $('#wizard-cf-ready');
  if (cfReady) cfReady.hidden = !cfService;
  const cfHelper = $('#wizard-cf-helper');
  if (cfHelper) cfHelper.hidden = cfService || cfCanInstall; // link only when we can't install here
  // Step 1 (install binary) → step 2 (paste token + connect) → ready note.
  const cfInstallRow = $('#wizard-cf-install-row');
  if (cfInstallRow) cfInstallRow.hidden = cfService || !cfCanInstall || cfBinary;
  const cfConnect = $('#wizard-cf-connect');
  if (cfConnect) cfConnect.hidden = cfService || !cfCanInstall || !cfBinary;
  if (cfCanInstall && cf.running) pollCloudflared({ btn: null, success: 'cloudflared step complete' });

  // Retire the bearer only when it's safe: an alternative can authenticate AND
  // this session didn't arrive over the bearer token (canDisableBearer).
  const retireRow = $('#wizard-retire-row');
  if (retireRow) retireRow.hidden = !(info && info.canDisableBearer);
  // No token configured → show the Generate button (writes WEBCHAT_TOKEN + binds
  // 0.0.0.0, then restarts at Finish). Once a token exists it hides and the
  // retire row shows instead.
  const bearerUnset = !!(info && !info.bearerConfigured);
  const bearerGenRow = $('#wizard-bearer-gen-row');
  // Keep the generate row hidden once a token's been generated this session
  // (the result panel is showing instead).
  if (bearerGenRow && !wizardBearerPendingRestart) bearerGenRow.hidden = !bearerUnset;

  if (stateEl) {
    if (!info) {
      // Not prose but a reason: it explains why the controls below are absent.
      stateEl.textContent = 'Access settings are available to the owner.';
      stateEl.hidden = false;
    } else {
      const methods = [];
      if (tsAuthActive) methods.push('Tailscale identity');
      if (proxyOn) methods.push('reverse-proxy SSO');
      if (bearerOn) methods.push('a bearer token');
      // Nothing configured is the DEFAULT, not a status worth narrating — and
      // the methods on offer are the controls directly beneath this line. It
      // used to read "Loopback-only — no network auth configured."; the line
      // now appears only when there is something to report.
      stateEl.textContent = methods.length ? `Secured by ${methods.join(' + ')}.` : '';
      stateEl.hidden = !methods.length;
    }
  }
  syncWizardAccessBodies();
}

async function wizardRetireBearer() {
  const btn = $('#wizard-retire-btn');
  const done = wizardBusy(btn, 'Retiring…');
  try {
    const r = await authFetch('/api/webchat/auth/bearer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ active: false }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      showToast('Bearer token retired — access is via Tailscale/SSO', { kind: 'success' });
      await renderWizardAccess(); // refresh the state line + hide the button
    } else {
      wizardSetStatus('#wizard-retire-status', data.error || 'Could not retire the token', 'err');
    }
  } catch {
    wizardSetStatus('#wizard-retire-status', 'Connection failed.', 'err');
  } finally {
    done();
  }
}

// Generate a bearer token (server writes WEBCHAT_TOKEN + binds 0.0.0.0) and show
// it to copy. The restart that activates it is deferred to Finish.
async function wizardGenerateBearer() {
  const btn = $('#wizard-bearer-gen');
  const done = wizardBusy(btn, 'Generating…');
  try {
    const r = await authFetch('/api/webchat/auth/bearer/generate', {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.token) {
      showToast(data.error || 'Could not generate a token', { kind: 'error', timeout: 8000 });
      return;
    }
    // Adopt the token immediately AND persist it, so the client keeps
    // authenticating across the restart-at-Finish. Enabling the bearer token
    // disables the loopback auto-owner bypass; without this the reloaded page
    // sends no token and 401s on everything (a self-inflicted lockout).
    setAuthToken(data.token);
    sessionStorage.setItem('nanoclaw-token', data.token);
    const field = $('#wizard-bearer-token') as HTMLInputElement;
    if (field) field.value = data.token;
    if ($('#wizard-bearer-result')) $('#wizard-bearer-result')!.hidden = false;
    if ($('#wizard-bearer-gen-row')) $('#wizard-bearer-gen-row')!.hidden = true;
    wizardBearerPendingRestart = true;
  } catch {
    showToast('Connection failed.', { kind: 'error' });
  } finally {
    done();
  }
}

// Copy the generated token — clipboard API, with a select+execCommand fallback
// for non-secure contexts where navigator.clipboard is unavailable.
async function wizardCopyBearerToken() {
  const field = $('#wizard-bearer-token');
  const value = (field as HTMLInputElement | null)?.value || '';
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast('Token copied', { kind: 'success' });
  } catch {
    (field as HTMLInputElement | null)?.select();
    try {
      document.execCommand('copy');
      showToast('Token copied', { kind: 'success' });
    } catch {
      showToast('Copy failed — select the token and copy manually', { kind: 'error' });
    }
  }
}

// Copy an element's value (input) or text (pre/span), with the same
// clipboard-plus-fallback pattern as the token copy.
async function wizardCopyText(selector?: any, okMsg?: any) {
  const el = $(selector);
  const text = String((el && 'value' in el ? (el as any).value : (el as any)?.textContent) || '').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg || 'Copied', { kind: 'success' });
  } catch {
    (el as HTMLInputElement | null)?.select?.();
    showToast('Copy failed — select and copy manually', { kind: 'error' });
  }
}

// Fire the deferred host restart at Finish and monitor it: a blocking overlay
// with a spinner, then poll the pre-auth /health until the server drops and
// returns, then reload — which lands on the login screen (a token is now
// required), so the operator is actually prompted for the token they saved.
async function wizardTriggerRestart() {
  const overlay = $('#restart-overlay');
  const titleEl = $('#restart-title');
  const statusEl = $('#restart-status');
  const reloadBtn = $('#restart-reload-btn');
  const setStatus = (t?: any) => {
    if (statusEl) statusEl.textContent = t;
  };
  if (overlay) overlay.hidden = false;
  reloadBtn?.addEventListener('click', () => location.reload(), { once: true });

  // Snapshot the current process uptime BEFORE restarting — the new process
  // reports a lower uptime, which detects the restart even when it's fast enough
  // that /health never appears to drop between polls.
  const readUptime = async () => {
    try {
      const r = await fetch('/health', { cache: 'no-store' });
      if (!r.ok) return null;
      const b = await r.json();
      return typeof b.uptime === 'number' ? b.uptime : null;
    } catch {
      return null; // unreachable (restart in flight)
    }
  };
  const baseUptime = (await readUptime()) ?? Infinity;

  // Fire the restart (fire-and-forget — the socket may drop mid-response).
  try {
    await authFetch('/api/webchat/restart', { method: 'POST', headers: { 'X-Webchat-CSRF': '1' } });
  } catch {
    /* expected as the host goes down */
  }

  // Poll until the server reports a fresh (lower) uptime — i.e., it restarted.
  const started = Date.now();
  const DEADLINE_MS = 90_000;
  while (Date.now() - started < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 1500));
    const up = await readUptime();
    if (up !== null && up < baseUptime) {
      setStatus('Back online — reloading…');
      await new Promise((r) => setTimeout(r, 700));
      location.reload();
      return;
    }
    setStatus('Restarting the server…');
  }
  // Never came back in time — let the operator reload by hand.
  if (titleEl) titleEl.textContent = 'Still restarting…';
  setStatus('This is taking longer than usual. Reload once you can reach the server.');
  if (reloadBtn) reloadBtn.hidden = false;
}

function wireWizard() {
  if (wizardWired) return;
  wizardWired = true;
  wireGrokLogin();
  // A login started before this page loaded (another tab, or a reload mid-flow)
  // is still running server-side — pick it back up rather than stranding it.
  void resumeGrokLogin();
  $('#wizard-next')?.addEventListener('click', async () => {
    // The Access step won't advance until the chosen exposure method is actually
    // live — Tailscale signed in, or a reverse proxy configured. Bearer (the
    // current method) is always valid; Skip bypasses. Detected by the step's own
    // radios, so it holds wherever the Access step sits in the order.
    const onAccessStep = !!document.querySelector(
      `.wizard-step[data-step="${wizardStep}"] input[name="wizard-access"]`,
    );
    if (onAccessStep && !(await wizardAccessReady())) {
      const sel = (document.querySelector('input[name="wizard-access"]:checked') as HTMLInputElement | null)?.value;
      showToast(
        sel === 'tailscale'
          ? 'Connect Tailscale first — sign in over your tailnet (install it above if needed), then continue.'
          : 'Configure the reverse proxy first — set WEBCHAT_TRUSTED_PROXY_IPS and restart, then continue.',
        { kind: 'info', timeout: 8000 },
      );
      return;
    }
    if (wizardStep === WIZARD_STEPS - 1) {
      wizardCreateAndFinish();
      return;
    }
    // Step 0 can't advance until the chosen engine is actually connected — a
    // selected-but-unconnected engine would leave the first agent unable to reply.
    // The row's own chip + connect controls say what's needed; a brief toast is
    // the only nudge on a blocked click (Skip bypasses, for operators wiring their
    // credentials their own way).
    if (wizardStep === 0 && !wizardEngineConnected()) {
      const how =
        wizardEngine === 'ollama'
          ? 'set a default Ollama model'
          : wizardEngine === 'grok'
            ? 'authenticate Grok from a terminal (the command is on the card), then reload'
            : wizardEngine === 'codex' && !wizardCodexAvailable
              ? 'install then connect Codex'
              : `connect ${wizardEngine === 'codex' ? 'Codex' : 'Claude'}`;
      showToast(`Finish this engine first — ${how} above.`, { kind: 'info', timeout: 6000 });
      return;
    }
    showWizardStep(wizardStep + 1);
  });
  $('#wizard-back')?.addEventListener('click', () => showWizardStep(wizardStep - 1));
  $('#wizard-skip')?.addEventListener('click', () => {
    if (wizardStep === WIZARD_STEPS - 1)
      finishWizard(); // skip = close without creating
    else showWizardStep(wizardStep + 1);
  });
  $('#wizard-close')?.addEventListener('click', () => finishWizard());

  // Step 2 (Access) — one radio per method; selecting one opens its body (and,
  // for Tailscale, surfaces one-click HTTPS when tailscaled is up).
  document.querySelectorAll('input[name="wizard-access"]').forEach((radio) => {
    radio.addEventListener('change', () => syncWizardAccessBodies());
  });
  $('#wizard-https-btn')?.addEventListener('click', () => wizardEnableHttps());
  $('#wizard-ts-install-btn')?.addEventListener('click', () => runTailscaleInstall());
  $('#wizard-cf-install-btn')?.addEventListener('click', () => runCloudflaredBinaryInstall());
  $('#wizard-cf-connect-btn')?.addEventListener('click', () => runCloudflaredConnect());
  $('#wizard-retire-btn')?.addEventListener('click', () => wizardRetireBearer());
  $('#wizard-bearer-gen')?.addEventListener('click', () => wizardGenerateBearer());
  $('#wizard-bearer-copy')?.addEventListener('click', () => wizardCopyBearerToken());
  $('#wizard-ts-manual-copy')?.addEventListener('click', () => wizardCopyText('#wizard-ts-manual-cmd', 'Copied'));

  // Step 0 — default engine radios. Every engine (incl. an uninstalled Codex) is
  // selectable: picking it opens its body, whose progressive controls (install →
  // connect → ✓) carry the operator to "connected". Next stays gated on that state
  // (wizardEngineConnected) and the readiness line narrates what's still needed.
  document.querySelectorAll('input[name="wizard-engine"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      wizardEngine = (radio as HTMLInputElement).value;
      syncWizardEngineBodies();
      if (wizardEngine === 'ollama') {
        void wizardCheckLocalOllama();
      } else {
        // Switching to a non-Ollama engine: drop any Ollama workspace default,
        // or claude-family agents keep falling back to that local model (running
        // on it, not the engine you just picked). Mirror of picking an Ollama
        // model, which SETS the default. Only fires when one is actually set.
        void wizardClearOllamaDefault();
      }
    });
  });

  // Step 1 (claude panel) — browser mint for subscriptions, or paste either
  // credential shape (auto-detected).
  $('#wizard-claude-oauth')?.addEventListener('click', () => deps.openOauthMintModal('workspace'));
  $('#wizard-codex-install')?.addEventListener('click', () => runCodexInstall());
  $('#wizard-grok-install')?.addEventListener('click', () => runOpencodeInstall(GROK_WIZARD_ELS));
  $('#wizard-codex-oauth')?.addEventListener('click', () => deps.openOauthMintModal('workspace-codex'));
  // Step 1 (codex panel) — paste an OpenAI API key as the workspace Codex default.
  $('#wizard-codex-save')?.addEventListener('click', async () => {
    const key = ($<HTMLInputElement>('#wizard-codex-key')?.value || '').trim();
    if (!/^sk-/.test(key)) return wizardSetStatus('#wizard-codex-status', 'Expected an OpenAI API key (sk-…).', 'err');
    const btn = $('#wizard-codex-save');
    const done = wizardBusy(btn, 'Saving…');
    try {
      const r = await authFetch('/api/workspace-credential', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'codex', type: 'api_key', apiKey: key }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return wizardSetStatus('#wizard-codex-status', out.error || 'Save failed.', 'err');
      $<HTMLInputElement>('#wizard-codex-key')!.value = '';
      await refreshWizardCredState(); // controls swap to the ✓ connected card
    } finally {
      done(); // restores label + disabled state
    }
  });
  $('#wizard-claude-save')?.addEventListener('click', async () => {
    const key = ($<HTMLInputElement>('#wizard-claude-key')?.value || '').trim();
    if (!/^sk-ant-/.test(key))
      return wizardSetStatus(
        '#wizard-claude-status',
        'Expected an Anthropic API key (sk-ant-…) or setup token (sk-ant-oat…).',
        'err',
      );
    const isOauth = /^sk-ant-oat/.test(key);
    const btn = $('#wizard-claude-save');
    const done = wizardBusy(btn, 'Saving…');
    try {
      const r = await authFetch('/api/workspace-credential', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isOauth ? { type: 'oauth_token', token: key } : { type: 'api_key', apiKey: key }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return wizardSetStatus('#wizard-claude-status', out.error || 'Save failed.', 'err');
      $<HTMLInputElement>('#wizard-claude-key')!.value = '';
      await refreshWizardCredState(); // controls swap to the ✓ connected card
    } finally {
      done();
    }
  });
  $('#wizard-claude-disconnect')?.addEventListener('click', async () => {
    const r = await authFetch('/api/workspace-credential', { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Failed to disconnect: ' + (err.error || r.statusText), { kind: 'error' });
      return;
    }
    await refreshWizardCredState();
  });
  $('#wizard-codex-disconnect')?.addEventListener('click', async () => {
    const r = await authFetch('/api/workspace-credential?provider=codex', { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Failed to disconnect: ' + (err.error || r.statusText), { kind: 'error' });
      return;
    }
    await refreshWizardCredState();
  });

  // Step 1 — Ollama probe; selecting a model radio sets it as the workspace
  // default (wizardSelectOllamaModel), so there's no separate "set default" step.
  $('#wizard-ollama-probe')?.addEventListener('click', () => void wizardProbeOllama());
  $('#wizard-ollama-list')?.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | null;
    if (t && t.name === 'wizard-ollama-model' && t.value) {
      // Keep the ref in step with the DOM the user just changed, or the next
      // render would reset the radio the click had selected.
      wizardOllamaSelected.value = t.value;
      void wizardSelectOllamaModel(t.value);
    }
  });
  // "Change" on the connected card reopens the picker (mirrors Disconnect).
  $('#wizard-ollama-change')?.addEventListener('click', () => {
    $('#wizard-ollama-connected')!.hidden = true;
    $('#wizard-ollama-setup')!.hidden = false;
  });

  // Ollama panel: one-click rootless install when nothing answers locally.
  $('#wizard-ollama-install')?.addEventListener('click', async () => {
    const btn = $('#wizard-ollama-install');
    const done = wizardBusy(btn, 'Installing…');
    const log = $('#wizard-ollama-install-log')!;
    log.hidden = false;
    log.textContent = 'Starting…';
    try {
      const r = await authFetch('/api/ollama/install', { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        // An install already in flight (e.g. after a reconnect) → follow it, don't
        // restart. The server dedupes, and the download resumes on its own.
        if (err.error !== 'already-running') {
          log.textContent = err.error || 'Install failed to start.';
          return;
        }
        log.textContent = 'Resuming the install already in progress…';
      }
      // Poll until the installer exits; the state carries its log tail.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const st = await (await authFetch('/api/ollama/local')).json();
        log.textContent = (st.lines || []).join('\n') || 'Working…';
        log.scrollTop = log.scrollHeight;
        if (!st.running) {
          if (st.exitCode === 0 && st.reachable) {
            $('#wizard-ollama-install-row')!.hidden = true;
            $<HTMLInputElement>('#wizard-ollama-url')!.value = 'http://localhost:11434';
            wizardSetStatus('#wizard-ollama-status', 'Ollama installed and running — download a model below.', 'ok');
            $('#wizard-ollama-dl-row')!.hidden = false;
            void wizardLoadRecommendation();
          } else {
            wizardSetStatus('#wizard-ollama-status', 'Install failed — see the log above.', 'err');
          }
          return;
        }
      }
    } finally {
      done();
    }
  });

  // Ollama panel: pull a model onto the probed host, with live progress.
  $('#wizard-ollama-dl')?.addEventListener('click', async () => {
    const model = ($<HTMLInputElement>('#wizard-ollama-dl-model')?.value || '').trim() || 'qwen3:1.7b';
    const host = ($<HTMLInputElement>('#wizard-ollama-url')?.value || '').trim() || 'http://localhost:11434';
    const r = await authFetch('/api/ollama/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, model }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return wizardSetStatus('#wizard-ollama-dl-status', err.error || 'Pull failed to start.', 'err');
    }
    await wizardFollowPull(host, model);
  });
}

// Finish = create the first agent + room from the (prefilled, editable) fields,
// wired to the chosen engine, then close into the chat. Codex rides the
// room-create body (provider pinned before first spawn); Claude/Ollama inherit
// the workspace defaults. Failure keeps the wizard open with the error inline.
async function wizardCreateAndFinish() {
  const roomName = ($<HTMLInputElement>('#wizard-room-name')?.value || '').trim() || 'General';
  const agentName = ($<HTMLInputElement>('#wizard-agent-name')?.value || '').trim() || 'Assistant';
  // Belt-and-suspenders: if the operator finishes on a non-Ollama engine, make
  // sure no stale Ollama default lingers (covers the case where Claude was the
  // pre-selected radio, so the engine `change` handler never fired to clear it).
  if (wizardEngine !== 'ollama') await wizardClearOllamaDefault();
  // Persist the MCP + skills marketplace choice (default on / recommended).
  const mktEnabled = $<HTMLInputElement>('#wizard-marketplace')?.checked !== false;
  try {
    await authFetch('/api/webchat/features', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ marketplaceEnabled: mktEnabled }),
    });
    state.marketplaceEnabled = mktEnabled;
    applyMarketplaceNav();
  } catch {
    /* non-fatal — defaults to on */
  }
  // Arm the one-shot "first Tailscale login becomes owner" if the operator opted
  // in — so their real (tailnet) identity gets owner, not just the bearer boot id.
  try {
    await authFetch('/api/webchat/tailscale-owner', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({
        armed:
          (document.querySelector('input[name="wizard-access"]:checked') as HTMLInputElement | null)?.value ===
          'tailscale',
      }),
    });
  } catch {
    /* non-fatal */
  }
  const btn = $('#wizard-next');
  const done = wizardBusy(btn, 'Creating…');
  {
    try {
      const agentRef: Record<string, unknown> = { kind: 'new', name: agentName };
      // Pin whichever non-default harness the operator chose. Ollama is not a
      // provider — it is a workspace default MODEL, handled above — so only the
      // real harnesses appear here. Codex-only was the bug: choosing Grok
      // authenticated it and then created an agent on the default harness.
      if (wizardEngine === 'codex' || wizardEngine === 'grok') agentRef.provider = wizardEngine;
      const r = await authFetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName, agents: [agentRef] }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) {
        // A room with this name already exists (409) — the operator is re-running
        // the wizard on an install that's already set up. That's not a failure to
        // dead-end on: the room+agent they'd create are effectively already there,
        // so just finish instead of blocking them behind an error they can't
        // resolve from this step.
        if (r.status === 409) {
          wizardSetStatus('#wizard-room-status', 'Already set up — finishing…', 'ok');
          await finishWizard();
          if (wizardBearerPendingRestart) await wizardTriggerRestart();
          return;
        }
        return wizardSetStatus('#wizard-room-status', out.error || 'Create failed.', 'err');
      }
      // No per-agent model assignment here: an Ollama engine is the WORKSPACE
      // default (set when the models were added), so the new agent — like every
      // unassigned agent — inherits it automatically.
      // JOIN WHAT WE CREATED. The WS echo only reaches clients whose tracked
      // room matches the broadcast's (`c.room_id === roomId` in state.ts), so a
      // client that never joined gets the unread signal instead of the message.
      // (Review note: this hunk and the provider default below originally landed
      // in wizardSelectOllamaModel — a wrong-anchor patch apply against a shape
      // both functions share — where neither condition could ever be true.)
      if (out?.room?.id) deps.joinRoom(out.room.id, out.room.name);
      wizardSetStatus('#wizard-room-status', 'Created. Finishing…', 'ok');
      await finishWizard();
      // A bearer token generated earlier is written but inert until the host
      // reloads .env — fire that restart now, after onboarding is marked done.
      if (wizardBearerPendingRestart) await wizardTriggerRestart();
      if (typeof deps.fetchAgents === 'function') deps.fetchAgents().catch(() => {});
      // Make the chosen engine the install's default for agents created LATER,
      // by any path — the per-agent pin above only covers the one this step
      // creates. Ollama is excluded: it is a workspace default MODEL, and the
      // harness is derived from it elsewhere. Best-effort, and deliberately
      // LAST: a changed default schedules a host restart on a short fuse, so
      // everything the wizard still needed to do has already happened.
      if (wizardEngine === 'claude' || wizardEngine === 'codex' || wizardEngine === 'grok') {
        try {
          await authFetch('/api/workspace-provider', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
            body: JSON.stringify({ provider: wizardEngine }),
          });
        } catch {
          /* the agent just created is still pinned correctly */
        }
      }
    } finally {
      done();
    }
  }
}

// Auto-open the wizard once on first login for owner/global-admin when onboarding
// isn't finished. Non-admins get {complete:true} from the endpoint, so this no-ops.
export async function maybeAutoOpenWizard() {
  try {
    const r = await authFetch('/api/webchat/onboarding');
    if (!r.ok) return;
    const s = await r.json();
    if (s.canEdit && !s.complete) openWizard();
  } catch {
    /* non-fatal — the wizard is always reachable from Settings */
  }
}

// ── Grok device login ────────────────────────────────────────────────────────
// The only wizard flow that finishes somewhere else: the operator confirms a
// code on another device, so this polls rather than awaits. Server-side state
// means closing the tab does not strand the login — reopening the wizard picks
// the same flow back up, and the container behind it is reaped on expiry.
let grokPollTimer: ReturnType<typeof setInterval> | null = null;

function stopGrokPoll() {
  if (grokPollTimer) clearInterval(grokPollTimer);
  grokPollTimer = null;
}

function renderGrokLogin(p: any) {
  const device = $('#wizard-grok-device');
  const row = $('#wizard-grok-login-row');
  const status = $('#wizard-grok-status');
  if (!device || !row) return;

  device.hidden = !p?.running;
  row.hidden = !!p?.running;

  if (p?.running) {
    const url = $('#wizard-grok-url') as HTMLAnchorElement | null;
    if (url && p.verificationUrl) {
      url.textContent = p.verificationUrl;
      url.href = p.verificationUrl;
    }
    // Until the CLI has printed them, say so rather than showing an empty box.
    $('#wizard-grok-code')!.textContent = p.userCode ?? 'waiting for a code…';
  }

  // A finished flow reports its own outcome; anything but success is worth
  // saying out loud, since the operator was watching another device for it.
  if (status && p && !p.running && p.outcome && p.outcome !== 'complete') {
    status.textContent = p.error ?? 'The login did not complete.';
    status.hidden = false;
  }
}

async function pollGrokLogin() {
  const r = await authFetch('/api/workspace-credential/grok');
  if (!r.ok) return stopGrokPoll();
  const p = await r.json();
  renderGrokLogin(p);
  if (!p.running) {
    stopGrokPoll();
    // Success flips the card to connected via the shared status path, so the
    // one source of truth for "is Grok connected" stays the credential probe.
    if (p.outcome === 'complete') await refreshWizardCredState();
  }
}

function startGrokPoll() {
  stopGrokPoll();
  void pollGrokLogin();
  grokPollTimer = setInterval(() => void pollGrokLogin(), 2000);
}

function wireGrokLogin() {
  $('#wizard-grok-login')?.addEventListener('click', async () => {
    const btn = $('#wizard-grok-login') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    const status = $('#wizard-grok-status');
    if (status) status.hidden = true;
    try {
      const r = await authFetch('/api/workspace-credential/grok/start', { method: 'POST' });
      const p = await r.json();
      if (!r.ok) {
        if (status) {
          status.textContent = p?.error ?? 'Could not start the login.';
          status.hidden = false;
        }
        return;
      }
      renderGrokLogin(p);
      startGrokPoll();
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $('#wizard-grok-cancel')?.addEventListener('click', async () => {
    await authFetch('/api/workspace-credential/grok/cancel', { method: 'POST' });
    stopGrokPoll();
    void pollGrokLogin();
  });
}

/** Resume a login that was started before this page loaded (or in another tab). */
async function resumeGrokLogin() {
  try {
    const r = await authFetch('/api/workspace-credential/grok');
    if (!r.ok) return;
    const p = await r.json();
    if (p.running) {
      renderGrokLogin(p);
      startGrokPoll();
    }
  } catch {
    /* status is best-effort; the card still renders from the credential probe */
  }
}
