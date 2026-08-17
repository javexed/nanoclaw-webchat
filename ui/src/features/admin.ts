// ── Admin ────────────────────────────────────────────────────────────────────
// Settings for the INSTALLATION, as opposed to Settings, which is now settings
// for YOU.
//
// Why this exists. The Settings modal had grown to fourteen blocks, of which
// eleven were an operator configuring the workspace — setup wizard, self-test,
// provider credentials and the CLI installers, network auth, secrets,
// credential isolation, prejudge, auto-learn, audit log, backup, versions. The
// remaining three (appearance, your own credentials, read-aloud and dictation)
// are the only ones a normal user can act on. So the page was simultaneously
// too long for an owner and almost entirely hidden for everyone else, which is
// the shape a surface takes when it has two jobs. Stage 1 moved the three
// catalog registries onto their own Manage tabs; this is stage 2.
//
// GATED ON ANY ADMIN, not owner. The individual blocks already hide themselves
// when their endpoint answers 403 — that idiom is used by every section here —
// so a scoped admin opens the page and sees exactly what they can act on. The
// alternative, an owner-only page, would have stranded About/versions (which
// is anyAdmin) behind a door scoped admins cannot open, splitting one group
// across two surfaces to enforce a rule the blocks already enforce themselves.
import { $ } from '../core/dom.js';
import { adminActive } from './views-state.js';
import { closeView, hideOtherFullViews, openFullView, openView } from './views.js';
import { renderSettingsWizardButton } from './wizard.js';
import { renderAutoLearnSetting } from './learn.js';
import { renderToolSecrets } from './agents.js';
import {
  renderAboutSettings,
  renderAccessSettings,
  renderAuditSettings,
  renderBackupSettings,
  renderCredentialsSettings,
  renderPrejudgeSettings,
  renderSelfTest,
} from './settings.js';

/**
 * Hide a group whose every block hid itself.
 *
 * Without this a scoped admin sees "Setup", "Access & credentials" and
 * "Policy" as headings over empty space — the page would advertise exactly
 * what they are not allowed to do. Same argument as syncFeaturesColumn in
 * settings.ts, and the same shape: ask the rendered children, do not try to
 * re-derive the permission rule here. A second source of truth for who may
 * see what is how the gates drifted apart the last three times.
 */
export function syncAdminGroups(): void {
  for (const group of document.querySelectorAll<HTMLElement>('#admin .admin-group')) {
    const blocks = group.querySelectorAll('.settings-credentials, .settings-feature');
    group.hidden = blocks.length > 0 && [...blocks].every((b) => b.hasAttribute('hidden'));
  }
}

// The menu entry is revealed in core/ws.ts, on the same /api/users success that
// already reveals Permissions — that request tells you "I am an admin", and
// issuing a second one here to learn the same fact would be a probe that can
// disagree with the first.

function openAdmin(): void {
  openFullView(() => {
    hideOtherFullViews('admin');
    adminActive.value = true;
    $('#chat')!.hidden = true;
    $('#admin')!.hidden = false;
    $('#overflow-btn')?.classList.add('active');
    $('#app')!.classList.add('in-dashboard');
    $('#app')!.classList.remove('in-room');
    // Every renderer decides its own block's visibility, so the group sync has
    // to run AFTER the async ones settle — otherwise it reads a half-rendered
    // page and hides a group that was about to fill in.
    renderSettingsWizardButton();
    renderCredentialsSettings();
    renderPrejudgeSettings();
    renderBackupSettings();
    void Promise.allSettled([
      renderSelfTest(),
      renderAccessSettings(),
      renderToolSecrets(),
      renderAutoLearnSetting(),
      renderAuditSettings(),
      renderAboutSettings(),
    ]).then(syncAdminGroups);
    openView('admin', teardownAdmin);
  });
}

function teardownAdmin(): void {
  adminActive.value = false;
  $('#chat')!.hidden = false;
  $('#admin')!.hidden = true;
  $('#overflow-btn')?.classList.remove('active');
  $('#app')!.classList.remove('in-dashboard');
}

export function toggleAdmin(): void {
  if (adminActive.value) closeView('admin');
  else openAdmin();
}
