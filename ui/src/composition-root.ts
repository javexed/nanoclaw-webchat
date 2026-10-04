// Composition root: imports every feature, injects the dependencies that would
// close an import cycle as direct imports (provide*Deps), attaches the listeners
// no single feature owns, and calls initApp(). ORDER IS LOAD-BEARING: statements
// run in source order, and scripts/check-boot-order.sh fails on any change.

import { marked } from '/marked.min.js';
import { lightboxOpen } from './features/modals-state.js';
import { attachPickerCfg, pendingFiles } from './features/attach-picker-state.js';
import { viewStack } from './features/views-state.js';
import './features/model-list-state.js';
import { routingCurrentRouter } from './features/routing-state.js';
import { roomSortAz, selectedRoomId } from './features/room-list-state.js';
import { selectedAgentId } from './features/agent-list-state.js';
import { membersFilter, usersSortAz } from './features/members-list-state.js';
import '/dompurify.min.js';

marked.setOptions({ breaks: true, gfm: true });

import { $ } from './core/dom.js';
import {
  clearBadgeCount,
  closeAllDetailDrawers,
  copyTextToClipboard,
  getDetailRouterOpen,
  setAfterDetailClose,
  wireComposerPaste,
  wireDetailOverlay,
  wireManageTabs,
  wireMobileBack,
  wireServiceWorker,
  wireSortToggle,
  wireVisibilityRefresh,
} from './boot.js';
import { state } from './core/state.js';

import {
  acceptMention,
  fetchMentionablePeople,
  getWiredAgentsForCurrentRoom,
  handleTypingEvent,
  renderTypingIndicator,
  sendCurrentMessage,
  setWiredAgentsForCurrentRoom,
  updateSlashMenu,
  wireComposer,
} from './features/composer.js';

import {
  closeRouteDetail,
  loadRoutingTab,
  probeRoutingAvailability,
  refreshRouterMetrics,
  renderRouterRoster,
  switchRoutingSubtab,
  wireRouterNew,
  wireRoutingPanel,
  wireRoutingProfiles,
} from './features/routing.js';

import { toggleAdmin } from './features/admin.js';
import { toggleSigninPage } from './features/signin-page.js';
import {
  permsRefreshCreateUI,
  permsShowDetail,
  permsShowList,
  refreshPermissions,
  renderPermsDetail,
  togglePermissions,
  wirePermsCreate,
  wirePermsNew,
} from './features/perms.js';
import { permsCreateChannelTouched, permsSelectedUserId, permsUserFilter } from './features/perms-list-state.js';

import {
  closeAttachPicker,
  openAttachPicker,
  renderAttachPickerList,
  stageFile,
  stageFiles,
  wireFileControls1,
  wireFileControls2,
  wireFileControls3,
} from './features/files.js';

import {
  applyLearningMaster,
  hideLearnNudge,
  provideLearnDeps,
  toggleLearnMenu,
  triggerLearn,
  wireLearnPanel,
} from './features/learn.js';

import {
  applyLoginHint,
  checkAuth,
  enterAuthedApp,
  provideAuthDeps,
  reprobeAuthWhenOnline,
  wireAuthPanel,
} from './features/auth.js';
import { consumeSigninResult } from './features/signins.js';

import {
  clearTopoFocus,
  closeOverflowMenu,
  closeTopDetailAside,
  closeView,
  hideDetail,
  hideOtherFullViews,
  openJourney,
  openManage,
  openView,
  provideViewsDeps,
  refreshJourney,
  refreshMatrix,
  switchManageTab,
  toggleDashboard,
  toggleHelp,
  toggleJourney,
  toggleMatrix,
  toggleTopology,
  wireViewChrome1,
  wireViewChrome2,
  wireViewsPanel,
} from './features/views.js';
import { wireDocLinks } from './features/docs.js';

import {
  blockingOverlayOpen,
  closeLightbox,
  confirmWithToggle,
  inspectAndConfirmImport,
  openLightbox,
  openOauthMintModal,
  provideModalsDeps,
  showConfirmModal,
  wireLightbox,
  wireModalsPanel,
  wireUserCredsOauth,
} from './features/modals.js';

import {
  closeUserCredsOauthModal,
  deleteUser,
  paintMembersList,
  provideMembersDeps,
  renderMembers,
  renderPermsUserList,
  saveHandle,
  toggleMembersPanel,
  updateHandleCreds,
  updateUserCredsBanner,
  wireMembersOauth1,
  wireMembersOauth2,
  wireMembersPanel,
} from './features/members.js';

import {
  closeSettings,
  loadSettings,
  openSettings,
  provideSettingsDeps,
  renderCredentialsSettings,
  renderRoutingSetup,
  renderSttSetupSettings,
  renderTtsSetupSettings,
  wireSettingsPanel1,
  wireSettingsPanel2,
} from './features/settings.js';

import {
  addSelectedFromProbe,
  bindDiscover,
  closeModelDetail,
  closeModelPicker,
  fetchModels,
  loadOllamaHostModels,
  modelKindLabel,
  populateKnownModelOptions,
  provideModelsDeps,
  renderPickerList,
  runProbe,
  setPickerAdd,
  syncCreateFormToKind,
  warnIfUnreachable,
  wireModelCreate,
  wireModelsPanel,
} from './features/models.js';
import { wireCloudModels } from './features/cloud-models.js';

import {
  closeRoomDetail,
  continueRoomImport,
  deleteCurrentRoom,
  joinRoom,
  openRoomCreate,
  openRoomDetail,
  provideRoomsDeps,
  renderRooms,
  roomColor,
  saveRoomName,
  wireRoomCreate,
  wireRoomDetail1,
  wireRoomDetail2,
  wireRoomDetail3,
  wireRoomDetail4,
  wireRoomDetail5,
  wireRoomsPanel,
} from './features/rooms.js';

import {
  agentColor,
  closeAgentDetail,
  endAgentTurn,
  fetchAgents,
  interruptAgent,
  mentionAgentColor,
  openAgentDetail,
  openWireToAgentsPicker,
  provideAgentsDeps,
  refreshWiredAgentsForCurrentRoom,
  wireAgentControls1,
  wireAgentControls2,
  wireAgentControls3,
  wireAgentControls4,
  wireAgentControls5,
  wireAgentCreate1,
  wireAgentCreate2,
  wireAgentDetail1,
  wireAgentDetail2,
  wireAgentDetail3,
  wireAgentsPanel,
} from './features/agents.js';

import {
  closeMcpDetail,
  provideMcpDeps,
  syncMcpCreateTransportFields,
  wireMcpCatalog,
  wireMcpPanel,
} from './features/mcp.js';

import {
  loadAgentTemplates,
  renderTemplateLibrary,
  wireAgentTemplateExport,
  wireTemplateLibrary,
} from './features/agent-templates.js';
import {
  draftFor,
  handleSkillDraftReview,
  provideSkillsDeps,
  refreshDraftBadge,
  scheduleSkillSuggest,
  skillDraftRow,
  wireSkillsPanel,
  wireSkillsRegistry,
} from './features/skills.js';

import { provideWsDeps } from './core/ws.js';

import { provideTranscriptDeps, wireScrollTracking, wireTranscriptPanel } from './features/transcript.js';

import { fetchApprovals, wireApprovalsPanel } from './features/approvals.js';
import { provideSelectToggleDeps } from './features/select-toggle.js';

import './features/ollama-cards.js';
import {
  deleteThreadConfirm,
  openThreadSwitcher,
  provideThreadsDeps,
  roomThreads,
  syncThread,
} from './features/threads.js';

import { OPENCODE_WIZARD_ELS, provideInstallerDeps, runInstall } from './features/installers.js';

import {
  provideWizardDeps,
  refreshWizardCredState,
  refreshWizardNextGate,
  renderWizardFeatures,
  renderWizardOpencodeInstall,
  wizardBusy,
} from './features/wizard.js';

import { authFetch } from './core/api.js';
import { checkSessionExpired, provideDraftCheck } from './core/session-expiry.js';

import { showToast } from './core/toast.js';
import { cancelDictation, isDictationActive, startDictation, stopDictation } from './features/voice.js';

import { toggleThinkingExpanded } from './features/thinking.js';

async function initApp() {
  const verdict = await checkAuth();
  if (verdict === 'expired') {
    // The page came from the cache while the front door's session had ended: say so, and sign in.
    enterAuthedApp();
    void checkSessionExpired();
  } else if (verdict === 'ok' || verdict === 'unreachable') {
    // 'unreachable' enters the app deliberately: the session is probably fine and
    // the WS reconnect + connection banner explain the state far better than a
    // token prompt would. If it turns out we really are unauthenticated, the
    // re-probe below catches it once the network is back.
    enterAuthedApp();
    if (verdict === 'unreachable') void reprobeAuthWhenOnline();
  } else {
    $('#login-screen')!.hidden = false;
    $('#app')!.hidden = true;
    // Tailor the login subtitle to whichever auth methods the server has
    // configured. Best-effort: if the endpoint isn't there or the fetch
    // fails, the static "enter your token" subtitle stands.
    void applyLoginHint();
  }
}

wireAuthPanel();
// A Microsoft sign-in lands back on /?signin=… — show the outcome once, then drop it.
consumeSigninResult();

// ── Settings ──────────────────────────────────────────────────────────────

state.settings = loadSettings(); // set here: settings.ts imports core/state

// Wizard OpenCode install: a deliberate click, never auto-run — installing rebuilds
// the image and restarts the host under the wizard session.
$('#wizard-opencode-install')?.addEventListener('click', () => runInstall('opencode', OPENCODE_WIZARD_ELS));

wireModalsPanel();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isDictationActive()) {
    e.preventDefault();
    cancelDictation();
  }
});

$('#mic-btn')?.addEventListener('click', () => {
  if (isDictationActive()) stopDictation();
  else startDictation();
});

// ── Sidebar overflow menu (Dashboard / Permissions / Settings) ──────────────
$('#overflow-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#overflow-menu');
  const open = menu!.hidden;
  menu!.hidden = !open;
  $('#overflow-btn')!.setAttribute('aria-expanded', String(open));
  // Re-probe on open so a routing install done elsewhere (in-app, CLI, another
  // tab) reveals Auto routing here without a full reload.
  if (open) void probeRoutingAvailability();
});
$('#overflow-menu')?.addEventListener('click', (e) => {
  const item = (e.target as Element | null)?.closest('.overflow-item');
  if (!item) return;
  closeOverflowMenu();
  const action = (item as HTMLElement).dataset.action;
  if (action === 'agents') openManage('agents');
  else if (action === 'models') openManage('models');
  else if (action === 'mcp') openManage('mcp');
  else if (action === 'skills') openManage('skills');
  else if (action === 'runners') openManage('runners');
  else if (action === 'network') openManage('network');
  else if (action === 'routing') openManage('routing');
  else if (action === 'journey') toggleJourney();
  else if (action === 'topology') toggleTopology();
  else if (action === 'wiring') toggleMatrix();
  else if (action === 'dashboard') toggleDashboard();
  else if (action === 'permissions') togglePermissions();
  else if (action === 'admin') toggleAdmin();
  else if (action === 'signin') toggleSigninPage();
  else if (action === 'settings') openSettings();
  else if (action === 'help') toggleHelp();
});
document.addEventListener('click', (e) => {
  const menu = $('#overflow-menu');
  if (menu && !menu.hidden && !menu.contains(e.target as Element) && (e.target as Element) !== $('#overflow-btn'))
    closeOverflowMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverflowMenu();
});
$('#settings-close')!.addEventListener('click', closeSettings);
wireSettingsPanel1();

window.addEventListener('popstate', (e) => {
  // The lightbox manages its own history entry — handle it first.
  if (lightboxOpen.value) {
    closeLightbox(true);
    return;
  }
  // Unwind overlay surfaces down to the depth the restored history state implies.
  const targetDepth = (e.state && e.state.viewDepth) || 0;
  while (viewStack.length > targetDepth) {
    const top = viewStack.pop();
    try {
      top!.teardown();
    } catch (err) {
      console.error('view teardown failed', err);
    }
  }
});

// Escape closes the topmost layer (an open aside, else the full view) via its Back
// path, keeping history in sync. Capture phase so it can defer to open modals and
// menus, which close on their own bubble-phase handlers. One layer per press (DESIGN.md §4).
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || viewStack.length === 0) return;
    if (blockingOverlayOpen()) return; // a higher layer owns this Escape
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    e.stopPropagation();
    if (closeTopDetailAside()) return; // aside is the topmost layer
    closeView(viewStack[viewStack.length - 1].name);
  },
  true,
);

wireLightbox();

// Theme selection
wireSettingsPanel2();

// @handle save — button click and Enter-in-field both commit.
$('#handle-save')?.addEventListener('click', saveHandle);
$('#handle-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveHandle();
  }
});

// A backgrounded mobile tab can lose its socket without onclose, or miss pushes
// while throttled: resync on return to foreground.
wireVisibilityRefresh();

// Safety-net approvals poll while visible: a foreground socket can die silently
// and drop an `approval` push with nothing to trigger a catch-up. Idempotent;
// skipped while hidden because the visibility handler refetches on return.
const APPROVAL_POLL_MS = 10000;
setInterval(() => {
  if (document.visibilityState === 'visible') fetchApprovals();
}, APPROVAL_POLL_MS);

// ── Message search (FTS) ────────────────────────────────────────────────────
wireRoomsPanel();

wireMembersPanel();

// One modal, three targets: a member's own credential ('member', room-gated) or
// the owner's workspace default ('workspace' / 'workspace-codex', admin-only).
$('#user-creds-oauth-btn')?.addEventListener('click', () => openOauthMintModal('member'));

$('#user-creds-oauth-cancel')?.addEventListener('click', closeUserCredsOauthModal);
$('#user-creds-oauth-close')?.addEventListener('click', closeUserCredsOauthModal);
// Backdrop click and Escape close; Tab is trapped in the dialog (a11y).
wireMembersOauth1();
// Auto-submit once a code is pasted (Claude path) — no separate Connect click.
$('#user-creds-oauth-code')?.addEventListener('paste', () => {
  setTimeout(() => {
    const submit = $('#user-creds-oauth-submit');
    if (submit && !submit.hidden && ($<HTMLInputElement>('#user-creds-oauth-code')?.value || '').trim()) submit.click();
  }, 0);
});

wireUserCredsOauth();

wireScrollTracking();
wireTranscriptPanel();
wireComposer();

$('#members-toggle')!.addEventListener('click', toggleMembersPanel);
$('#members-close')!.addEventListener('click', toggleMembersPanel);
$('#members-search')?.addEventListener('input', (e) => {
  membersFilter.value = (e.target as HTMLInputElement).value.trim().toLowerCase();
  paintMembersList();
});
wireMembersOauth2();

wireDetailOverlay();

// ── Manage section (Agents / Models) ────────────────────────────────────────
// Router-managed so the back gesture returns to chat.
$('#manage-back')?.addEventListener('click', () => closeView('manage'));
wireManageTabs();

wireSkillsPanel();

// ── Approvals ─────────────────────────────────────────────────────────────

wireApprovalsPanel();

// ── Mobile back button ────────────────────────────────────────────────────
wireMobileBack();

wireViewChrome1();
$('#journey-back')?.addEventListener('click', toggleJourney);

$('#journey-refresh')?.addEventListener('click', () => void refreshJourney(true));
wireViewsPanel();

$('#topo-focus-pill')?.addEventListener('click', clearTopoFocus);

// ── Wiring matrix (rooms × agents) ──────────────────────────────────────────
$('#matrix-back')?.addEventListener('click', toggleMatrix);
$('#matrix-refresh')?.addEventListener('click', refreshMatrix);

// Help — a static full-view (no data to load); same open/close mechanics as the
// matrix/topology dashboards so the back gesture and view stacking work for free.
$('#help-back')?.addEventListener('click', toggleHelp);
// Delegated: covers the nav's links and the cross-links inside a rendered
// doc, which do not exist yet when this runs.
wireDocLinks($('#help') ?? document);

$('#perms-user-search')?.addEventListener('input', (e) => {
  permsUserFilter.value = (e.target as HTMLInputElement).value.trim().toLowerCase();
  renderPermsUserList();
});

// Permissions / admin / sign-in view chrome.
$('#perms-exit')!.addEventListener('click', togglePermissions);
$('#admin-exit')!.addEventListener('click', toggleAdmin);
$('#signin-exit')!.addEventListener('click', toggleSigninPage);
$('#perms-refresh')!.addEventListener('click', refreshPermissions);
wirePermsNew();
$('#perms-detail-back')!.addEventListener('click', permsShowList);
$('#perms-create-back')!.addEventListener('click', permsShowList);
$('#perms-delete-btn')!.addEventListener('click', () => {
  if (permsSelectedUserId.value) deleteUser(permsSelectedUserId.value);
});

// ── + New User wizard ────────────────────────────────────────────────
// The dropdown picks a channel "namespace prefix"; the handle/email input
// is appended after a colon to compose the full user_id. Picking
// "__raw__" reveals a single raw input instead. The preview line shows
// the resolved id as the user types.
$('#perms-create-channel')!.addEventListener('change', () => {
  permsCreateChannelTouched.value = true;
  permsRefreshCreateUI();
});
$('#perms-create-handle')!.addEventListener('input', permsRefreshCreateUI);
$('#perms-create-raw')!.addEventListener('input', permsRefreshCreateUI);
$('#perms-create-kind')!.addEventListener('change', permsRefreshCreateUI);

wirePermsCreate();

$('#dash-detail-close')!.addEventListener('click', hideDetail);

// ── Agent management ────────────────────────────────────────────────────────
wireAgentsPanel();

// ── Agent export / import ───────────────────────────────────────────────
wireAgentControls1();

// ── Room export/import ──
$('#room-export-btn')?.addEventListener('click', () => {
  const roomId = selectedRoomId.value || state.currentRoom;
  if (!roomId) return;
  const a = document.createElement('a');
  a.href = `/api/rooms/${encodeURIComponent(roomId)}/export`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('Room export started', { kind: 'success' });
});

// Settings → "Import…" routes by bundle type into the room/agent import flows.
wireFileControls1();

$('#import-room-file')?.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!file) return;
  showToast('Uploading room bundle…', { kind: 'info' });
  let up;
  try {
    const fd = new FormData();
    fd.append('bundle', file);
    const res = await authFetch('/api/rooms/import', { method: 'POST', body: fd });
    up = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(up.error || res.statusText);
  } catch (err) {
    showToast('Import failed: ' + ((err as any)?.message || err), { kind: 'error' });
    return;
  }
  return continueRoomImport(up);
});

// ── System backup ──
$('#system-export-btn')?.addEventListener('click', async () => {
  const {
    ok,
    checks: [checked, withSecrets],
  } = await confirmWithToggle({
    title: 'Download system backup?',
    toggleLabels: [
      'Lean (skip conversation history — much smaller)',
      'Include secrets (API keys, deploy keys, MCP tokens)',
    ],
    note: 'Without secrets, a restore keeps this install’s own. Host identity never travels.',
    confirmLabel: 'Download',
  });
  if (!ok) return;
  // Fetch, not an <a> navigation: an anchor has no status check, so a refusal
  // would be saved to disk as the backup and reported as success.
  showToast('Preparing backup — this can take a while for large installs', { kind: 'info' });
  let blob: Blob;
  try {
    const q = new URLSearchParams();
    if (checked) q.set('lean', '1');
    if (withSecrets) q.set('secrets', '1');
    const res = await authFetch(`/api/system/export${q.toString() ? `?${q}` : ''}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}) as { error?: string });
      showToast('Backup failed: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    blob = await res.blob();
  } catch (e) {
    showToast('Backup failed: ' + ((e as Error)?.message || 'network error'), { kind: 'error' });
    return;
  }
  // An object URL has no name of its own; without this the file lands as a bare uuid.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nanoclaw-backup-${new Date().toISOString().slice(0, 10)}.tgz`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Backup downloaded', { kind: 'success' });
});

wireFileControls2();

wireAgentControls2();

// ── Shared multi-select attach picker (MCP servers, rooms) ──────────────────
// One bottom-sheet for every "attach" surface; the caller's config supplies rows and toggles.
$('#attach-picker-close')!.addEventListener('click', closeAttachPicker);
$('#attach-picker .model-picker-backdrop')!.addEventListener('click', closeAttachPicker);
$<HTMLInputElement>('#attach-picker-search')!.addEventListener('input', (e) =>
  renderAttachPickerList((e.target as HTMLInputElement).value),
);
$('#attach-picker-add-new')!.addEventListener('click', () => attachPickerCfg.value?.onAddNew?.());

// "+ Attach server" opens the shared picker; "+ Add new server" creates and auto-attaches.
wireAgentControls3();

// Save existing agent
wireAgentDetail1();

// Delete agent
wireAgentControls4();

// ── Create agent ────────────────────────────────────────────────────────────
wireAgentCreate1();

// ── Skill suggestions in the create form ────────────────────────────────────
// Installed matches are informational (new agents load every installed skill);
// catalog matches get a checkbox and are imported on create.
for (const sel of ['#agent-create-draft-prompt', '#agent-create-name', '#agent-create-instructions']) {
  $(sel)?.addEventListener('input', scheduleSkillSuggest);
}

wireSkillsRegistry();
// Populate the create form's template picker. Fire-and-forget: the picker
// stays hidden if the library is empty or the caller cannot stamp, and a
// failure here must never block creating a blank agent.
void loadAgentTemplates();
wireTemplateLibrary();
wireAgentTemplateExport();
// The library block hides itself for a non-owner or an empty library, so
// this is safe to run unconditionally at boot.
void renderTemplateLibrary();

// ── Drafter: ✨ Suggest from prompt ───────────────────────────────────────
// Fills the target form's name + instructions for review; never auto-creates.
document.querySelectorAll('.drafter-btn').forEach((btn) => {
  btn.addEventListener('click', () => draftFor(btn));
});

// ── Room management ─────────────────────────────────────────────────────────
// Tapping the room name opens/closes room settings (frees the chat-header slot
// and kills the duplicate ⚙). Keyboard-accessible since it's a role="button".
wireRoomDetail1();
// Thread context-sync: pull the regular chat into this thread / push this
// thread back up. Confirm first (the copy is verbatim and additive), then
// report the count — "nothing new" when the delta is empty.
$('#thread-switch')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openThreadSwitcher();
});
$('#thread-pull')?.addEventListener('click', () => syncThread('pull'));
$('#thread-push')?.addEventListener('click', () => syncThread('push'));
$('#thread-delete')?.addEventListener('click', () => {
  if (!state.currentRoom || state.currentThread === 'main') return;
  const thread = roomThreads().find((t) => t.thread_id === state.currentThread);
  if (thread) deleteThreadConfirm(thread);
});

$('#room-detail-close')!.addEventListener('click', closeRoomDetail);
$('#room-delete')!.addEventListener('click', deleteCurrentRoom);
wireRoomDetail2();
$('#room-rename-save')?.addEventListener('click', saveRoomName);
wireRoomDetail3();
wireAgentDetail2();
wireAgentControls5();

// ── Create room ─────────────────────────────────────────────────────────────
$('#create-room-btn')!.addEventListener('click', openRoomCreate);
wireRoomDetail4();
// A–Z sort toggles (rooms / agents / models). One small button each: off = the
// list's natural order, on = alphabetical. State persists per-list.
wireSortToggle(
  '#room-sort-az',
  'webchat:roomSortAz',
  () => roomSortAz.value,
  (v) => (roomSortAz.value = v),
  () => {
    if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
  },
);
wireSortToggle(
  '#perms-sort-az',
  'webchat:usersSortAz',
  () => usersSortAz.value,
  (v) => (usersSortAz.value = v),
  () => renderPermsUserList(),
);
// The Manage view shares ONE sort icon (in the header) that acts on the active
// tab — toggling agents' or models' sort and reflecting that tab's state.
wireViewChrome2();
$('#room-create-close')!.addEventListener('click', closeRoomDetail);
wireRoomDetail5();

wireRoomCreate();

$('#learn-btn')?.addEventListener('click', toggleLearnMenu);

// Composer overflow "+": on narrow screens the tools (attach/camera/learn)
// live in a popover this button toggles. Closes on outside-tap and whenever a
// tool inside is chosen (each opens its own dialog/menu).
wireLearnPanel();

// ── Typing send (debounced) ───────────────────────────────────────────────
let typingTimeout: ReturnType<typeof setTimeout> | null = null;
let isTyping = false;

$('#message-input')!.addEventListener('input', function () {
  updateSlashMenu(); // slash-command autocomplete
  // Auto-grow textarea — only resize when content overflows or shrinks
  const prevH = (this as any)._prevScrollHeight || this.clientHeight;
  if (this.scrollHeight > this.clientHeight || this.scrollHeight < prevH) {
    this.style.height = '0';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  }
  (this as any)._prevScrollHeight = this.scrollHeight;
  if (!state.currentRoom || !state.ws || state.ws!.readyState !== WebSocket.OPEN) return;
  if (!isTyping) {
    isTyping = true;
    state.ws!.send(JSON.stringify({ type: 'typing', is_typing: true }));
  }
  clearTimeout(typingTimeout ?? undefined);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    state.ws!.send(JSON.stringify({ type: 'typing', is_typing: false }));
  }, 2000);
});

$('#message-form')!.addEventListener('submit', () => {
  if (isTyping) {
    isTyping = false;
    clearTimeout(typingTimeout ?? undefined);
    state.ws!.send(JSON.stringify({ type: 'typing', is_typing: false }));
  }
});

// ── File upload (drag-drop, paste, picker) ────────────────────────────────
const messagesEl = $('#messages');

messagesEl!.addEventListener('dragover', (e) => {
  e.preventDefault();
  messagesEl!.classList.add('drag-over');
});
messagesEl!.addEventListener('dragleave', () => {
  messagesEl!.classList.remove('drag-over');
});
messagesEl!.addEventListener('drop', (e) => {
  e.preventDefault();
  messagesEl!.classList.remove('drag-over');
  if (e.dataTransfer!.files.length > 0) stageFiles(e.dataTransfer!.files);
});

document.addEventListener('paste', (e) => {
  if (!state.currentRoom) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length > 0) {
    e.preventDefault();
    stageFiles(files);
  }
});

wireComposerPaste();

wireFileControls3();

$('#camera-btn')!.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.addEventListener('change', () => {
    if (input!.files!.length > 0) stageFile(input!.files![0]);
  });
  input.click();
});

// ── App badge (unread counter) ───────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) clearBadgeCount();
});
if (!document.hidden) clearBadgeCount();

// ── Init ──────────────────────────────────────────────────────────────────
wireServiceWorker(() => Array.isArray(pendingFiles.value) && pendingFiles.value.length > 0);
// An expired sign-in goes back to the login page by itself only when nothing unsent would be lost.
provideDraftCheck(() => Array.isArray(pendingFiles.value) && pendingFiles.value.length > 0);

$('#router-select')?.addEventListener('change', (e) => {
  routingCurrentRouter.value = (e.target as HTMLInputElement).value;
  loadRoutingTab();
});

wireRouterNew();

wireRoutingProfiles();

// Routing pane has three sub-tabs: Rules (bench + routes), Models (the router
// roster with +/− select toggles + suggestions), and Logs (recent decisions).
document.querySelectorAll('.routing-subtab').forEach((b) => {
  b.addEventListener('click', () => switchRoutingSubtab((b as HTMLElement).dataset.rsub));
});

wireRoutingPanel();
// Startup probe (deferred so auth is settled before the first owner-gated call).
setTimeout(probeRoutingAvailability, 3000);

$('#model-detail-close')!.addEventListener('click', closeModelDetail);
$('#model-create-close')!.addEventListener('click', closeModelDetail);

wireModelCreate();

$('#model-create-kind')!.addEventListener('change', syncCreateFormToKind);

// ── Probe-by-URL flow ──────────────────────────────────────────────────────
$('#model-probe-btn')!.addEventListener('click', runProbe);
$('#model-probe-url')!.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runProbe();
  }
});
$('#model-probe-select-all')!.addEventListener('click', () => {
  document.querySelectorAll('#model-probe-list input[type=checkbox]').forEach((cb) => {
    (cb as HTMLInputElement).checked = true;
  });
});
$('#model-probe-add-selected')!.addEventListener('click', addSelectedFromProbe);

bindDiscover(
  '#model-create-discover-btn',
  () => $<HTMLInputElement>('#model-create-kind')!.value,
  () => $<HTMLInputElement>('#model-create-endpoint')!.value.trim(),
  '#model-create-model-id',
  '#model-create-discover-select',
);
wireModelsPanel();
wireCloudModels();

wireMcpCatalog();

$('#mcp-detail-close')!.addEventListener('click', closeMcpDetail);
$('#mcp-create-close')!.addEventListener('click', closeMcpDetail);

wireAgentCreate2();

// Manual-entry transport select swaps url vs command/args fields (the bearer
// token is a remote-transport concept — hidden for stdio).
$('#mcp-create-transport')!.addEventListener('change', syncMcpCreateTransportFields);

wireMcpPanel();

// ── Model picker ──────────────────────────────────────────────────────────
wireAgentDetail3();

// Picker close paths.
$('#model-picker-close')!.addEventListener('click', closeModelPicker);
$('#model-picker .model-picker-backdrop')!.addEventListener('click', closeModelPicker);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#model-picker')!.hidden) closeModelPicker();
});

// Live filter.
$('#model-picker-search')!.addEventListener('input', (e) => {
  renderPickerList((e.target as HTMLInputElement).value);
});

// "+ Add new model": open model-create with the auto-assign flag set, so the new
// model lands on this agent and the agent detail returns.
$('#model-picker-add-new')!.addEventListener('click', () => {
  if (!selectedAgentId.value) return;
  setPickerAdd(true, selectedAgentId.value);
  closeModelPicker();
  setTimeout(() => $('#create-model-btn')!.click(), 180);
});

initApp();

// ── Injected dependencies: each would close an import cycle as a direct import ──
provideWizardDeps({
  openOauthMintModal,
  fetchAgents,
  closeSettings,
  applyLearningMaster,
  joinRoom,
});

provideInstallerDeps({
  // Passed through: installers cannot import wizard (wizard imports installers).
  wizardBusy,
  refreshWizardNextGate,
  renderWizardOpencodeInstall,
  renderWizardFeatures,
  refreshWizardCredState,
  renderCredentialsSettings,
  renderTtsSetupSettings,
  renderSttSetupSettings,
  renderRoutingSetup,
  probeRoutingAvailability,
  loadOllamaHostModels,
  fetchModels,
  fetchAgents,
});

provideThreadsDeps({
  hideOtherFullViews,
  joinRoom,
  renderRooms,
  roomColor,
  showConfirmModal,
});

// toggleThinkingExpanded is injected so the edge stays one-way: thinking imports transcript.
provideTranscriptDeps({
  agentColor,
  endAgentTurn,
  interruptAgent,
  mentionAgentColor,
  openLightbox,
  skillDraftRow,
  toggleThinkingExpanded,
});

provideWsDeps({
  fetchApprovals,
  fetchMentionablePeople,
  handleSkillDraftReview,
  handleTypingEvent,
  joinRoom,
  refreshDraftBadge,
  refreshWiredAgentsForCurrentRoom,
  renderMembers,
  renderRooms,
  triggerLearn,
});

provideSkillsDeps({
  closeRoomDetail,
  closeView,
  joinRoom,
  openJourney,
  openManage,
  openView,
  openWireToAgentsPicker,
  showConfirmModal,
  triggerLearn,
});

provideMcpDeps({
  closeAgentDetail,
  closeModelDetail,
  closeRoomDetail,
  openAgentDetail,
  showConfirmModal,
});

provideAgentsDeps({
  warnIfUnreachable, // models imports agents
  // composer imports agents
  getWiredAgentsForCurrentRoom,
  closeAttachPicker,
  closeModelDetail,
  closeRoomDetail,
  fetchModels,
  inspectAndConfirmImport,
  modelKindLabel,
  openAttachPicker,
  openRoomDetail,
  populateKnownModelOptions,
  showConfirmModal,
  setWiredAgentsForCurrentRoom,
});

provideRoomsDeps({
  closeModelDetail,
  fetchMentionablePeople,
  hideLearnNudge,
  hideOtherFullViews,
  renderMembers,
  renderTypingIndicator,
  showConfirmModal,
  updateUserCredsBanner,
});

provideModelsDeps({
  // routing imports models
  closeRouteDetail,
  switchManageTab,
});

provideSettingsDeps({
  updateUserCredsBanner,
});

provideMembersDeps({
  permsShowDetail,
  permsShowList,
  refreshPermissions,
  renderPermsDetail,
  showConfirmModal,
});

provideModalsDeps({
  // members imports modals
  updateHandleCreds,
  acceptMention,
  copyTextToClipboard,
});

provideViewsDeps({
  closeAllDetailDrawers,
  loadRoutingTab,
  probeRoutingAvailability,
  refreshRouterMetrics,
  getDetailRouterOpen,
  setAfterDetailClose,
});

provideAuthDeps({
  permsRefreshCreateUI,
});

provideLearnDeps({
  sendCurrentMessage,
});

provideSelectToggleDeps({
  fetchModels,
  refreshRouterRoster: () => {
    if (!$('#mtab-routing')!.hidden) renderRouterRoster();
  },
});
