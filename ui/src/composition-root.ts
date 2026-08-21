// ── Composition root ────────────────────────────────────────────────────────
// The app's wiring, and nothing else: it imports every feature module, hands
// each the dependencies it cannot import for itself, attaches the DOM listeners
// that belong to no single feature, and calls initApp().
//
// This file was legacy.js. It began as the whole console — one 19k-line script —
// and shrank across the extraction phases until only wiring was left. It is
// renamed rather than deleted because what remains is not residue: a composition
// root is where dependency injection belongs.
//
// WHY THE provide*Deps SEAMS SURVIVE. They are not debt. Measured on the module
// graph, 93 of the 175 injected references would close an import CYCLE if they
// became direct imports — modals↔composer, installers↔wizard, transcript↔agents,
// agents↔models, members↔perms. The feature graph is mutually recursive because
// the UI is: a modal opens from the composer and the composer reads the modal's
// mention state. Injection breaks those cycles at one well-known place, which is
// this file. The 82 that did NOT form a cycle became plain imports and are gone.
//
// ORDER IS LOAD-BEARING. The statements below run in source order, and moving one
// changes when its side effect happens. That is not a theoretical hazard: during
// the extraction, relocating a single .vue import by one line shifted eight
// bootstrap events, and moving a stray addEventListener out of here dropped a
// connectivity probe entirely. scripts/check-boot-order.sh records the startup
// sequence and fails on any change; re-record only when the change is intended.
//
// It is TypeScript now. As legacy.js it was the only file in the project outside
// the typechecker (checkJs is off), and the rename surfaced 100 real errors on
// first contact — including five provide*Deps entries supplied to interfaces that
// no longer declared them, which check:deps cannot see because it only detects
// UNDER-supply.

import { marked } from '/marked.min.js';
import { journeyFilter } from './features/journey-state.js';
import { bearerConfirmTimer, sttChosenBackend } from './features/settings-state.js';
import { lightboxOpen } from './features/modals-state.js';
import { attachPickerCfg, pendingFiles } from './features/attach-picker-state.js';
import { helpActive, manageActive, manageTab, matrixWired, topoData, viewStack } from './features/views-state.js';
import { allModels, lastProbeResult, modelSortAz, selectedModelId } from './features/model-list-state.js';
import {
  agentDetailBaseline,
  agentDetailRooms,
  roomDetailWiredAgents,
  showArchivedAgents,
  turnElapsedTimer,
} from './features/agent-detail-state.js';
import {
  routingAvailable,
  routingCurrentRouter,
  routingDraft,
  routingRouterInfo,
  selectedRouteIdx,
} from './features/routing-state.js';
import {
  cloudflaredInstallActive,
  codexInstallActive,
  ollamaPullPoller,
  opencodeGateFromServer,
  opencodeGatePoll,
  opencodeInstallActive,
  routingInstallActive,
  sttInstallActive,
  tailscaleInstallActive,
  ttsInstallActive,
} from './features/installer-state.js';
import {
  agentMcpServers,
  allMcpServers,
  lastMcpProbe,
  lastMcpProbeToken,
  mcpAddInProgress,
  mcpAgentForAdd,
  selectedMcpId,
} from './features/mcp-list-state.js';
import {
  learnTurnToolCount,
  roomAutoLearn,
  roomSortAz,
  selectedRoomId,
  showArchived,
  showHidden,
} from './features/room-list-state.js';
import { agentSortAz, selectedAgentId } from './features/agent-list-state.js';
import { members, membersFilter, usersSortAz } from './features/members-list-state.js';
import DOMPurify from '/dompurify.min.js';

marked.setOptions({ breaks: true, gfm: true });

// $ / lucide / lucideEl / esc now live in core/dom.ts.
import { $, esc, lucide, lucideEl } from './core/dom.js';
import {
  clearBadgeCount,
  closeAllDetailDrawers,
  copyTextToClipboard,
  getAfterDetailClose,
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
import { isAdminView, state } from './core/state.js';

import {
  BULK_COMMANDS,
  acceptMention,
  broadcastSessionCommand,
  fetchMentionablePeople,
  getMentionMatches,
  getMentionSelectedIndex,
  getMentionStart,
  getWiredAgentsForCurrentRoom,
  handleTypingEvent,
  provideComposerDeps,
  renderTypingIndicator,
  sendCurrentMessage,
  setMentionMatches,
  setMentionSelectedIndex,
  setMentionStart,
  setWiredAgentsForCurrentRoom,
  slashKeydown,
  tryActivateMention,
  updateSlashMenu,
  wireComposer,
} from './features/composer.js';

import {
  closeRouteDetail,
  loadRoutingTab,
  probeRoutingAvailability,
  provideRoutingDeps,
  refreshRouterMetrics,
  renderRouterRoster,
  saveRoutingConfig,
  switchRoutingSubtab,
  wireRouterNew,
  wireRoutingPanel,
  wireRoutingProfiles,
} from './features/routing.js';

import { toggleAdmin } from './features/admin.js';
import {
  grantPerm,
  permsCreateComposedId,
  permsRefreshCreateUI,
  permsShowCreate,
  permsShowDetail,
  permsShowList,
  providePermsDeps,
  refreshPermissions,
  renderPermsDetail,
  togglePermissions,
  wirePermsCreate,
  wirePermsNew,
} from './features/perms.js';
import {
  permsActive,
  permsAgents,
  permsCreateChannelTouched,
  permsMyUserId,
  permsSelectedUserId,
  permsUserFilter,
} from './features/perms-list-state.js';
import {
  userCredsConnected,
  userCredsOauthReturnFocus,
  userCredsOauthSessionId,
  userCredsOauthTarget,
  userCredsProvider,
  userCredsState,
  userCredsWords,
} from './features/user-creds-state.js';

import {
  clearStagedFiles,
  closeAttachPicker,
  openAttachPicker,
  provideFilesDeps,
  renderAttachPickerList,
  stageFile,
  stageFiles,
  uploadFile,
  wireFileControls1,
  wireFileControls2,
  wireFileControls3,
} from './features/files.js';

import {
  applyLearningMaster,
  closeLearnMenu,
  hideLearnNudge,
  isLearnUrlToken,
  loadLearningMaster,
  pickLearnTarget,
  promptLearnSource,
  provideLearnDeps,
  renderAutoLearnSetting,
  showLearnNudge,
  toggleLearnMenu,
  triggerLearn,
  wireLearnPanel,
} from './features/learn.js';

import {
  applyCreateAuthDefault,
  applyLoginHint,
  checkAuth,
  ensureServerAuthMethods,
  enterAuthedApp,
  provideAuthDeps,
  reprobeAuthWhenOnline,
  toggleBearerToken,
  wireAuthPanel,
} from './features/auth.js';

// The full-view stack now lives in features/views.ts.
import {
  applyJourneyFilters,
  applyTopoFocus,
  clearTopoFocus,
  closeOverflowMenu,
  closeTopDetailAside,
  closeView,
  hideDetail,
  hideOtherFullViews,
  openFullView,
  openJourney,
  openManage,
  openView,
  provideViewsDeps,
  refreshDashboard,
  refreshJourney,
  refreshMatrix,
  refreshTopology,
  renderHealthStrip,
  renderJourneyFilterControls,
  setTopoFocus,
  showContainersDetail,
  showMessagesDetail,
  svgEl,
  switchManageTab,
  syncManageSortIcon,
  toggleDashboard,
  toggleHelp,
  toggleJourney,
  toggleMatrix,
  toggleTopology,
  updateTopoFocusPill,
  wireViewChrome1,
  wireViewChrome2,
  wireViewsPanel,
  toggleFloor,
} from './features/views.js';

// Modals, overlays and popovers now live in features/modals.ts.
import {
  applyLightboxTransform,
  blockingOverlayOpen,
  closeHandlePopover,
  closeLightbox,
  confirmWithToggle,
  dismissMentionPopover,
  inspectAndConfirmImport,
  navigateLightbox,
  openHandlePopover,
  openLightbox,
  openOauthMintModal,
  provideModalsDeps,
  renderMentionPopover,
  resetLightboxTransform,
  showConfirmModal,
  showInputModal,
  wireLightbox,
  wireModalsPanel,
  wireUserCredsOauth,
} from './features/modals.js';

import {
  closeUserCredsOauthModal,
  deleteUser,
  disconnectUserCreds,
  findMembership,
  paintMembersList,
  provideMembersDeps,
  rememberServerAuthHint,
  renderHandleChip,
  renderMembers,
  renderPermsUserList,
  saveHandle,
  toggleMembersPanel,
  updateHandleCreds,
  updateUserCredsBanner,
  userDisplayName,
  userIsOwner,
  wireMembersOauth1,
  wireMembersOauth2,
  wireMembersPanel,
} from './features/members.js';

import {
  applySettings,
  closeSettings,
  enableWebPush,
  loadSettings,
  openSettings,
  provideSettingsDeps,
  renderAccessSettings,
  renderCredentialsSettings,
  renderHttpsSettings,
  renderRoutingSetup,
  renderSettingsModal,
  renderSttSetupSettings,
  renderTtsSetupSettings,
  saveSettings,
  wireSettingsPanel1,
  wireSettingsPanel2,
} from './features/settings.js';

import {
  addSelectedFromProbe,
  bindDiscover,
  closeModelDetail,
  closeModelPicker,
  discoverModels,
  fetchModels,
  isRouterBackendModel,
  loadOllamaHostModels,
  maybeAssignAfterPickerAdd,
  modelKindLabel,
  openModelDetail,
  openModelPicker,
  populateKnownModelOptions,
  provideModelsDeps,
  renderModels,
  renderPickerList,
  renderProbeResults,
  runProbe,
  setPickerAdd,
  sttPopulateModelSelect,
  syncCreateFormToKind,
  warnIfUnreachable,
  wireModelCreate,
  wireModelsPanel,
} from './features/models.js';

import {
  clearRoomSearch,
  closeRoomDetail,
  continueRoomImport,
  deleteCurrentRoom,
  joinRoom,
  openRoomCreate,
  openRoomDetail,
  provideRoomsDeps,
  putRoomLearning,
  renderRooms,
  reorderPinnedRoom,
  roomColor,
  saveRoomName,
  snapshotRoomImages,
  toggleRoomArchive,
  toggleRoomSettings,
  wireRoomCreate,
  wireRoomDetail1,
  wireRoomDetail2,
  wireRoomDetail3,
  wireRoomDetail4,
  wireRoomDetail5,
  wireRoomsPanel,
} from './features/rooms.js';

import {
  AGENT_STATUS_HINTS,
  addExistingAgentToRoom,
  addNewAgentToRoom,
  agentColor,
  agentDetailSnapshot,
  beginAgentTurn,
  closeAgentDetail,
  continueAgentImport,
  endAgentTurn,
  endAllAgentTurns,
  endpointHost,
  fetchAgents,
  interruptAgent,
  loadAgentRooms,
  markTurnActivity,
  mentionAgentColor,
  openAgentDetail,
  openWireToAgentsPicker,
  populatePermsAgentDropdowns,
  provideAgentsDeps,
  refreshAgentModelTrigger,
  refreshAgentSaveDirty,
  refreshRoomWiredAgents,
  refreshWiredAgentsForCurrentRoom,
  removeAgentKey,
  removeToolSecret,
  renderAgentSecrets,
  renderAgents,
  renderRoomCreateAgentChecklist,
  renderRoomWiredAgents,
  renderToolSecrets,
  setAgentEgressControl,
  setAgentHarnessControl,
  setAgentStatusControl,
  setAgentSubtab,
  showAgentsDetail,
  showDetail,
  toolSecretUrl,
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
  wireCustomScheme,
} from './features/agents.js';

import {
  closeMcpDetail,
  createMcpServer,
  fetchMcpServers,
  loadMcpCatalog,
  maybeAttachAfterMcpAdd,
  openMcpDetail,
  provideMcpDeps,
  renderAgentMcp,
  renderMcpServers,
  renderMcpSources,
  runMcpProbe,
  setAgentMcp,
  syncMcpCreateTransportFields,
  wireMcpCatalog,
  wireMcpPanel,
} from './features/mcp.js';

// The skills surface now lives in features/skills.js.
import {
  loadAgentTemplates,
  renderTemplateLibrary,
  wireAgentTemplateExport,
  wireTemplateLibrary,
} from './features/agent-templates.js';
import {
  applySkillsSections,
  discardSkillDraft,
  draftFor,
  draftKeepButton,
  getSkillEditorDraft,
  handleSkillDraftReview,
  importSkill,
  keepSkillDraft,
  openScopedSkillEditor,
  openSkillEditor,
  openSkillsAdd,
  provideSkillsDeps,
  refreshDraftBadge,
  renderAgentSkills,
  renderDraftEditor,
  renderRoomSkills,
  renderSkillPool,
  renderSkillSources,
  renderSkillsRegistry,
  saveSkillEditor,
  scheduleSkillSuggest,
  setSkillTrust,
  showSkillEditor,
  skillDraftRow,
  wireSkillsPanel,
  wireSkillsRegistry,
} from './features/skills.js';

// The socket and its dispatcher now live in core/ws.js.
import { connect, diagnoseConnection, provideWsDeps, setConnectionBanner } from './core/ws.js';

// The message transcript now lives in features/transcript.js.
import {
  appendMessage,
  appendSystem,
  clearUserScrollMarkers,
  decorateMentions,
  endTranscriptSwitch,
  incrementMissedMessages,
  isNearBottom,
  jumpToMessage,
  loadOlderMessages,
  messageMentionsMe,
  mountTranscript,
  provideTranscriptDeps,
  scheduleFollowScroll,
  scrollToBottom,
  setMessages,
  updateScrollButton,
  wireScrollTracking,
  wireTranscriptPanel,
} from './features/transcript.js';
import { thinkingTurns, turnFor } from './features/transcript-state.js';

import {
  fetchApprovals,
  handleApprovalEvent,
  handleApprovalResolvedEvent,
  respondToApproval,
  wireApprovalsPanel,
} from './features/approvals.js';
import { provideSelectToggleDeps } from './features/select-toggle.js';
import { createApp } from 'vue';
import RouteList from './features/RouteList.vue';
import RouteSuggestions from './features/RouteSuggestions.vue';
import ProbeResults from './features/ProbeResults.vue';
import ModelPicker from './features/ModelPicker.vue';
import Reachability from './features/Reachability.vue';
import PrejudgeActions from './features/PrejudgeActions.vue';
import ToolSecretList from './features/ToolSecretList.vue';
import MyCredentials from './features/MyCredentials.vue';
import Preflight from './features/Preflight.vue';
import { preflightChecks, preflightMessage, preflightPhase } from './features/preflight-state.js';

import { myCredGroups, myCredSaving } from './features/my-credentials-state.js';
import { toolSecretRows } from './features/tool-secrets-state.js';
import { prejudgeRows } from './features/prejudge-state.js';
import { reachError, reachOutcome, reachPhase } from './features/reachability-state.js';
import { pickerEmptyNote, pickerRows, pickerSelected } from './features/model-picker-state.js';
import { probeEmptyNote, probeRows, probeSingle } from './features/probe-results-state.js';
import {
  routeDefaultName,
  routeRows,
  routeSelectedIdx,
  routeSuggestBusy,
  routeSuggestions,
} from './features/route-list-state.js';
import { loadOllamaHosts, ollamaCardId } from './features/ollama-cards.js';
import {
  closeThreadSwitcher,
  createThread,
  deleteThreadConfirm,
  loadRoomThreads,
  loadThreadList,
  openThreadSwitcher,
  provideThreadsDeps,
  roomThreads,
  syncThread,
  toggleRoomThreads,
  updateThreadSyncControls,
} from './features/threads.js';

// Install/pull runners now live in features/installers.js.
import {
  OPENCODE_WIZARD_ELS,
  pollOllamaPulls,
  pollRoutingInstall,
  pollSttInstall,
  pollTtsInstall,
  provideInstallerDeps,
  renderRoutingInstallProgress,
  runCodexInstall,
  runOpencodeInstall,
  runRoutingInstall,
  runSttInstall,
  runTtsInstall,
  startOllamaPull,
} from './features/installers.js';

// The setup wizard now lives in features/wizard.js. Only the 8 entry points
// legacy still calls are imported; the other 34 functions are module-private.
import {
  maybeAutoOpenWizard,
  provideWizardDeps,
  refreshWizardCredState,
  refreshWizardNextGate,
  renderSettingsWizardButton,
  renderWizardFeatures,
  renderWizardOpencodeInstall,
  wizardBusy,
  wizardSelectOllamaModel,
} from './features/wizard.js';

// ── Code block copy / wrap controls ──────────────────────────────────────
// Decorates any <pre> inside a container with a toolbar (language label,
// wrap toggle, copy button). Called after marked+DOMPurify renders agent
// messages. Event handling is delegated on #messages below.

// Auth token + fetch helpers now live in core/api.ts — it owns the token
// because an imported binding cannot be reassigned, and the token is.
import { apiJson, authFetch, getAuthToken, getWsProtocols, getWsUrl, setAuthToken } from './core/api.js';

// showToast / toastError now live in core/toast.ts.
import { showToast, toastError } from './core/toast.js';
// Voice (TTS playback + STT dictation) now lives in features/voice.js. The
// Settings panels below still read/write three pieces of its state, so they go
// through accessors — see the note in that file.
import {
  cancelDictation,
  getSttConfig,
  getTtsReadAloudEnabled,
  initSttFeature,
  isDictationActive,
  loadTtsConfig,
  setSttConfig,
  setTtsReadAloudEnabled,
  speak,
  startDictation,
  stopDictation,
  stopTts,
  ttsPlainText,
} from './features/voice.js';

// Thinking bubbles + reasoning feed. It needs five transcript helpers that are
// still defined below; they are INJECTED (provideThinkingDeps, called once at
// the bottom of this file) rather than imported back, to avoid a cycle through
// this module. See the note in features/thinking.js.
import {
  provideThinkingDeps,
  pushReasoning,
  setThinkingMilestone,
  toggleThinkingExpanded,
  updateThinkingBubble,
} from './features/thinking.js';

/**
 * Three outcomes, not two: 'ok' | 'unauthenticated' | 'unreachable'.
 *
 * The distinction is the whole point. The service worker caches the app shell
 * and serves it cache-first, so the PWA boots fine with no network at all — but
 * `/api/` deliberately bypasses the SW, so this probe goes straight to the
 * network. On a cold start (app launched from the home screen, radio still
 * waking, VPN/Tailscale not up yet, host mid-restart) it can fail while the user
 * is perfectly authenticated. Treating that as "unauthenticated" is what shows
 * the token screen to someone who never needed it — and why a hard refresh
 * "fixes" it: the retry simply succeeds.
 *
 * So: only a real auth verdict (401/403) sends anyone to the login screen.
 * Anything else retries briefly, then defers to the WebSocket reconnect logic
 * and the connection banner, which already handle being offline gracefully.
 */

// ── Text-to-speech ─────────────────────────────────────────────────────────
// Agent replies get a "read aloud" control. Two backends, one affordance:
// server-side synthesis (Kokoro / any OpenAI-compatible endpoint) when the host
// has WEBCHAT_TTS_ENABLED, else the browser's built-in Web Speech API (device
// voices, no backend). See src/channels/webchat/tts.ts and /add-webchat-tts.

// Apply the learning master to the live UI: the composer 🎓 and its nudge only
// exist while learning is on. Agent/room panels re-read the flag when opened.

// Shared post-auth entry: reveal the app, open the socket, and run first-run
// hooks. Called from BOTH initApp (reload with a stored token) and the login
// form (fresh token entry) — the wizard must auto-open in both, not only on a
// later reload, or a just-logged-in owner never sees it.
/**
 * We entered the app without a verdict (see checkAuth). Once the network is
 * genuinely back, settle it: a real 401/403 means show the login screen after
 * all. Runs at most once, and only while still on the optimistic path.
 */

// ── Suggest retiring the bearer token once a stronger identity is live ───────
// Fires when THIS session authenticated via Tailscale/proxy (not bearer), the
// shared bearer token is still active, and it's safe to drop (an alternative
// method works). That's the natural moment — e.g. right after the first
// Tailscale login is promoted to owner — so the operator doesn't have to hunt
// through Settings. Dismissible; the same control lives in Settings → Access.

async function initApp() {
  const verdict = await checkAuth();
  if (verdict === 'ok' || verdict === 'unreachable') {
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

// Whether this server uses Tailscale auth. Cached from /api/auth/info and
// persisted to localStorage so the connection-lost banner can suggest starting
// Tailscale even when the device is currently offline (cold start, no network).

// ── Connection diagnosis ───────────────────────────────────────────────────
// "Reconnecting…" alone can't tell the user WHERE the path broke. Three states
// are distinguishable from a browser:
//   offline — navigator.onLine is false (no network at all)
//   no-path — an internet probe succeeds but the server stays unreachable; on
//             a Tailscale-auth install that means Tailscale is off on THIS
//             device (we can't probe tailscaled itself: Quad100 is plain HTTP,
//             blocked as mixed content from an HTTPS page)
//   unknown — the probe failed too; plain "no internet" wording
// The probe races two no-cors /generate_204 fetches (Tailscale's own DERP
// relay + gstatic; both CSP-allowed in server.ts): an opaque response
// resolving proves internet works without reading any content. Throttled —
// reconnect retries fire on a backoff and don't each need a fresh probe.

// Best-effort: cache the server's auth mode even for already-authenticated
// users who never see the login screen (so applyLoginHint never runs for them).

/**
 * Fetch `/api/auth/info` and rewrite the login subtitle so the user knows
 * what's expected (Tailscale on this device vs token entry vs server
 * misconfig) instead of facing a generic token prompt.
 *
 * The common failure mode is the client device (this phone / laptop) not
 * having Tailscale running — the server's almost always fine because the
 * operator had to install Tailscale to set up this server in the first
 * place. The copy reflects that.
 */

wireAuthPanel();

// ── Settings ──────────────────────────────────────────────────────────────

state.settings = loadSettings(); // state.js cannot call this yet

// ── Token usage (Settings → Token usage, owner-only) ──

// ── Workspace credentials policy (Settings → User credentials, owner-only) ──

// ── Settings → "Run setup wizard" (owner/global-admin only) ──────────────────

// ── Self-test (preflight) ────────────────────────────────────────────────────
// Runs capability checks (tailscale, docker, container→host networking) from
// the vantage point that matters and shows verdicts + copy-paste fixes. Owner-
// gated to match the endpoint (GET 401s everyone else → section stays hidden).

// ── Access & security: bearer-token retirement ───────────────────────────────
// Owner/global-admin only (GET 403s everyone else → section stays hidden). The
// bootstrap bearer token can be retired once Tailscale or SSO/trusted-proxy is
// live; the server refuses to disable it otherwise, so the UI only offers the
// action when it will actually be accepted.

// ── HTTPS over Tailscale (`tailscale serve`) ─────────────────────────────────
// Owner/global-admin. Shown only when tailscaled is detected up on the host.
// Enabling fronts webchat with a real *.ts.net cert so it's a secure context
// (PWA install / push / voice). Identity stays continuous across http→https
// (auth.ts maps Serve's header back to the whois id), so an owner claimed over
// http://<node>.ts.net:PORT stays owner over https.

// Show/hide the MCP + Skills nav for the current session (admin AND enabled).
/**
 * Credential isolation — an install policy, shown only to someone who can change
 * it. `credentialIsolation` is null when no choice has been made here, in which
 * case .env decides and the row says so; the toggle still reflects what is
 * actually in force (`credentialIsolationEffective`) so it never contradicts
 * the agent panel's "Not private yet" note.
 */

// ── First-run setup wizard ───────────────────────────────────────────────────
// Owner/global-admin only. Auto-opens on first login while onboarding is
// incomplete (see maybeAutoOpenWizard); re-openable from Settings. Every step is
// skippable and reuses existing endpoints. Closing (X) or reaching Finish marks
// onboarding complete so it never re-nags.

// Codex install DOM sets — the wizard engine step and Settings → User credentials
// drive the SAME two-phase server install (/api/codex/install: build → host
// restart). Each surface passes its own element ids so one runner serves both.

// The wizard OpenCode install-row: offered (prominently, one-click) once a local
// Ollama model is the workspace default and OpenCode isn't installed — because the
// built-in harness confuses small models. Not auto-run: installing rebuilds the
// image and RESTARTS the host, which would yank the wizard session out from under
// the operator, so it's a deliberate click (the restart-poll handles reconnect).
$('#wizard-opencode-install')?.addEventListener('click', () => runOpencodeInstall(OPENCODE_WIZARD_ELS));

/**
 * Reflect live credential state on the engine list: connected engines swap
 * their connect controls for a prominent ✓ card (standard OAuth-connect UX —
 * the action you completed disappears), and the radio chips update without a
 * wizard reopen. Also greys Codex out when its provider isn't installed.
 */

/** Reveal the wizard's install-Ollama row when nothing answers locally (Linux
 *  only), or prefill the endpoint when a local Ollama is already running. */

// Accordion: only the selected engine's connect controls are expanded.
// True once the engine picked in step 0 has a usable credential/default set, from
// the last refreshWizardCredState snapshot. Gates the step-0 Next so the operator
// can't advance with an engine that can't answer a message.

// Block advancing/finishing while OpenCode is installing. The install ends in a
// host restart that auto-assigns the harness and respawns the agent container —
// finishing before that settles drops the operator into chat just as their first
// message gets killed mid-turn. opencodeInstallActive.value stays true across the whole
// build + restart poll, so this holds Next/Finish until the harness is stable.
/**
 * Put an async wizard button into a busy state: disabled, label swapped, and a
 * small inline spinner — the "doing something" signal lives ON the control the
 * user just pressed. Returns a restore function for the finally block.
 */

// Step 1 "Features" — reflect the MCP + read-aloud toggles from state and surface
// the TTS voice-model install (same /api/webchat/tts/install as Settings → Features,
// via the shared runTtsInstall/pollTtsInstall with wizard element ids).
// Wizard voice-dictation control — mirrors Settings → Features → Voice dictation:
// pick a backend (Local whisper.cpp / ElevenLabs cloud), install (local) or connect
// a key (ElevenLabs). Drives the same /api/webchat/stt/install as Settings via the
// shared run/pollSttInstall. Owner-only: the endpoint 403s → the whole block hides.

// One-click Tailscale install (wizard Access step). Runs the install + sign-in on
// the host; `tailscale up` prints its auth URL into the log for the operator to
// open. Same install-row + progress-log shape as the other wizard installers.

// Persist the @handle from the Settings field. Inline feedback (per DESIGN.md):
// success/taken/invalid all surface on the #handle-status line, not a toast.

wireModalsPanel();

// ── Voice dictation (capture → /api/stt/transcribe → composer) ──────────────

/** Recording chrome: mic ⇄ red pulsing stop square + elapsed chip (the
 *  standard voice-recorder idiom, so state is unmistakable at a glance). */

/** Wrap accumulated PCM16 frames in a minimal 16 kHz mono WAV container. */

/** Close the current segment and ship it for transcription (if it held speech). */

/** Per-frame handler: RMS gate → segment bookkeeping → cut on pause/length. */

/** Stop capture, flush the tail segment, wait for transcripts, then tidy. */

/** Esc = cancel: discard everything dictated, restore the prior composer text. */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isDictationActive()) {
    e.preventDefault();
    cancelDictation();
  }
});

/**
 * Tidy the dictated span via the server's cleanup model. The replacement goes
 * through execCommand('insertText') over a selection of just the dictated
 * text, so the native undo stack (Ctrl/Cmd+Z) restores the raw transcript.
 */

$('#mic-btn')?.addEventListener('click', () => {
  if (isDictationActive()) stopDictation();
  else startDictation();
});

/** Post-auth: reveal the mic when the server has an STT backend configured. */

// ── Settings → Features → Voice dictation (install + config, owner-only) ────
// Backend segmented Local/ElevenLabs; Local shows the hardware-suggested model
// select + Install, ElevenLabs swaps to key + Connect. Same install-row/log/
// badge flow as Read aloud, through /api/webchat/stt/install.

// ── Settings → Features → Auto-learn (workspace master, owner-only) ─────────
// The master kill switch for the learning loop. Owner-gated (the section hides
// for non-owners). Off disables learning workspace-wide and, via the flag,
// removes the per-agent / per-room learning controls. Behavior applies to each
// agent on its next spawn.

// ── Settings → Approval pre-judge (owner-only) ──────────────────────────────
// An optional LLM triage tier in front of approval holds (docs/webchat/
// approval-prejudge.md). Judge model Off = feature off; the action opt-ins
// appear once a judge is set. Never-listed actions render disabled — they
// always reach a human, no matter what.

// ── Settings → "Set up routing" (one-click add-routing install) ─────────────
// Owner-only (the /api/router/install endpoint 403s otherwise, hiding the whole
// section). Scaffolds routing + pulls the classifier model, then the Routing tab
// appears via probeRoutingAvailability().

// ── Sidebar overflow menu (Dashboard / Permissions / Settings) ──────────────
// Replaces the three unlabeled glyph buttons with one self-labeling menu, so
// the occasional surfaces are discoverable (no more cryptic ▦/key/⚙ icons).
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
  else if (action === 'routing') openManage('routing');
  else if (action === 'journey') toggleJourney();
  else if (action === 'floor') toggleFloor();
  else if (action === 'topology') toggleTopology();
  else if (action === 'wiring') toggleMatrix();
  else if (action === 'dashboard') toggleDashboard();
  else if (action === 'permissions') togglePermissions();
  else if (action === 'admin') toggleAdmin();
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

// Image lightbox — opened from file-bubble image clicks. Closes via ×, backdrop tap,
// ESC, or device back gesture. pushState lets the OS back gesture / Android back
// button dismiss the viewer instead of leaving the app (the common mobile pain).
//
// Features: prev/next nav over all images in the current room, pinch-zoom +
// drag-to-pan on touch, native browser zoom on desktop, loading spinner for
// slow images, explicit download button, fade-out on close, body-scroll lock.

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

// True when a modal / popover / menu is open that should consume Escape before a
// full-screen view does. These each have their own ESC handler (bubble phase);
// the view-close handler below runs in the CAPTURE phase, so it sees the overlay
// still open and yields to it — one Escape closes exactly one layer.

// Escape closes the topmost full-screen view (dashboard, topology, wiring,
// permissions, agents/models) — the same path as its Back button, so history
// and the OS back gesture stay in sync. Capture phase so it can defer to any
// open modal/menu (which closes on its own bubble-phase handler instead).
// Detail asides (model/agent/MCP/members) sit one layer above their view:
// Escape closes the aside first, the next Escape closes the view — same
// "one layer per press" rule as everything else (DESIGN.md §4).

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

// Font size selection

// Send key selection

// Read aloud (Settings → Features) — WORKSPACE-level: the owner flips it for
// everyone (PUT /api/tts/config, owner-gated server-side). Newly rendered
// messages pick it up immediately; existing bubbles on next render; other
// members see it after their next reload. Server voices when the
// /add-webchat-tts backend is on, device voices otherwise.

// Notifications toggle — handles both foreground Notifications and Web Push

// @handle save — button click and Enter-in-field both commit.
$('#handle-save')?.addEventListener('click', saveHandle);
$('#handle-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveHandle();
  }
});

// A–Z sort toggles per list. Off = the list's natural "auto" order (rooms by
// recent activity, agents newest-first, models by provider); on = alphabetical.

// Load my @-mention handle (server-stored, settable in Settings). Used to
// highlight + notify when a message @-mentions me. Best-effort.

// True when `text` contains an @-mention of the current user's handle. Mirrors
// the token boundary used by decorateMentions so highlight + notify agree.

// iOS/mobile: when the app returns from background, the WebSocket may be
// silently dead without onclose firing. Force a full reconnect on resume.
// Also: even when the socket is alive, browsers can throttle a backgrounded
// tab so that WS-pushed approvals never get rendered. On foreground, refetch
// the canonical pending-approvals list so anything that arrived while we
// were hidden surfaces immediately. (If we have to reconnect, fetchApprovals
// also runs from the system message handler — so this branch is the
// "WS still up but we may have missed an event" case.)
wireVisibilityRefresh();
const APPROVAL_POLL_MS = 10000;
setInterval(() => {
  if (document.visibilityState === 'visible') fetchApprovals();
}, APPROVAL_POLL_MS);

// Sentinel rendered as a horizontal rule between the pinned group and the rest.

// Deferred retry for renderRooms when it's skipped because a kebab menu is
// open — see the guard at the top of renderRooms.

// Id of the pinned room currently being dragged for reorder (null while
// dragging an unpinned room to pin it, or when nothing is dragging).

// Move a pinned room before/after another within the pinned group and persist
// the new order. Optimistic: reindex pin_position locally and re-render, then
// POST; the server's broadcastRooms re-syncs authoritative order to every device.

// Touch-friendly pinned-room reorder: drag is mouse-only (native HTML5 DnD
// doesn't fire from touch), so the kebab's Move up / Move down call this to swap
// a pinned room with its neighbour. Same optimistic reindex + persist as
// reorderPinnedRoom. `dir` is -1 (up) or +1 (down).

// ── Threads ─────────────────────────────────────────────────────────────────
// A webchat thread maps to an isolated agent session. The sidebar nests a
// room's threads under it; switching a thread re-joins the room scoped to that
// thread (server filters history). See docs/webchat/threads.md.
// Single source of truth for a room's threads (roomId → threads[]), keyed by
// room. The active room's threads are just threadCache.get(currentRoom) — see
// roomThreads(). loadThreadList/loadRoomThreads write it; render reads it. One
// cache means one invalidation point (no roomThreads-vs-threadsByRoom drift).

// One-shot message queued behind a programmatic room switch (the Skills page's
// 'Add from link…'): sending in the same tick as the join loses the optimistic
// bubble to the incoming history render, so the 'history' handler flushes this
// once the transcript is in place. Same idiom as pendingJumpMessageId.

// Smooth room/thread switches: instead of blanking the transcript to a
// "Loading…" flash (a jarring gap while the async `history` message is in
// flight), keep the previous messages visible but dimmed until the new history
// arrives and swaps them in (the 'history' handler calls endTranscriptSwitch).
// A fallback un-dims if history never lands (e.g. a socket hiccup).

// ── Message search (FTS) ────────────────────────────────────────────────────
// Sidebar search across the user's accessible rooms. Results replace the room
// list while a query is active; clearing the box (or picking a result) restores
// it. Backend: GET /api/search (scoped server-side to rooms the user can see).

wireRoomsPanel();

// Stable per-name colour for a2a side-channel agent labels. Hashes the name to
// a hue so the same agent is always tinted the same; fixed saturation/lightness
// stay legible on both the light and dark themes.

// Render an in-room approval card. Actionable (approve/deny buttons) only for
// users in the card's `approvers` list — others see a read-only "pending" note.
// A resolved card renders as a static note. Tagged with data-question-id so the
// approval_resolved handler can update it in place.
// Learning loop: an agent proposed a skill from the work it just did. The card
// lands in ITS OWN room so you can Keep/Discard in context — same shape as the
// approval card. Keep wires it scoped to the proposing agent (no fan-out).

// `beforeNode`, when given, inserts the message before that node instead of at
// the bottom — used to PREPEND older messages during scroll-back pagination.

// ── Scroll-back (older-message pagination) ──────────────────────────────────
// Join loads only the most recent window; older history (it's all in SQLite)
// is fetched on demand when the user scrolls to the top, via ?before_id=. State
// is reset per room in the `history` handler above.
// During a search-jump we page older history in a tight loop; suppress
// loadOlderMessages' per-page scroll re-pin so the viewport doesn't bounce —
// jumpToMessage does one clean scroll at the end instead.

// Center + briefly flash a specific message (used by search-result clicks). If
// the target isn't in the loaded window, page older history in until it appears
// (or we run out / hit a safety cap), then scroll to it. Reuses the same
// ?before_id= pagination as scroll-back, so no backend change is needed.

// ── Toasts + confirm modal ────────────────────────────────────────────────
// One feedback vocabulary for the whole app. showToast replaces post-action
// alert()s; showConfirmModal replaces destructive confirm()s. Both reuse the
// existing modal-overlay / toast container styling so there are no native
// browser dialogs in the installed PWA.

/**
 * Transient corner notification. `kind` is 'info' (default), 'success', or
 * 'error'. Errors linger longer and must be dismissed-or-time-out; all toasts
 * are click-to-dismiss. Returns the element so callers can remove it early.
 */
// ── UserCreds: per-member key banner ───────────────────────────────────────────
// Shown in a room whose credential_mode is optional/required when the current
// user hasn't connected their own Anthropic key. Connecting onboards the key
// into the OneCLI vault (host-side) so the member's turns bill their account.
// The room's model provider decides the connect vocabulary + which mint runs.
// Latest banner state, so the @handle popover credentials shortcut can mirror it.
// Whether the member has a connected credential for the open room — drives the
// 🔑 indicator on the @handle chip (the standalone key chip was merged into it).

wireMembersPanel();

// The same modal serves three flows: a MEMBER connecting their own credential
// (per-member endpoints, room-gated), and the OWNER setting a WORKSPACE DEFAULT
// (admin-only endpoints, no room) for Claude ('workspace') or Codex
// ('workspace-codex'). `userCredsOauthTarget.value` selects the endpoints.
$('#user-creds-oauth-btn')?.addEventListener('click', () => openOauthMintModal('member'));

$('#user-creds-oauth-cancel')?.addEventListener('click', closeUserCredsOauthModal);
$('#user-creds-oauth-close')?.addEventListener('click', closeUserCredsOauthModal);
// Click the backdrop (outside the modal card) to close.
wireMembersOauth1();
// Escape closes; Tab is trapped within the dialog (a11y, matches other modals).
// Auto-submit once a code is pasted (Claude path) — no separate Connect click.
$('#user-creds-oauth-code')?.addEventListener('paste', () => {
  setTimeout(() => {
    const submit = $('#user-creds-oauth-submit');
    if (submit && !submit.hidden && ($<HTMLInputElement>('#user-creds-oauth-code')?.value || '').trim()) submit.click();
  }, 0);
});

wireUserCredsOauth();

/**
 * Promise-based confirmation modal. Resolves true on confirm, false on
 * cancel / backdrop / Escape. `body` may be a string or an HTMLElement (use an
 * element when the message contains user-supplied text, so it stays escaped).
 * `destructive` styles the confirm button as a delete action and focuses
 * Cancel by default.
 */
// `extraActions` (optional): buttons rendered between Cancel and the primary
// Confirm, each `{ label, value, className? }`. Clicking one resolves the promise
// with its `value` (Confirm still resolves `true`, Cancel/Escape `false`), so a
// caller can offer more than a yes/no without a bespoke modal.
// `beforeConfirm` (optional): runs on every confirm attempt (button or Enter);
// returning false keeps the modal open — the inline-validation hook.

/** Single-line text prompt in the app's modal chrome — replaces native prompt()
 * (unstylable, ESC-inconsistent, blocked in some PWA contexts). Returns the
 * trimmed value, or null on cancel/empty.
 * `validate(trimmedValue)` (optional): return an error string to keep the modal
 * open with that message inline (DESIGN §5 — field validation is inline text),
 * or null/undefined to accept. */

// Coalesce multiple image-load re-scroll requests into a single rAF call so
// many simultaneous loads don't queue up overlapping scrollTo invocations.

// Delegated clicks for code-block toolbar buttons (copy + wrap).

wireScrollTracking();
wireTranscriptPanel();
wireComposer();

/**
 * Walk a rendered bubble's text nodes and wrap `@<slug>` tokens in a styled
 * span. Cosmetic only — even if the token doesn't match a wired agent, the
 * styling tells the user "this looks like a mention." Server-side matching
 * is what actually decides routing.
 */
// Map a mention handle (folder/slug) to its wired agent's colour, matching the
// per-name tint used on a2a labels. Humans / unknown handles → null (default chip).

// ── Members panel ─────────────────────────────────────────────────────────

// Render #members-list from currentMembers, applying the search filter. Split
// from renderMembers so the search box can re-paint without a re-fetch.

$('#members-toggle')!.addEventListener('click', toggleMembersPanel);
$('#members-close')!.addEventListener('click', toggleMembersPanel);
$('#members-search')?.addEventListener('input', (e) => {
  membersFilter.value = (e.target as HTMLInputElement).value.trim().toLowerCase();
  paintMembersList();
});
wireMembersOauth2();

// Shared tap-to-close for #agent-detail / #room-detail / #model-detail. There
// are 14-ish call sites that toggle `.hidden` on those panels; rather than
// patch each one, a MutationObserver mirrors panel state onto the backdrop.
wireDetailOverlay();

// ── Sidebar tabs ──────────────────────────────────────────────────────────
// ── Manage section (Agents / Models) ────────────────────────────────────────
// Full-screen surface reached from the ⋯ menu — replaces the old sidebar
// Agents/Models tabs (the sidebar is now Rooms-only). Router-managed so the
// back gesture returns to chat; detail panes (z-index above) overlay it.
$('#manage-back')?.addEventListener('click', () => closeView('manage'));
wireManageTabs();

// Draft-editor state. Non-null while the SKILL.md editor is showing a DRAFT
// (as opposed to an installed skill) — saveSkillEditor branches on it.

// A self-contained SKILL.md viewer/editor modal that overlays the CURRENT view
// (opened from the agent page, so you never leave it). onSave(content) returns a
// promise; a thrown error keeps the modal open and surfaces the message.
// `actions` (optional): [{ label, onClick }] — low-emphasis buttons rendered
// before Cancel/Close; clicking one closes the modal, then runs onClick (e.g.
// the scoped editor's 'History' jump into Journey).

// View/edit a skill scoped to ONE agent (its own .claude-shared/skills — where a
// learned-and-kept skill lives). Opens the in-place modal. Scoped skills only
// affect that agent, so a per-group admin may edit; the server re-checks.

// View a shared-pool skill from the agent page, in-place. User-pool skills are
// editable (server enforces owner/global-admin on save); built-ins are read-only.

/**
 * Undo window: swaps an actions row for a sliding countdown + Undo. The action
 * commits when the bar empties; Undo restores the row untouched. The timer only
 * ever starts from a human CLICK — automation (auto-keep) stays instant — and a
 * tab closed mid-countdown commits nothing: the draft simply stays pending,
 * which is the safe default.
 */
/** Paint the editor from skillEditorDraft (diff-review or edit mode). */

wireSkillsPanel();

// Swaps actionsEl's children for a countdown (label + draining bar + Undo)
// and calls onCommit(restore) when it expires. The container's width is
// frozen for the countdown: the undo widget is wider than the buttons it
// replaces, and letting it grow the box squeezes the sibling info column —
// the row's name wraps and its description re-truncates (DESIGN.md: a state
// change alters only the control, never sibling typography or layout).
// onCommit receives `restore`: callers whose row lives on after the commit
// (Keep → 'Reviewing…') call it to put the original buttons back; callers
// whose row is about to disappear (Discard, thread delete) ignore it.

// Draft ids whose keep is under server-side overlap review (Keep pressed,
// 202 received, outcome not yet pushed). A re-render keeps those rows in
// their 'Reviewing…' state, and the WS handler re-enables exactly the right
// button. Per-draft, so OTHER drafts stay keepable in parallel.

/** The Keep button currently rendered for a draft (null after navigation). */

/** Reflect a draft's in-flight review on its Keep button, if one is rendered. */

// Async keep-review outcome, pushed by the server after a 202-queued Keep.
// kept → success toast + list refresh; overlaps → the overlap-choice modal
// (re-drives keep with force/updateTarget); error → toast. Fires on every
// open tab of the pressing user, so the outcome lands as a toast even after
// navigating away from the Skills view.

// Keep a staged draft. A plain Keep is asynchronous: the server validates,
// answers 202 { queued: true }, runs the (slow, LLM-backed) overlap review in
// the background, and pushes the outcome as a 'skill_draft_review' WS event —
// so only THIS row goes busy, other drafts stay keepable, and navigation is
// never blocked. force / updateTarget skip the review and resolve here.

// No confirm modal here: every caller arms the 10s undo timer first — the
// countdown IS the confirmation, and stacking a modal on top of it double-asks.

// Learning loop: the same skill learned independently on 2+ agents → offer to
// promote ONE copy to the shared pool. Owner-gated server-side; the section
// simply stays hidden for everyone else (403 → empty).

// ── Skills page sections: 'Workspace' (the shared pool) first, then one
// section per agent that carries scoped skills. Collapse state is remembered
// per section (same idiom as the Ollama server cards): Workspace defaults
// open, agent sections default closed.
// One visibility pass over the rendered list — no re-fetch, no re-render.
// Without a query: headers always visible, rows follow the persisted collapse
// state. With a query: rows show iff name+description match, sections with
// matches are forced open, empty sections hide entirely.

// Update checks ride AFTER render (one GitHub probe per pinned import, cached
// server-side an hour) — rows get an Update button as results land. Imports
// from before SHA-pinning simply never show one.

// ── SKILL.md editor — view any skill; create/edit user skills (the upload +
// manual-edit path). Built-ins are read-only (repo files).

// Three sub-views: browse (the list), add (catalog + URL import), editor.
// Leaving the editor always drops draft mode — the next opener (an installed
// skill, or "write your own") starts from a clean slate.
// Guards against a second closeView('skill-editor') firing before the first
// history.go settles (e.g. saveSkillEditor closes, then re-renders the list,
// which closes again) — two go() calls would over-pop and close Manage.

// ── Add view: browse well-known collections + import by URL ────────────────
// Trust is a deliberate top-level mode (Official vs Community), not something
// that mutates as you flip a mixed source dropdown. The source picker only ever
// lists one tier's collections, so switching sources never changes trust chrome.

// A network-loading list row: inline spinner + label, matching the busy-button
// spinner (.btn-spinner) so "loading" reads the same everywhere.

// Stable hue from a label, so every collection keeps its own distinct colour
// across renders — and any newly added collection gets one for free. The green
// band (~90–175°) is skipped so a community colour never reads as the reserved
// official green (Anthropic ≈148°); the hash maps into the remaining wheel.
// labelHue and originBadgeEl moved to features/origin-badge.ts in phase 4.2j.
// Ten call sites across mcp.ts and skills.ts import them directly now, and the
// islands need the same decisions available declaratively — so the module
// exports originBadgeProps() and both renderers read from it.

// Switch trust tier: toggle the segment, gate the search box to Community (the
// persistent community warning too), then load that tier's merged pool.

// Render ONE merged, badged pool for the current tier. Community pools every
// collection + the awesomeskill.ai marketplace equally; the search box filters
// it. No per-source picker — each row's origin badge carries (and links to) its
// provenance.

// Adding a skill asks WHICH agents up front — the same multi-select attach picker
// MCP uses. Each toggle wires the skill to just that agent (per-agent scoped
// import, no pool fan-out); "Wire to all agents" does the shared-pool import.

// The pre-import gate: fetch the skill's contents (nothing is written) and show
// what's inside — files, scripts, size, external links, lint findings — before
// the user commits. Falls back to a text-only confirm if inspection fails, so a
// GitHub hiccup can't brick importing.

// Filter-as-you-type over the rendered sections — a pure visibility pass, so
// a light debounce is plenty even with a large registry.

// ── 'Add from link…' — learn a skill from a URL, run by an agent ───────────
// /learn is room-mediated by design: the command must run IN a session of the
// chosen agent, so we resolve one of its webchat rooms, join it, and send
// `/learn <url>` as the user — the command and the draft card that follows are
// visible in the room, exactly like typing it there.

// ── Settings: skill-collections registry (global admin) ────────────────────
// Owners/global admins manage the Skills tab's catalog sources: label + a
// GitHub folder URL per collection. Server verifies the folder actually lists
// skills before saving.

// Import-by-URL now asks which agents up front (same picker as the catalog rows).

// ── Approvals ─────────────────────────────────────────────────────────────

wireApprovalsPanel();

// ── Mobile back button ────────────────────────────────────────────────────
wireMobileBack();

// ── Dashboard ─────────────────────────────────────────────────────────────
// On-open + manual refresh only — no background polling. The dashboard
// surfaces a snapshot of webchat-internal state (rooms, sessions, agents,
// 24h messages) plus host-level system metrics for owner-only callers.
// Non-owner admins see a graceful-degrade view: their visible agents,
// session count, channel breakdown — no system info or busiest-rooms.

// The full-width surfaces (dashboard/permissions/topology/matrix) are flex
// siblings of #chat — only one may be visible at a time, or they'd split the
// pane. Each opener hides its peers synchronously (the router stack still
// unwinds normally on back).

wireViewChrome1();
$('#journey-back')?.addEventListener('click', toggleJourney);

// A floor desk is a link to its room. Delegated: the grid is re-rendered on
// every poll, so per-desk listeners would be re-attached every few seconds.
// Wired here rather than in views.ts because joinRoom lives in rooms.ts and
// views.ts importing it would close an import cycle.
$('#floor-grid')?.addEventListener('click', (e) => {
  const desk = (e.target as HTMLElement | null)?.closest('.floor-desk') as HTMLElement | null;
  const roomId = desk?.dataset.room;
  // Agent-shared sessions and non-webchat rooms carry no room id; leave the
  // desk inert rather than navigating somewhere that 404s.
  if (!roomId) return;
  toggleFloor(); // close the floor first, so the room lands on the chat view
  joinRoom(roomId);
});
// Feed rows link to their room the same way desks do (and for the same
// delegation reason: the feed re-renders on every poll).
$('#floor-feed')?.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement | null)?.closest('.floor-event') as HTMLElement | null;
  const roomId = row?.dataset.room;
  if (!roomId) return;
  toggleFloor();
  joinRoom(roomId);
});
$('#journey-refresh')?.addEventListener('click', () => void refreshJourney(true));
wireViewsPanel();

// ── Journey filters ─────────────────────────────────────────────────────────
// Agent select options come from the loaded feed (plus a deep-linked agent),
// so no extra endpoint is needed; they grow as 'Load more' pages in.

$('#topo-focus-pill')?.addEventListener('click', clearTopoFocus);

// Open the settings drawer for a clicked topology node. The detail drawers are
// fixed overlays (z-index 110), so they layer over the graph and closing one
// returns here. fetchAgents/fetchModels are lazy so the lookup data exists even
// when the user jumped straight to the topology view.

// ── Wiring matrix (rooms × agents management console) ──────────────────────
// Same /api/topology data as the graph, rendered as a grid: tap a cell to
// wire/unwire via the existing endpoints. Empty cells make gaps visible. Agents
// shown are those in use (wired somewhere); brand-new unwired agents appear once
// wired via a room's add-agent flow. Plain table — sticky headers, scrolls on
// mobile.
$('#matrix-back')?.addEventListener('click', toggleMatrix);
$('#matrix-refresh')?.addEventListener('click', refreshMatrix);

// Help — a static full-view (no data to load); same open/close mechanics as the
// matrix/topology dashboards so the back gesture and view stacking work for free.
$('#help-back')?.addEventListener('click', toggleHelp);

$('#perms-user-search')?.addEventListener('input', (e) => {
  permsUserFilter.value = (e.target as HTMLInputElement).value.trim().toLowerCase();
  renderPermsUserList();
});

// findRole, auditTooltip and buildToggleRow moved out in phase 4.2g. The first
// two are pure and live in features/perms-audit.ts; the third built the
// Owner/Global-admin rows and is now the PermsGlobalToggles template. Nothing
// outside renderPermsDetail ever called any of them.

/**
 * Toggle a permission on or off. `granting=true` calls /grant; false calls
 * /revoke. The cell is briefly disabled while the request is in flight, then
 * the canonical state is re-fetched from the server.
 */

// Wiring
$('#perms-exit')!.addEventListener('click', togglePermissions);
$('#admin-exit')!.addEventListener('click', toggleAdmin);
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

// Router traffic panel: per-model request counts from the routing decision
// log (the shadow hook classifies every LiteLLM completion, so the log IS
// the request ledger). Owner-only; the section stays hidden when the

$('#dash-detail-close')!.addEventListener('click', hideDetail);

// ── Agent management ────────────────────────────────────────────────────────

// Archived agents are hidden by default (server-side). The Agents tab can opt
// in to see them so they can be unarchived; pickers/topology never do.

// Reflect the agent's egress mode on the segmented control + badge. 'none' is
// only settable via ncl, so if an agent carries it, show it read-only rather
// than silently rendering as one of the two we offer.

// Reflect the agent's status on the 3-button segmented control + hint.

// Switch the agent harness (provider). Restarts the group's containers, so it's
// an admin action with a restart toast. OpenCode is gated server-side on the
// stack being installed (400 if not).
wireAgentsPanel();

// Known Anthropic model ids for the "Anthropic model" datalist. Fetched once per
// page load; a failure is silent because the field is free text either way.

// Status control: each button PUTs the new status, then refreshes the list so
// the badge + (if archived) visibility update immediately.

// "+ Wire to room" opens the shared attach picker — toggle the agent in/out of
// any room. (Rooms are created from the room list, so no "+ Add new" here.)

// Active sessions for an agent, each with a Reset control that injects /clear
// host-side — the only way to clear a background a2a session (a room-typed
// /clear only reaches the session you're in). Admin-gated server-side.

// Per-agent skills: list every available skill with a toggle reflecting whether
// this agent loads it. Changes batch behind Save (one PUT → one respawn) rather
// than restarting the agent on every toggle.

// Skills wired to this one agent (imported into its own dir) + the import row.

// Learning defaults (agent-level layer): two On/Off pill pairs backed by the
// per-agent API. Room 🎓 settings override these — the section says so. The
// whole accordion hides for non-admins (the GET 403s).
/** Confirm modal with one switch option — the modal twin of .setting-toggle
 * (DESIGN.md §2b: binary choices are switches, never raw checkboxes). */

// ── Agent export / import (backup Phase 1) ──────────────────────────────
wireAgentControls1();

// ── Room export/import (backup Phase 3) ──
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

// Settings → "Import…" routes by bundle type: peek is cheap, both flows
// share the room/agent file inputs' logic.
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

// ── System backup (Phase 2) ──
$('#system-export-btn')?.addEventListener('click', async () => {
  const { ok, checked } = await confirmWithToggle({
    title: 'Download system backup?',
    toggleLabel: 'Lean (skip conversation history — much smaller)',
    note: 'Secrets and host identity never travel; a restored install keeps its own credentials.',
    confirmLabel: 'Download',
  });
  if (!ok) return;
  // Fetch rather than point an <a> at the URL. An anchor navigation has no
  // status check, so a refusal was saved to disk as though it were the backup:
  // a non-owner got a 22-byte file containing {"error":"Owner only"} and a
  // green "Backup started" toast. The endpoint carries guards:['owner'], so it
  // was never a data leak — but "it worked" was exactly the wrong thing to say.
  showToast('Preparing backup — this can take a while for large installs', { kind: 'info' });
  let blob: Blob;
  try {
    const res = await authFetch(`/api/system/export${checked ? '?lean=1' : ''}`);
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
  // Filename comes from the server's Content-Disposition when it sets one;
  // an object URL has no name of its own, so without this the file lands as
  // a bare uuid.
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
// A single bottom-sheet reused by every "attach" surface. The caller supplies a
// config describing the item source, how to render/search a row, whether an item
// is already attached, and what to do on toggle. Reuses the model-picker chrome.

$('#attach-picker-close')!.addEventListener('click', closeAttachPicker);
$('#attach-picker .model-picker-backdrop')!.addEventListener('click', closeAttachPicker);
$<HTMLInputElement>('#attach-picker-search')!.addEventListener('input', (e) =>
  renderAttachPickerList((e.target as HTMLInputElement).value),
);
$('#attach-picker-add-new')!.addEventListener('click', () => attachPickerCfg.value?.onAddNew?.());

// "+ Attach server" now opens the shared picker (attach/detach any registry
// server; "+ Add new server" creates one and auto-attaches).
wireAgentControls3();
// State for the attach picker's "+ Add new server": on a successful create,
// maybeAttachAfterMcpAdd auto-attaches the new server to the agent and returns.

// Save existing agent
wireAgentDetail1();

// Delete agent
wireAgentControls4();

// ── Create agent ────────────────────────────────────────────────────────────

wireAgentCreate1();

// ── Skill suggestions in the create form ────────────────────────────────────
// As the operator describes the agent, match installed skills + the catalog
// collections and surface fits. Installed matches are informational (new agents
// load all installed skills by default); catalog matches get a checkbox and are
// imported when the agent is created.
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
//
// Three target sets keyed on data-drafter-target:
//   agent-create   → #agent-create-draft-prompt → #agent-create-name + -instructions
//   room-create    → #room-create-draft-prompt  → #room-create-new-name + -instructions
//   room-add-agent → #room-add-agent-draft-prompt → #room-add-agent-new-name + -instructions
//
// Each ✨ click POSTs the prompt to /api/agents/draft (host-side LLM call,
// routed through the OneCLI proxy for the webchat-drafter identifier).
// The response populates the corresponding name + instructions inputs and
// focuses the name so the operator can tweak before submitting. Never
// auto-creates — review is always required.

document.querySelectorAll('.drafter-btn').forEach((btn) => {
  btn.addEventListener('click', () => draftFor(btn));
});

// ── Room management ─────────────────────────────────────────────────────────

// Rename the selected room. Owner-only (the field is hidden otherwise, and the
// server re-checks). The server's broadcastRooms() pushes the new name, so the
// sidebar + panel title update via the 'rooms' handler — no manual refresh.

// Engage mode for the currently-loaded room. Populated alongside the agents
// list. Only 'mention-only' surfaces here now (un-primed agents fire only when
// @-mentioned); the legacy 'broadcast' mode has been retired. Mode-aware
// rendering is in renderRoomWiredAgents.

/**
 * Learning loop, room-level view: what this room's agents have proposed and what
 * they've learned — in the room, rather than buried in the global Skills page.
 * Pending proposals first (they need a decision); learned skills below, removable.
 * Purely a view over existing endpoints — no new backend.
 */

// Wire up room-detail UI.
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
// Per-room credential TYPES moved to Settings → User credentials (global); the
// room only sets the mode override above.
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

// ── Typing indicators ─────────────────────────────────────────────────────
// Rooms whose wired agents auto-run the review: nudging a human to press the
// button the machine already presses is pure noise. Refreshed on join and when
// the 🎓 toggle changes; unknown (fetch failed / non-admin) keeps the nudge.

/**
 * 🎓 popover (DESIGN.md § Composer popups — mirrors .mention-popover, no third
 * style). Click the icon → "Distill now" plus the per-agent automation toggles:
 *   Auto-distill — admin-tier; it only stages drafts (default ON).
 *   Auto-keep    — owner-tier; it writes live agent context, so the server
 *                  refuses the toggle for anyone else and the row only renders
 *                  when the server says canAutoKeep.
 */

$('#learn-btn')?.addEventListener('click', toggleLearnMenu);

// Composer overflow "+": on narrow screens the tools (attach/camera/learn)
// live in a popover this button toggles. Closes on outside-tap and whenever a
// tool inside is chosen (each opens its own dialog/menu).
wireLearnPanel();

// after this much silence, say "still working"

// Remove every agent's bubble (room switch / reset).

// Interrupt ONE agent's in-progress turn (per-agent Stop) — sends a "stop" over
// the WS targeting that agent (the host resolves the name to its session). The
// GUI equivalent of the CLI's ESC. Removes that agent's bubble optimistically;
// the host's stream-abort + 'done' keep it gone.

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

// Multi-line pastes → fenced code block. Pasted code/errors otherwise render as
// Markdown (backticks/asterisks/# reformat; stray @handles chip). Wrapping in a
// fence renders them verbatim — monospace + copy button — and suppresses BOTH
// Markdown and mention decoration inside (decorateMentions skips <pre>/<code>),
// while typed @mentions OUTSIDE the block keep working. Single-line pastes stay
// inline; Ctrl/Cmd+Z reverts the wrap in one step. Files are handled above.
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

// ── Models ─────────────────────────────────────────────────────────────────
//
// Sidebar tab + create/edit/delete + per-agent assignment dropdown. Mirrors
// the agents tab shape. Models are skill-owned (webchat_models) and the
// assignment-to-agent flows through PUT /api/agents/:id/model, which the
// host turns into per-agent settings.json env overrides on next spawn.

// ── Servers & selection (owner-only; hidden entirely for non-owners) ──
// One mental model: SERVERS (Ollama hosts + the LiteLLM router) each list
// what they serve; +/− on a server row adds/removes that model from the
// SELECTABLE list at the top (what agent settings offers). Server rows are
// never clickable-for-detail — only selectable-list rows are. Everything
// renders in one pass from loadServers() so sections can't race each other.

// The Ollama host cards moved to features/ollama-cards.ts in phase 4.2q.
// loadOllamaHostModels and renderOllamaPulls write into the SAME card
// subtree, so the three had to leave together — none of them can become an
// island while a builder here keeps rebuilding the elements they own.

// ── Routing aside: routes editor + test bench + recent decisions ─────────
// Opened from the router server card. Edits write routes.json through the
// server (validated); the hook re-reads per request, so Save is immediate.

// The Routing tab exists only when the LLM stack answers: the routing skill
// installed (routes.json present) AND the viewer is the owner — anyone else
// gets no tab, no menu item, no dead surface. Probed lazily, re-checked when
// the manage view opens so installing the stack shows up without a reload.

// Which router (routing profile) the tab is currently editing. null → the
// server picks the primary (auto).

// The router (profile) picker: a dropdown of all routers + new/delete. Shown
// only when the config exposes a routers list (multi-router aware). Switching
// reloads the tab for the selected router.

// DESIGN.md §6 (prose budget): the intro is a PREREQUISITE hint, so it only
// exists while the prerequisite is unmet — no agent routes through this
// profile yet. Once the router's model is assigned somewhere, the line goes
// away; the controls explain themselves.

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

// Router models: the LiteLLM roster with the same +/− selection controls as
// the Ollama host cards — one row per roster model, nothing else.

wireRoutingPanel();
// Startup probe (deferred so auth is settled before the first owner-gated call).
setTimeout(probeRoutingAvailability, 3000);

// Display label for a model kind. The STORED kind stays 'openai-compatible'
// (it names the endpoint's protocol — what the probe detects); the UI says
// "openai" for brevity. All kinds run the default Claude provider — LiteLLM
// fronts openai-compatible models through its Anthropic-spec /v1/messages.

// A model registered as an openai-compatible endpoint pointing at the LiteLLM
// router (:4000) is an auto-routing BACKEND, not a standalone selectable — it is
// added/removed in Auto routing → Models. Hide it from the main Models list so
// it doesn't clutter it with a misleading "openai" badge. The virtual 'auto'
// model (also :4000) is the exception: it IS the selectable routing entry.

// One identity convention everywhere (list rows, detail header, host cards):
// kind badge + bare model name + dim host meta. Older registrations baked
// "host · " into the display name — strip it for DISPLAY when it matches the
// endpoint, so both naming eras render identically. Stored names untouched.

// Live facts for ollama-kind models: is the model actually installed on its
// endpoint, how big is it, is it in memory right now — the same facts the
// host cards below show, so the two surfaces agree.

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

/**
 * MCP catalog — browse the public registry, prefill the add form.
 *
 * Discovery only: choosing a row never writes anything. It fills in the form below,
 * and the server still has to be probed and added like any hand-entered one.
 *
 * The remote/package split is the security line. A REMOTE server is a URL the
 * container dials out to. A PACKAGE server is npm/pypi code that runs INSIDE the
 * agent container, next to its credentials — so it's labelled, and picking one costs
 * an explicit confirm naming the exact command. Browsing must never be one click
 * away from executing a stranger's code.
 */

/**
 * The MCP registry is a switchable source, exactly like a skill collection: the
 * same webchat_disabled_sources row, surfaced in Settings the same way. Off means
 * off server-side too — the catalog block disappears and no request is made.
 */
// ── Tool secrets ────────────────────────────────────────────────────────────

// Per-agent secrets. Isolation is the prerequisite, not a nicety: in the default
// `all` mode the gateway offers every vault secret to every agent, so a secret
// "for this agent" would in fact be handed to all of them. Isolating pins the
// agent's model credential and switches it to `selective` first.

/**
 * Per-agent env vars. The list shows NAMES only — the server never returns a
 * value, so there is nothing to render and nothing to leak into a screenshot.
 */

/**
 * One row per credential: the host, a scope pill, and Remove.
 *
 * The pill (not prose) carries ownership because it is the thing you scan for —
 * and `personal` gets the accent colour because it is the EXCEPTION worth
 * noticing; shared is the default and stays neutral. Reuses the `.skill-badge`
 * vocabulary already used for skill provenance, so the panel doesn't invent a
 * second badge language.
 */

// ── My credentials ──────────────────────────────────────────────────────────
// Self-service personal credentials, one block per agent the person is enrolled
// in. Not admin-gated by design: a per-user PAT is only worth having if its
// owner is the only one who ever handles it.

/** Labelled input matching the .secret-field pattern used in the static forms. */

/**
 * The learning loop's explicit trigger (docs/webchat/design/learning-loop.md §1): reviews
 * THIS session and drafts a skill only if it taught something. It just sends
 * `/learn` — one path, the same one the slash command takes, so there's no second
 * implementation to keep in step.
 *
 * Only offered for the room you're actually in: `/learn` reviews the session, and
 * the session is the one you have open.
 */

/** Hide the catalog entirely when its source is switched off. */

/** Prefill the add form from a catalog row. Package servers gate on an explicit confirm. */

// Catalog wiring: load on first expand, debounce the search.
wireMcpCatalog();

// Health, drift re-approval, tool allowlist, OAuth connect — the hardening
// surface of one server's detail panel (remote servers only).

$('#mcp-detail-close')!.addEventListener('click', closeMcpDetail);
$('#mcp-create-close')!.addEventListener('click', closeMcpDetail);

wireAgentCreate2();

// Manual-entry transport select swaps url vs command/args fields (the bearer
// token is a remote-transport concept — hidden for stdio).
$('#mcp-create-transport')!.addEventListener('change', syncMcpCreateTransportFields);

// ── MCP probe — connect to the URL as an MCP client, list its tools ──
// The bearer token used by the LAST SUCCESSFUL probe — carried into the add
// body so the registered server keeps working. Kept out of lastMcpProbe.value (the
// server response) so it can't leak via logging of that object.

wireMcpPanel();

// ── Model picker ──────────────────────────────────────────────────────────

// Trigger button → open picker. Only meaningful when an agent is open.
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

// "+ Add new model" → close picker, set the auto-assign flag, then trigger
// the existing model-create flow. After a successful create we auto-assign
// the new model id to the agent and return them to the agent detail.
$('#model-picker-add-new')!.addEventListener('click', () => {
  if (!selectedAgentId.value) return;
  setPickerAdd(true, selectedAgentId.value);
  closeModelPicker();
  // Existing path: opens model-detail aside in create mode.
  setTimeout(() => $('#create-model-btn')!.click(), 180);
});

initApp();

// Hand the thinking module the transcript helpers it calls. Declarations hoist,
// so these are all defined by the time this runs.
provideThinkingDeps({ interruptAgent });
// The wizard reaches back into legacy for install runners, a few panels, and,
// some module-level flags. Read-only views are getters; anything the wizard,
// ASSIGNS gets a setter too — a getter alone would silently drop the write.,
provideWizardDeps({
  openOauthMintModal,
  fetchAgents,
  closeSettings,
  applyLearningMaster,
  joinRoom,
});

// Installers run from both the wizard and settings, and reach back into legacy
// for renderers, probes and the re-entrancy flags. The five wizard entry points
// are passed through from legacy's own wizard import — installers must not
// import wizard directly, since wizard already imports installers.
provideInstallerDeps({
  // wizard entry points, passed through from legacy's own import so that,
  // installers never has to import wizard (wizard already imports installers),
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
  // install re-entrancy flags still owned by legacy (not shared app state),
});

provideThreadsDeps({
  hideOtherFullViews,
  joinRoom,
  renderRooms,
  roomColor,
  showConfirmModal,
});

// The transcript reaches back for bubble decorations and the shared identity /
// pager state. buildThoughtsDisclosure is injected rather than imported so the
// transcript <-> thinking edge stays one-way (thinking imports transcript).
provideTranscriptDeps({
  agentColor,
  endAgentTurn,
  interruptAgent,
  mentionAgentColor,
  openLightbox,
  skillDraftRow,
  toggleThinkingExpanded,
});

// The socket dispatcher turns server events into UI updates, so it reaches back
// for the renderers and fetchers that still live here. All plain functions —
// core/state removed every state accessor this used to need.
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

// Skills reaches back for view-stack/overlay plumbing, the undo bar and a few
// selection ids. All read-only — it writes none of them, so getters only.
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

// MCP spans the registry view and the agent panel, so it reaches back for the
// detail-pane plumbing and the selection/probe state legacy still owns.
provideMcpDeps({
  // agentMcpServers.value was MISSED in phase 2b: mcp.js used it while legacy kept
  // it, and check:refs matched only TS2304 at the time — tsc reports this one
  // as TS2552 ("did you mean fetchMcpServers?"), so the gate stayed green on a,
  // guaranteed ReferenceError. Widening the guard to TS2552 found it.,
  closeAgentDetail,
  closeModelDetail,
  closeRoomDetail,
  openAgentDetail,
  showConfirmModal,
});

// Agents is referenced from nearly every other view, so it reaches back for
// the detail-pane plumbing and the selection state legacy still owns.
provideAgentsDeps({
  // Stays a dep: agents→models would close a cycle (models reaches agents).
  warnIfUnreachable,
  // Stays a dep: agents→composer would close a cycle (composer already
  // reaches agents), which is exactly what this seam is for.,
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

// Rooms drives the sidebar and the room lifecycle, so it reaches back for the
// detail panes, member/typing renderers and a few sort/visibility toggles.
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

// Models is surfaced from the manage view and several pickers, so it reaches
// back for the row/toggle builders and the routing availability flags.
provideModelsDeps({
  // Stays a dep: models→routing would close a cycle (routing reaches models).
  closeRouteDetail,
  switchManageTab,
});

// The overlay hosts sections other features own; those are imported. What is
// injected is the handful of renderers and toggles still living in legacy.
provideSettingsDeps({
  // renderToolSecrets and renderAutoLearnSetting used to be injected here to
  // dodge a settings→agents cycle. Both blocks live on the Admin view now, and
  // admin.ts imports them directly — nothing imports admin.ts, so there is no
  // cycle to dodge.
  toggleBearerToken,
  updateUserCredsBanner,
});

// Members spans the room member list and the permissions view, so it reaches
// back for the perms renderers and the per-user credential state legacy owns.
provideMembersDeps({
  permsShowDetail,
  permsShowList,
  refreshPermissions,
  renderPermsDetail,
  showConfirmModal,
});

// Modals reach back for the mention-accept path, clipboard, and the OAuth
// credential state legacy still owns.
provideModalsDeps({
  // Stays a dep: modals→members would close a cycle (members imports modals).
  updateHandleCreds,
  acceptMention,
  copyTextToClipboard,
});

// The view stack reaches back for the topology/routing renderers and the
// which-view-is-open flags legacy still owns.
provideViewsDeps({
  closeAllDetailDrawers,
  loadRoutingTab,
  probeRoutingAvailability,
  refreshRouterMetrics,
  getDetailRouterOpen,
  getAfterDetailClose,
  setAfterDetailClose,
  // no accessor pair for topoFocus: the legacy setTopoFocus(kind, id, name)
  // function IS the write path, and views calls it directly. Generating one,
  // produced a duplicate key with the function of the same name.,
});

// Auth reaches back for what legacy still owns.
provideAuthDeps({
  permsRefreshCreateUI,
});

// Learn reaches back for what legacy still owns.
provideLearnDeps({
  sendCurrentMessage,
});

// Files reaches back for what legacy still owns.
provideFilesDeps({});

// The +/- selectable toggle needs the model registry legacy still owns, plus
// the two things its click does afterwards. refreshRouterRoster keeps the
// hidden-tab check that used to live inside the button handler.
provideSelectToggleDeps({
  fetchModels,
  refreshRouterRoster: () => {
    if (!$('#mtab-routing')!.hidden) renderRouterRoster();
  },
});

// The host cards read the classifier id to section it under System rather
// than offering it as a selectable model.

// Perms reaches back for what legacy still owns.
providePermsDeps({});

// Routing reaches back for what legacy still owns.
provideRoutingDeps({});

// Composer reaches back for what legacy still owns.
provideComposerDeps({});
