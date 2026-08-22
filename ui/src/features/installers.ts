// ── Installers ───────────────────────────────────────────────────────────────
// Every "install a thing and watch it happen" flow: the coding-agent CLIs
// (Codex, OpenCode), the speech stacks (TTS, STT), the routing/LiteLLM stack,
// and local model pulls. Each is the same shape — kick off a job, poll it,
// render progress into a set of elements — which is why they belong together
// even though the wizard and the settings panel both surface them.
//
// The *_ELS constants are the element maps each flow renders into, moved here
// with their runners. OPENCODE_WIZARD_ELS deliberately stays in legacy: it is
// read by code outside this set too.
//
// Injection, as in features/wizard: the install-active flags live in legacy and
// are ASSIGNED here, so they arrive as getter/setter pairs. A getter alone
// would compile and silently drop the write, leaving the re-entrancy guards
// permanently unlatched.
import { $, lucide, lucideEl, esc } from '../core/dom.js';
import { codexInstallActive, ollamaPullPoller, opencodeInstallActive, routingInstallActive, sttInstallActive, ttsInstallActive } from './installer-state.js';
import { mmFmtGB } from './models.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
// Voice is a module and does NOT import this one, so these are safe as direct
// imports. The five wizard entry points these runners also call are injected
// instead: wizard.js imports THIS module, so importing it back would form a
// cycle. legacy wires them in provideInstallerDeps from its own wizard import.
import { loadTtsConfig, initSttFeature } from './voice.js';
import { hostPulls, hostPullPreview } from './ollama-cards-state.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideInstallerDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface InstallerDeps {
  fetchAgents: () => any;
  fetchModels: () => any;
  loadOllamaHostModels: (a0?: any) => any;
  probeRoutingAvailability: () => any;
  refreshWizardCredState: () => any;
  refreshWizardNextGate: () => any;
  renderCredentialsSettings: () => any;
  renderRoutingSetup: () => any;
  renderSttSetupSettings: () => any;
  renderTtsSetupSettings: () => any;
  renderWizardFeatures: () => any;
  renderWizardOpencodeInstall: () => any;
  wizardBusy: (a0?: any, a1?: any) => any;
}

const deps = {} as InstallerDeps;

/** Wire the legacy helpers these runners call. Call once at startup. */
export function provideInstallerDeps(provided: Partial<InstallerDeps>): void {
  Object.assign(deps, provided);
}

const CODEX_WIZARD_ELS: Record<string, string> = {
  btn: '#wizard-codex-install',
  log: '#wizard-codex-install-log',
  doneMsg: 'Codex loaded — connect your credentials below.',
};

// One-click Codex provider install from the wizard engine step OR Settings →
// User credentials. Unlike Ollama/LiteLLM, this mutates the source tree, rebuilds
// the agent image (minutes), and then RESTARTS the host — codexAvailable only
// flips once the process re-imports the provider barrel. So the poll rides through
// the restart: the connection drops, recovers, and by then `installed` is true.
export async function runCodexInstall(els = CODEX_WIZARD_ELS) {
  const btn = $(els.btn)!;
  const log = $(els.log)!;
  if (!btn || codexInstallActive.value) return;
  codexInstallActive.value = true;
  const progress = els.progress ? $(els.progress) : null;
  if (progress) progress.hidden = false;
  log.hidden = false;
  log.textContent = 'Installing…';
  let done = deps.wizardBusy(btn, 'Installing…');
  const finish = () => {
    log.textContent = els.doneMsg || 'Codex installed.';
    showToast('Codex installed', { kind: 'success' });
  };
  try {
    const res = await authFetch('/api/codex/install', { method: 'POST' });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      log.textContent = 'Install failed: ' + (err.error || res.status);
      showToast(err.error || 'Codex install failed', { kind: 'error' });
      return;
    }
    // Phase 1 — build. Poll until the host fires its restart (green build → exit
    // 0, not running), the build fails, or the connection drops (host going down).
    let restarting = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      let st;
      try {
        st = await (await authFetch('/api/codex/install')).json();
      } catch {
        restarting = true; // host went down — the restart is underway
        break;
      }
      if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-14).join('\n');
      if (st.installed) {
        finish();
        return;
      }
      if (!st.running && st.exitCode === 0) {
        restarting = true; // chain green → restart just fired
        break;
      }
      // Non-zero exit, no restart → build failed; tree is unchanged-but-partial.
      if (!st.running && st.exitCode != null && st.exitCode !== 0) {
        log.textContent = 'Install failed — see log:\n' + (st.lines || []).slice(-14).join('\n');
        showToast('Codex install failed — see log', { kind: 'error' });
        return;
      }
    }
    // Phase 2 — restart probe. The host is restarting to load the provider barrel;
    // `installed` only flips once it re-imports at boot. Probe until it answers,
    // or give up after the deadline and point at a manual restart (no infinite spin).
    if (restarting) {
      done();
      done = deps.wizardBusy(btn, 'Restarting…');
      log.textContent = 'Restarting…';
      const deadline = Date.now() + 150000;
      let sawResponsive = false;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        let st = null;
        try {
          st = await (await authFetch('/api/codex/install')).json();
          sawResponsive = true; // host is answering again
        } catch {
          st = null; // still down — keep probing
        }
        if (st?.installed) {
          finish();
          return;
        }
        if (Date.now() > deadline) {
          // Two distinct end states: the host answered again but Codex still isn't
          // registered → the restart didn't reload the provider (the auto-restart
          // likely didn't take); a manual service restart fixes it. Never answered
          // → it's still down. Both resolve with a restart, but say which happened.
          log.textContent = sawResponsive
            ? 'Codex didn’t load — restart the service, then reopen setup.'
            : 'Server didn’t come back — restart it, then reopen setup.';
          showToast('Codex built — restart the server to finish', { kind: 'error' });
          return;
        }
      }
    }
  } catch (err: any) {
    log.textContent = 'Install error: ' + err.message;
    showToast('Codex install error', { kind: 'error' });
  } finally {
    done();
    codexInstallActive.value = false;
    // Re-render BOTH surfaces so whichever the operator is viewing flips
    // Installing… → Installed (the active-guard means only one runner exists).
    deps.refreshWizardCredState(); // wizard: installed → show connect controls
    deps.renderCredentialsSettings(); // settings: installed → hide Install, enable pill
  }
}

// One-click OpenCode stack install (wizard Ollama step or Settings). Same two-phase
// build→restart shape as runCodexInstall: the chain mutates the tree, rebuilds the
// agent image (minutes), restarts the host; opencodeAvailable only flips once the
// process re-imports the provider barrel, so the poll rides through the restart.
// Moved here in phase 1i. It was left in legacy in 1e on the reasoning that
// legacy also read it — but this file's default parameter referenced it, so
// runOpencodeInstall() with no argument threw ReferenceError. Unreachable in
// practice (all three call sites pass one), and found only once check:refs
// was widened to compile legacy.js alongside the modules.
export const OPENCODE_WIZARD_ELS: Record<string, string> = {
  btn: '#wizard-opencode-install',
  log: '#wizard-opencode-install-log',
  doneMsg: 'OpenCode installed — your local agent can now use it (Agent → Harness).',
};

export const GROK_WIZARD_ELS = {
  btn: '#wizard-grok-install',
  log: '#wizard-grok-install-log',
  url: '/api/grok/install',
  name: 'Grok',
  doneMsg: 'Grok installed — sign in with a device code below.',
} as Record<string, string>;

export async function runOpencodeInstall(els = OPENCODE_WIZARD_ELS) {
  // Shared harness-install runner: els.url + els.name parameterize it for any
  // stack with the same GET/POST install contract (OpenCode, pi).
  const url = els.url || '/api/opencode/install';
  const name = els.name || 'OpenCode';
  const btn = $(els.btn)!;
  const log = $(els.log)!;
  if (!btn || opencodeInstallActive.value) return;
  opencodeInstallActive.value = true;
  deps.refreshWizardNextGate(); // hold Next/Finish for the duration of the install
  const progress = els.progress ? $(els.progress) : null;
  if (progress) progress.hidden = false;
  log.hidden = false;
  log.textContent = 'Installing…';
  let done = deps.wizardBusy(btn, 'Installing…');
  const finish = () => {
    log.textContent = els.doneMsg || name + ' installed.';
    showToast(name + ' installed', { kind: 'success' });
    // Re-render the card. Without this the install BUTTON stays on screen after a
    // successful install: the row's visibility is computed from wizard state that
    // was fetched before the provider existed, and the chain restarts the host, so
    // nothing re-reads it. The operator is left looking at "Install X" for a
    // provider that is already installed, with the control they actually need —
    // authenticate — still hidden behind the same stale flag.
    void deps.refreshWizardCredState?.();
  };
  try {
    const res = await authFetch(url, { method: 'POST' });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      // Already installed isn't a failure — it's the desired end state. Reflect it
      // (badge + re-render) instead of a scary "Install failed" line.
      if (err.code === 'already-installed') {
        finish();
        return;
      }
      log.textContent = 'Install failed: ' + (err.error || res.status);
      showToast(err.error || name + ' install failed', { kind: 'error' });
      return;
    }
    // Phase 1 — build. Poll until the host fires its restart (green build → exit 0,
    // not running), the build fails, or the connection drops (host going down).
    let restarting = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      let st;
      try {
        st = await (await authFetch(url)).json();
      } catch {
        restarting = true; // host went down — the restart is underway
        break;
      }
      if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-14).join('\n');
      if (st.installed) {
        finish();
        return;
      }
      if (!st.running && st.exitCode === 0) {
        restarting = true;
        break;
      }
      if (!st.running && st.exitCode != null && st.exitCode !== 0) {
        log.textContent = 'Install failed — see log:\n' + (st.lines || []).slice(-14).join('\n');
        showToast(name + ' install failed — see log', { kind: 'error' });
        return;
      }
    }
    // Phase 2 — restart probe. installed only flips once the host re-imports the
    // provider barrel at boot. Probe until it answers, or give up after the deadline.
    if (restarting) {
      done();
      done = deps.wizardBusy(btn, 'Restarting…');
      log.textContent = 'Restarting…';
      const deadline = Date.now() + 150000;
      let sawResponsive = false;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        let st = null;
        try {
          st = await (await authFetch(url)).json();
          sawResponsive = true;
        } catch {
          st = null;
        }
        if (st?.installed) {
          finish();
          return;
        }
        if (Date.now() > deadline) {
          log.textContent = sawResponsive
            ? 'OpenCode didn’t load — restart the service, then reopen setup.'
            : 'Server didn’t come back — restart it, then reopen setup.';
          showToast(name + ' built — restart the server to finish', { kind: 'error' });
          return;
        }
      }
    }
  } catch (err: any) {
    log.textContent = 'Install error: ' + err.message;
    showToast(name + ' install error', { kind: 'error' });
  } finally {
    done();
    opencodeInstallActive.value = false;
    deps.refreshWizardNextGate(); // install settled → release Next/Finish
    deps.renderWizardOpencodeInstall(); // wizard: installed → badge
    deps.renderCredentialsSettings(); // settings: installed → hide Install, show ✓ badge
    deps.fetchAgents(); // an agent's Harness can now be set to OpenCode
  }
}

// TTS install DOM sets — the Settings → Features section and the wizard's Features
// step drive the SAME server install (/api/webchat/tts/install); each passes its
// own element ids + a re-render callback so one poll loop serves both surfaces.
const TTS_SETTINGS_ELS: Record<string, string> = { btn: '#tts-install-btn', log: '#tts-install-log', progress: '#tts-install-progress' };

/** One speech-stack install poll. */
export interface PollSpec {
  /** element ids for the button, log pane and progress bar */
  els: Record<string, string>;
  /** status endpoint, polled until `running` goes false */
  endpoint: string;
  isActive: () => boolean;
  setActive: (v: boolean) => void;
  /** shown on exitCode 0, then `onSuccess` runs */
  successMsg: string;
  failMsg: string;
  errPrefix: string;
  onSuccess?: () => Promise<void> | void;
  /** always runs in `finally`, after the active flag is cleared */
  onFinally?: () => void;
}

/**
 * The shared install-poll loop.
 *
 * pollTtsInstall and pollSttInstall were the same 30 lines twice, differing in
 * four values: the endpoint, which active-flag accessors to use, the two toast
 * strings, and what to re-render afterwards. The duplication was not harmless —
 * the TTS copy re-renders BOTH its surfaces (settings and wizard) because the
 * shared active-guard means only one poll runs and it cannot rely on a single
 * caller re-rendering; the STT copy does not, and it is not obvious from either
 * one alone whether that is a deliberate difference or a missed edit.
 *
 * Making the difference a parameter answers that question in the call site.
 */
async function pollInstall(spec: PollSpec): Promise<void> {
  if (spec.isActive()) return;
  spec.setActive(true);
  const btn = $<HTMLInputElement>(spec.els.btn);
  const log = $(spec.els.log);
  const progress = $(spec.els.progress);
  if (progress) progress.hidden = false;
  if (btn) btn.disabled = true;
  try {
    for (;;) {
      const st = await (await authFetch(spec.endpoint)).json();
      if (log) {
        log.textContent = (st.lines || []).slice(-12).join('\n') || 'Starting…';
        log.scrollTop = log.scrollHeight;
      }
      if (!st.running) {
        if (st.exitCode === 0) {
          showToast(spec.successMsg, { kind: 'success' });
          if (spec.onSuccess) await spec.onSuccess();
        } else {
          showToast(spec.failMsg, { kind: 'error' });
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err: any) {
    showToast(spec.errPrefix + (err as any)?.message, { kind: 'error' });
  } finally {
    spec.setActive(false);
    if (spec.onFinally) spec.onFinally();
  }
}

export async function pollTtsInstall(els = TTS_SETTINGS_ELS) {
  await pollInstall({
    els,
    endpoint: '/api/webchat/tts/install',
    isActive: () => ttsInstallActive.value,
    setActive: (v) => (ttsInstallActive.value = v),
    successMsg: 'Read aloud installed — Kokoro voices are live',
    failMsg: 'Read aloud install failed — see log',
    errPrefix: 'Read aloud install error: ',
    onSuccess: () => loadTtsConfig(), // pick up server-side synthesis immediately
    onFinally: () => {
      // Re-render BOTH TTS surfaces (Settings + wizard) so whichever the
      // operator is viewing flips Installing… → Installed. The shared
      // active-guard means only one poll runs, so it cannot rely on a single
      // caller's re-render. STT deliberately does not do this — it has one
      // surface — which is only visible now that the difference is a parameter.
      deps.renderTtsSetupSettings();
      deps.renderWizardFeatures();
    },
  });
}

export async function runTtsInstall(els = TTS_SETTINGS_ELS) {
  const btn = $(els.btn)!;
  const log = $(els.log)!;
  const progress = $(els.progress);
  if (progress) progress.hidden = false;
  const done = btn ? deps.wizardBusy(btn, 'Installing…') : null; // spinner, like the step-0 installs
  if (log) log.textContent = 'Starting…';
  try {
    const res = await authFetch('/api/webchat/tts/install', { method: 'POST' });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      if (log) log.textContent = 'Install failed: ' + (err.error || res.status);
      showToast('Read aloud install failed', { kind: 'error' });
      done?.();
      return;
    }
    pollTtsInstall(els); // completion re-renders the surface, clearing the spinner
  } catch (err: any) {
    if (log) log.textContent = 'Install failed: ' + err.message;
    done?.();
  }
}

// STT install DOM sets — Settings → Features and the wizard's Features step drive
// the SAME /api/webchat/stt/install, each passing its own element ids so one
// install/poll path serves both surfaces (mirrors the TTS pattern).
const STT_SETTINGS_ELS: Record<string, string> = { btn: '#stt-install-btn', log: '#stt-install-log', progress: '#stt-install-progress' };

export async function pollSttInstall(els = STT_SETTINGS_ELS, onDone?: any) {
  await pollInstall({
    els,
    endpoint: '/api/webchat/stt/install',
    isActive: () => sttInstallActive.value,
    setActive: (v) => (sttInstallActive.value = v),
    successMsg: 'Voice dictation installed — the mic is live',
    failMsg: 'Voice dictation install failed — see log',
    errPrefix: 'Voice dictation install error: ',
    onSuccess: () => initSttFeature(), // reveal the composer mic immediately
    onFinally: () => {
      deps.renderSttSetupSettings();
      if (onDone) onDone();
    },
  });
}

export async function runSttInstall(payload?: any, els = STT_SETTINGS_ELS, onDone?: any) {
  const btn = $(els.btn)!;
  const log = $(els.log)!;
  const progress = $(els.progress);
  if (progress) progress.hidden = false;
  const done = btn ? deps.wizardBusy(btn, 'Installing…') : null; // spinner, like the step-0 installs
  if (log) log.textContent = 'Starting…';
  try {
    const res = await authFetch('/api/webchat/stt/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      if (log) log.textContent = 'Install failed: ' + (err.error || res.status);
      showToast('Voice dictation install failed', { kind: 'error' });
      done?.();
      return;
    }
    pollSttInstall(els, onDone); // completion re-renders the surface, clearing the spinner
  } catch (err: any) {
    if (log) log.textContent = 'Install failed: ' + err.message;
    done?.();
  }
}

// Element ids for the routing-install progress surfaces. Settings and the wizard
// each own a copy of the same three nodes; the install/poll logic is shared and
// just targets whichever set it's handed.
const ROUTING_ELS_SETTINGS: Record<string, string> = { log: '#routing-install-log', bar: '#routing-pull-bar', label: '#routing-pull-label' };

/**
 * The current step, read out of the installer's own output.
 *
 * Both install scripts share a marker vocabulary: `→ ` opens a step, `✓` and
 * `✗` close one, `= ` is an aside. So the most recent line carrying one of
 * those glyphs IS the current step — no parsing beyond a prefix match, and it
 * degrades to '' rather than guessing when the output is something else.
 *
 * Deliberately NOT a percentage. The long pole in phase 1 is the docker image
 * pull, whose only signal is per-layer byte counts from several concurrent
 * layers, in a format that shifts between docker versions. A single number
 * synthesised from that would be a guess wearing the costume of a measurement;
 * the log underneath already shows the real bytes.
 */
export function installStepLabel(lines?: unknown): string {
  if (!Array.isArray(lines)) return '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] ?? '').trim();
    // Keep ✓/✗ verbatim — the glyph is the status. Strip the arrow from a step.
    if (line.startsWith('✓') || line.startsWith('✗')) return line;
    if (line.startsWith('→')) return line.slice(1).trim();
  }
  return '';
}

export function renderRoutingInstallProgress(st?: any, els = ROUTING_ELS_SETTINGS) {
  const log = $(els.log)!;
  const bar = $(els.bar)!;
  const label = $(els.label)!;
  log.textContent = (st.lines || []).slice(-12).join('\n') || 'Starting…';
  log.scrollTop = log.scrollHeight;
  const pull = st.pull;
  if (pull) {
    bar.hidden = false;
    label.hidden = false;
    const pct = pull.total > 0 ? Math.min(100, Math.round((100 * pull.completed) / pull.total)) : 0;
    (bar.querySelector('span') as HTMLElement | null)!.style.width = pct + '%';
    if (pull.status === 'pulling') label.textContent = 'Classifier model: ' + (pull.detail || 'downloading…') + ' (' + pct + '%)';
    else if (pull.status === 'success') label.textContent = 'Classifier model ready.';
    else label.textContent = 'Classifier model pull failed: ' + (pull.error || '');
  } else {
    // No model pull in flight — so no honest percentage exists. Show WHICH STEP
    // is running instead of nothing: before this, the bar and label both hid
    // and the only feedback for the whole LiteLLM phase (the slowest part of a
    // first install) was a scrolling log tail.
    bar.hidden = true;
    const step = installStepLabel(st.lines);
    label.hidden = !step;
    if (step) label.textContent = step;
  }
}

// Poll until the install chain finishes (Routing tab appears then) AND the model
// pull is no longer downloading (so the progress bar reaches completion).
export async function pollRoutingInstall() {
  if (routingInstallActive.value) return;
  routingInstallActive.value = true;
  const btn = ($('#routing-install-btn')!) as HTMLInputElement;
  $('#routing-install-progress')!.hidden = false;
  btn.disabled = true;
  let chainHandled = false;
  try {
    while (true) {
      const st = await (await authFetch('/api/router/install')).json();
      renderRoutingInstallProgress(st);
      if (!st.running && !chainHandled) {
        chainHandled = true;
        if (st.exitCode === 0) {
          // Installing routing means using it — flip it live (the server registers
          // the selectable 'auto' model on this PUT) instead of leaving it in
          // shadow behind a separate toggle.
          try {
            await authFetch('/api/router/routes', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ live: { enabled: true } }),
            });
          } catch {
            /* non-fatal — routing still installed; the roster refresh below shows state */
          }
          await deps.fetchModels(); // pick up the freshly-registered 'auto' model
          showToast('Auto routing installed and live — assign the “auto” model to an agent.', { kind: 'success' });
          await deps.probeRoutingAvailability(); // un-hides the Auto routing tab + menu item
        } else {
          showToast('Auto routing setup failed — see log', { kind: 'error' });
          break;
        }
      }
      const pullDone = !st.pull || st.pull.status !== 'pulling';
      if (!st.running && pullDone) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err: any) {
    showToast('Auto routing setup error: ' + err.message, { kind: 'error' });
  } finally {
    routingInstallActive.value = false;
    deps.renderRoutingSetup(); // reflect installed state / re-enable
  }
}

// Phase-1 helper: install the LiteLLM router (routing's prerequisite) and
// stream its log into the shared routing-install box, resolving true on
// success. Automates what used to require running /add-litellm in a shell, so
// the one-click Install flow no longer dead-ends on the missing prerequisite.
async function installLitellmPhase(els: Record<string, string> = ROUTING_ELS_SETTINGS) {
  const log = $(els.log)!;
  const label = $(els.label)!;
  // This phase has no `pull`, so renderRoutingInstallProgress's bar path never
  // applies — but the step label does, and it is the only at-a-glance signal
  // available while docker pulls the image. Driven here rather than by calling
  // that function, because the two phases poll different endpoints.
  const setStep = (text: string) => {
    label.hidden = !text;
    if (text) label.textContent = text;
  };
  log.textContent = 'Installing the LiteLLM router…';
  setStep('Installing the LiteLLM router…');
  let res;
  try {
    res = await authFetch('/api/router/litellm-install', { method: 'POST' });
  } catch (err: any) {
    log.textContent = 'LiteLLM install failed: ' + err.message;
    setStep('✗ LiteLLM install failed');
    showToast('LiteLLM install failed', { kind: 'error' });
    return false;
  }
  if (!res.ok && res.status !== 202) {
    const err = await res.json().catch(() => ({}));
    log.textContent = 'LiteLLM install failed: ' + (err.error || res.status);
    setStep('✗ LiteLLM install failed');
    showToast('LiteLLM install failed', { kind: 'error' });
    return false;
  }
  while (true) {
    const st = await (await authFetch('/api/router/litellm-install')).json();
    if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-12).join('\n');
    // Keep the last known step when a poll returns no marker yet, rather than
    // blanking the label between steps.
    const step = installStepLabel(st.lines);
    if (step) setStep(step);
    if (!st.running) {
      if (st.exitCode === 0) {
        showToast('LiteLLM router installed', { kind: 'success' });
        return true;
      }
      showToast('LiteLLM install failed — see log', { kind: 'error' });
      return false;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function runRoutingInstall() {
  const btn = ($('#routing-install-btn')!) as HTMLInputElement;
  const log = $('#routing-install-log')!;
  $('#routing-install-progress')!.hidden = false;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  log.textContent = 'Starting…';
  try {
    // Phase 1 — ensure the LiteLLM router is present. If it's missing, install
    // it here and wait for it to finish before layering routing on top.
    const pre = await (await authFetch('/api/router/install')).json().catch(() => ({}));
    if (!pre.litellmReady) {
      const ok = await installLitellmPhase(ROUTING_ELS_SETTINGS);
      if (!ok) {
        btn.disabled = false;
        btn.textContent = 'Install';
        return;
      }
    }
    // Phase 2 — install auto routing (shadow mode).
    const res = await authFetch('/api/router/install', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      log.textContent = 'Install failed: ' + (err.error || res.status);
      showToast('Auto routing setup failed', { kind: 'error' });
      btn.disabled = false;
      btn.textContent = 'Install';
      return;
    }
    pollRoutingInstall();
  } catch (err: any) {
    log.textContent = 'Install failed: ' + err.message;
    showToast('Auto routing setup failed', { kind: 'error' });
    btn.disabled = false;
    btn.textContent = 'Install';
  }
}

/** Debounce handles for the live pull preview, one per host. */
const previewTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/**
 * What pulling the currently-typed ref would cost, shown UNDER the box as it
 * is typed.
 *
 * This replaced a confirm dialog. The dialog opened centre-screen while the
 * card it described sat in a corner, dimmed the pane behind it, and put its
 * loudest button on "Pull" directly beneath a warning advising against
 * pulling. Worse, it asked a question whose answer was already computable:
 * size and VRAM fit are known the moment the ref is typed, so making someone
 * click, read and click again bought nothing. Now the cost is simply visible
 * while they decide, and the click that starts the pull is the only click.
 *
 * Silence is a valid answer. A ref whose size cannot be read — private
 * registry, registry unreachable — clears the line rather than announcing its
 * own ignorance, and any failure here leaves the pull entirely unaffected.
 */
export function previewOllamaPull(host: string, model: string): void {
  clearTimeout(previewTimers[host]);
  const ref = (model || '').trim();
  if (!ref) {
    hostPullPreview.value = { ...hostPullPreview.value, [host]: null };
    return;
  }
  previewTimers[host] = setTimeout(async () => {
    try {
      const pre = await (await authFetch('/api/ollama/prepull?model=' + encodeURIComponent(ref))).json();
      if (pre.sizeBytes == null) {
        hostPullPreview.value = { ...hostPullPreview.value, [host]: null };
        return;
      }
      const parts = [`${mmFmtGB(pre.sizeBytes)} download`];
      if (pre.vramFit === 'fits') parts.push(`✓ should fit in VRAM (~${mmFmtGB(pre.estFootprintBytes)} est.)`);
      else if (pre.vramFit === 'spills')
        parts.push(`⚠ likely spills to CPU (~${mmFmtGB(pre.estFootprintBytes)} est.) — slow`);
      hostPullPreview.value = {
        ...hostPullPreview.value,
        [host]: { model: ref, text: parts.join(' · '), warn: pre.vramFit === 'spills' },
      };
    } catch {
      hostPullPreview.value = { ...hostPullPreview.value, [host]: null };
    }
  }, 400);
}

/** Stop a pull that is already running. */
export async function cancelOllamaPull(host: string, model: string): Promise<void> {
  try {
    const res = await authFetch('/api/ollama/pull/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, model }),
    });
    // 404 means it finished between the render and the click. Saying "cancelled"
    // there would be a lie about a model that is now on disk, so let the poll
    // report whatever actually happened instead of asserting anything.
    if (!res.ok) return;
  } catch {
    /* the poller remains the source of truth for the job's real state */
  }
}

export async function startOllamaPull(host?: any, model?: any, input?: any, btn?: any) {
  if (!model) return;
  btn.disabled = true;
  // No confirm step: the cost was on screen while they typed, and the pull is
  // interruptible from the progress row now, so there is nothing left for a
  // dialog to protect against.
  clearTimeout(previewTimers[host]);
  hostPullPreview.value = { ...hostPullPreview.value, [host]: null };
  try {
    const res = await authFetch('/api/ollama/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, model }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.status);
    input.value = '';
    pollOllamaPulls();
  } catch (err: any) {
    showToast('Pull failed to start: ' + err.message, { kind: 'error' });
  } finally {
    btn.disabled = false;
  }
}

/** One-model fitness verdict, attached to the host card's pull status. */
async function attachPullVerdict(host: string, model: string): Promise<void> {
  try {
    const r = await authFetch('/api/models/manage');
    if (!r.ok) return;
    const inv = await r.json();
    const tag = String(model).toLowerCase();
    const m = (inv.models || []).find((x: any) => String(x.tag).toLowerCase().startsWith(tag));
    if (!m) return;
    const lines: string[] = [];
    const spec = [m.paramSize, m.quant, m.sizeBytes ? mmFmtGB(m.sizeBytes) : null].filter(Boolean).join(' · ');
    if (spec) lines.push(spec);
    const ctxTxt = `context ${Math.round(m.configuredCtx / 1024)}k${m.maxContext ? ` of ${Math.round(m.maxContext / 1024)}k max` : ''}`;
    lines.push(m.fit?.context === 'fits' ? `✓ ${ctxTxt} — agent prompt fits` : `⚠ ${ctxTxt} — agent prompt truncates`);
    if (m.fit?.vram !== 'unknown') {
      lines.push(
        m.fit?.vram === 'fits'
          ? `✓ VRAM fits (~${mmFmtGB(m.fit.estFootprintBytes)} est.)`
          : `⚠ spills to CPU (~${mmFmtGB(m.fit.estFootprintBytes)} est.) — slow`,
      );
    }
    const entry = hostPulls.value[host];
    if (entry && entry.model === model) hostPulls.value = { ...hostPulls.value, [host]: { ...entry, verdict: lines } };
  } catch {
    /* verdict is a bonus — a pull that succeeded stays a success */
  }
}

function renderOllamaPulls(pulls?: any) {
  for (const job of pulls) {
    const pct = job.total > 0 ? Math.min(100, Math.round((100 * job.completed) / job.total)) : 0;
    // No esc() anywhere: model, detail and error come from the Ollama daemon and
    // are BOUND in the template now, which escapes by construction. The manual
    // escaping this replaced was there because the line was built as innerHTML.
    // Preserve an attached verdict across ticks: attachPullVerdict lands
    // asynchronously after the success tick, and a later poll rebuilding this
    // entry from the job alone silently erased it — the verdict flashed for
    // one tick and vanished. Same host+model → the verdict still describes
    // this pull.
    const prev = hostPulls.value[job.host];
    hostPulls.value[job.host] = {
      status: job.status,
      model: job.model,
      detail: job.detail,
      error: job.error || '',
      pct,
      verdict: prev && prev.model === job.model ? prev.verdict : undefined,
    };
    if (job.status !== 'pulling' && !pullsDone.has(job.host + '\u0000' + job.model)) {
      pullsDone.add(job.host + '\u0000' + job.model);
      // A cancel is an outcome the operator chose, so it gets a neutral
      // acknowledgement and nothing else — no verdict (there is no model to
      // judge) and no error styling (nothing went wrong).
      if (job.status === 'cancelled') showToast('Cancelled pull of ' + job.model);
      if (job.status === 'success') {
        showToast('Pulled ' + job.model, { kind: 'success' });
        deps.loadOllamaHostModels(job.host);
        // Fitness at PULL TIME. The standing "Local models" analysis block is
        // gone — a page of ✓/⚠ prose about every model was noise, but the same
        // three facts about the model you JUST pulled, measured against the
        // hardware as it is right now, answer the only question the pull
        // raises: will this actually work here? Owner-gated endpoint; a 403
        // (or any failure) just means no verdict line — never a broken pull.
        void attachPullVerdict(job.host, job.model);
      }
    }
  }
}

/**
 * host\0model pairs whose finish has already been announced.
 *
 * Was a data-* attribute on the status box (`done_<model>`), which only worked
 * because that element survived between polls. The element is a vnode now, so
 * the bookkeeping lives beside the state it guards — and a dataset key built by
 * concatenating a model name was one dot away from colliding anyway.
 */
const pullsDone = new Set<string>();

export async function pollOllamaPulls() {
  if (ollamaPullPoller.value) return; // one poller
  const tick = async () => {
    try {
      const res = await authFetch('/api/ollama/pulls');
      if (!res.ok) throw new Error(String(res.status));
      const { pulls } = await res.json();
      renderOllamaPulls(pulls);
      if (pulls.some((p: any) => p.status === 'pulling')) {
        ollamaPullPoller.value = setTimeout(tick, 1500);
      } else {
        ollamaPullPoller.value = null;
      }
    } catch {
      ollamaPullPoller.value = null;
    }
  };
  ollamaPullPoller.value = setTimeout(tick, 0);
}
