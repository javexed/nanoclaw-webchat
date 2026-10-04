// ── Admin ────────────────────────────────────────────────────────────────────
// Settings for the INSTALLATION, as opposed to Settings, which is settings for YOU.
//
// GATED ON ANY ADMIN, not owner: each block hides itself when its endpoint
// answers 403, so a scoped admin sees exactly what they can act on (including
// About/versions, which is anyAdmin) without a second copy of the rule here.
import { $ } from '../core/dom.js';
import { adminActive } from './views-state.js';
import { closeView, hideOtherFullViews, openFullView, openView } from './views.js';
import { renderSettingsWizardButton } from './wizard.js';
import { renderAutoLearnSetting } from './learn.js';
import { renderToolSecrets } from './agents.js';
import { loadAuditLog } from './audit-log.js';
import {
  renderAboutSettings,
  renderAgentActivitySettings,
  renderAuditSettings,
  renderBackupSettings,
  renderCredentialsSettings,
  renderPrejudgeSettings,
  renderSelfTest,
} from './settings.js';

/**
 * Hide a group whose every block hid itself, so a scoped admin never sees
 * headings over empty space. Asks the rendered children rather than re-deriving
 * the permission rule: a second source of truth for who may see what drifts.
 */
export function syncAdminGroups(): void {
  for (const group of document.querySelectorAll<HTMLElement>('#admin .admin-group')) {
    const blocks = group.querySelectorAll('.settings-credentials, .settings-feature');
    group.hidden = blocks.length > 0 && [...blocks].every((b) => b.hasAttribute('hidden'));
  }
}

// The menu entry is revealed in core/ws.ts on the /api/users success that
// reveals Permissions: a second probe here could disagree with the first.

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
      renderToolSecrets(),
      renderAutoLearnSetting(),
      renderAuditSettings(),
      renderAgentActivitySettings(),
      loadAuditLog(),
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
