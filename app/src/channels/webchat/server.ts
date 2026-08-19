/**
 * Webchat HTTP server — routes, auth, static PWA serve, WS upgrade.
 *
 * Endpoints:
 *   GET  /health                            health check, no auth
 *   GET  /api/auth/check                    verify token
 *   GET  /api/overview                      dashboard snapshot (owner: full,
 *                                             admin: graceful degrade)
 *   GET  /api/rooms                              list rooms
 *   POST /api/rooms                              create room + wire 1+ agents  [owner]
 *   DELETE /api/rooms/:id                        delete room + wirings (agents preserved)  [owner]
 *   GET  /api/rooms/:id/agents                   list agents wired to a room (incl. is_prime flag)
 *   POST /api/rooms/:id/agents                   wire an agent (existing or new)  [owner]
 *   DELETE /api/rooms/:id/agents/:agentId        unwire an agent (refuses last)  [owner]
 *   PUT  /api/rooms/:id/prime                    set { agentId } as the room's prime  [owner]
 *   DELETE /api/rooms/:id/prime                  clear the room's prime designation  [owner]
 *   GET  /api/rooms/:id/engage-mode              read room's engage default ('mention-only')
 *   PUT  /api/rooms/:id/engage-mode              set { mode } for the room  [owner]
 *   PUT  /api/rooms/:id/name                     rename the room (set { name })  [owner]
 *   GET  /api/rooms/:id/threads                  list threads (+ per-thread unread)
 *   POST /api/rooms/:id/threads                  create a topic thread ({ title })  [member]
 *   PATCH /api/rooms/:id/threads/:tid            rename a thread ({ title })  [member]
 *   DELETE /api/rooms/:id/threads/:tid           delete a thread + its session  [owner]
 *   PUT  /api/rooms/:id/threads/:tid/read        mark a thread read  [member]
 *   GET  /api/rooms/:id/messages                 history (?after_id= catch-up, ?before_id= scroll-back, ?thread_id=)
 *   POST /api/rooms/:id/archive                  mark room archived (owner + admin) — global
 *   POST /api/rooms/:id/unarchive                clear global archive (owner + admin)
 *   POST /api/rooms/:id/hide                     hide room from this user's sidebar — per-user
 *   POST /api/rooms/:id/unhide                   un-hide for this user
 *   POST /api/rooms/:id/upload                   multipart upload
 *   POST /api/rooms/:id/upload/chunk             chunked upload
 *   GET  /api/files/:roomId/:filename            serve uploaded file
 *   GET  /api/agents                             list agent groups (filtered by caller's roles, incl. assigned_model_id)
 *   POST /api/agents                             create agent group + (optionally) wire a room  [owner]
 *   POST /api/agents/draft                       draft { name, instructions } from a freeform prompt  [owner]
 *   PUT  /api/agents/:id                         update agent group  [admin-of]
 *   DELETE /api/agents/:id                       delete agent group + filesystem  [admin-of]
 *   GET  /api/agents/:id/instructions            read instructions.prepend.md
 *   PUT  /api/agents/:id/instructions            write instructions.prepend.md  [admin-of]
 *   PUT  /api/agents/:id/model                   set { modelId } (or null to unassign) [owner]
 *   GET  /api/models                             list registered models
 *   POST /api/models                             register a new model (anthropic|ollama|openai-compatible)  [owner]
 *   POST /api/models/discover                    list models served by an endpoint (Ollama: /api/tags)  [owner]
 *   POST /api/models/probe                       paste a base URL, classify provider + list models  [owner]
 *   POST /api/models/bulk                        bulk-register many models in one call  [owner]
 *   PUT  /api/models/:id                         update a model  [owner]
 *   DELETE /api/models/:id                       delete a model (refuses if assigned; use ?force=1 to cascade-unassign)  [owner]
 *   GET  /api/push/vapid-public             VAPID public key
 *   POST /api/push/subscribe                add push subscription
 *   POST /api/push/unsubscribe              remove push subscription
 *   WS   /ws                                WebSocket chat (handled in ws.ts)
 *   GET  /*                                 PWA static files
 *
 * Cut from v1 for the v2 PR scope (referenced by their original v1 paths):
 *   - /api/agents (v1 token endpoint)   tokens are gone in v2; agents push via outbound.db
 *   - /api/routes                        v1 message_routes (v2 has agent_destinations)
 *   - /api/tasks                         scheduling lives in modules/scheduling
 *   - /api/bots/create-from-chat         v1 main-room flow; replaced by direct POST /api/agents
 *
 * Replaces v1's /api/stats: see /api/overview (re-shaped to v2 data model).
 */
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { json, safeParseJson, readBody, readJsonBody, BodyTooLargeError, MAX_JSON_BODY_BYTES } from './server/http.js';
import {
  rOllamaDeletePost,
  rOllamaHostsGet,
  rOllamaLocalGet,
  rOllamaModelsGet,
  rOllamaPrepullGet,
  rOllamaPullCancelPost,
  rOllamaPullPost,
  rOllamaPullsGet,
  rOllamaRecommendGet,
} from './server/routes-ollama.js';
import { buildOverview } from './server/overview.js';
import {
  rAgentsGet,
  rAgentsDraftPost,
  rAgentsPost,
  rAgentsFromTemplatePost,
  rAgentExportTemplatePost,
  rAgentTemplateApplyPost,
  rAgentTemplatePlanGet,
  rTemplateDelete,
  rTemplateDetailGet,
  rTemplateFetchPost,
  rTemplateSourceBrowseGet,
  rTemplateSourceDelete,
  rTemplateSourcePost,
  rTemplateSourcesGet,
  rTemplatesGet,
  rAgentPut,
  rAgentDelete,
  rAgentRoomsGet,
  rAgentModelPut,
  rAgentProviderPut,
  rAgentConfigModelPut,
  rAgentEgressPut,
  rAgentEnv,
  rAgentMcp,
  rAgentSkills,
  rAgentSkillImportPost,
  rAgentExportGet,
  rAgentsImportPost,
  rAgentsImportApplyPost,
  rAgentLearning,
  rAgentScopedSkillDelete,
  rAgentStatusPut,
  rAgentSessionsGet,
  provisionWebchatAgentWithRoom,
  createAgentHandler,
  grantCreatorAdmin,
  updateAgentHandler,
  draftAgentHandler,
  importAgentUploadHandler,
  importAgentApplyHandler,
  deleteAgentHandler,
  setAgentStatusHandler,
  assignAgentModelHandler,
  setAgentSkillsHandler,
  importScopedSkillHandler,
  deleteScopedSkillHandler,
  listAgentMcpHandler,
  setAgentMcpHandler,
} from './server/routes-agents.js';
import {
  rSkillsGet,
  rSkillsImportPost,
  rSkillsCatalogGet,
  rSkillsSuggestGet,
  rSkillsSourcesGet,
  rSkillSource,
  rSkillsInspectPost,
  rSkillsUpdatesGet,
  rSkillUpdatePost,
  rSkillsDuplicatesGet,
  rSkillsPromotePost,
  rSkillItem,
  rSkillRevertPost,
  rSkillRestorePost,
  rSkillDraftsGet,
  catalogCache,
  SKILL_DISCOVERY_SOURCE,
  fetchMarketplace,
  PoolSkill,
  catalogPoolHandler,
  putSkillSourceHandler,
  SKILL_SYNONYMS,
  SUGGEST_STOPWORDS,
  suggestTokens,
  suggestSkillsHandler,
  importSkillHandler,
  inspectSkillHandler,
  skillUpdatesHandler,
  applySkillUpdateHandler,
  deleteUserSkillHandler,
  getSkillContentHandler,
} from './server/routes-skills.js';
import {
  AvailableSkill,
  ScopedSkillForList,
  SkillOrigin,
  SkillOriginRef,
  USER_SKILLS_DIR,
  draftSourceRoom,
  frontMatterDescription,
  listAvailableSkills,
  listScopedSkills,
  listScopedSkillsForUser,
  putUserSkillHandler,
  readSkillOrigin,
  sanitizeOrigin,
  sanitizeSkillName,
  scopedSkillsDir,
} from './server/skills-store.js';
import {
  SKILL_DISCOVERY_URL,
  fetchGithubDir,
  githubFetch,
  latestCommitSha,
  parseGithubDirUrl,
  resolveDiscoveredSkillUrl,
  resolveSourceUrl,
  shaCache,
} from './server/skill-sources.js';
import {
  AgentForUI,
  deriveEffectiveModelLabel,
  listAgentsForUser,
  resolveAgent,
  toAgentForUI,
} from './server/agent-lookup.js';
import { rMeHandleGet, rMeHandlePut } from './server/routes-me.js';
import {
  rModelsKnownGet,
  rModelsGet,
  rModelsPost,
  rModelsDiscoverPost,
  rModelsProbePost,
  rModelsReachabilityPost,
  reachabilityHandler,
  rModelsBulkPost,
  rModelIdPut,
  rModelIdDelete,
  manageEndpoint,
  rModelsManageGet,
  rModelsContextVariantPost,
  ModelForUI,
  listModelsForUI,
  createModelHandler,
  updateModelHandler,
  routesBoundToModel,
  deleteModelHandler,
  probeModelsHandler,
  bulkCreateModelsHandler,
  discoverModelsHandler,
} from './server/routes-models.js';
import { refreshUnassignedGroupsForDefaultModel, reloadAgentModelEnv } from './server/model-wiring.js';
import {
  rRoomsGet,
  rRoomsPost,
  rRoomIdDelete,
  rRoomAgentsGet,
  rRoomMentionableGet,
  rRoomAgentsPost,
  rRoomCredModeGet,
  rRoomCredModePut,
  rRoomOauthGet,
  rRoomOauthPut,
  rRoomAgentDelete,
  rRoomPrimePut,
  rRoomPrimeDelete,
  rRoomArchivePost,
  rRoomHidePost,
  rRoomPinPost,
  rRoomsPinsOrderPost,
  rRoomEngageGet,
  rRoomEngagePut,
  rRoomNamePut,
  rRoomThreadReadPut,
  rRoomThreadsGet,
  rRoomThreadsPost,
  rRoomThreadPatch,
  rRoomThreadDelete,
  rRoomThreadPullPost,
  rRoomLearning,
  rRoomExportGet,
  rRoomsImportPost,
  rRoomsImportApplyPost,
  rRoomBroadcastPost,
  FRESH_SYNC_LIMIT,
  sessionsForThreadKey,
  syncThreadContext,
  importRoomUploadHandler,
  importRoomApplyHandler,
  AgentRef,
  createRoomHandler,
  rollbackBareAgents,
  deleteRoomHandler,
  deleteThreadHandler,
  addAgentToRoomHandler,
  removeAgentFromRoomHandler,
  setRoomPrimeHandler,
  clearRoomPrimeHandler,
} from './server/routes-rooms.js';
import {
  SESSION_COMMANDS,
  ciFolderToken,
  createBareAgentGroup,
  ensureA2aDestination,
  injectSessionCommand,
  nameToFolder,
  newAgentGroupId,
  parseAgentLearning,
  recomputeEngagePatterns,
  wireAgentToWebchatRoom,
} from './server/agent-wiring.js';
import {
  IMPORT_TTL_MS,
  pendingAgentImports,
  spawnTar,
  spoolUploadToTmp,
  sweepPendingImports,
} from './server/archive.js';
import {
  rUserCredentialsCredential,
  rUserCredsMintPost,
  rUsersGet,
  rUserIdDelete,
  rPermissionsGrantPost,
  rPermissionsRevokePost,
  RoleEntry,
  MembershipEntry,
  UserWithPermissions,
  listUsersWithPermissions,
  deriveUserKind,
  GrantBody,
  validateGrantBody,
  checkMemberGrantAuth,
  grantPermissionHandler,
  deleteUserHandler,
  revokePermissionHandler,
} from './server/routes-users.js';
import { USER_CREDS_MIN_INTERVAL_MS, userCredsActionAt, userCredsRateLimited } from './server/rate-limit.js';
import {
  rWebchatCredentialsConfig,
  rWebchatOnboarding,
  rWebchatFeatures,
  rWebchatAuditLog,
  rWebchatAuditSyslog,
  rWebchatTailscaleOwner,
  rWebchatTailscaleHttps,
  rWebchatCloudflaredGet,
  rWebchatCloudflaredInstallPost,
  rWebchatCloudflaredConnectPost,
  rWebchatTailscaleInstallGet,
  rWebchatPreflightGet,
  rWebchatTailscaleInstallPost,
  rWebchatUsageGet,
} from './server/routes-webchat.js';
import { DEFAULT_PORT, MARKETPLACE_ID } from './server/constants.js';
import {
  rMcpServersGet,
  rMcpServersPost,
  rMcpSourcesGet,
  rMcpSourcePut,
  rMcpSourceDelete,
  rMcpSourcePost,
  rMcpCatalogGet,
  rMcpServersProbePost,
  rMcpServersOauthCallbackGet,
  rMcpOauthStartPost,
  rMcpRepinPost,
  rMcpToolsPut,
  rMcpAuthPut,
  rMcpServerIdPut,
  rMcpServerIdDelete,
  listMcpServersForUI,
  parseMcpServerBody,
  createMcpServerHandler,
  updateMcpServerHandler,
  deleteMcpServerHandler,
  MCP_REGISTRY_URL,
  MCP_REGISTRY_SOURCE,
  McpCatalogRow,
  mcpCatalogCache,
  MCP_CATALOG_TTL_MS,
  versionGreater,
  packageCommand,
  safeHttpUrl,
  normalizeMcpRegistry,
  mcpCatalogHandler,
  probeMcpServerHandler,
  escapeHtml,
} from './server/routes-mcp.js';
import {
  MCP_REGISTRY_ID,
  mcpRegistryRemovedKey,
  mcpServerForUI,
  reloadAgentMcpServers,
} from './server/mcp-registry.js';
import type { McpServerForUI } from './server/mcp-registry.js';
import {
  rRouterRoutesGet,
  syncAutoRouterSelectable,
  rRouterRoutesPut,
  rRouterRoutersPost,
  rRouterDelDelete,
  rRouterClassifyPost,
  rRouterDecisionsGet,
  rRouterMetricsGet,
  rRouterSuggestionsGet,
  rRouterModelsGet,
  rRouterRosterRefreshGet,
  rRouterRosterRefreshPost,
  rRouterInstallGet,
  rRouterInstallPost,
  rRouterLitellmInstallGet,
  rRouterLitellmInstallPost,
} from './server/routes-router.js';
import { codexAvailable, opencodeAvailable, piAvailable } from './server/providers.js';
import { grokStatus } from './server/grok-status.js';
import {
  rCodexInstallGet,
  rCodexInstallPost,
  rGrokLoginGet,
  rGrokLoginPost,
  rOllamaInstallPost,
  rOpencodeInstallGet,
  rOpencodeInstallPost,
  rPiInstallGet,
  rPiInstallPost,
  rWebchatSttInstallGet,
  rWebchatSttInstallPost,
  rWebchatTtsInstallGet,
  rWebchatTtsInstallPost,
} from './server/routes-install.js';
import { createServer as createHttpsServer } from 'https';
import { createHash, randomUUID, randomBytes } from 'crypto';
import zlib from 'node:zlib';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';
import {
  deleteSessionDbState,
  findSessionsByAgentGroup,
  findSessionsByMessagingGroup,
  findSessionsByMessagingGroupThread,
  teardownSessionResources,
  type TeardownTarget,
} from '../../session-teardown.js';
import type { AgentGroup, MessagingGroup } from '../../types.js';
import type { InboundDeliveryPlan } from '../../router.js';
import {
  createAgentGroup,
  deleteAgentGroup,
  getAgentGroup,
  getAllAgentGroups,
  setAgentStatus,
  updateAgentGroup,
} from '../../db/agent-groups.js';
import {
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { syncSessionContext, type ContextMessage } from '../../session-manager.js';
import { getPendingApproval, getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { insertMessage, openInboundDb } from '../../db/session-db.js';
import { killContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { initGroupFilesystem } from '../../group-init.js';
import {
  addMember as permsAddMember,
  removeMember as permsRemoveMember,
  getMembers as permsGetMembers,
} from '../../modules/permissions/db/agent-group-members.js';
import {
  deleteUser as permsDeleteUser,
  getAllUsers as permsGetAllUsers,
  getUser as permsGetUser,
  upsertUser as permsUpsertUser,
} from '../../modules/permissions/db/users.js';
import {
  getOwners as permsGetOwners,
  getUserRoles as permsGetUserRoles,
  grantRole as permsGrantRole,
  revokeRole as permsRevokeRole,
} from '../../modules/permissions/db/user-roles.js';
// Used by the symmetric "create destination on wire" step in
// wireAgentToWebchatRoom — see comment there.
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../../modules/agent-to-agent/db/agent-destinations.js';
import { projectDestinationsToActiveSessions } from '../../modules/agent-to-agent/write-destinations.js';
import type { InboundMessage, OutboundFile } from '../adapter.js';
import {
  assertBearerTokenStrength,
  authenticateRequest,
  canonicalizeWebchatUserId,
  getAuthInfo,
  getAuthManagementInfo,
  hasExplicitAuth,
  probeTailscaleHealth,
  requiresExplicitAuth,
  warnIfAutoProxyTrust,
} from './auth.js';
import { getTailscaleServeState, enableTailscaleServe } from './tailscale-serve.js';
import {
  deleteHostModel,
  getPullsSnapshot,
  getOllamaLocalState,
  startOllamaInstall,
  getCodexInstallProgress,
  startCodexInstall,
  getOpencodeInstallProgress,
  startOpencodeInstall,
  getPiInstallProgress,
  startPiInstall,
  getRosterRefreshState,
  dryClassify,
  getRouteSuggestions,
  getRouterInfo,
  getRouterMetrics,
  listHostModels,
  mergeRoutesUpdate,
  primaryRouter,
  readRoutesConfig,
  removeRouteFromConfig,
  recentDecisions,
  type RoutesUpdate,
  writeRoutesConfig,
  listRouters,
  routerView,
  addRouter,
  deleteRouter,
  parseConfiguredHosts,
  cancelPull,
  startPull,
  startRosterRefresh,
  getRoutingInstallState,
  getTtsInstallState,
  startTtsInstall,
  getTailscaleInstallState,
  startTailscaleInstall,
  getCloudflaredInstallState,
  startCloudflaredInstall,
  startCloudflaredConnect,
  getSttInstallState,
  startSttInstall,
  startRoutingInstall,
  getLitellmInstallState,
  startLitellmInstall,
  deriveModelServerHosts,
  upsertEnv,
  scheduleHostRestart,
} from './ollama-manage.js';
import {
  approvalInboxForUser,
  archiveRoom,
  assignModelToAgent,
  clearPrimeAgentForWebchatRoom,
  countAgentsForWebchatRoom,
  createWebchatModel,
  createWebchatRoom,
  deleteWebchatModel,
  deleteWebchatRoom,
  getAgentsAssignedToModel,
  getAgentsForWebchatRoom,
  getWebchatRoomsForAgent,
  getAllWebchatRooms,
  getArchivedRoomIds,
  getHiddenRoomIdsForUser,
  getAssignedModelForAgent,
  getEffectiveModelForAgent,
  getPrimeAgentForWebchatRoom,
  getRoomEngageDefault,
  setRoomEngageDefault,
  isWebchatApprovalIndexedFor,
  getWebchatMessages,
  getWebchatMessagesAfterId,
  getWebchatMessagesBeforeId,
  searchWebchatMessages,
  ensureMainThread,
  listWebchatThreads,
  createWebchatThread,
  getWebchatThread,
  renameWebchatThread,
  deleteWebchatThread,
  MAIN_THREAD,
  threadToSessionKey,
  getThreadSyncMarks,
  setThreadSyncMark,
  getSyncDelta,
  insertSyncedMessages,
  engageAgent,
  disengageAgent,
  getEngagedAgents,
  getUnreadThreadIdsForRoom,
  markThreadRead,
  sanitizeThreadTitle,
  getWebchatTopology,
  getWebchatModel,
  getWebchatPendingApprovalsForUser,
  getWebchatHandleUsers,
  getWebchatRoom,
  getWebchatUserHandle,
  sanitizeRoomName,
  updateWebchatRoomName,
  hideRoomForUser,
  listWebchatModels,
  pinRoomForUser,
  setPrimeAgentForWebchatRoom,
  setWebchatUserHandle,
  storeWebchatFileMessage,
  unarchiveRoom,
  unhideRoomForUser,
  unpinRoomForUser,
  setPinnedOrderForUser,
  unassignModelFromAgent,
  unwireAgentFromWebchatRoom,
  updateWebchatModel,
  listSkillSources,
  upsertSkillSource,
  deleteSkillSource,
  isSourceDisabled,
  setSourceDisabled,
  type FileMeta,
  type WebchatModel,
  type WebchatModelKind,
  type WebchatRoomAgent,
  type WebchatSkillSource,
  getSttCleanupModelId,
  setSttCleanupModelId,
  getSttCleanupPrompt,
  setSttCleanupPrompt,
  setReadAloudEnabled,
  getApprovalPrejudgeModelId,
  setApprovalPrejudgeModelId,
  getApprovalPrejudgeActions,
  setApprovalPrejudgeActions,
} from './db.js';
import { DraftError, draftAgent } from './drafter.js';
import { PERSONA_PREPEND_FILE, readGroupPersona } from '../../group-persona.js';
import { recommendForHost } from './model-recommend.js';
import { probeContainerReachability } from './reachability.js';
import { runPreflight } from './preflight.js';
import {
  KNOWN_ANTHROPIC_MODELS,
  isPlausibleAnthropicModelId,
  discoverOllamaModels,
  probeEndpoint,
  validateModel,
  writeAgentSettingsForAssignedModel,
  syncAgentProviderForAssignedModel,
  writeLocalModelForAgent,
  classifierParamsForModel,
} from './models.js';
import { handleChunkedUpload, handleFileServe, handleMultipartUpload } from './files.js';
import { initWebPush, isValidPushEndpoint } from './push.js';
import { redactSensitiveData } from './redact.js';
import {
  grantOwnerRole,
  hasAdminPrivilege,
  isAnyAdmin,
  isGlobalAdmin,
  isOwner,
  warnIfNoPermissionsModule,
} from './roles.js';
import {
  getLearningMasterEnabled,
  setLearningMasterEnabled,
  getLearningClassifier,
  setLearningClassifier,
} from '../../modules/learning/master.js';
import {
  isUsableJudgeModel,
  NEVER_AUTO_APPROVE_ACTIONS,
  NEVER_AUTO_APPROVE_PATTERNS,
} from '../../modules/approvals/prejudge.js';
import { listRegisteredApprovalActions } from '../../modules/approvals/primitive.js';
import { maybeHandleTts, ttsEndpoint } from './tts.js';
import {
  DEFAULT_CLEANUP_PROMPT,
  MAX_CLEANUP_CHARS,
  MAX_SEGMENT_BYTES,
  MIN_SEGMENT_BYTES,
  cleanupTranscript,
  sttEnabled,
  sttProvider,
  transcribeSegment,
} from './stt.js';
import { canAccessRoom, canArchiveRoom, filterRoomsForUser } from './access.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { audit, auditActor } from '../../audit.js';
import { configureSyslog } from './audit-syslog.js';
import {
  getRoomOauthAllowed,
  setRoomOauthAllowed,
  getEffectiveRoomMode,
  getRoomModeOverride,
  setRoomModeOverride,
  getCredentialsConfig,
  setCredentialsConfig,
  getAuditSyslogTarget,
  getOnboardingComplete,
  setOnboardingComplete,
  setBearerTokenDisabled,
  getMarketplaceDisabled,
  setMarketplaceDisabled,
  getCredentialIsolation,
  setCredentialIsolation,
  getPromoteFirstTailscaleOwner,
  setPromoteFirstTailscaleOwner,
  getDefaultModelId,
  setDefaultModelId,
  type CredentialsConfig,
  type CredentialMode,
} from './db.js';
import { listProviderContainerConfigNames } from '../../providers/provider-container-registry.js';

import {
  storeUserCredential,
  revokeUserCredential,
  setWorkspaceDefaultCredential,
} from '../../modules/user-credentials/onboard.js';
import { WORKSPACE_DEFAULT_USER_ID } from '../../modules/user-credentials/identity.js';
import {
  startClaudeMint,
  mintClaudeToken,
  startCodexMint,
  finishCodexMint,
  cancelMint,
  activeMintCount,
  MAX_ACTIVE_MINTS,
} from './oauth-mint.js';
import { realOnecliAdmin } from '../../modules/user-credentials/onecli-admin.js';
import { fleetIsolationEnabled } from '../../modules/fleet-isolation/index.js';
import {
  listAgentEnvNames,
  setAgentEnv,
  deleteAgentEnv,
  isValidEnvName,
  validateEnvValue,
} from '../../modules/agent-env/store.js';
import {
  listDeployKeys,
  createDeployKey,
  deleteDeployKey,
  setDeployKeyTarget,
} from '../../modules/deploy-keys/index.js';
import {
  WORKSPACE,
  type Scope,
  listToolSecrets,
  createToolSecret,
  deleteToolSecret,
  getGroupIsolation,
  isolateGroup,
  unisolateGroup,
  refreshCredentialNote,
  resolveAuthScheme,
  type AuthScheme,
} from '../../modules/tool-secrets/index.js';
import {
  userHasConnectedCredential,
  getUserCredential,
  listEnrolledGroups,
  listAllTrackedSecretIds,
  listGroupMemberEnrollments,
} from '../../modules/user-credentials/db.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  ensureContainerConfig,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import {
  listSkillDrafts,
  getSkillDraft,
  readSkillDraftBody,
  resolveSkillDraft,
  updateSkillDraftBody,
} from '../../db/skill-drafts.js';
import type { SkillDraft } from '../../db/skill-drafts.js';
import { listSkillDraftCards, markRoomSkillDraftResolved, skillDraftCardPosition } from './db.js';
import { computeUsageRollup } from './usage.js';
import { createContextVariant, gatherModelInventory, prepullEstimate } from './model-manage.js';
import type { McpServerConfig } from '../../container-config.js';
import { validateMcpServerName } from '../../mcp-server-config.js';
import {
  assignMcpServerToAgent,
  createWebchatMcpServer,
  deleteWebchatMcpServer,
  getAgentsAssignedToMcpServer,
  getMcpServersForAgent,
  getWebchatMcpServer,
  getWebchatMcpServerByName,
  listWebchatMcpServers,
  pinMcpToolSurface,
  setMcpServerAuth,
  setMcpServerDrift,
  setMcpServerEnabledTools,
  syncAgentMcpConfig,
  unassignMcpServerFromAgent,
  updateWebchatMcpServer,
  type WebchatMcpServer,
  type WebchatMcpTransport,
  type WebchatMcpServerInput,
} from './mcp-registry.js';
import { probeMcpEndpoint } from './mcp-probe.js';
import { checkMcpServer } from './mcp-health.js';
import { finishOAuthFlow, parseMcpAuth, startOAuthFlow } from './mcp-auth.js';
import { broadcast, broadcastRooms, pushToUser } from './state.js';
import { setupWebSocket } from './ws.js';
import {
  findDuplicateScopedSkills,
  listArchivedSkills,
  promoteScopedSkill,
  restoreArchivedSkill,
} from '../../modules/learning/curator.js';
import { listRevisions, revertLastRevision, snapshotRevision } from '../../modules/learning/apply.js';
import { inspectSkillFiles } from '../../modules/skills/inspect.js';
import { applySkillDraft } from '../../modules/learning/apply.js';
import { findKeepOverlaps } from '../../modules/learning/overlap.js';
import { getRoomLearning, setRoomLearning } from '../../modules/learning/room-settings.js';
import {
  applyImport,
  exportTarArgs,
  extractBundle,
  previewImport,
  stageAgentExport,
} from '../../modules/transfer/agent-transfer.js';
import {
  executeSystemRestore,
  isSafeSystemEntry,
  previewSystemImport,
  stageSystemExport,
  systemTarArgs,
} from '../../modules/transfer/system-transfer.js';
import { closeDb } from '../../db/connection.js';
import {
  applyRoomImport,
  isSafeRoomEntry,
  previewRoomImport,
  roomTarArgs,
  stageRoomExport,
} from '../../modules/transfer/room-transfer.js';
import { spawn } from 'child_process';
import Busboy from 'busboy';

const DEFAULT_HOST = '127.0.0.1';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface WebchatServerHooks {
  /** `threadId` is the session key (null = the room's main/default thread). */
  onInbound: (roomId: string, message: InboundMessage, threadId: string | null) => void;
  onAction: (questionId: string, selectedOption: string, userId: string) => void;
}

export interface WebchatServer {
  host: string;
  port: number;
  tls: boolean;
  http: HttpServer;
  wss: import('ws').WebSocketServer;
  broadcast: (roomId: string, payload: unknown) => void;
  persistOutboundFile: (roomId: string, file: OutboundFile) => string;
}

export async function startWebchatServer(hooks: WebchatServerHooks): Promise<WebchatServer> {
  const host = process.env.WEBCHAT_HOST || DEFAULT_HOST;
  const port = Number(process.env.WEBCHAT_PORT || DEFAULT_PORT);
  const tlsCert = process.env.WEBCHAT_TLS_CERT;
  const tlsKey = process.env.WEBCHAT_TLS_KEY;
  const publicDir = path.resolve(process.env.WEBCHAT_PUBLIC_DIR || 'public/webchat');

  // Refuse to start if the server is reachable from the network without any
  // explicit auth method configured. Localhost-only installs are fine.
  if (requiresExplicitAuth(host) && !hasExplicitAuth()) {
    throw new Error(
      `Webchat refusing to bind to ${host}:${port}: no auth method configured. ` +
        'Set WEBCHAT_TOKEN, WEBCHAT_TAILSCALE=true, or WEBCHAT_TRUSTED_PROXY_IPS, ' +
        'or bind to 127.0.0.1 instead.',
    );
  }
  // Refuse to start with a weak bearer token regardless of bind host.
  assertBearerTokenStrength();

  initWebPush();
  warnIfNoPermissionsModule();
  // Re-establish the audit forwarder from the persisted target, so a restart
  // does not silently turn forwarding off. Invalid persisted value → off, and
  // the health status says so; it cannot brick boot.
  configureSyslog(getAuditSyslogTarget());
  convergeAgentProviders();
  // Background probe — finishes before any client can hit /api/auth/info in
  // practice (boot completes synchronously to listen()), and the endpoint
  // tolerates the not-yet-probed state by treating it as unhealthy. No await:
  // failing slow shouldn't delay binding.
  void probeTailscaleHealth();

  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    log.warn('Webchat: both WEBCHAT_TLS_CERT and WEBCHAT_TLS_KEY must be set for HTTPS — falling back to HTTP');
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleHttp(req, res, hooks, publicDir).catch((err) => {
      log.error('Webchat HTTP handler threw', { err });
      if (!res.headersSent) {
        // Webchat is single-tenant + auth-gated; surface err.message so
        // operators get a real diagnostic instead of "Internal error". The
        // log line above still has the full stack for debugging.
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error', message }));
      }
    });
  };

  const tlsEnabled = Boolean(tlsCert && tlsKey);
  let httpServer: HttpServer;
  if (tlsCert && tlsKey) {
    httpServer = createHttpsServer(
      { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) },
      requestHandler,
    ) as unknown as HttpServer;
    log.info('Webchat TLS enabled');
  } else {
    httpServer = createHttpServer(requestHandler);
  }

  const wss = setupWebSocket(httpServer, { onInbound: hooks.onInbound }, async (req) => {
    const auth = await authenticateRequest(req);
    if (!auth.ok) return null;
    return { userId: auth.userId, displayName: auth.displayName };
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE on this port is almost always "another nanoclaw host is
      // already running for this checkout" — `pnpm run dev` doesn't single-
      // instance, and a Ctrl-C + restart can leave the old node behind. The
      // generic "Failed to start channel adapter" the registry would log is
      // unhelpful; surface the cause + recovery before rethrowing.
      if (err.code === 'EADDRINUSE') {
        log.fatal(
          `Webchat: port ${port} already in use — another nanoclaw host is likely running for this checkout. ` +
            `Recovery: pgrep -f "$(basename $(pwd)).*tsx" | xargs -r kill -9; sleep 2; pnpm run dev`,
          { host, port },
        );
      }
      reject(err);
    });
    httpServer.listen(port, host, () => {
      log.info('Webchat HTTP listening', { host, port, tls: tlsEnabled });
      warnIfAutoProxyTrust();
      resolve();
    });
  });

  return {
    host,
    port,
    tls: tlsEnabled,
    http: httpServer,
    wss,
    broadcast: (roomId, payload) => {
      broadcast(roomId, payload as object);
    },
    persistOutboundFile: (roomId, file) => persistOutboundFile(roomId, file),
  };
}

export async function stopWebchatServer(server: WebchatServer): Promise<void> {
  // close() waits for every open socket — and a webchat server ALWAYS has
  // open sockets (connected PWAs, WebSocket upgrades, keep-alive API calls).
  // Without force-closing, shutdown hangs until systemd's 90s SIGKILL, which
  // marks the run "unclean" and inflates the crash circuit breaker on every
  // routine restart.
  // closeAllConnections() EXCLUDES upgraded sockets by design — the open
  // WebSocket clients (every connected PWA) are exactly what held close()
  // until systemd's 90s SIGKILL. Terminate them first, then the rest.
  for (const client of server.wss.clients) client.terminate();
  server.wss.close();
  server.http.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.http.close(() => resolve());
  });
  log.info('Webchat HTTP stopped');
}

// ── HTTP request handler ─────────────────────────────────────────────────

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  hooks: WebchatServerHooks,
  publicDir: string,
): Promise<void> {
  // Same-origin-only CORS: echo Origin only when its host matches our Host.
  const origin = req.headers.origin;
  if (origin && req.headers.host) {
    try {
      if (new URL(origin).host === req.headers.host) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    } catch {
      // malformed Origin — refuse to echo
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Security headers on every response (set via setHeader so later writeHead
  // calls merge rather than clobber them). CSP is the key one: this is a chat
  // app rendering LLM/markdown output, so even if the DOMPurify sanitizer is
  // ever bypassed, script-src 'self' stops injected <script>/handlers/eval from
  // executing — defense-in-depth behind the sanitizer. Everything is
  // same-origin and vendored (script-src/connect-src/font-src 'self'); the WS
  // is same-origin so 'self' covers it; img allows data:/blob: (thumbnails,
  // icon masks). style-src keeps 'unsafe-inline' for the handful of inline
  // style= attrs + JS el.style assignments — style injection is low-risk and
  // the script protection stays strict.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      // connect-src additionally allows the two /generate_204 connectivity
      // probes the connection-lost banner uses to tell "Tailscale is off on
      // this device" apart from "no internet" (no-cors, response never read).
      "img-src 'self' data: blob:; connect-src 'self' https://derp1.tailscale.com https://www.gstatic.com; font-src 'self'; " +
      // media-src covers <audio>/Audio() playback of the blob: URL the TTS
      // feature builds from /api/tts's response (default-src 'self' alone would
      // block blob:, mirroring the img-src carve-out above).
      "media-src 'self' blob:; " +
      "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');

  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  // Public endpoints (skip auth)
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/health' && method === 'GET') {
    return json(res, 200, { ok: true, uptime: process.uptime() });
  }
  // Pre-auth, public — the login screen reads this so it can tell the user
  // which methods are configured and whether tailscale is currently working
  // on the server. Returns only configured-method booleans + a coarse
  // tailscale-on-server health flag; no tokens, IPs, or detailed failure
  // reasons. See `getAuthInfo` for why this is safe to expose.
  if (url.pathname === '/api/auth/info' && method === 'GET') {
    return json(res, 200, getAuthInfo());
  }

  // Static PWA assets — the app shell that CONTAINS the login screen — must be
  // reachable BEFORE auth. Otherwise a token-only deployment (no localhost
  // auto-pass, no tailscale) 401s index.html/app.js and the user never sees the
  // field to enter their token. servePwa only serves real files under publicDir
  // (path-traversal guarded) and returns false for anything that isn't a file,
  // so every /api/* route still falls through to the auth gate below.
  if (method === 'GET' && servePwa(req, res, publicDir)) return;

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    return json(res, 401, { error: auth.reason });
  }
  const userId = auth.userId;
  const senderIdentity = auth.displayName;

  // ── Auth check ────────────────────────────────────────────────────────
  if (url.pathname === '/api/auth/check' && method === 'GET') {
    return json(res, 200, { ok: true, userId, identity: senderIdentity });
  }

  // ── Text-to-speech (config probe + synthesis proxy) ───────────────────
  // Authenticated like every other /api/* route; the module owns its own
  // enabled-gating and backend proxying. See tts.ts + /add-webchat-tts skill.
  if (await maybeHandleTts(req, res, url, method)) return;

  // These two routes stay inline (not in API_ROUTES): they read `auth.source`,
  // which only exists in this scope — RouteCtx deliberately carries the
  // resolved identity, not the auth object. Their paths collide with no
  // table entry, so position relative to the table is immaterial.

  // ── Access & security: retire the bearer token ──────────────────────────────
  // Owner/global-admin only. GET reports the auth-method picture so Settings can
  // offer to drop the bootstrap bearer token once Tailscale or SSO/trusted-proxy
  // (EntraID) is live. PUT flips it. Disabling is refused unless (a) something
  // else can authenticate server-side AND (b) THIS request already arrived via a
  // non-bearer method — so the admin proves the alternative works for their own
  // device and can't lock themselves (or everyone) out.
  if (url.pathname === '/api/webchat/auth' && method === 'GET') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    // sessionSource lets the client tell whether disabling the bearer token will
    // actually succeed from THIS session: the retire endpoint refuses a disable
    // requested over bearer (self-lockout guard), so the "retire it now" prompt
    // should only surface when the caller arrived via tailscale / proxy.
    return json(res, 200, { ...getAuthManagementInfo(), sessionSource: auth.source });
  }
  if (url.pathname === '/api/webchat/auth/bearer' && method === 'PUT') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { active?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.active !== 'boolean') return json(res, 400, { error: 'active must be a boolean' });
    const info = getAuthManagementInfo();
    if (!info.bearerConfigured) {
      return json(res, 400, { error: 'No bearer token is configured (WEBCHAT_TOKEN is unset).' });
    }
    if (body.active === false) {
      if (!info.hasAlternativeAuth) {
        return json(res, 400, {
          error:
            'Set up Tailscale or an SSO / trusted-proxy method first — disabling the bearer token now would leave no way to sign in.',
        });
      }
      if (auth.source === 'bearer') {
        return json(res, 400, {
          error:
            'Reconnect via Tailscale or SSO first, then disable the bearer token — otherwise this session would be locked out.',
        });
      }
      setBearerTokenDisabled(true);
    } else {
      setBearerTokenDisabled(false);
    }
    return json(res, 200, getAuthManagementInfo());
  }

  // ── Generate a bearer token + expose on the network ─────────────────────────
  // Owner/global-admin only. The token is a boot-time WEBCHAT_TOKEN, so this
  // WRITES it to .env (plus WEBCHAT_HOST=0.0.0.0 — a token on loopback-only is
  // pointless) and returns it for the operator to copy. It does NOT restart:
  // the wizard fires POST /restart at Finish, so the token can be saved first.
  // Refuses if one already exists (retire it first).
  if (url.pathname === '/api/webchat/auth/bearer/generate' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    if (getAuthManagementInfo().bearerConfigured) {
      return json(res, 400, { error: 'A bearer token is already set. Retire it first to replace it.' });
    }
    // 24 random bytes → 32 base64url chars, comfortably over the 24-char floor.
    const token = randomBytes(24).toString('base64url');
    upsertEnv(process.cwd(), 'WEBCHAT_TOKEN', token);
    upsertEnv(process.cwd(), 'WEBCHAT_HOST', '0.0.0.0');
    // Grant the bearer identity owner. Once WEBCHAT_TOKEN is live the loopback
    // auto-owner bypass is disabled and requests authenticate as `webchat:owner`
    // (auth.ts). On a --local install the owner role sits on `webchat:local-owner`,
    // so without this the operator's own token authenticates as a NON-owner →
    // 403 on every owner endpoint (a self-inflicted lockout on the next restart).
    grantOwnerRole('webchat:owner', userId);
    return json(res, 200, { token });
  }
  // ── Restart the host to load a freshly-written .env (bearer token / bind) ────
  // Owner/global-admin only. Detached systemd restart; the response flushes
  // before the process goes down. The client reconnects on its own.
  if (url.pathname === '/api/webchat/restart' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    scheduleHostRestart();
    return json(res, 202, { restarting: true });
  }

  // This prefix gate ran mid-chain in the old dispatcher; it now runs before
  // the table dispatch (its guarded routes live in API_ROUTES). No route
  // above it in the original order matched these prefixes, so hoisting it is
  // behavior-neutral.
  // MCP + skills marketplace can be turned off workspace-wide (hardened installs
  // — both are code-execution surfaces). Gate every management endpoint at the
  // server, not just the UI, per the admin-surface rule (DOM hide + server 403).
  if (
    (url.pathname === '/api/mcp-servers' ||
      url.pathname.startsWith('/api/mcp-servers/') ||
      url.pathname === '/api/skills' ||
      url.pathname.startsWith('/api/skills/')) &&
    getMarketplaceDisabled()
  ) {
    return json(res, 403, { error: 'MCP and the skills marketplace are disabled by the workspace owner.' });
  }

  for (const r of API_ROUTES) {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (!methods.includes(method)) continue;
    const m =
      typeof r.path === 'string'
        ? url.pathname === r.path
          ? ([url.pathname] as unknown as RegExpMatchArray)
          : null
        : url.pathname.match(r.path);
    if (!m) continue;
    for (const g of r.guards ?? []) {
      if (g === 'csrf' && req.headers['x-webchat-csrf'] !== '1')
        return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
      if (g === 'owner' && !isOwner(userId)) return json(res, 403, { error: 'Owner only' });
      if (g === 'anyAdmin' && !isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    }
    if (!r.audit) return r.h({ req, res, url, method, userId, senderIdentity, hooks }, m);
    // Audited routes are awaited so the recorded outcome is the real one.
    // try/finally, not a happy path: a handler that throws still performed an
    // attempt, and "the request that blew up" is precisely the line someone
    // will be looking for later.
    try {
      await r.h({ req, res, url, method, userId, senderIdentity, hooks }, m);
    } finally {
      audit({
        type: r.audit,
        actor: auditActor({ kind: 'human', userId }),
        action: `${method} ${url.pathname}`,
        effect: res.statusCode >= 400 ? 'failed' : 'ok',
        // Identifiers only — the captured path segment (room id, model id,
        // user id) and the status. Never the body: request payloads carry
        // message text, tokens and env values, and audit.ts is explicit that
        // a log which hoards secrets becomes the thing you leak.
        detail: { status: res.statusCode, ...(m[1] ? { id: m[1] } : {}) },
      });
    }
    return;
  }

  // The engaged-agents routes stay inline (not in API_ROUTES): while the
  // flag below is off they must fall through to the default 404, which a
  // table entry cannot do (matching consumes the request). No table entry
  // matches their paths, so they are checked here, after the table.

  // ── Engaged agents (per-thread set) — DORMANT ──
  // The engaged-agents routing model is disabled (see the dormancy note in
  // index.ts): nothing registers the inbound delivery-plan resolver, so the stored set has no
  // routing effect and no client calls these routes. They are gated OFF behind
  // ENGAGED_AGENTS_ENABLED rather than left live-but-inert — a write that does
  // nothing is a footgun. When off, the routes fall through to the default 404.
  // To bring the subsystem back: flip this flag AND add the registerInboundDeliveryPlanResolver
  // wiring. GET lists, POST engages, DELETE disengages; the 'main' thread can
  // never engage. See docs/webchat/thread-engaged-agents.md.
  const ENGAGED_AGENTS_ENABLED: boolean = false;
  const roomThreadEngagedMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/threads\/([^/]+)\/engaged$/);
  if (ENGAGED_AGENTS_ENABLED && roomThreadEngagedMatch && method === 'GET') {
    const roomId = decodeURIComponent(roomThreadEngagedMatch[1]);
    const threadId = decodeURIComponent(roomThreadEngagedMatch[2]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    return json(res, 200, engagedAgentsForThread(roomId, threadId));
  }
  if (ENGAGED_AGENTS_ENABLED && roomThreadEngagedMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomThreadEngagedMatch[1]);
    const threadId = decodeURIComponent(roomThreadEngagedMatch[2]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    if (threadId === 'main') return json(res, 400, { error: 'The regular chat cannot engage agents' });
    if (!getWebchatThread(roomId, threadId)) return json(res, 404, { error: 'Thread not found' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { agentGroupId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const agentGroupId = typeof body.agentGroupId === 'string' ? body.agentGroupId : '';
    // Only agents actually wired to this room can be engaged.
    if (!getAgentsForWebchatRoom(roomId).some((a) => a.id === agentGroupId)) {
      return json(res, 400, { error: 'Agent is not wired to this room' });
    }
    engageAgent(roomId, threadId, agentGroupId);
    broadcastEngagedSet(roomId, threadId);
    return json(res, 200, { ok: true, engaged: engagedAgentsForThread(roomId, threadId) });
  }
  const roomThreadDisengageMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/threads\/([^/]+)\/engaged\/([^/]+)$/);
  if (ENGAGED_AGENTS_ENABLED && roomThreadDisengageMatch && method === 'DELETE') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomThreadDisengageMatch[1]);
    const threadId = decodeURIComponent(roomThreadDisengageMatch[2]);
    const agentGroupId = decodeURIComponent(roomThreadDisengageMatch[3]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    disengageAgent(roomId, threadId, agentGroupId);
    broadcastEngagedSet(roomId, threadId);
    return json(res, 200, { ok: true, engaged: engagedAgentsForThread(roomId, threadId) });
  }

  // Static PWA is served pre-auth (see the servePwa call above the auth gate).
  return json(res, 404, { error: 'Not found' });
}

// ── Declarative API route table ──────────────────────────────────────────
// One entry per converted branch of the old hand-rolled dispatcher.
// ORDER IS LOAD-BEARING: entries are tried top to bottom in exactly the
// order the original if-chain checked them (literal paths before the
// overlapping :id regexes, e.g. /api/agents/draft before /api/agents/:id).
// Guards run IN ORDER before the handler and reproduce the exact original
// responses; any auth beyond the three uniform checks stays in the handler.

export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  userId: string;
  senderIdentity: string;
  hooks: WebchatServerHooks;
}

type RouteGuard = 'csrf' | 'owner' | 'anyAdmin';

interface ApiRoute {
  method: string | string[];
  path: string | RegExp; // string = exact url.pathname match
  guards?: RouteGuard[]; // applied IN ORDER before the handler
  h: (ctx: RouteCtx, m: RegExpMatchArray) => void | Promise<void>;
  /**
   * Record this route in the audit log under this dotted kind.
   *
   * Declared on the ROUTE rather than called from inside each handler. Twelve
   * scattered audit() calls would be twelve chances to forget one, to record a
   * different shape, or to emit before knowing whether the thing succeeded —
   * and a handler that quietly stops emitting is exactly the failure an audit
   * trail cannot afford. Here it is one line per route, and the dispatcher
   * below reports the real outcome because it emits after the handler has run.
   *
   * Not every privileged route is listed. The bar is audit.ts's own: would
   * this line answer a "who did what" question during an incident? Probes,
   * discovery and progress polls are privileged but say nothing after the
   * fact, and burying the twelve that matter under them helps nobody.
   */
  audit?: string;
}

const RE_ROOM_ID = /^\/api\/rooms\/([^/]+)$/;
// Parameterised paths must be RegExp: a STRING path is compared with `===`,
// so a pattern written as a string silently never matches (404).
const RE_AGENT_EXPORT_TEMPLATE = /^\/api\/agents\/([^/]+)\/export-template$/;
const RE_AGENT_TEMPLATE = /^\/api\/agents\/([^/]+)\/template$/;
const RE_AGENT_TEMPLATE_APPLY = /^\/api\/agents\/([^/]+)\/template\/apply$/;
const RE_TEMPLATE_SOURCE_BROWSE = /^\/api\/template-sources\/([^/]+)\/browse$/;
const RE_TEMPLATE_SOURCE = /^\/api\/template-sources\/([^/]+)$/;
const RE_ROOM_AGENTS = /^\/api\/rooms\/([^/]+)\/agents$/;
const RE_ROOM_MENTIONABLE = /^\/api\/rooms\/([^/]+)\/mentionable$/;
const RE_ROOM_CRED_MODE = /^\/api\/rooms\/([^/]+)\/credential-mode$/;
const RE_ROOM_OAUTH = /^\/api\/rooms\/([^/]+)\/oauth-allowed$/;
const RE_USER_CREDS_MINT = /^\/api\/user-credentials\/oauth\/(start|code|cancel)$/;
const RE_CODEX_MINT = /^\/api\/user-credentials\/codex\/(start|finish|cancel)$/;
const RE_WS_CRED_MINT = /^\/api\/workspace-credential\/oauth\/(start|code|cancel)$/;
const RE_WS_CODEX_MINT = /^\/api\/workspace-credential\/codex\/(start|finish|cancel)$/;
// Grok's device login: POST start|cancel drives it, GET reports it. Polling is a
// GET so it stays cache-neutral and needs no CSRF header on every tick.
const RE_WS_GROK_LOGIN = /^\/api\/workspace-credential\/grok\/(start|cancel)$/;
const RE_ROOM_AGENT = /^\/api\/rooms\/([^/]+)\/agents\/([^/]+)$/;
const RE_ROOM_PRIME = /^\/api\/rooms\/([^/]+)\/prime$/;
const RE_ROOM_ARCHIVE = /^\/api\/rooms\/([^/]+)\/(archive|unarchive)$/;
const RE_ROOM_HIDE = /^\/api\/rooms\/([^/]+)\/(hide|unhide)$/;
const RE_ROOM_PIN = /^\/api\/rooms\/([^/]+)\/(pin|unpin)$/;
const RE_ROOM_ENGAGE = /^\/api\/rooms\/([^/]+)\/engage-mode$/;
const RE_ROOM_NAME = /^\/api\/rooms\/([^/]+)\/name$/;
const RE_ROOM_THREAD_READ = /^\/api\/rooms\/([^/]+)\/threads\/([^/]+)\/read$/;
const RE_ROOM_THREADS = /^\/api\/rooms\/([^/]+)\/threads$/;
const RE_ROOM_THREAD = /^\/api\/rooms\/([^/]+)\/threads\/([^/]+)$/;
const RE_ROOM_THREAD_PULL = /^\/api\/rooms\/([^/]+)\/threads\/([^/]+)\/(pull|push)$/;
const RE_HIST = /^\/api\/rooms\/([^/]+)\/messages$/;
const RE_UPLOAD = /^\/api\/rooms\/([^/]+)\/upload$/;
const RE_CHUNK = /^\/api\/rooms\/([^/]+)\/upload\/chunk$/;
const RE_FILE = /^\/api\/files\/([^/]+)\/([^/]+)$/;
const RE_AGENT = /^\/api\/agents\/([^/]+)$/;
const RE_INSTR = /^\/api\/agents\/([^/]+)\/instructions$/;
const RE_AGENT_ROOMS = /^\/api\/agents\/([^/]+)\/rooms$/;
const RE_AGENT_MODEL = /^\/api\/agents\/([^/]+)\/model$/;
const RE_AGENT_CONFIG_MODEL = /^\/api\/agents\/([^/]+)\/config-model$/;
const RE_AGENT_PROVIDER = /^\/api\/agents\/([^/]+)\/provider$/;
const RE_AGENT_EGRESS = /^\/api\/agents\/([^/]+)\/egress$/;
const RE_AGENT_ENV = /^\/api\/agents\/([^/]+)\/env$/;
const RE_MCP_SOURCE = /^\/api\/mcp-sources\/([^/]+)$/;
const RE_MCP_OAUTH_START = /^\/api\/mcp-servers\/([^/]+)\/oauth\/start$/;
const RE_MCP_REPIN = /^\/api\/mcp-servers\/([^/]+)\/repin$/;
const RE_MCP_TOOLS = /^\/api\/mcp-servers\/([^/]+)\/tools$/;
const RE_MCP_AUTH = /^\/api\/mcp-servers\/([^/]+)\/auth$/;
const RE_MCP_SERVER_ID = /^\/api\/mcp-servers\/([^/]+)$/;
const RE_AGENT_MCP = /^\/api\/agents\/([^/]+)\/mcp-servers$/;
const RE_SKILL_SOURCE = /^\/api\/skills\/sources\/([^/]+)$/;
const RE_SKILL_UPDATE = /^\/api\/skills\/([^/]+)\/update$/;
const RE_SKILL_ITEM = /^\/api\/skills\/([^/]+)$/;
const RE_AGENT_SKILLS = /^\/api\/agents\/([^/]+)\/skills$/;
const RE_AGENT_SKILL_IMPORT = /^\/api\/agents\/([^/]+)\/skills\/import$/;
const RE_SCOPED_SKILL_CONTENT = /^\/api\/agents\/([^/]+)\/skills\/scoped\/([^/]+)\/content$/;
const RE_ROOM_LEARNING = /^\/api\/rooms\/([^/]+)\/learning$/;
const RE_ROOM_EXPORT = /^\/api\/rooms\/([^/]+)\/export$/;
const RE_AGENT_EXPORT = /^\/api\/agents\/([^/]+)\/export$/;
const RE_AGENT_LEARNING = /^\/api\/agents\/([^/]+)\/learning$/;
const RE_SKILL_REVERT = /^\/api\/agents\/([^/]+)\/skills\/scoped\/([^/]+)\/revert$/;
const RE_SKILL_RESTORE = /^\/api\/agents\/([^/]+)\/skills\/archived\/([^/]+)\/restore$/;
const RE_AGENT_SCOPED_SKILL = /^\/api\/agents\/([^/]+)\/skills\/scoped\/([^/]+)$/;
const RE_DRAFT = /^\/api\/skill-drafts\/([^/]+)$/;
const RE_DRAFT_KEEP = /^\/api\/skill-drafts\/([^/]+)\/keep$/;
const RE_AGENT_STATUS = /^\/api\/agents\/([^/]+)\/status$/;
const RE_AGENT_SESSIONS = /^\/api\/agents\/([^/]+)\/sessions$/;
const RE_SESSION_RESET = /^\/api\/sessions\/([^/]+)\/reset$/;
const RE_ROOM_BROADCAST = /^\/api\/rooms\/([^/]+)\/sessions\/broadcast$/;
const RE_ROUTER_DEL = /^\/api\/router\/routers\/([^/]+)$/;
const RE_MODEL_ID = /^\/api\/models\/([^/]+)$/;
const RE_APPROVE = /^\/api\/approvals\/([^/]+)\/respond$/;
const RE_USER_ID = /^\/api\/users\/([^/]+)$/;

// ── Overview ──────────────────────────────────────────────────────────
async function rOverviewGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  return json(res, 200, await buildOverview(userId));
}

// ── UserCreds Codex browser-mint: connect a ChatGPT subscription without a terminal
// `codex login --device-auth` runs in a throwaway container; the user enters
// the pairing code at OpenAI's site (no code pasted back here). 'start' returns
// the URL + code; 'finish' waits for the written auth.json and stores it as the
// member's user-level Codex credential (→ an `openai` auth.json secret). Same
// gates as the Claude mint: room access + the room's OAuth opt-in.
async function rCodexMintPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { roomId?: unknown; sessionId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const step = m[1];
  if (step === 'cancel') {
    if (typeof body.sessionId === 'string') cancelMint(userId, body.sessionId);
    return json(res, 200, { ok: true });
  }
  const roomId = typeof body.roomId === 'string' ? body.roomId : '';
  if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
  if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
  if (!getCredentialsConfig().allowCodexOauth)
    return json(res, 403, {
      error: 'This workspace does not accept Codex (ChatGPT) subscription (OAuth) connections.',
    });
  const groups = getAgentsForWebchatRoom(roomId);
  if (groups.length === 0) return json(res, 400, { error: 'Room has no wired agent' });
  try {
    if (step === 'start') {
      if (activeMintCount() >= MAX_ACTIVE_MINTS)
        return json(res, 429, { error: 'Too many sign-ins in progress — try again shortly.' });
      if (userCredsRateLimited(userId, 'mint-start'))
        return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
      const { sessionId, url: signinUrl, userCode } = await startCodexMint(userId);
      return json(res, 200, { sessionId, url: signinUrl, userCode });
    }
    // step === 'finish': wait for auth.json, then onboard.
    if (typeof body.sessionId !== 'string') return json(res, 400, { error: 'sessionId required' });
    const authJson = await finishCodexMint(userId, body.sessionId);
    await storeUserCredential(realOnecliAdmin, userId, 'codex', authJson, 'oauth_token');
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

// "My credentials" — the self-service surface for PERSONAL credentials.
// Deliberately NOT admin-gated: the whole point of a per-user PAT is that its
// owner is the only one who ever handles it, so each person needs a place to
// manage their own without an admin in the loop. Returns only the caller's
// own credentials, for the agents they are actually enrolled in.
async function rToolSecretsMine(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, url, method, userId } = ctx;
  const seen = new Set<string>();
  const groups: { agentGroupId: string; name: string; secrets: unknown[] }[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    for (const row of listEnrolledGroups(userId, provider)) {
      if (seen.has(row.agent_group_id)) continue;
      seen.add(row.agent_group_id);
      const group = getAgentGroup(row.agent_group_id);
      if (!group) continue;
      groups.push({
        agentGroupId: group.id,
        name: group.name,
        secrets: await listToolSecrets(realOnecliAdmin, {
          kind: 'user',
          agentGroupId: group.id,
          userId,
        }),
      });
    }
  }
  return json(res, 200, { groups: groups.sort((a, b) => a.name.localeCompare(b.name)) });
}

// Tool secrets — per-agent-group API credentials (PATs, tokens, third-party
// keys) injected by the OneCLI gateway. The sanctioned alternative to pasting
// a token into a room, which would persist it in webchat_messages, the session
// DB and every archived transcript. Admin-only on every verb, and WRITE-ONLY:
// GET returns metadata (id/label/host) and never a value, so this endpoint can
// never become a way to read a stored credential back out.
async function rToolSecrets(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, url, method, userId } = ctx;
  // Scope: no agentGroupId (or '*') = system-wide; + userId = that person only.
  // Auth is scope-dependent and applied once the scope is known (below).
  const rawGroup = url.searchParams.get('agentGroupId');
  const rawUser = url.searchParams.get('userId');
  const agentGroupId = rawGroup && rawGroup !== '*' ? rawGroup : null;
  if (agentGroupId && !getAgentGroup(agentGroupId)) return json(res, 400, { error: 'Unknown agent group' });
  if (rawUser && !agentGroupId) return json(res, 400, { error: 'userId needs an agentGroupId' });
  const scope: Scope = !agentGroupId
    ? WORKSPACE
    : rawUser
      ? { kind: 'user', agentGroupId, userId: rawUser }
      : { kind: 'agent', agentGroupId };
  // Authorisation follows the scope, not one blanket rule:
  //  - workspace: install-wide, so owner / global admin only.
  //  - agent: whoever ADMINISTERS that agent, which includes scoped admins —
  //    matching hasAdminPrivilege as used everywhere else for per-group
  //    actions. (Gating this on owner-only locked scoped admins out of the
  //    agents they run.)
  //  - user (self): anyone. A personal credential must be entered by its
  //    owner; an admin doing it for them would have to handle that person's
  //    token, which is what per-user credentials exist to prevent.
  //  - user (someone else): nobody, at any privilege level.
  const isSelfScope = scope.kind === 'user' && scope.userId === userId;
  const isElevated = isOwner(userId) || isGlobalAdmin(userId);
  const canAdminGroup = agentGroupId ? isElevated || hasAdminPrivilege(userId, agentGroupId) : isElevated;
  const permitted = scope.kind === 'workspace' ? isElevated : scope.kind === 'agent' ? canAdminGroup : isSelfScope;
  if (!permitted)
    return json(res, 403, {
      error: scope.kind === 'user' ? 'You can only manage your own credentials' : 'Forbidden',
    });
  try {
    if (method === 'GET') {
      // For an agent scope also return each enrolled member and THEIR
      // credentials, so the panel can offer per-person PATs without a second
      // round trip (and can show who is eligible at all — user scope needs a
      // per-member agent, which only exists once someone has connected).
      const members =
        agentGroupId && !rawUser
          ? await Promise.all(
              listGroupMemberEnrollments(agentGroupId).map(async (row) => ({
                userId: row.user_id,
                secrets: await listToolSecrets(realOnecliAdmin, {
                  kind: 'user' as const,
                  agentGroupId,
                  userId: row.user_id,
                }),
              })),
            )
          : null;
      return json(res, 200, {
        secrets: await listToolSecrets(realOnecliAdmin, scope),
        isolation: agentGroupId ? await getGroupIsolation(realOnecliAdmin, agentGroupId) : null,
        members,
      });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (userCredsRateLimited(userId, 'tool-secret'))
      return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
    if (method === 'DELETE') {
      const secretId = url.searchParams.get('id') ?? '';
      const removed = await deleteToolSecret(realOnecliAdmin, scope, secretId);
      return removed ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not a secret of this agent' });
    }
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    const body = JSON.parse(raw) as { value?: string; hostPattern?: string; scheme?: unknown };
    const value = body.value ?? '';
    const hostPattern = (body.hostPattern ?? '').trim();
    if (!value || !hostPattern) return json(res, 400, { error: 'host and value are required' });
    // Optional: how the credential goes on the wire, for a host that cannot say
    // which service answers there. Either a preset name or a custom
    // {headerName, valueFormat}. resolveAuthScheme owns the validation — header
    // token charset, forbidden request-control headers, exactly one {value},
    // printable single-line template — so a crafted request cannot smuggle a
    // header or split the request.
    let scheme: AuthScheme | undefined;
    if (body.scheme !== undefined) {
      const resolved = resolveAuthScheme(body.scheme);
      if ('error' in resolved) return json(res, 400, { error: resolved.error });
      scheme = resolved;
    }
    // The host pattern is what SCOPES the credential. A bare `*` (or a
    // wildcard anywhere but the leading label) would offer the token to every
    // site the agent touches — the whole point is that a DevOps PAT never
    // leaves dev.azure.com. Allow `example.com` and `*.example.com`, nothing looser.
    if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(hostPattern))
      return json(res, 400, { error: 'hostPattern must be a hostname, optionally *.example.com' });
    // Injection scheme is inferred from the host (injectionForHost) rather than
    // asked for — the operator should not need to know an API's auth header by
    // heart, and one credential per host is the sane model. The exception is a
    // self-hosted service on an IP, which no host rule can identify; there the
    // operator names the service and the table still supplies the header.
    const created = await createToolSecret(realOnecliAdmin, scope, hostPattern, value, scheme);
    return json(res, 200, { ok: true, secret: created });
  } catch (err) {
    // Never echo the error verbatim — an onecli failure can quote the argv it
    // was given, which includes the secret value. The refusal messages from
    // tool-secrets itself are safe and actionable, so surface just those.
    log.error('Tool secret request failed', { agentGroupId, method, err });
    const msg = err instanceof Error ? err.message : '';
    const safe =
      /^(No OneCLI agent|Could not (create|isolate)|No model credential|This person has not|A credential for)/.test(
        msg,
      );
    return json(res, safe ? 409 : 500, { error: safe ? msg : 'Vault operation failed — check host logs' });
  }
}

// Credential isolation for one agent group: flip its OneCLI agent between
// `all` (receives every matching vault secret) and `selective` (only what is
// assigned). Per-agent secrets are meaningless without this — see
// modules/tool-secrets.
async function rToolSecretsIsolation(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, url, method, userId } = ctx;
  // CSRF stays the outermost gate so a cross-site POST cannot probe which agent
  // group ids exist. Authorisation then follows the scope, as in rToolSecrets:
  // this toggle is per-agent, so whoever ADMINISTERS that agent may flip it —
  // gating it on owner-only left scoped admins able to assign per-agent secrets
  // but unable to turn on the isolation that makes them mean anything.
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const agentGroupId = url.searchParams.get('agentGroupId') ?? '';
  if (!getAgentGroup(agentGroupId)) return json(res, 400, { error: 'Unknown agent group' });
  if (!isOwner(userId) && !isGlobalAdmin(userId) && !hasAdminPrivilege(userId, agentGroupId))
    return json(res, 403, { error: 'Forbidden' });
  try {
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    const isolated = !!(JSON.parse(raw) as { isolated?: boolean }).isolated;
    if (isolated) await isolateGroup(realOnecliAdmin, agentGroupId);
    else await unisolateGroup(realOnecliAdmin, agentGroupId);
    return json(res, 200, { ok: true, isolation: await getGroupIsolation(realOnecliAdmin, agentGroupId) });
  } catch (err) {
    log.error('Tool secret isolation change failed', { agentGroupId, err });
    const msg = err instanceof Error ? err.message : '';
    const safe = /^(No OneCLI agent|No model credential)/.test(msg);
    return json(res, safe ? 409 : 500, { error: safe ? msg : 'Vault operation failed — check host logs' });
  }
}

// Deploy keys — per-agent SSH keypairs. Not vault-backed: OneCLI injects into
// outbound HTTPS, and SSH is not HTTP, so these are files in the group folder
// (which is mounted only into that group's container, so they are private to
// the agent by construction). The PRIVATE half is never returned by any verb
// here — only the public key, which is the half you paste into a server.
async function rDeployKeys(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, url, method, userId } = ctx;
  const agentGroupId = url.searchParams.get('agentGroupId') ?? '';
  if (!getAgentGroup(agentGroupId)) return json(res, 400, { error: 'Unknown agent group' });
  // Per-agent resource → whoever administers that agent, scoped admins included.
  if (!isOwner(userId) && !isGlobalAdmin(userId) && !hasAdminPrivilege(userId, agentGroupId))
    return json(res, 403, { error: 'Forbidden' });
  if (method === 'GET') return json(res, 200, { keys: listDeployKeys(agentGroupId) });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (userCredsRateLimited(userId, 'deploy-key'))
    return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
  try {
    if (method === 'DELETE') {
      const removed = deleteDeployKey(agentGroupId, url.searchParams.get('name') ?? '');
      if (removed) await refreshCredentialNote(realOnecliAdmin, agentGroupId);
      return removed ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No such key' });
    }
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    const body = JSON.parse(raw) as { name?: string; target?: string };
    const name = (body.name ?? '').trim().toLowerCase();
    const target = (body.target ?? '').trim() || undefined;
    // Re-stamping an existing key's target must not regenerate it — anything
    // already trusting the public half would break.
    const key = listDeployKeys(agentGroupId).some((k) => k.name === name)
      ? setDeployKeyTarget(agentGroupId, name, target ?? '')
      : createDeployKey(agentGroupId, name, target);
    await refreshCredentialNote(realOnecliAdmin, agentGroupId);
    return json(res, 200, { ok: true, key });
  } catch (err) {
    log.error('Deploy key request failed', { agentGroupId, method, err });
    const msg = err instanceof Error ? err.message : '';
    // These refusals are safe to show — they name a rule, never a key.
    const safe = /^(Name must be|Target must|A key named|No key named|This agent has no)/.test(msg);
    return json(res, safe ? 409 : 500, { error: safe ? msg : 'Could not manage deploy keys' });
  }
}

// ── Workspace DEFAULT logins (owner / global admin ONLY) ────────────────────────
// The fallback credentials `all`-mode base agents auto-inject when a member has no
// user credential of their own — `claude` (Anthropic key or subscription) and,
// when the Codex provider is installed, `codex` (OpenAI key or ChatGPT
// subscription). STRICTLY admin-only on EVERY verb incl. GET — a non-admin gets
// 403 with no body, so even the existence/connection state of the defaults never
// leaks (unlike /api/webchat/credentials-config, which is world-readable so room
// UIs can see accepted types).
async function rWorkspaceCredential(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, url, method, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
  // The OneCLI vault, loaded lazily + once per request: only the GET path needs
  // it (to detect a pre-existing credential), and only when there's no webchat
  // row to short-circuit on.
  let vaultSecrets: { id: string; type?: string }[] | null = null;
  const loadVault = async () => {
    if (vaultSecrets === null) {
      try {
        vaultSecrets = await realOnecliAdmin.listAllSecrets();
      } catch {
        vaultSecrets = []; // vault unreachable — fall back to "not connected"
      }
    }
    return vaultSecrets;
  };
  const trackedSecretIds = new Set(listAllTrackedSecretIds());
  // `connected` is true when the webchat manages a workspace-default credential
  // (`external:false`) OR when a usable provider credential already lives in the
  // OneCLI vault from `/setup` or a legacy path (`external:true`) — the latter is
  // what base `all`-mode agents already authenticate with, so the wizard must
  // not nag the operator to "connect" an engine that already works. An external
  // credential is webchat-unmanaged: no cred_type to show, and not disconnectable.
  const credState = async (provider: 'claude' | 'codex') => {
    const row = getUserCredential(WORKSPACE_DEFAULT_USER_ID, provider);
    if (row?.status === 'active') return { connected: true, credType: row.cred_type ?? null, external: false };
    const secType = provider === 'codex' ? 'openai' : 'anthropic';
    const external = (await loadVault()).some((s) => s.type === secType && !trackedSecretIds.has(s.id));
    return { connected: external, credType: null, external };
  };
  if (method === 'GET') {
    // Flat claude fields (the original shape) + a codex block + the workspace
    // default MODEL (the Ollama-engine analogue of the default credential).
    const defaultModelId = getDefaultModelId();
    const defaultModel = defaultModelId ? getWebchatModel(defaultModelId) : undefined;
    return json(res, 200, {
      ...(await credState('claude')),
      provider: 'claude',
      codex: await credState('codex'),
      codexAvailable: codexAvailable(),
      // Grok resolves from a host credential file, not a user_credentials row
      // or a vault secret — see server/grok-status.ts for why.
      grok: grokStatus(),
      defaultModelId: defaultModel?.id ?? null,
      defaultModelName: defaultModel ? `${defaultModel.name} (${defaultModel.model_id})` : null,
      // Real fields so the wizard's Ollama card only claims "set" when an Ollama
      // model is actually the default — kind is authoritative, not inferred.
      defaultModelKind: defaultModel?.kind ?? null,
      defaultModelModelId: defaultModel?.model_id ?? null,
    });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (userCredsRateLimited(userId, 'connect'))
    return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
  // Provider: PUT reads it from the body below; DELETE from the query string.
  try {
    if (method === 'DELETE') {
      const provider = url.searchParams.get('provider') === 'codex' ? 'codex' : 'claude';
      const priorOauth = getUserCredential(WORKSPACE_DEFAULT_USER_ID, provider)?.cred_type === 'oauth_token';
      await revokeUserCredential(realOnecliAdmin, WORKSPACE_DEFAULT_USER_ID, provider);
      restartGroupsForWorkspaceCredChange(provider, priorOauth, false);
      return json(res, 200, { ok: true });
    }
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { provider?: unknown; type?: unknown; apiKey?: unknown; token?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const provider = body.provider === 'codex' ? 'codex' : 'claude';
    if (provider === 'codex' && !codexAvailable())
      return json(res, 400, { error: 'Codex support isn’t installed yet — add it with /add-codex first.' });
    const priorOauth = getUserCredential(WORKSPACE_DEFAULT_USER_ID, provider)?.cred_type === 'oauth_token';
    if (body.type === 'oauth_token') {
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (provider === 'codex') {
        // A ChatGPT/Codex subscription = a whole auth.json (normally from the
        // browser mint; pasting is the fallback). Mirror the member validation.
        let ok = false;
        try {
          const parsed = JSON.parse(token) as Record<string, unknown>;
          ok = Boolean(parsed.tokens || parsed.OPENAI_API_KEY);
        } catch {
          ok = false;
        }
        if (!ok)
          return json(res, 400, {
            error: 'Expected a Codex auth.json — use “Connect with ChatGPT subscription” instead of pasting.',
          });
      } else if (!/^sk-ant-oat/.test(token)) {
        // Claude subscription: pasted `claude setup-token` output. The base-agent
        // sentinel wiring (user-credentials/index.ts env resolver) flips base
        // containers into OAuth mode to match.
        return json(res, 400, {
          error: 'Expected a Claude subscription token from `claude setup-token` (sk-ant-oat…)',
        });
      }
      await setWorkspaceDefaultCredential(realOnecliAdmin, provider, token, 'oauth_token');
      afterWorkspaceCredentialSet(provider, priorOauth, true);
      return json(res, 200, { ok: true });
    }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (provider === 'codex') {
      if (!/^sk-/.test(apiKey)) return json(res, 400, { error: 'Expected an OpenAI API key (sk-…)' });
    } else if (!/^sk-ant-/.test(apiKey)) {
      return json(res, 400, { error: 'Expected an Anthropic API key (sk-ant-…)' });
    }
    await setWorkspaceDefaultCredential(realOnecliAdmin, provider, apiKey, 'api_key');
    afterWorkspaceCredentialSet(provider, priorOauth, false);
    return json(res, 200, { ok: true });
  } catch (err) {
    log.error('Workspace default credential failed', {
      userId,
      err: err instanceof Error ? err.message : err,
    });
    return json(res, 502, { error: 'Credential setup failed — check OneCLI is running.' });
  }
}

// ── Workspace-default OAuth browser-mint (owner / global admin ONLY) ────────────
// Same throwaway-container `claude setup-token` flow as the per-member mint, but
// the captured token is stored as the WORKSPACE DEFAULT (synthetic id), and the
// gates are admin-only instead of room access + the member OAuth opt-in (that
// policy governs members; the operator setting the workspace fallback is above it).
async function rWsCredMintPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { sessionId?: unknown; code?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const step = m[1];
  if (step === 'cancel') {
    if (typeof body.sessionId === 'string') cancelMint(userId, body.sessionId);
    return json(res, 200, { ok: true });
  }
  try {
    if (step === 'start') {
      if (activeMintCount() >= MAX_ACTIVE_MINTS)
        return json(res, 429, { error: 'Too many sign-ins in progress — try again shortly.' });
      if (userCredsRateLimited(userId, 'mint-start'))
        return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
      const { sessionId, url: signinUrl } = await startClaudeMint(userId);
      return json(res, 200, { sessionId, url: signinUrl });
    }
    // step === 'code': mint, then store as the workspace default. The spawn-time
    // sentinel mode may have changed (none/key → oauth) — respawn containers.
    if (typeof body.sessionId !== 'string' || typeof body.code !== 'string')
      return json(res, 400, { error: 'sessionId and code required' });
    const priorRow = getUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude');
    const priorOauth = priorRow?.status === 'active' && priorRow.cred_type === 'oauth_token';
    const token = await mintClaudeToken(userId, body.sessionId, body.code);
    await setWorkspaceDefaultCredential(realOnecliAdmin, 'claude', token, 'oauth_token');
    afterWorkspaceCredentialSet('claude', priorOauth, true);
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Workspace-default Codex browser-mint (owner / global admin ONLY) ────────────
// Same `codex login --device-auth` throwaway-container flow as the per-member
// Codex mint, but the captured auth.json is stored as the WORKSPACE DEFAULT
// (synthetic id) `openai` secret that `all`-mode Codex base agents auto-inject.
async function rWsCodexMintPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { sessionId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const step = m[1];
  if (step === 'cancel') {
    if (typeof body.sessionId === 'string') cancelMint(userId, body.sessionId);
    return json(res, 200, { ok: true });
  }
  if (!codexAvailable())
    return json(res, 400, { error: 'Codex support isn’t installed yet — add it with /add-codex first.' });
  try {
    if (step === 'start') {
      if (activeMintCount() >= MAX_ACTIVE_MINTS)
        return json(res, 429, { error: 'Too many sign-ins in progress — try again shortly.' });
      if (userCredsRateLimited(userId, 'mint-start'))
        return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
      const { sessionId, url: signinUrl, userCode } = await startCodexMint(userId);
      return json(res, 200, { sessionId, url: signinUrl, userCode });
    }
    // step === 'finish': wait for auth.json, then store as the workspace default.
    if (typeof body.sessionId !== 'string') return json(res, 400, { error: 'sessionId required' });
    const priorRow = getUserCredential(WORKSPACE_DEFAULT_USER_ID, 'codex');
    const priorOauth = priorRow?.status === 'active' && priorRow.cred_type === 'oauth_token';
    const authJson = await finishCodexMint(userId, body.sessionId);
    await setWorkspaceDefaultCredential(realOnecliAdmin, 'codex', authJson, 'oauth_token');
    afterWorkspaceCredentialSet('codex', priorOauth, true);
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Workspace DEFAULT model (owner / global admin ONLY) ─────────────────────────
// The ollama-kind roster model every claude-family agent WITHOUT its own
// assignment falls back to — what makes "default engine: Ollama" a true
// workspace-wide default rather than a one-agent assignment. Same strict
// admin gating as the workspace credential.
async function rWorkspaceModelPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { modelId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (body.modelId !== null) {
    if (typeof body.modelId !== 'string' || !body.modelId.trim())
      return json(res, 400, { error: 'modelId must be a string or null' });
    const model = getWebchatModel(body.modelId.trim());
    if (!model) return json(res, 404, { error: 'Model not found' });
    if (model.kind !== 'ollama')
      return json(res, 400, { error: 'The workspace default model must be an ollama roster model' });
    if (!model.endpoint) return json(res, 400, { error: 'That model has no endpoint to call' });
    setDefaultModelId(model.id);
  } else {
    setDefaultModelId(null);
  }
  refreshUnassignedGroupsForDefaultModel('Workspace default model changed');
  return json(res, 200, { ok: true, defaultModelId: getDefaultModelId() });
}

// Room → agent → model topology for the explore view, scoped to the caller's
// accessible rooms (and only the agents/models reachable from them).
async function rTopologyGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const rooms = filterRoomsForUser(userId, getAllWebchatRooms());
  // ALL agents the caller manages become columns/nodes (not just wired ones),
  // so unused agents show as orphans and can be wired from the matrix.
  const agents = listAgentsForUser(userId).map((a) => ({ id: a.id, name: a.name }));
  const topo = getWebchatTopology(rooms, agents);
  // SCOPED skills only — the ones wired to a specific agent (including anything
  // the learning loop produced). The shared pool is on ~every agent, so drawing
  // it would add hundreds of identical edges that say nothing about any one
  // agent; it stays visible in the agent's own settings. A skill wired to two
  // agents is ONE node with two edges — that's the fact worth seeing.
  const skillMap = new Map<string, { id: string; name: string; origin: string | null }>();
  const skillEdges: { agent: string; skill: string }[] = [];
  for (const a of agents) {
    for (const sk of listScopedSkills(a.id)) {
      if (!skillMap.has(sk.name)) {
        skillMap.set(sk.name, { id: sk.name, name: sk.name, origin: sk.origin?.label ?? null });
      }
      skillEdges.push({ agent: a.id, skill: sk.name });
    }
  }
  return json(res, 200, { ...topo, skills: [...skillMap.values()], skillEdges });
}

// Full-text search across the caller's accessible rooms (FTS5). Scoped to
// rooms the user can see — never leaks messages from other rooms.
async function rSearchGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  const q = url.searchParams.get('q') ?? '';
  if (!q.trim()) return json(res, 200, { results: [] });
  const rooms = filterRoomsForUser(userId, getAllWebchatRooms());
  const nameById = new Map(rooms.map((r) => [r.id, r.name]));
  const hits = searchWebchatMessages(
    rooms.map((r) => r.id),
    q,
    50,
  );
  return json(res, 200, {
    results: hits.map((h) => ({
      id: h.id,
      roomId: h.room_id,
      roomName: nameById.get(h.room_id) ?? h.room_id,
      sender: h.sender,
      senderType: h.sender_type,
      snippet: redactSensitiveData(h.snippet),
      createdAt: h.created_at,
    })),
  });
}

async function rHistGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  const room = getWebchatRoom(m[1]);
  if (!room) return json(res, 404, { error: 'Room not found' });
  if (!canAccessRoom(userId, room.id)) return json(res, 403, { error: 'Access denied' });
  const afterId = url.searchParams.get('after_id');
  const beforeId = url.searchParams.get('before_id');
  // Optional thread filter — absent = the whole room (back-compat).
  const threadId = url.searchParams.get('thread_id') || undefined;
  const msgs = afterId
    ? getWebchatMessagesAfterId(room.id, afterId, 200, threadId)
    : beforeId
      ? getWebchatMessagesBeforeId(room.id, beforeId, 50, threadId)
      : getWebchatMessages(room.id, 100, threadId);
  return json(
    res,
    200,
    msgs.map((m) => ({ ...m, content: redactSensitiveData(m.content) })),
  );
}

// ── Upload (multipart / chunked) + serve ──────────────────────────────
// Require a custom header on uploads so cross-origin form-POSTs (which are
// CORS "simple requests" and skip preflight) can't auto-attach credentials
// from a fronting proxy / cookie / Tailscale identity. The PWA sets this
// header in authFetch().
async function rUploadPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, url, userId, senderIdentity, hooks } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const csrfOk = req.headers['x-webchat-csrf'] === '1';
  const accessOk = canAccessRoom(userId, roomId);
  log.info('Webchat upload (multipart) request', {
    roomId,
    userId,
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
    csrfOk,
    accessOk,
  });
  if (!csrfOk) return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!accessOk) return json(res, 403, { error: 'Access denied' });
  return handleMultipartUpload(
    req,
    res,
    roomId,
    senderIdentity,
    userId,
    hooks,
    url.searchParams.get('thread_id') || undefined,
  );
}

async function rChunkPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, url, userId, senderIdentity, hooks } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const csrfOk = req.headers['x-webchat-csrf'] === '1';
  const accessOk = canAccessRoom(userId, roomId);
  log.info('Webchat upload (chunked) request', {
    roomId,
    userId,
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
    csrfOk,
    accessOk,
  });
  if (!csrfOk) return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!accessOk) return json(res, 403, { error: 'Access denied' });
  return handleChunkedUpload(
    req,
    res,
    roomId,
    senderIdentity,
    userId,
    hooks,
    url.searchParams.get('thread_id') || undefined,
  );
}

async function rFileGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
  return handleFileServe(res, roomId, decodeURIComponent(m[2]));
}

async function rInstrGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  return readInstructions(res, group.id);
}

async function rInstrPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  return writeInstructions(req, res, group.id);
}

// ── MCP servers (registry + per-agent assignment) ──────────────────────
// A registry of MCP tool servers (webchat_mcp_servers) mirroring the models
// registry: define a server once (owner-gated CRUD + a probe that connects
// as a real MCP client and lists the server's tools), then attach it to any
// number of agents. Assignment syncs container_configs.mcp_servers — the
// same field `ncl groups config add-mcp-server` writes and the container
// reads — and restarts the group's containers. List responses never include
// env/headers (they may hold credentials).

// Read / edit the SKILL.md of a skill scoped to ONE agent (its own
// .claude-shared/skills — where a learned-and-kept or per-agent import lives).
// A scoped skill affects only this agent, so per-group admin is sufficient to
// view AND edit — it can never reach an agent the caller can't access. (Pool
// skills fan out install-wide and stay owner/global-admin via /api/skills/:name.)
// The /content suffix keeps this distinct from the scoped wire/unwire routes.
async function rScopedSkillContent(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const group = resolveAgent(decodeURIComponent(m[1]));
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  const name = sanitizeSkillName(decodeURIComponent(m[2]));
  if (!name) return json(res, 400, { error: 'Invalid skill name' });
  if (method === 'GET') return getScopedSkillContentHandler(res, group.id, name);
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return putScopedSkillContentHandler(req, res, group.id, name);
}

/**
 * What is this install running?
 *
 * Nothing answered that before: an operator could read the nanoclaw version off
 * package.json by hand, and had NO way to tell which webchat overlay was
 * layered on top of it — this repo's versions.json is a build input and is
 * never copied in, and the install's own versions.json is nanoclaw's (onecli +
 * agent-image pins), a different file that happens to share a name.
 *
 * Read-only and deliberately so. Updating either component is a git operation
 * against a customised tree (see the /update-nanoclaw skill and install.sh);
 * this reports state, it does not change it.
 *
 * Every field is independently optional. A tarball install has no git, an
 * install composed before the provenance stamp existed has no stamp, and a
 * partial answer is far more useful than a 500.
 */
/**
 * Compare the payload on disk against the fingerprint install.sh stamped.
 *
 * Answers the question the old `dirty` flag only appeared to: has anything in
 * this install changed since it was composed? Hand-copying a single file into
 * a running tree is a real and easy thing to do — it is how you ship a fix
 * ahead of a merge — and the failure mode is that the install quietly stops
 * being any released version, with nothing on screen saying so.
 *
 * Reports the count checked alongside the drift so "nothing changed" and
 * "nothing was checked" cannot be confused: a missing stamp returns null and
 * About says the install predates the check, rather than claiming it is clean.
 *
 * Cost is bounded by the payload (the overlay plus patch targets, a few
 * hundred small files), not the tree, and it runs only when About is opened.
 */
export function checkComposition(root: string): { checked: number; drifted: string[]; matches: boolean } | null {
  let stamp: { files?: Record<string, string> };
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(root, '.webchat-payload.json'), 'utf8')) as typeof stamp;
  } catch {
    return null; // composed before this existed, or a tarball install
  }
  const files = stamp.files;
  if (!files || typeof files !== 'object') return null;

  const drifted: string[] = [];
  let checked = 0;
  for (const [rel, want] of Object.entries(files)) {
    checked++;
    try {
      const got = createHash('sha256')
        .update(fs.readFileSync(path.join(root, rel)))
        .digest('hex');
      if (got !== want) drifted.push(rel);
    } catch {
      drifted.push(rel); // gone is a form of changed, and the more alarming one
    }
  }
  drifted.sort();
  return { checked, drifted, matches: drifted.length === 0 };
}

export function collectVersions(root = process.cwd()): {
  nanoclaw: { version: string | null; commit: string | null };
  /** Does the payload on disk still match what the composition wrote? */
  composition: { checked: number; drifted: string[]; matches: boolean } | null;
  webchat: {
    ref: string | null;
    dirty: boolean | null;
    upstreamRef: string | null;
    seamRef: string | null;
    composedAt: string | null;
  } | null;
  components: Record<string, string>;
} {
  const readJson = (p: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const pkg = readJson('package.json');
  const prov = readJson('.webchat-provenance.json');
  // nanoclaw's own versions.json — onecli + agent image. Named the same as this
  // repo's build-input file and unrelated to it; that collision is why the
  // comment above exists.
  const comps = readJson('versions.json') ?? {};

  let commit: string | null = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 3000 }).toString().trim() || null;
  } catch {
    /* not a git checkout, or git is absent — both fine */
  }
  // `git status` used to ride along here as `dirty`. It was true on every
  // install that ever worked — the composed tree carries the overlay and every
  // patch, so it is modified by construction — which made it a constant
  // wearing a warning's clothes. What an operator actually wants to know is
  // whether the payload still matches the release, and that is below.

  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const components: Record<string, string> = {};
  for (const [k, v] of Object.entries(comps)) if (typeof v === 'string') components[k] = v;

  return {
    nanoclaw: { version: str(pkg?.version), commit },
    composition: checkComposition(root),
    webchat: prov
      ? {
          ref: str(prov.webchatRef),
          dirty: typeof prov.webchatDirty === 'boolean' ? prov.webchatDirty : null,
          upstreamRef: str(prov.upstreamRef),
          seamRef: str(prov.seamRef),
          composedAt: str(prov.composedAt),
        }
      : null,
    components,
  };
}

async function rSystemVersionsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, collectVersions());
}

// ── System backup (Phase 2): export streams; restore swaps + reboots ──
async function rSystemExportGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const lean = url.searchParams.get('lean') === '1';
  let stage: string;
  try {
    stage = await stageSystemExport(lean);
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  const fname = `nanoclaw-system-${new Date().toISOString().slice(0, 10)}${lean ? '-lean' : ''}.tgz`;
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${fname}"`,
  });
  const tar = spawnTar(systemTarArgs(stage, lean));
  tar.stdout?.pipe(res);
  let tarErr = '';
  tar.stderr?.on('data', (d: Buffer) => (tarErr += d));
  tar.on('close', (code: number) => {
    fs.rmSync(stage, { recursive: true, force: true });
    // tar exits 1 for "file changed as we read it" — tolerable on a live
    // system; only exit 2 (fatal) voids the stream.
    if (code !== null && code >= 2) {
      log.error('System export tar failed', { code, err: tarErr.slice(0, 300) });
      res.destroy();
    } else {
      res.end();
    }
  });
  res.on('close', () => tar.kill('SIGTERM'));
  return;
}

async function rSystemImportPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return importSystemUploadHandler(req, res);
}

async function rSystemImportApplyPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return importSystemApplyHandler(req, res);
}

async function rDraftPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  // Edit a pending draft's body before keeping it. Same tier as Keep: admin
  // over the agent the draft belongs to — editing shapes what gets kept.
  const id = decodeURIComponent(m[1]);
  const draft = getSkillDraft(id);
  if (!draft || draft.status !== 'pending') return json(res, 404, { error: 'Draft not found' });
  if (!hasAdminPrivilege(userId, draft.agent_group_id)) return json(res, 403, { error: 'Admin privilege required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body = '';
  try {
    body = String((JSON.parse(raw) as { body?: unknown }).body || '');
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (!/^---\s*\n[\s\S]*?description:\s*\S[\s\S]*?\n---/.test(body)) {
    return json(res, 400, { error: 'Body must be a SKILL.md with YAML front-matter including a description' });
  }
  if (!updateSkillDraftBody(id, body)) return json(res, 404, { error: 'Draft not found' });
  return json(res, 200, { ok: true });
}

async function rDraft(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const id = decodeURIComponent(m[1]);
  const draft = getSkillDraft(id);
  if (!draft || draft.status !== 'pending') return json(res, 404, { error: 'Draft not found' });
  // Same tier as PUT/Keep: admin over the agent the draft belongs to. A
  // scoped admin of group B must not read or discard group A's drafts —
  // isAnyAdmin above only hides existence from non-admins.
  if (!hasAdminPrivilege(userId, draft.agent_group_id)) return json(res, 403, { error: 'Admin privilege required' });
  if (method === 'GET') {
    // For a patch, hand back the version it would REPLACE too, so the reviewer
    // sees what actually changes rather than a wall of unchanged text.
    let currentBody = '';
    if (draft.kind === 'patch' && draft.target_skill) {
      currentBody = readSkillBody(draft.agent_group_id, draft.target_skill);
    }
    return json(res, 200, {
      id: draft.id,
      skillName: draft.skill_name,
      description: draft.description,
      kind: draft.kind,
      targetSkill: draft.target_skill,
      agentGroupId: draft.agent_group_id,
      body: readSkillDraftBody(id) || '',
      currentBody,
    });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!resolveSkillDraft(id, 'discarded')) return json(res, 404, { error: 'Draft not found' });
  resolveDraftCard(id, 'discarded', userId);
  return json(res, 200, { ok: true });
}

// Keep + wire a draft to an agent group (scoped, origin "learned").
async function rDraftKeepPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const id = decodeURIComponent(m[1]);
  const draft = getSkillDraft(id);
  if (!draft || draft.status !== 'pending') return json(res, 404, { error: 'Draft not found' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  // Admin over the draft's OWN group is required here; the handler separately
  // checks admin over the body-supplied TARGET group. Without this, a scoped
  // admin of group B could wire group A's draft content into group B.
  if (!hasAdminPrivilege(userId, draft.agent_group_id)) return json(res, 403, { error: 'Admin privilege required' });
  return keepSkillDraftHandler(req, res, userId, draft);
}

// ── Learning timeline (Journey view) ───────────────────────────────────
// Read-only chronological feed of what each agent learned, derived from the
// records that already exist — no new event storage:
//   - proposed / kept / discarded: the persisted in-room skill-draft cards
//     (the ONLY durable outcome record — resolveSkillDraft deletes the row),
//     plus pending skill_drafts rows that never got a card (non-webchat).
//     Card events are dated by PROPOSAL time; resolution time isn't stored.
//   - kept (fallback): a learned-origin scoped skill with no card recording
//     its keep (pre-cards, or kept outside webchat). Dated by its oldest
//     history snapshot when revised (first-revision time bounds the keep),
//     else SKILL.md mtime.
//   - revised: on-disk .history/<name>/<ts>/ snapshots. A revert also
//     snapshots (and consumes the restored one), so reverts appear here as
//     revisions — the disk record can't tell them apart.
//   - archived: the curator's .archive/ entries, dated by dir mtime.
// Visibility mirrors the drafts-list rule: owner sees all, a scoped admin
// only their groups. Row actions on the client reuse EXISTING endpoints
// (scoped-skill editor, revert); this route mutates nothing.
interface LearningTimelineEvent {
  id: string;
  kind: 'proposed' | 'kept' | 'discarded' | 'revised' | 'archived';
  ts: number; // epoch ms, as the sources store it — display conversion is client-side
  agentGroupId: string;
  agentName: string;
  skillName: string;
  description?: string;
  roomId?: string | null;
  roomName?: string | null;
  /** Who resolved it: a user id, 'auto-keep', 'expired', or 'superseded'. */
  by?: string | null;
  draftId?: string;
  /** kept/revised only: the scoped skill is live, so the editor can open it. */
  skillExists?: boolean;
  /** Newest revision of a live skill only — the existing revert endpoint applies. */
  canRevert?: boolean;
}

// At equal ts (a kept dated by its first-revision snapshot), the revision
// reads as the more recent act — rank it above in the newest-first feed.
const TIMELINE_KIND_RANK: Record<LearningTimelineEvent['kind'], number> = {
  proposed: 0,
  kept: 1,
  discarded: 2,
  revised: 3,
  archived: 4,
};

async function rLearningTimelineGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 200);
  const beforeRaw = Number(url.searchParams.get('before'));
  const cutoff = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : Number.MAX_SAFE_INTEGER;

  const owner = isOwner(userId);
  const allowed = new Map<string, string>();
  for (const g of getAllAgentGroups()) {
    if (owner || hasAdminPrivilege(userId, g.id)) allowed.set(g.id, g.name || g.id);
  }

  const events: LearningTimelineEvent[] = [];
  const roomNameOf = (roomId: string | null): string | null => (roomId ? (getWebchatRoom(roomId)?.name ?? null) : null);
  const skillLives = (gid: string, name: string): boolean =>
    !!name && fs.existsSync(path.join(scopedSkillsDir(gid), name, 'SKILL.md'));

  // 1. Draft cards — fetched unwindowed (bounded) so the kept-card dedupe set
  // is complete regardless of the page cursor; the sort+slice below pages.
  const cards = listSkillDraftCards(undefined, 1000);
  const keptCardSkills = new Set<string>();
  for (const c of cards) {
    if (!allowed.has(c.agentGroupId)) continue;
    const landed = sanitizeSkillName(c.kind === 'patch' && c.targetSkill ? c.targetSkill : c.skillName);
    if (c.status === 'kept' && landed) keptCardSkills.add(`${c.agentGroupId}/${landed}`);
    if (c.createdAt >= cutoff) continue;
    const kind = c.status === 'pending' ? 'proposed' : c.status;
    events.push({
      id: `card-${c.draftId}`,
      kind,
      ts: c.createdAt,
      agentGroupId: c.agentGroupId,
      agentName: allowed.get(c.agentGroupId) as string,
      skillName: landed || c.skillName,
      description: c.description || undefined,
      roomId: c.roomId,
      roomName: roomNameOf(c.roomId),
      by: c.resolvedBy,
      draftId: c.draftId,
      skillExists: kind === 'kept' ? skillLives(c.agentGroupId, landed) : undefined,
    });
  }

  // 2. Pending drafts that never got a card (proposed from a non-webchat session).
  for (const d of listSkillDrafts()) {
    if (!allowed.has(d.agent_group_id) || d.created_at >= cutoff) continue;
    if (skillDraftCardPosition(d.id)) continue; // its card is the event
    events.push({
      id: `draft-${d.id}`,
      kind: 'proposed',
      ts: d.created_at,
      agentGroupId: d.agent_group_id,
      agentName: allowed.get(d.agent_group_id) as string,
      skillName: d.kind === 'patch' && d.target_skill ? d.target_skill : d.skill_name,
      description: d.description || undefined,
      roomId: draftSourceRoom(d.session_id),
      roomName: roomNameOf(draftSourceRoom(d.session_id)),
      draftId: d.id,
    });
  }

  // 3. Disk: revisions, card-less keeps, curator archives — per visible agent.
  for (const [gid, gname] of allowed) {
    const dir = scopedSkillsDir(gid);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      // Dirent kinds come from lstat: pooled symlinks fail isDirectory() and skip.
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const name = e.name;
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(dir, name, 'SKILL.md')).mtimeMs;
      } catch {
        continue; // not a skill
      }
      const revs = listRevisions(dir, name);
      revs.forEach((rev, i) => {
        if (rev >= cutoff) return;
        events.push({
          id: `rev-${gid}-${name}-${rev}`,
          kind: 'revised',
          ts: rev,
          agentGroupId: gid,
          agentName: gname,
          skillName: name,
          skillExists: true,
          canRevert: i === 0 ? true : undefined,
        });
      });
      if (readSkillOrigin(path.join(dir, name))?.label === 'learned' && !keptCardSkills.has(`${gid}/${name}`)) {
        const ts = Math.round(revs.length ? revs[revs.length - 1] : mtime);
        if (ts < cutoff) {
          events.push({
            id: `keep-${gid}-${name}`,
            kind: 'kept',
            ts,
            agentGroupId: gid,
            agentName: gname,
            skillName: name,
            skillExists: true,
          });
        }
      }
    }
    for (const a of listArchivedSkills(gid)) {
      const ts = Math.round(a.archivedAt);
      if (ts >= cutoff) continue;
      events.push({
        id: `arch-${gid}-${a.name}`,
        kind: 'archived',
        ts,
        agentGroupId: gid,
        agentName: gname,
        skillName: a.name,
      });
    }
  }

  events.sort(
    (a, b) => b.ts - a.ts || TIMELINE_KIND_RANK[b.kind] - TIMELINE_KIND_RANK[a.kind] || a.id.localeCompare(b.id),
  );
  // The cursor is strictly-less-than, so a page must never end mid-tie — any
  // event sharing the boundary ts (e.g. a kept dated by its first revision)
  // would be unreachable from the next page. Extend across the tie instead.
  const page = events.slice(0, limit);
  let nextBefore: number | null = null;
  if (events.length > limit) {
    const lastTs = page[page.length - 1].ts;
    let i = limit;
    while (i < events.length && events[i].ts === lastTs) page.push(events[i++]);
    nextBefore = i < events.length ? lastTs : null;
  }
  return json(res, 200, { events: page, nextBefore });
}

async function rSessionResetPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const session = getSession(decodeURIComponent(m[1]));
  if (!session) return json(res, 404, { error: 'Session not found' });
  if (!hasAdminPrivilege(userId, session.agent_group_id)) {
    return json(res, 403, { error: 'Admin privilege required' });
  }
  try {
    injectSessionCommand(session.agent_group_id, session.id, '/clear');
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Voice list, proxied from the TTS backend (Kokoro serves ~67). Owner-only —
// it's the voice-picker's data source, not a runtime need.
async function rTtsVoicesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  try {
    const upstream = await fetch(`${ttsEndpoint()}/v1/audio/voices`, { signal: AbortSignal.timeout(5000) });
    if (!upstream.ok) return json(res, 502, { error: `TTS backend answered ${upstream.status}` });
    const body = (await upstream.json()) as { voices?: unknown };
    const voices = Array.isArray(body.voices) ? body.voices.filter((v) => typeof v === 'string') : [];
    return json(res, 200, { voices });
  } catch {
    return json(res, 502, { error: 'TTS backend unreachable' });
  }
}

// Auto-learn MASTER switch (Settings → Features). GET for every authed user
// (the client hides the per-agent / per-room learning controls when off);
// PUT is owner-only. Enforced at spawn in materializeContainerJson.
async function rLearningConfig(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const canEdit = isOwner(userId) || isGlobalAdmin(userId);
  if (method === 'GET') {
    const base = { enabled: getLearningMasterEnabled() };
    return json(
      res,
      canEdit ? 200 : 200,
      canEdit
        ? { ...base, canEdit: true, classifierModelId: getLearningClassifier().modelId }
        : { ...base, canEdit: false },
    );
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!canEdit) return json(res, 403, { error: 'Owner only' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { enabled?: unknown; classifierModelId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  // Classifier model pick — resolve the roster model to CONTAINER-REACHABLE
  // call params so the agent-runner (a Docker container) can reach it.
  if ('classifierModelId' in body) {
    if (body.classifierModelId === null) {
      setLearningClassifier(null, null, null);
      return json(res, 200, { ok: true, classifierModelId: null });
    }
    if (typeof body.classifierModelId !== 'string' || !body.classifierModelId.trim())
      return json(res, 400, { error: 'classifierModelId must be a string or null' });
    const model = getWebchatModel(body.classifierModelId.trim());
    if (!model) return json(res, 404, { error: 'Model not found' });
    const clf = classifierParamsForModel(model);
    if (!clf)
      return json(res, 400, {
        error: 'Classifier must be an ollama or openai-compatible roster model with an endpoint',
      });
    setLearningClassifier(model.id, clf.url, clf.model);
    return json(res, 200, { ok: true, classifierModelId: model.id });
  }
  if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' });
  setLearningMasterEnabled(body.enabled);
  return json(res, 200, { ok: true, enabled: body.enabled });
}

// Read aloud is workspace-level: the owner flips it for everyone (the GET
// half lives in tts.ts's public config probe).
async function rTtsConfigPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { readAloud?: unknown; voice?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  // Voice change — persisted to .env and activated in-process (no restart).
  // Strict shape: Kokoro voice ids / blends only, since this lands in .env.
  if ('voice' in body) {
    if (typeof body.voice !== 'string' || !/^[a-z0-9_]+(\+[a-z0-9_]+)*$/.test(body.voice) || body.voice.length > 120)
      return json(res, 400, { error: 'voice must be a voice id (letters/digits/underscore, + for blends)' });
    upsertEnv(process.cwd(), 'WEBCHAT_TTS_VOICE', body.voice);
    process.env.WEBCHAT_TTS_VOICE = body.voice;
    return json(res, 200, { ok: true, voice: body.voice });
  }
  if (typeof body.readAloud !== 'boolean') return json(res, 400, { error: 'readAloud must be a boolean' });
  setReadAloudEnabled(body.readAloud);
  return json(res, 200, { ok: true, readAloud: body.readAloud });
}

// Dictation runtime config. GET is for every authed user (the mic gates on
// `enabled`); provider/cleanup details only for owners/global admins.
async function rSttConfig(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const canEdit = isOwner(userId) || isGlobalAdmin(userId);
  if (method === 'GET') {
    const base = { enabled: sttEnabled(), cleanup: getSttCleanupModelId() !== null };
    return json(
      res,
      200,
      canEdit
        ? {
            ...base,
            provider: sttProvider(),
            cleanupModelId: getSttCleanupModelId(),
            cleanupPrompt: getSttCleanupPrompt(),
            defaultCleanupPrompt: DEFAULT_CLEANUP_PROMPT,
            canEdit: true,
          }
        : base,
    );
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!canEdit) return json(res, 403, { error: 'Forbidden' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { cleanupModelId?: unknown; cleanupPrompt?: unknown; enabled?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  // Workspace toggle — mirrors Read aloud: the owner flips the mic for
  // everyone. Env-backed (WEBCHAT_STT_ENABLED already gates every STT
  // surface), persisted + activated in-process.
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' });
    upsertEnv(process.cwd(), 'WEBCHAT_STT_ENABLED', body.enabled ? 'true' : 'false');
    process.env.WEBCHAT_STT_ENABLED = body.enabled ? 'true' : 'false';
    return json(res, 200, { ok: true, enabled: body.enabled });
  }
  // Prompt edit — its own PUT shape; null/empty resets to the built-in default.
  if ('cleanupPrompt' in body) {
    if (body.cleanupPrompt !== null && typeof body.cleanupPrompt !== 'string')
      return json(res, 400, { error: 'cleanupPrompt must be a string or null' });
    const trimmed = typeof body.cleanupPrompt === 'string' ? body.cleanupPrompt.trim() : '';
    if (trimmed.length > 4000) return json(res, 413, { error: 'Prompt too long (4000 chars max)' });
    const stored = trimmed && trimmed !== DEFAULT_CLEANUP_PROMPT ? trimmed : null;
    setSttCleanupPrompt(stored);
    return json(res, 200, { ok: true, cleanupPrompt: stored });
  }
  if (body.cleanupModelId === null) {
    setSttCleanupModelId(null);
    return json(res, 200, { ok: true, cleanupModelId: null });
  }
  if (typeof body.cleanupModelId !== 'string' || !body.cleanupModelId.trim())
    return json(res, 400, { error: 'cleanupModelId must be a string or null' });
  const model = getWebchatModel(body.cleanupModelId.trim());
  if (!model) return json(res, 404, { error: 'Model not found' });
  if (model.kind !== 'ollama' && model.kind !== 'openai-compatible')
    return json(res, 400, { error: 'Cleanup model must be an ollama or openai-compatible roster model' });
  if (!model.endpoint) return json(res, 400, { error: 'That model has no endpoint to call' });
  setSttCleanupModelId(model.id);
  return json(res, 200, { ok: true, cleanupModelId: model.id });
}

async function rSttTranscribePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  if (!sttEnabled()) return json(res, 404, { error: 'Voice dictation not configured' });
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_SEGMENT_BYTES) return json(res, 413, { error: 'Segment too large' });
  const chunks: Buffer[] = [];
  let received = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    received += c.length;
    if (received > MAX_SEGMENT_BYTES) {
      aborted = true;
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  await new Promise<void>((resolve) => {
    req.on('end', resolve);
    req.on('close', resolve);
    req.on('error', resolve);
  });
  if (aborted) return json(res, 413, { error: 'Segment too large' });
  const wav = Buffer.concat(chunks);
  // Below ~1 kB it's a click or an empty buffer, not speech — don't bill a
  // transcription round-trip for it.
  if (wav.length < MIN_SEGMENT_BYTES) return json(res, 200, { text: '' });
  try {
    const text = await transcribeSegment(wav);
    return json(res, 200, { text });
  } catch (err) {
    log.warn('Webchat STT: transcription failed', { err: err instanceof Error ? err.message : err });
    return json(res, 502, { error: 'Transcription failed — check the dictation backend.' });
  }
}

async function rSttCleanupPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { text?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.text !== 'string') return json(res, 400, { error: 'text required' });
  if (body.text.length > MAX_CLEANUP_CHARS) return json(res, 413, { error: 'Text too long to clean up' });
  const result = await cleanupTranscript(body.text);
  return json(res, 200, result);
}

// ── Approvals inbox (per-user) ────────────────────────────────────────
// ── Approval pre-judge config (owner-only; Settings → Approval pre-judge) ──
// See src/modules/approvals/prejudge.ts and docs/webchat/approval-prejudge.md.

function prejudgeConfigView(): Record<string, unknown> {
  return {
    modelId: getApprovalPrejudgeModelId(),
    actions: getApprovalPrejudgeActions(),
    // Every action registered with an approval handler — the opt-in
    // candidates the settings UI lists.
    knownActions: listRegisteredApprovalActions(),
    neverList: {
      actions: [...NEVER_AUTO_APPROVE_ACTIONS],
      payloadPatterns: NEVER_AUTO_APPROVE_PATTERNS.map((re) => re.source),
    },
  };
}

async function rApprovalPrejudgeGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, prejudgeConfigView());
}

async function rApprovalPrejudgePut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { modelId?: unknown; actions?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  if ('modelId' in body) {
    if (body.modelId !== null && typeof body.modelId !== 'string') {
      return json(res, 400, { error: 'modelId must be a roster model id or null' });
    }
    if (typeof body.modelId === 'string') {
      // Same gate as the runtime consult (prejudge.ts): anthropic-kind
      // models qualify with a NULL endpoint — they route through the
      // OneCLI gateway rather than a local /v1/chat/completions server.
      const model = getWebchatModel(body.modelId);
      if (!isUsableJudgeModel(model)) {
        return json(res, 400, {
          error:
            'modelId must name an anthropic roster model, or an ollama/openai-compatible roster model with an endpoint',
        });
      }
    }
  }
  let actions: string[] | undefined;
  if ('actions' in body) {
    if (!Array.isArray(body.actions) || body.actions.some((a) => typeof a !== 'string' || !a.trim())) {
      return json(res, 400, { error: 'actions must be an array of non-empty action names' });
    }
    actions = [...new Set((body.actions as string[]).map((a) => a.trim()))];
    const blocked = actions.filter((a) => NEVER_AUTO_APPROVE_ACTIONS.has(a));
    if (blocked.length > 0) {
      return json(res, 400, { error: `never-auto-approve actions cannot be opted in: ${blocked.join(', ')}` });
    }
  }

  if ('modelId' in body) setApprovalPrejudgeModelId((body.modelId as string | null) ?? null);
  if (actions !== undefined) setApprovalPrejudgeActions(actions);
  return json(res, 200, { ok: true, ...prejudgeConfigView() });
}

async function rApprovalsPendingGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const rows = getWebchatPendingApprovalsForUser(userId);
  return json(
    res,
    200,
    rows.map((r) => ({
      questionId: r.approval_id,
      action: r.action,
      title: r.title,
      options: JSON.parse(r.options_json),
      // Payload is action-specific (apt list / mcp config / etc). The PWA
      // renders it as a JSON-pretty block so the user can review what
      // they're approving without us having to ship per-action templates.
      payload: safeParseJson(r.payload),
      created_at: r.created_at,
    })),
  );
}

async function rApprovePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId, hooks } = ctx;
  const approvalId = decodeURIComponent(m[1]);
  const pending = getPendingApproval(approvalId);
  if (!pending || pending.status !== 'pending') {
    return json(res, 404, { error: 'Approval not found or already resolved' });
  }
  // Authorize against the webchat-owned index, not the pending_approvals row
  // columns — trunk's `requestApproval` doesn't populate channel_type /
  // platform_id, so those are NULL on every webchat-routed approval. Same
  // constraint that drove the read path's JOIN against webchat_approvals_index.
  const expectedPlatformId = approvalInboxForUser(userId);
  if (!expectedPlatformId || !isWebchatApprovalIndexedFor(approvalId, expectedPlatformId)) {
    return json(res, 403, { error: 'Not the intended approver for this request' });
  }
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { value?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const value = typeof body.value === 'string' ? body.value : '';
  if (value !== 'approve' && value !== 'reject') {
    return json(res, 400, { error: 'value must be "approve" or "reject"' });
  }
  // Hand off to the existing approvals plumbing — onAction → response
  // handler → registered approval handler. We don't update the row here;
  // handleApprovalsResponse owns the lifecycle (status update + delete).
  hooks.onAction(approvalId, value, userId);
  return json(res, 200, { ok: true });
}

// ── Push ──────────────────────────────────────────────────────────────
async function rPushVapidPublicGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const pub = process.env.WEBCHAT_VAPID_PUBLIC_KEY || '';
  if (!pub) return json(res, 501, { error: 'WEBCHAT_VAPID_PUBLIC_KEY not set' });
  return json(res, 200, { key: pub });
}

async function rPushSubscribePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  // CSRF: with ambient auth (localhost auto-pass / tailscale whois) a
  // cross-site simple POST is the one vector that skips the preflight —
  // these two were the only mutating POSTs without the header check.
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return pushSubscribe(req, res, userId);
}

async function rPushUnsubscribePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  return pushUnsubscribe(req, res, userId);
}

const API_ROUTES: ApiRoute[] = [
  { method: 'GET', path: '/api/me/handle', h: rMeHandleGet },
  { method: 'PUT', path: '/api/me/handle', guards: ['csrf'], h: rMeHandlePut },
  { method: 'GET', path: '/api/overview', h: rOverviewGet },
  { method: 'GET', path: '/api/rooms', h: rRoomsGet },
  { method: 'POST', path: '/api/rooms', guards: ['csrf', 'owner'], h: rRoomsPost },
  { method: 'DELETE', path: RE_ROOM_ID, guards: ['owner', 'csrf'], h: rRoomIdDelete, audit: 'room.delete' },
  { method: 'GET', path: RE_ROOM_AGENTS, h: rRoomAgentsGet },
  { method: 'GET', path: RE_ROOM_MENTIONABLE, h: rRoomMentionableGet },
  { method: 'POST', path: RE_ROOM_AGENTS, guards: ['csrf'], h: rRoomAgentsPost },
  { method: 'GET', path: RE_ROOM_CRED_MODE, h: rRoomCredModeGet },
  { method: 'PUT', path: RE_ROOM_CRED_MODE, guards: ['csrf'], h: rRoomCredModePut },
  { method: 'GET', path: RE_ROOM_OAUTH, h: rRoomOauthGet },
  { method: 'PUT', path: RE_ROOM_OAUTH, guards: ['csrf'], h: rRoomOauthPut },
  { method: ['GET', 'PUT'], path: '/api/webchat/credentials-config', h: rWebchatCredentialsConfig },
  { method: ['POST', 'DELETE', 'GET'], path: '/api/user-credentials/credential', h: rUserCredentialsCredential },
  { method: 'POST', path: RE_USER_CREDS_MINT, guards: ['csrf'], h: rUserCredsMintPost },
  { method: 'POST', path: RE_CODEX_MINT, guards: ['csrf'], h: rCodexMintPost },
  { method: ['GET', 'PUT', 'DELETE'], path: '/api/workspace-credential', h: rWorkspaceCredential },
  { method: 'GET', path: '/api/tool-secrets/mine', h: rToolSecretsMine },
  { method: ['GET', 'POST', 'DELETE'], path: '/api/tool-secrets', h: rToolSecrets },
  { method: 'POST', path: '/api/tool-secrets/isolation', h: rToolSecretsIsolation },
  { method: ['GET', 'POST', 'DELETE'], path: '/api/deploy-keys', h: rDeployKeys },
  { method: 'POST', path: RE_WS_CRED_MINT, h: rWsCredMintPost },
  { method: 'POST', path: RE_WS_CODEX_MINT, h: rWsCodexMintPost },
  { method: 'POST', path: RE_WS_GROK_LOGIN, guards: ['csrf', 'owner'], h: rGrokLoginPost },
  { method: 'GET', path: '/api/workspace-credential/grok', guards: ['owner'], h: rGrokLoginGet },
  { method: 'PUT', path: '/api/workspace-model', h: rWorkspaceModelPut },
  { method: ['GET', 'PUT'], path: '/api/webchat/onboarding', h: rWebchatOnboarding },
  { method: ['GET', 'PUT'], path: '/api/webchat/features', h: rWebchatFeatures },
  { method: 'GET', path: '/api/webchat/usage', guards: ['owner'], h: rWebchatUsageGet },
  { method: 'GET', path: '/api/models/manage', guards: ['owner'], h: rModelsManageGet },
  { method: 'POST', path: '/api/models/context-variant', guards: ['csrf', 'owner'], h: rModelsContextVariantPost },
  { method: ['GET', 'PUT'], path: '/api/webchat/tailscale-owner', h: rWebchatTailscaleOwner },
  { method: ['GET', 'PUT'], path: '/api/webchat/audit-syslog', h: rWebchatAuditSyslog },
  { method: 'GET', path: '/api/webchat/audit-log', h: rWebchatAuditLog },
  { method: ['GET', 'POST'], path: '/api/webchat/tailscale-https', h: rWebchatTailscaleHttps },
  { method: 'GET', path: '/api/webchat/cloudflared', h: rWebchatCloudflaredGet },
  { method: 'POST', path: '/api/webchat/cloudflared/install', guards: ['csrf'], h: rWebchatCloudflaredInstallPost },
  { method: 'POST', path: '/api/webchat/cloudflared/connect', guards: ['csrf'], h: rWebchatCloudflaredConnectPost },
  { method: 'DELETE', path: RE_ROOM_AGENT, h: rRoomAgentDelete },
  { method: 'PUT', path: RE_ROOM_PRIME, guards: ['owner', 'csrf'], h: rRoomPrimePut },
  { method: 'DELETE', path: RE_ROOM_PRIME, guards: ['owner', 'csrf'], h: rRoomPrimeDelete },
  { method: 'POST', path: RE_ROOM_ARCHIVE, guards: ['csrf'], h: rRoomArchivePost },
  { method: 'POST', path: RE_ROOM_HIDE, guards: ['csrf'], h: rRoomHidePost },
  { method: 'POST', path: RE_ROOM_PIN, guards: ['csrf'], h: rRoomPinPost },
  { method: 'POST', path: '/api/rooms/pins/order', guards: ['csrf'], h: rRoomsPinsOrderPost },
  { method: 'GET', path: RE_ROOM_ENGAGE, h: rRoomEngageGet },
  { method: 'PUT', path: RE_ROOM_ENGAGE, guards: ['owner', 'csrf'], h: rRoomEngagePut },
  { method: 'PUT', path: RE_ROOM_NAME, guards: ['csrf', 'owner'], h: rRoomNamePut },
  { method: 'PUT', path: RE_ROOM_THREAD_READ, guards: ['csrf'], h: rRoomThreadReadPut },
  { method: 'GET', path: RE_ROOM_THREADS, h: rRoomThreadsGet },
  { method: 'POST', path: RE_ROOM_THREADS, guards: ['csrf'], h: rRoomThreadsPost },
  { method: 'PATCH', path: RE_ROOM_THREAD, guards: ['csrf'], h: rRoomThreadPatch },
  { method: 'DELETE', path: RE_ROOM_THREAD, guards: ['csrf', 'owner'], h: rRoomThreadDelete },
  { method: 'POST', path: RE_ROOM_THREAD_PULL, guards: ['csrf'], h: rRoomThreadPullPost },
  { method: 'GET', path: '/api/topology', h: rTopologyGet },
  { method: 'GET', path: '/api/search', h: rSearchGet },
  { method: 'GET', path: RE_HIST, h: rHistGet },
  { method: 'POST', path: RE_UPLOAD, h: rUploadPost },
  { method: 'POST', path: RE_CHUNK, h: rChunkPost },
  { method: 'GET', path: RE_FILE, h: rFileGet },
  { method: 'GET', path: '/api/agents', h: rAgentsGet },
  // POST /api/agents/draft must come BEFORE the /api/agents/:id pattern
  // (which would otherwise match 'draft' as an id) AND before the bare
  // /api/agents POST so the literal-path handlers stay distinct.
  { method: 'POST', path: '/api/agents/draft', h: rAgentsDraftPost },
  { method: 'POST', path: RE_AGENT_EXPORT_TEMPLATE, guards: ['csrf'], h: rAgentExportTemplatePost },
  { method: 'GET', path: RE_AGENT_TEMPLATE, h: rAgentTemplatePlanGet },
  { method: 'POST', path: RE_AGENT_TEMPLATE_APPLY, guards: ['csrf'], h: rAgentTemplateApplyPost },
  { method: 'GET', path: '/api/templates', h: rTemplatesGet },
  // `detail` and `fetch` are literal segments and must precede nothing here —
  // /api/templates takes no :id pattern — but they stay adjacent for clarity.
  { method: 'GET', path: '/api/templates/detail', h: rTemplateDetailGet },
  { method: 'DELETE', path: '/api/templates', guards: ['csrf'], h: rTemplateDelete },
  { method: 'POST', path: '/api/templates/fetch', guards: ['csrf'], h: rTemplateFetchPost },
  { method: 'GET', path: '/api/template-sources', h: rTemplateSourcesGet },
  { method: 'POST', path: '/api/template-sources', guards: ['csrf'], h: rTemplateSourcePost },
  { method: 'GET', path: RE_TEMPLATE_SOURCE_BROWSE, h: rTemplateSourceBrowseGet },
  { method: 'DELETE', path: RE_TEMPLATE_SOURCE, guards: ['csrf'], h: rTemplateSourceDelete },
  // Literal path — must precede the /api/agents/:id patterns, which would
  // otherwise match 'from-template' as an agent id.
  { method: 'POST', path: '/api/agents/from-template', guards: ['csrf'], h: rAgentsFromTemplatePost },
  { method: 'POST', path: '/api/agents', guards: ['csrf'], h: rAgentsPost },
  { method: 'PUT', path: RE_AGENT, h: rAgentPut },
  { method: 'DELETE', path: RE_AGENT, h: rAgentDelete },
  { method: 'GET', path: RE_INSTR, h: rInstrGet },
  { method: 'PUT', path: RE_INSTR, h: rInstrPut },
  { method: 'GET', path: RE_AGENT_ROOMS, h: rAgentRoomsGet },
  { method: 'PUT', path: RE_AGENT_MODEL, h: rAgentModelPut },
  { method: 'PUT', path: RE_AGENT_CONFIG_MODEL, h: rAgentConfigModelPut },
  { method: 'PUT', path: RE_AGENT_PROVIDER, h: rAgentProviderPut },
  { method: 'PUT', path: RE_AGENT_EGRESS, h: rAgentEgressPut },
  { method: ['GET', 'PUT', 'DELETE'], path: RE_AGENT_ENV, h: rAgentEnv },
  { method: 'GET', path: '/api/mcp-servers', guards: ['anyAdmin'], h: rMcpServersGet },
  { method: 'POST', path: '/api/mcp-servers', guards: ['csrf', 'anyAdmin'], h: rMcpServersPost, audit: 'mcp.create' },
  { method: 'GET', path: '/api/mcp-sources', guards: ['anyAdmin'], h: rMcpSourcesGet },
  { method: 'PUT', path: RE_MCP_SOURCE, h: rMcpSourcePut },
  { method: 'DELETE', path: RE_MCP_SOURCE, h: rMcpSourceDelete },
  { method: 'POST', path: RE_MCP_SOURCE, h: rMcpSourcePost },
  { method: 'GET', path: '/api/mcp-catalog', guards: ['anyAdmin'], h: rMcpCatalogGet },
  { method: 'POST', path: '/api/mcp-servers/probe', guards: ['csrf', 'anyAdmin'], h: rMcpServersProbePost },
  { method: 'GET', path: '/api/mcp-servers/oauth/callback', h: rMcpServersOauthCallbackGet },
  { method: 'POST', path: RE_MCP_OAUTH_START, guards: ['anyAdmin', 'csrf'], h: rMcpOauthStartPost },
  { method: 'POST', path: RE_MCP_REPIN, guards: ['anyAdmin', 'csrf'], h: rMcpRepinPost },
  { method: 'PUT', path: RE_MCP_TOOLS, guards: ['anyAdmin', 'csrf'], h: rMcpToolsPut },
  { method: 'PUT', path: RE_MCP_AUTH, h: rMcpAuthPut },
  { method: 'PUT', path: RE_MCP_SERVER_ID, guards: ['owner', 'csrf'], h: rMcpServerIdPut, audit: 'mcp.update' },
  { method: 'DELETE', path: RE_MCP_SERVER_ID, guards: ['owner', 'csrf'], h: rMcpServerIdDelete, audit: 'mcp.delete' },
  { method: ['GET', 'PUT'], path: RE_AGENT_MCP, h: rAgentMcp },
  { method: 'GET', path: '/api/skills', guards: ['anyAdmin'], h: rSkillsGet },
  { method: 'POST', path: '/api/skills/import', h: rSkillsImportPost },
  { method: 'GET', path: '/api/skills/catalog', guards: ['anyAdmin'], h: rSkillsCatalogGet },
  { method: 'GET', path: '/api/skills/suggest', guards: ['anyAdmin'], h: rSkillsSuggestGet },
  // NOTE: the literal /api/skills/* routes must stay ABOVE the
  // /api/skills/:name (RE_SKILL_ITEM) matcher.
  { method: 'GET', path: '/api/skills/sources', guards: ['anyAdmin'], h: rSkillsSourcesGet },
  { method: ['PUT', 'DELETE'], path: RE_SKILL_SOURCE, h: rSkillSource },
  { method: 'POST', path: '/api/skills/inspect', guards: ['anyAdmin', 'csrf'], h: rSkillsInspectPost },
  { method: 'GET', path: '/api/skills/updates', guards: ['anyAdmin'], h: rSkillsUpdatesGet },
  { method: 'POST', path: RE_SKILL_UPDATE, h: rSkillUpdatePost },
  { method: 'GET', path: '/api/skills/duplicates', guards: ['anyAdmin'], h: rSkillsDuplicatesGet },
  { method: 'POST', path: '/api/skills/promote', h: rSkillsPromotePost },
  { method: ['GET', 'PUT', 'DELETE'], path: RE_SKILL_ITEM, guards: ['anyAdmin'], h: rSkillItem },
  { method: ['GET', 'PUT'], path: RE_AGENT_SKILLS, h: rAgentSkills },
  { method: 'POST', path: RE_AGENT_SKILL_IMPORT, h: rAgentSkillImportPost },
  { method: ['GET', 'PUT'], path: RE_SCOPED_SKILL_CONTENT, h: rScopedSkillContent },
  { method: ['GET', 'PUT'], path: RE_ROOM_LEARNING, h: rRoomLearning },
  // Read-only, but owner/global-admin gated: exact component versions are
  // reconnaissance, and this install now hides every other owner-only surface
  // from non-owners. Consistency beats a marginal convenience here.
  { method: 'GET', path: '/api/system/versions', guards: ['anyAdmin'], h: rSystemVersionsGet },
  { method: 'GET', path: '/api/system/export', guards: ['owner'], h: rSystemExportGet, audit: 'system.export' },
  {
    method: 'POST',
    path: '/api/system/import',
    guards: ['owner', 'csrf'],
    h: rSystemImportPost,
    audit: 'system.import',
  },
  {
    method: 'POST',
    path: '/api/system/import/apply',
    guards: ['owner', 'csrf'],
    h: rSystemImportApplyPost,
    audit: 'system.restore',
  },
  { method: 'GET', path: RE_ROOM_EXPORT, h: rRoomExportGet },
  { method: 'POST', path: '/api/rooms/import', h: rRoomsImportPost },
  { method: 'POST', path: '/api/rooms/import/apply', h: rRoomsImportApplyPost },
  { method: 'GET', path: RE_AGENT_EXPORT, h: rAgentExportGet },
  { method: 'POST', path: '/api/agents/import', h: rAgentsImportPost },
  { method: 'POST', path: '/api/agents/import/apply', h: rAgentsImportApplyPost },
  { method: ['GET', 'PUT'], path: RE_AGENT_LEARNING, h: rAgentLearning },
  { method: 'POST', path: RE_SKILL_REVERT, h: rSkillRevertPost },
  { method: 'POST', path: RE_SKILL_RESTORE, h: rSkillRestorePost },
  { method: 'DELETE', path: RE_AGENT_SCOPED_SKILL, h: rAgentScopedSkillDelete },
  { method: 'GET', path: '/api/skill-drafts', guards: ['anyAdmin'], h: rSkillDraftsGet },
  { method: 'GET', path: '/api/learning/timeline', guards: ['anyAdmin'], h: rLearningTimelineGet },
  { method: 'PUT', path: RE_DRAFT, h: rDraftPut },
  { method: ['GET', 'DELETE'], path: RE_DRAFT, guards: ['anyAdmin'], h: rDraft },
  { method: 'POST', path: RE_DRAFT_KEEP, h: rDraftKeepPost },
  { method: 'PUT', path: RE_AGENT_STATUS, guards: ['csrf'], h: rAgentStatusPut },
  { method: 'GET', path: RE_AGENT_SESSIONS, h: rAgentSessionsGet },
  { method: 'POST', path: RE_SESSION_RESET, guards: ['csrf'], h: rSessionResetPost },
  { method: 'POST', path: RE_ROOM_BROADCAST, guards: ['csrf'], h: rRoomBroadcastPost },
  { method: 'GET', path: '/api/models', h: rModelsGet },
  { method: 'GET', path: '/api/ollama/hosts', guards: ['owner'], h: rOllamaHostsGet },
  { method: 'GET', path: '/api/ollama/models', guards: ['owner'], h: rOllamaModelsGet },
  { method: 'GET', path: '/api/router/routes', guards: ['owner'], h: rRouterRoutesGet },
  { method: 'PUT', path: '/api/router/routes', guards: ['csrf', 'owner'], h: rRouterRoutesPut },
  { method: 'POST', path: '/api/router/routers', guards: ['csrf', 'owner'], h: rRouterRoutersPost },
  { method: 'DELETE', path: RE_ROUTER_DEL, guards: ['csrf', 'owner'], h: rRouterDelDelete },
  { method: 'POST', path: '/api/router/classify', guards: ['csrf', 'owner'], h: rRouterClassifyPost },
  { method: 'GET', path: '/api/router/decisions', guards: ['owner'], h: rRouterDecisionsGet },
  { method: 'GET', path: '/api/router/metrics', guards: ['owner'], h: rRouterMetricsGet },
  { method: 'GET', path: '/api/router/suggestions', guards: ['owner'], h: rRouterSuggestionsGet },
  { method: 'GET', path: '/api/router/models', guards: ['owner'], h: rRouterModelsGet },
  { method: 'GET', path: '/api/ollama/pulls', guards: ['owner'], h: rOllamaPullsGet },
  { method: 'GET', path: '/api/ollama/recommend', guards: ['owner'], h: rOllamaRecommendGet },
  { method: 'GET', path: '/api/ollama/local', guards: ['owner'], h: rOllamaLocalGet },
  { method: 'POST', path: '/api/ollama/install', guards: ['csrf', 'owner'], h: rOllamaInstallPost },
  { method: 'GET', path: '/api/codex/install', guards: ['owner'], h: rCodexInstallGet },
  { method: 'POST', path: '/api/codex/install', guards: ['csrf', 'owner'], h: rCodexInstallPost },
  { method: 'GET', path: '/api/opencode/install', guards: ['owner'], h: rOpencodeInstallGet },
  { method: 'POST', path: '/api/opencode/install', guards: ['csrf', 'owner'], h: rOpencodeInstallPost },
  { method: 'GET', path: '/api/pi/install', guards: ['owner'], h: rPiInstallGet },
  { method: 'POST', path: '/api/pi/install', guards: ['csrf', 'owner'], h: rPiInstallPost },
  { method: 'GET', path: '/api/ollama/prepull', guards: ['owner'], h: rOllamaPrepullGet },
  { method: 'POST', path: '/api/ollama/pull', guards: ['csrf', 'owner'], h: rOllamaPullPost },
  { method: 'POST', path: '/api/ollama/pull/cancel', guards: ['csrf', 'owner'], h: rOllamaPullCancelPost },
  {
    method: 'POST',
    path: '/api/ollama/delete',
    guards: ['csrf', 'owner'],
    h: rOllamaDeletePost,
    audit: 'model.files.delete',
  },
  { method: 'GET', path: '/api/router/roster-refresh', guards: ['owner'], h: rRouterRosterRefreshGet },
  { method: 'POST', path: '/api/router/roster-refresh', guards: ['csrf', 'owner'], h: rRouterRosterRefreshPost },
  { method: 'GET', path: '/api/webchat/tts/install', guards: ['owner'], h: rWebchatTtsInstallGet },
  { method: 'POST', path: '/api/webchat/tts/install', guards: ['csrf', 'owner'], h: rWebchatTtsInstallPost },
  { method: 'GET', path: '/api/webchat/tailscale/install', guards: ['owner'], h: rWebchatTailscaleInstallGet },
  { method: 'GET', path: '/api/webchat/preflight', guards: ['owner'], h: rWebchatPreflightGet },
  {
    method: 'POST',
    path: '/api/webchat/tailscale/install',
    guards: ['csrf', 'owner'],
    h: rWebchatTailscaleInstallPost,
  },
  { method: 'GET', path: '/api/webchat/stt/install', guards: ['owner'], h: rWebchatSttInstallGet },
  { method: 'POST', path: '/api/webchat/stt/install', guards: ['csrf', 'owner'], h: rWebchatSttInstallPost },
  { method: 'GET', path: '/api/tts/voices', guards: ['owner'], h: rTtsVoicesGet },
  { method: ['GET', 'PUT'], path: '/api/learning/config', h: rLearningConfig },
  { method: 'PUT', path: '/api/tts/config', guards: ['csrf', 'owner'], h: rTtsConfigPut },
  { method: ['GET', 'PUT'], path: '/api/stt/config', h: rSttConfig },
  { method: 'POST', path: '/api/stt/transcribe', guards: ['csrf'], h: rSttTranscribePost },
  { method: 'POST', path: '/api/stt/cleanup', guards: ['csrf'], h: rSttCleanupPost },
  { method: 'GET', path: '/api/router/install', guards: ['owner'], h: rRouterInstallGet },
  { method: 'POST', path: '/api/router/install', guards: ['csrf', 'owner'], h: rRouterInstallPost },
  { method: 'GET', path: '/api/router/litellm-install', guards: ['owner'], h: rRouterLitellmInstallGet },
  { method: 'POST', path: '/api/router/litellm-install', guards: ['csrf', 'owner'], h: rRouterLitellmInstallPost },
  { method: 'POST', path: '/api/models', guards: ['csrf', 'owner'], h: rModelsPost, audit: 'model.create' },
  { method: 'GET', path: '/api/models/known', h: rModelsKnownGet },
  { method: 'POST', path: '/api/models/discover', guards: ['csrf', 'owner'], h: rModelsDiscoverPost },
  { method: 'POST', path: '/api/models/probe', guards: ['csrf', 'owner'], h: rModelsProbePost },
  { method: 'POST', path: '/api/models/reachability', guards: ['csrf', 'owner'], h: rModelsReachabilityPost },
  { method: 'POST', path: '/api/models/bulk', guards: ['csrf', 'owner'], h: rModelsBulkPost },
  { method: 'PUT', path: RE_MODEL_ID, guards: ['owner', 'csrf'], h: rModelIdPut },
  { method: 'DELETE', path: RE_MODEL_ID, guards: ['owner', 'csrf'], h: rModelIdDelete, audit: 'model.delete' },
  { method: 'GET', path: '/api/approvals/pending', h: rApprovalsPendingGet },
  { method: 'GET', path: '/api/approvals/prejudge', guards: ['owner'], h: rApprovalPrejudgeGet },
  {
    method: 'PUT',
    path: '/api/approvals/prejudge',
    guards: ['csrf', 'owner'],
    h: rApprovalPrejudgePut,
    audit: 'policy.prejudge',
  },
  { method: 'POST', path: RE_APPROVE, guards: ['csrf'], h: rApprovePost },
  { method: 'GET', path: '/api/users', h: rUsersGet },
  { method: 'DELETE', path: RE_USER_ID, guards: ['csrf', 'owner'], h: rUserIdDelete, audit: 'user.delete' },
  { method: 'POST', path: '/api/permissions/grant', guards: ['csrf'], h: rPermissionsGrantPost },
  { method: 'POST', path: '/api/permissions/revoke', guards: ['csrf'], h: rPermissionsRevokePost },
  { method: 'GET', path: '/api/push/vapid-public', h: rPushVapidPublicGet },
  { method: 'POST', path: '/api/push/subscribe', h: rPushSubscribePost },
  { method: 'POST', path: '/api/push/unsubscribe', guards: ['csrf'], h: rPushUnsubscribePost },
];

// ── Helpers ──────────────────────────────────────────────────────────────

// Derive the service-worker cache name from a hash of every served asset
// (except sw.js itself), so the cache busts exactly when an asset changes —
// replacing the old hand-bumped `nanoclaw-chat-vNNN` constant that conflicted
// on every webchat branch. Sorted for determinism; recomputed per sw.js fetch,
// which is an infrequent request, so no memoization is needed (and none can go
// stale). Returns a stable fallback if the directory can't be read.
export function computeSwCacheVersion(publicDir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(publicDir).sort();
  } catch {
    return 'nanoclaw-chat-dev';
  }
  const hash = createHash('sha256');
  for (const name of entries) {
    if (name === 'sw.js') continue;
    const fp = path.join(publicDir, name);
    try {
      if (!fs.statSync(fp).isFile()) continue;
      hash.update(name);
      hash.update(fs.readFileSync(fp));
    } catch {
      /* skip unreadable entries */
    }
  }
  return 'nanoclaw-chat-' + hash.digest('hex').slice(0, 12);
}

// Text assets we compress before sending. Images (png/jpg/webp/ico) are already
// compressed — running them through gzip/brotli wastes CPU for ~0% gain.
const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.md', '.webmanifest', '.map']);

// In-memory asset cache keyed by path → { raw, per-encoding compressed, etag }.
// Invalidated by (mtimeMs, size): a redeploy that rewrites the file re-reads +
// re-compresses on the next request; unchanged files serve from memory, so we
// stop hitting the disk and stop re-compressing the same 400KB bundle per load.
type CachedAsset = { mtimeMs: number; size: number; etag: string; raw: Buffer; gzip?: Buffer; br?: Buffer };
const assetCache = new Map<string, CachedAsset>();

function loadAsset(filePath: string): CachedAsset {
  const st = fs.statSync(filePath);
  const hit = assetCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = fs.readFileSync(filePath);
  const etag = '"' + createHash('sha256').update(raw).digest('hex').slice(0, 16) + '"';
  const entry: CachedAsset = { mtimeMs: st.mtimeMs, size: st.size, etag, raw };
  assetCache.set(filePath, entry);
  return entry;
}

// Pick the best encoding the client accepts (brotli > gzip > identity), but only
// for compressible types. Compressed bytes are memoized on the cache entry so a
// given asset version is compressed at most once per encoding.
function encodedBody(entry: CachedAsset, accept: string, compressible: boolean): { body: Buffer; encoding?: string } {
  if (!compressible) return { body: entry.raw };
  if (/\bbr\b/.test(accept)) {
    entry.br ??= zlib.brotliCompressSync(entry.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
    return { body: entry.br, encoding: 'br' };
  }
  if (/\bgzip\b/.test(accept)) {
    entry.gzip ??= zlib.gzipSync(entry.raw, { level: 6 });
    return { body: entry.gzip, encoding: 'gzip' };
  }
  return { body: entry.raw };
}

function servePwa(req: IncomingMessage, res: ServerResponse, publicDir: string): boolean {
  let urlPath = req.url?.split('?')[0] ?? '/';
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(publicDir, urlPath);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403);
    res.end();
    return true;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath);
  const basename = path.basename(filePath);
  const contentType =
    basename === 'manifest.json' ? 'application/manifest+json' : STATIC_MIME[ext] || 'application/octet-stream';
  const accept = (req.headers['accept-encoding'] as string) || '';
  const compressible = COMPRESSIBLE_EXT.has(ext);
  // sw.js carries a `__CACHE_VERSION__` placeholder; substitute the derived
  // asset hash so the service worker's cache name tracks asset content. Its body
  // is computed per request (infrequent), so compress inline without caching.
  if (basename === 'sw.js') {
    const raw = Buffer.from(
      fs.readFileSync(filePath, 'utf8').replace('__CACHE_VERSION__', computeSwCacheVersion(publicDir)),
    );
    const headers: Record<string, string> = { 'Content-Type': contentType, 'Cache-Control': 'no-cache' };
    let body = raw;
    if (/\bbr\b/.test(accept)) {
      body = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
      headers['Content-Encoding'] = 'br';
    } else if (/\bgzip\b/.test(accept)) {
      body = zlib.gzipSync(raw, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
    }
    if (headers['Content-Encoding']) headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }
  // `no-cache` = browser MAY cache but must revalidate before reuse — deliberate:
  // it stops browsers and reverse proxies (Azure App Service, Cloudflare, nginx)
  // holding stale CSS/JS/HTML across deploys. The content-hash ETag makes that
  // revalidation cheap: an unchanged asset gets a 304 (empty body) instead of
  // re-downloading. Freshness across deploys is owned by the SW cache version.
  const entry = loadAsset(filePath);
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }
  const { body, encoding } = encodedBody(entry, accept, compressible);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    ETag: entry.etag,
  };
  if (encoding) {
    headers['Content-Encoding'] = encoding;
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

function persistOutboundFile(roomId: string, file: OutboundFile): string {
  const safeRoom = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFile = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(DATA_DIR, 'webchat', 'uploads', safeRoom);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const filename = `${stamp}-${safeFile}`;
  fs.writeFileSync(path.join(dir, filename), file.data);
  return `/api/files/${encodeURIComponent(safeRoom)}/${filename}`;
}

// ── Agents (agent groups) ──

/**
 * Recompute `messaging_group_agents.engage_pattern` for every wiring on a
 * room based on the current prime designation.
 *
 *   - No prime configured  → all wirings get '.' (default: every agent
 *     engages on every message — current behavior pre-prime).
 *   - Prime configured     → prime gets a negative-lookahead pattern that
 *     matches text NOT mentioning any other wired agent's folder; each
 *     non-prime agent gets a positive `\B@<folder>\b` pattern.
 *
 * Match key is the agent's `folder` (already slugified to `[a-z0-9-]+` by
 * `nameToFolder`, no regex special chars to escape). Word-boundary on the
 * left is `\B@` so `@alice` matches at start-of-string and after spaces but
 * not inside an email like `foo@alice.com`.
 *
 * Idempotent and cheap (one row per wiring, single UPDATE each). Called from
 * every wiring-change path: wireAgentToWebchatRoom, unwireAgentFromWebchatRoom,
 * and the prime PUT/DELETE handlers.
 */

/** Engaged agents in a thread, resolved to {id, name, folder} for the UI. */
function engagedAgentsForThread(roomId: string, threadId: string): Array<{ id: string; name: string; folder: string }> {
  const ids = new Set(getEngagedAgents(roomId, threadId));
  if (ids.size === 0) return [];
  return getAgentsForWebchatRoom(roomId)
    .filter((a) => ids.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, folder: a.folder }));
}

/** Push the current engaged set for a thread to all room clients (live chips). */
function broadcastEngagedSet(roomId: string, threadId: string): void {
  broadcast(roomId, {
    type: 'engaged_set_changed',
    room_id: roomId,
    thread_id: threadId,
    engaged: engagedAgentsForThread(roomId, threadId),
  });
}

const ENGAGE_FOLDER_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Engaged-thread routing decision for the host router (registered via
 * registerInboundDeliveryPlanResolver). Auto-engages @mentioned wired agents, then classifies each
 * engaged agent as 'expected' (addressed, or the sole engaged agent on an
 * un-addressed message → a one-agent thread keeps replying without re-mention) or
 * 'defer' (engaged but someone else was addressed → receives context, no reply).
 * Returns null when engagement doesn't apply so the router falls back to normal
 * mention-only routing. See docs/webchat/thread-engaged-agents.md.
 */
export function resolveInboundDeliveryPlan(
  mg: MessagingGroup,
  threadId: string | null,
  messageText: string,
  senderAgentGroupId: string | undefined,
): InboundDeliveryPlan | null {
  if (mg.channel_type !== 'webchat') return null;
  if (threadId === null || threadId === 'main') return null;
  const roomId = mg.platform_id;
  const wired = getAgentsForWebchatRoom(roomId);
  if (wired.length === 0) return null;
  const wiredIds = new Set(wired.map((a) => a.id));

  // Peer fan-out: an engaged agent's own reply is delivered to the OTHER engaged
  // agents as silent context (isPeerReply, trigger=0) so they stay in sync but
  // never reply to a peer (no cascades). The producer is excluded.
  if (senderAgentGroupId) {
    const allEngaged = [...getEngagedAgents(roomId, threadId)].filter((id) => wiredIds.has(id));
    const recipients = allEngaged.filter((id) => id !== senderAgentGroupId);
    if (recipients.length === 0) return null;
    const perAgent = new Map<string, 'expected' | 'defer'>();
    for (const id of recipients) perAgent.set(id, 'defer');
    return { participants: allEngaged, perAgent, isPeerReply: true };
  }

  // Which wired agents are explicitly @mentioned (case-insensitive, word-boundary).
  const mentioned = new Set<string>();
  for (const a of wired) {
    const re = new RegExp(`\\B@${a.folder.replace(ENGAGE_FOLDER_ESCAPE_RE, '\\$&')}\\b`, 'i');
    if (re.test(messageText)) mentioned.add(a.id);
  }

  // Auto-engage any newly-mentioned wired agent (broadcast the chip change once).
  const engaged = new Set([...getEngagedAgents(roomId, threadId)].filter((id) => wiredIds.has(id)));
  let changed = false;
  for (const id of mentioned) {
    if (!engaged.has(id)) {
      engageAgent(roomId, threadId, id);
      engaged.add(id);
      changed = true;
    }
  }
  if (changed) broadcastEngagedSet(roomId, threadId);
  if (engaged.size === 0) return null; // nothing engaged → normal mention-only routing

  const soleEngaged = engaged.size === 1;
  const perAgent = new Map<string, 'expected' | 'defer'>();
  for (const id of engaged) {
    const addressed = mentioned.has(id) || (mentioned.size === 0 && soleEngaged);
    perAgent.set(id, addressed ? 'expected' : 'defer');
  }
  return { participants: [...engaged], perAgent };
}

// Staged bundles can be GBs — sweep on a timer, not only on the next upload
// (an abandoned preview would otherwise squat /tmp for the process lifetime).
setInterval(sweepPendingImports, 5 * 60 * 1000).unref();

async function importSystemUploadHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  sweepPendingImports();
  let tmpFile: string | null = null;
  try {
    tmpFile = await spoolUploadToTmp(req);
    // System bundles use their own member allowlist.
    const listing = await new Promise<string>((resolve, reject) => {
      const p = spawnTar(['-tzf', tmpFile!]);
      let out = '';
      let err = '';
      p.stdout?.on('data', (d: Buffer) => (out += d));
      p.stderr?.on('data', (d: Buffer) => (err += d));
      p.on('close', (code: number) =>
        code === 0 ? resolve(out) : reject(new Error(`tar -t failed: ${err.slice(0, 200)}`)),
      );
    });
    const bad = listing
      .split('\n')
      .filter(Boolean)
      .filter((e) => !isSafeSystemEntry(e));
    if (bad.length > 0) throw new Error(`Bundle contains unsafe paths: ${bad.slice(0, 3).join(', ')}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sysimport-'));
    await new Promise<void>((resolve, reject) => {
      const p = spawnTar(['-xzf', tmpFile!, '-C', dir, '--no-same-owner']);
      let err = '';
      p.stderr?.on('data', (d: Buffer) => (err += d));
      p.on('close', (code: number) =>
        code === 0 ? resolve() : reject(new Error(`tar -x failed: ${err.slice(0, 200)}`)),
      );
    });
    const preview = previewSystemImport(dir);
    const token = randomUUID();
    pendingAgentImports.set(token, { dir, at: Date.now() });
    return json(res, 200, { token, preview });
  } catch (err) {
    return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (tmpFile) fs.rmSync(tmpFile, { force: true });
  }
}

async function importSystemApplyHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { token?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const staged = pendingAgentImports.get(String(body.token || ''));
  if (!staged) return json(res, 410, { error: 'Import expired — upload the bundle again' });
  let preview: ReturnType<typeof previewSystemImport>;
  try {
    preview = previewSystemImport(staged.dir);
  } catch (err) {
    return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
  }
  if (!preview.schemaOk) {
    return json(res, 409, {
      error: `Backup schema (v${preview.manifest.schemaVersion}) is newer than this install (v${preview.currentSchemaVersion}) — update NanoClaw first.`,
    });
  }
  pendingAgentImports.delete(String(body.token));
  // Respond FIRST — the restore ends this process by design.
  json(res, 200, { ok: true, restarting: true });
  log.warn('System restore starting — the host will exit and boot on restored data');
  executeSystemRestore(staged.dir, closeDb);
}

/**
 * Standing instructions live in `instructions.prepend.md` — the file
 * claude-md-compose reads via readGroupPersona() and emits as the persona
 * fragment of every provider's composed CLAUDE.md.
 *
 * This editor used to read and write `CLAUDE.local.md`, which nanoclaw stopped
 * composing. That file is still picked up by the Claude harness (settingSources
 * includes 'local'), so edits appeared to work — but they were provider-local:
 * nothing written here reached a Codex-backed group, and a provider switch
 * silently dropped them. `legacy` below reports a non-empty CLAUDE.local.md so
 * the UI can say where that content went instead of showing an empty box for a
 * group that plainly has instructions.
 */
function readInstructions(res: ServerResponse, id: string): void {
  const group = getAgentGroup(id);
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const dir = path.resolve(GROUPS_DIR, group.folder);
  const content = readGroupPersona(dir) ?? '';
  let legacy = 0;
  try {
    const st = fs.lstatSync(path.join(dir, 'CLAUDE.local.md'));
    if (st.isFile()) legacy = st.size;
  } catch {
    /* absent — the normal case for a group created after the cutover */
  }
  return json(res, 200, { content, legacyBytes: legacy });
}

async function writeInstructions(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const group = getAgentGroup(id);
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { content?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const dir = path.resolve(GROUPS_DIR, group.folder);
  fs.mkdirSync(dir, { recursive: true });
  const text = typeof body.content === 'string' ? body.content : '';
  const file = path.join(dir, PERSONA_PREPEND_FILE);
  // Match readGroupPersona's posture: never follow a symlink out of the group
  // folder. Upstream's stageGroupPersona is create-only ('wx'), so the editor
  // needs its own write — O_NOFOLLOW keeps a planted symlink from turning an
  // instructions save into an arbitrary-file write.
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o644,
    );
    fs.writeFileSync(fd, text.trimEnd() ? `${text.trimEnd()}\n` : '');
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: string }).code : '';
    if (code === 'ELOOP') return json(res, 409, { error: 'instructions.prepend.md is a symlink — refusing to write' });
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return json(res, 200, { ok: true });
}

// ── Room handlers ──

// ── Models ──
//
// CRUD for webchat_models + per-agent model assignment. The "discover"
// endpoint is the cheap UX win — it lets the PWA populate the model_id
// dropdown from a live Ollama endpoint instead of asking the user to
// paste tag names.

/**
 * Respawn containers after a workspace-default credential MODE change (key ↔
 * subscription, or removing an OAuth default). The Claude OAuth sentinel env and
 * the Codex gateway auth stub are applied at container SPAWN, so a running
 * container would keep the wrong auth mode until it idles out. Scoped to the
 * groups the provider actually serves: `claude` → every non-Codex group;
 * `codex` → Codex groups only. Value-only rotation (same mode) needs no restart —
 * OneCLI swaps the real credential on the wire per request.
 */
function restartGroupsForWorkspaceCredChange(
  provider: 'claude' | 'codex',
  priorOauth: boolean,
  nowOauth: boolean,
): void {
  if (priorOauth === nowOauth) return;
  for (const g of getAllAgentGroups()) {
    const groupProvider = getContainerConfig(g.id)?.provider === 'codex' ? 'codex' : 'claude';
    if (groupProvider !== provider) continue;
    try {
      restartAgentGroupContainers(g.id, 'Workspace default credential mode changed');
    } catch (err) {
      log.warn('Webchat: container restart after workspace-cred change failed', { agentGroupId: g.id, err });
    }
  }
}

/**
 * Aftermath of SETTING a workspace-default credential (the wizard's engine
 * choice). Choosing Claude/Codex supersedes a leftover Ollama workspace-default
 * MODEL — which otherwise still wins for base agents (getEffectiveModelForAgent
 * returns the default model regardless of credential), so connecting Claude
 * would silently keep agents on the local model. Clear the default model, then
 * respawn the affected groups (the respawn also applies the OAuth sentinel).
 */
function afterWorkspaceCredentialSet(provider: 'claude' | 'codex', priorOauth: boolean, nowOauth: boolean): void {
  // The default model is always an ollama-kind (claude-family) model, so it only
  // conflicts with a claude engine — a codex credential leaves it untouched.
  const clearModel = provider === 'claude' && getDefaultModelId() !== null;
  if (clearModel) {
    setDefaultModelId(null);
    // Rewrites settings.json (drops the ollama env) + respawns unassigned
    // claude-family groups; the respawn also picks up the new OAuth sentinel.
    refreshUnassignedGroupsForDefaultModel(`Workspace engine set to ${provider}`);
  } else {
    restartGroupsForWorkspaceCredChange(provider, priorOauth, nowOauth);
  }
}

/**
 * Boot convergence: bring every group's provider + OpenCode model wiring in step
 * with its effective model. This is what makes "install OpenCode, restart, done"
 * flip existing local-model groups onto the harness — the install's restart
 * re-enters startWebchatServer with OpenCode now registered, and this loop flips
 * the unassigned local-default groups + (re)writes each OpenCode group's model
 * file. Codex-safe (sync leaves explicit non-managed providers alone) and
 * non-restarting: containers pick up the change on their next spawn. Per-group
 * failures are logged, never fatal to boot.
 */
function convergeAgentProviders(): void {
  for (const g of getAllAgentGroups()) {
    try {
      syncAgentProviderForAssignedModel(g.id);
    } catch (err) {
      log.warn('Webchat: provider convergence at boot failed', { agentGroupId: g.id, err });
    }
  }
}

// ── MCP server registry handlers ──
//
// The registry mirrors the models registry: owner-gated CRUD + probe, with a
// per-agent assignment surface. Secrets discipline: env/headers are accepted
// on create/update but NEVER returned by any list/read response.

/**
 * Read a skill's current SKILL.md as the AGENT sees it: its own scoped copy wins,
 * otherwise the shared pool (shipped skills, then the user pool). Used to show a
 * patch draft against the version it would actually replace. Empty string when the
 * target can't be resolved — the caller renders that as "new file".
 */

function readSkillBody(agentGroupId: string, skillName: string): string {
  const name = sanitizeSkillName(skillName);
  if (!name) return '';
  const candidates = [
    path.join(scopedSkillsDir(agentGroupId), name),
    path.join(process.cwd(), 'container', 'skills', name),
    path.join(USER_SKILLS_DIR, name),
  ];
  for (const dir of candidates) {
    try {
      return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {
      /* try the next location */
    }
  }
  return '';
}

/**
 * Pre-import preview: resolve the same body /api/skills/import takes, fetch the
 * files, inspect — write NOTHING. The client shows this before the user
 * confirms; a failed preview falls back to the old text-only confirm.
 */

// Read a skill's SKILL.md (either source) for the viewer/editor.
// Return the SKILL.md of a skill scoped to one agent. Caller auth (per-group
// admin) is checked at the route. Scoped skills are always user-editable.
function getScopedSkillContentHandler(res: ServerResponse, agentGroupId: string, name: string): void {
  const file = path.join(scopedSkillsDir(agentGroupId), name, 'SKILL.md');
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return json(res, 404, { error: 'Skill not found' });
  }
  return json(res, 200, { name, body, source: 'scoped', editable: true });
}

// Overwrite a scoped skill's SKILL.md. Snapshots a revision first (revertable),
// then respawns the one agent so it loads the edit. Per-group admin only —
// enforced at the route; the write can't touch any other agent.
async function putScopedSkillContentHandler(
  req: IncomingMessage,
  res: ServerResponse,
  agentGroupId: string,
  name: string,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let content = '';
  try {
    content = String((JSON.parse(raw) as { content?: unknown }).content || '');
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  // Same explicit cap as the pool-skill editor (putUserSkillHandler) — the
  // global body limit is a backstop, not a contract.
  if (content.length > 512 * 1024) return json(res, 413, { error: 'SKILL.md exceeds 512KB' });
  if (!/^---\s*\n[\s\S]*?description:\s*\S[\s\S]*?\n---/.test(content)) {
    return json(res, 400, { error: 'Body must be a SKILL.md with YAML front-matter including a description' });
  }
  const dir = scopedSkillsDir(agentGroupId);
  const skillDir = path.join(dir, name);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    return json(res, 404, { error: 'Skill not found' });
  }
  try {
    snapshotRevision(dir, name);
  } catch {
    /* best-effort history; never block the save */
  }
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  const restarted = restartAgentGroupContainers(agentGroupId, `Scoped skill ${name} edited`);
  return json(res, 200, { ok: true, name, restarted });
}

// Flip the in-room "proposed skill" card (if the draft was surfaced in a webchat
// room) so it stops being actionable, and push the update to connected clients.
function resolveDraftCard(draftId: string, outcome: 'kept' | 'discarded', userId: string): void {
  const flipped = markRoomSkillDraftResolved(draftId, outcome, userId);
  if (flipped) broadcast(flipped.roomId, { type: 'message', ...flipped.message });
}

// A draft as the keep routes see it — the metadata the apply/review paths need.
type KeepDraftMeta = { id: string; skill_name: string; kind?: string; target_skill?: string | null };

// In-flight keep reviews (learning loop, async Keep), keyed by draft id.
// Deliberately in-memory rather than a status column: the draft row stays
// 'pending' in the DB, so the overlap re-drive (force=1 / updateTarget) works
// unchanged with no migration, and a host restart clears the map — worst case
// is pressing Keep again. Same-draft double-keep is refused off this map.
const keepReviewJobs = new Map<string, Promise<void>>();

/** Test seam: the in-flight review job for a draft (undefined when idle). */
export function keepReviewJobFor(draftId: string): Promise<void> | undefined {
  return keepReviewJobs.get(draftId);
}

/**
 * The actual keep write, shared by the sync (force/updateTarget) and async
 * (background review) paths. The write itself lives in modules/learning/
 * apply.ts — ONE implementation shared with auto-keep, so the paths cannot
 * drift. An "update existing" choice re-types the draft as a patch of the
 * chosen skill. sanitizeSkillName in apply.ts guards the path.
 */
function applyKeepDecision(
  draft: KeepDraftMeta,
  groupId: string,
  updateTarget: string,
  userId: string,
): { status: number; body: Record<string, unknown> } {
  const toApply = updateTarget
    ? { ...draft, agent_group_id: groupId, kind: 'patch' as const, target_skill: updateTarget }
    : { ...draft, agent_group_id: groupId };
  const r = applySkillDraft(
    toApply as Parameters<typeof applySkillDraft>[0],
    updateTarget || draft.kind === 'patch' ? 'Webchat skill revision applied' : 'Webchat learned skill kept',
  );
  if (!r.ok) return { status: r.status, body: { error: r.error } };
  resolveDraftCard(draft.id, 'kept', userId);
  return {
    status: 200,
    body: {
      ok: true,
      name: r.name,
      patched: r.patched,
      updated: !!updateTarget,
      forkedFromPool: r.forkedFromPool,
      restarted: r.restarted,
    },
  };
}

/**
 * Background half of an async Keep: run the overlap review, then either apply
 * the draft or hand the overlaps back to the pressing user's connected tabs
 * as a `skill_draft_review` WS event ('kept' | 'overlaps' | 'error'). On
 * overlaps the draft stays pending, so the client's overlap-choice modal can
 * re-drive the keep with force=1 / updateTarget exactly as before.
 */
async function runKeepReview(draft: KeepDraftMeta, group: { id: string; name: string }, userId: string): Promise<void> {
  const base = {
    type: 'skill_draft_review' as const,
    draftId: draft.id,
    skillName: draft.skill_name,
    agentGroupId: group.id,
    agentName: group.name,
  };
  try {
    // Re-fetch: the draft may have been discarded (or kept via a concurrent
    // force) between the 202 and the job actually running.
    const fresh = getSkillDraft(draft.id);
    if (!fresh || fresh.status !== 'pending') {
      // Both bail-outs below log. They report 'error' to the pressing user's
      // tab, and until now did so with nothing server-side — so an operator
      // (or a failing test) saw only the outcome, never the reason.
      log.warn('Keep review: draft no longer pending', {
        draftId: draft.id,
        status: fresh?.status ?? '(row gone)',
      });
      pushToUser(userId, { ...base, outcome: 'error', error: 'Draft no longer pending' });
      return;
    }
    // Keep-time overlap review: compare the draft against the agent's scoped
    // skills, its OTHER pending drafts, and the pool. Advisory, not a wall —
    // the human overrides with force=1 ("Keep anyway"). Detects the twins the
    // exact-name supersede can't (the reviewer names skills freely).
    let overlaps: Awaited<ReturnType<typeof findKeepOverlaps>> = [];
    try {
      overlaps = await findKeepOverlaps(fresh);
    } catch (err) {
      // Same posture as the old sync path: the review is advisory — its
      // failure never blocks a keep.
      log.warn('Keep overlap review failed — keeping without it', { draftId: draft.id, err: String(err) });
    }
    if (overlaps.length > 0) {
      pushToUser(userId, {
        ...base,
        outcome: 'overlaps',
        overlaps: overlaps.map((o) => ({ name: o.name, source: o.source, reason: o.reason })),
      });
      return;
    }
    const r = applyKeepDecision(draft, group.id, '', userId);
    if (r.status !== 200) {
      log.warn('Keep review: apply refused the draft', {
        draftId: draft.id,
        status: r.status,
        err: String(r.body.error ?? 'Keep failed'),
      });
      pushToUser(userId, { ...base, outcome: 'error', error: String(r.body.error ?? 'Keep failed') });
      return;
    }
    pushToUser(userId, { ...base, outcome: 'kept', ...r.body });
  } catch (err) {
    log.warn('Keep review job failed', { draftId: draft.id, err: String(err) });
    pushToUser(userId, { ...base, outcome: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

// Keep + wire a learning-loop draft: write its SKILL.md into the chosen agent's
// own .claude-shared/skills (scoped, origin "learned"), then mark it kept.
// The overlap review is slow (optionally LLM-backed), so a plain Keep is
// asynchronous: validate everything, answer 202 { queued: true }, and let
// runKeepReview push the outcome over the WS. force / updateTarget are
// explicit human decisions that skip the review, so they stay synchronous.
async function keepSkillDraftHandler(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  draft: KeepDraftMeta,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let agentGroupId = '';
  try {
    agentGroupId = String((JSON.parse(raw) as { agentGroupId?: unknown }).agentGroupId || '');
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const group = resolveAgent(agentGroupId);
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  const params = new URL(req.url || '', 'http://x').searchParams;
  const force = params.get('force') === '1';
  // `updateTarget` = the operator chose "Update <existing skill>" in the overlap
  // review: apply THIS draft as a revision of that skill (snapshots the old
  // version) instead of creating a duplicate.
  const updateTarget = (params.get('updateTarget') || '').trim();
  if (force || updateTarget) {
    const r = applyKeepDecision(draft, group.id, updateTarget, userId);
    return json(res, r.status, r.body);
  }
  if (keepReviewJobs.has(draft.id)) return json(res, 409, { error: 'Review already in progress' });
  const job = runKeepReview(draft, { id: group.id, name: group.name }, userId).finally(() =>
    keepReviewJobs.delete(draft.id),
  );
  keepReviewJobs.set(draft.id, job);
  return json(res, 202, { queued: true });
}

// ── Push subscriptions ──

async function pushSubscribe(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const db = getDb();
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
  if (!endpoint || !p256dh || !auth) return json(res, 400, { error: 'Missing endpoint or keys' });
  if (!isValidPushEndpoint(endpoint)) return json(res, 400, { error: 'Endpoint not on allowlist' });
  if (endpoint.length > 2048) return json(res, 400, { error: 'Endpoint too long' });
  if (p256dh.length > 256 || auth.length > 64) return json(res, 400, { error: 'Key material too long' });

  // Prevent identity-hijack on known endpoints.
  const existing = db.prepare(`SELECT identity FROM webchat_push_subscriptions WHERE endpoint = ?`).get(endpoint) as
    | { identity: string }
    | undefined;
  if (existing && existing.identity !== userId) {
    log.warn('Webchat push subscribe rejected — endpoint owned by different identity', {
      identity: userId,
      existingOwner: existing.identity,
      endpointTail: endpoint.slice(-24),
    });
    return json(res, 409, { error: 'Endpoint already registered to a different identity' });
  }
  db.prepare(
    `INSERT INTO webchat_push_subscriptions (endpoint, identity, keys_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET identity = excluded.identity, keys_json = excluded.keys_json`,
  ).run(endpoint, userId, JSON.stringify({ p256dh, auth }), Date.now());
  return json(res, 200, { ok: true });
}

async function pushUnsubscribe(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { endpoint?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.endpoint !== 'string') return json(res, 400, { error: 'Missing endpoint' });
  // Only allow deleting your own subscription.
  getDb()
    .prepare(`DELETE FROM webchat_push_subscriptions WHERE endpoint = ? AND identity = ?`)
    .run(body.endpoint, userId);
  return json(res, 200, { ok: true });
}

// Re-export for the adapter so it can flow files into webchat_messages too.
export { storeWebchatFileMessage };
export type { FileMeta };
