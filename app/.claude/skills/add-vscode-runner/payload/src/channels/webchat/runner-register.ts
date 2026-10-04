/**
 * The VS Code runner as a webchat extension: registers its routes, its
 * WebSocket endpoint, the laptop tools' relay, its sign-in settings section,
 * and the feature name the UI shows its screens for. Core never imports this
 * module; ./extensions-installed.ts does.
 */
import { log } from '../../log.js';
import { onChannelStart, onServerStart, registerFeature, registerRoutes, registerSigninSection } from './extensions.js';
import { derivedClientConfig, getClientOverrides } from './runner-client-config.js';
import { registerSessionPrepareHook } from '../../seam/index.js';
import { ensureSessionKeys, startRelayForToolsPlacements } from './runner-tools.js';
import { getPlacement, RUNNER_ID } from './runner-registry.js';
import { RUNNER_ENABLED, RUNNER_WS_PATHS, setupRunnerWebSocket } from './runner-ws.js';
import { json } from './server/http.js';
import {
  rRunnerClientConfigGet,
  rRunnerMineGet,
  rRunnerClientConfigPut,
  rRunnerExtensionDownload,
  rRunnerExtensionGet,
  rRunnerExtensionPost,
  rRunnerExtensionSignaturePut,
  rRunnerMachineApprovePost,
  rRunnerMachineRevokePost,
  rRunnerPlacementDelete,
  rRunnerPlacementPut,
  rRunnersGet,
} from './server/routes-runners.js';

const RE_RUNNER_PLACEMENT = /^\/api\/runners\/placements\/([^/]+)$/;

registerFeature('vscode');

// A placed group's sessions each get the key that ties ReadAttachment to their
// own inbox, before the container that sends it starts.
registerSessionPrepareHook(async (agentGroupId) => {
  if ((await getPlacement(agentGroupId))?.mode === 'tools') await ensureSessionKeys(agentGroupId);
});

registerRoutes([
  { method: 'GET', path: '/api/runners', guards: ['globalAdmin'], h: rRunnersGet },
  { method: 'GET', path: '/api/runners/extension', h: rRunnerExtensionGet },
  { method: 'GET', path: '/api/runners/extension/download', h: rRunnerExtensionDownload },
  { method: 'GET', path: '/api/runners/client-config', h: rRunnerClientConfigGet },
  { method: 'GET', path: '/api/runners/mine', h: rRunnerMineGet },
  {
    method: 'PUT',
    path: '/api/runners/client-config',
    guards: ['csrf', 'globalAdmin'],
    h: rRunnerClientConfigPut,
    audit: 'runner.client.set',
  },
  {
    method: 'POST',
    path: '/api/runners/extension',
    guards: ['csrf', 'globalAdmin'],
    h: rRunnerExtensionPost,
    audit: 'runner.extension.publish',
  },
  {
    method: 'PUT',
    path: '/api/runners/extension/signature',
    guards: ['csrf', 'globalAdmin'],
    h: rRunnerExtensionSignaturePut,
    audit: 'runner.extension.sign',
  },
  {
    method: 'POST',
    // The same ids a runner's hello may carry (runner-registry.ts): any machine that paired can be approved and revoked.
    path: new RegExp(`^/api/runners/machines/(${RUNNER_ID})/approve$`),
    guards: ['csrf', 'globalAdmin'],
    h: rRunnerMachineApprovePost,
    audit: 'runner.machine.approve',
  },
  {
    method: 'POST',
    path: new RegExp(`^/api/runners/machines/(${RUNNER_ID})/revoke$`),
    guards: ['csrf', 'globalAdmin'],
    h: rRunnerMachineRevokePost,
    audit: 'runner.machine.revoke',
  },
  {
    method: 'PUT',
    path: RE_RUNNER_PLACEMENT,
    guards: ['csrf', 'globalAdmin'],
    h: rRunnerPlacementPut,
    audit: 'runner.placement.set',
  },
  {
    method: 'DELETE',
    path: RE_RUNNER_PLACEMENT,
    guards: ['csrf', 'globalAdmin'],
    h: rRunnerPlacementDelete,
    audit: 'runner.placement.delete',
  },
]);

// Laptop runners connect on their own path over this same server (see
// runner-ws.ts). Off unless WEBCHAT_RUNNER_ENABLED=true; when off the path is
// destroyed like any other unknown upgrade.
if (RUNNER_ENABLED) {
  onServerStart(({ chatInbound }) => {
    setupRunnerWebSocket({ chatInbound });
    log.info('Webchat runner endpoint enabled', { paths: RUNNER_WS_PATHS });
  });
  // Placed agents reach their laptop tools through the MCP relay.
  onChannelStart(
    () =>
      void startRelayForToolsPlacements().catch((err: unknown) =>
        log.warn('Laptop tools: could not start the relay at startup', { err: String(err) }),
      ),
  );

  // A plain GET on the runner WebSocket path means a proxy hop dropped the
  // Upgrade/Connection headers (nginx forwards them per-location, so a path
  // that worked for /ws can silently fail for this one). Say so in the log:
  // from the laptop the App Service reports the failed handshake as a bare 500.
  registerRoutes(
    RUNNER_WS_PATHS.map((path) => ({
      method: 'GET',
      path,
      h: (ctx) => {
        log.warn('Runner path reached over plain HTTP — proxy did not forward the WebSocket Upgrade header', {
          userId: ctx.userId,
          upgrade: ctx.req.headers.upgrade ?? null,
          connection: ctx.req.headers.connection ?? null,
        });
        return json(ctx.res, 426, {
          error: 'Upgrade required',
          hint: 'WebSocket-only path; the reverse proxy must forward the Upgrade and Connection headers for it.',
        });
      },
    })),
  );
}

// VS Code (Microsoft only): the two optional overrides, and what applies without them.
registerSigninSection('vscode', async () => {
  const overrides = await getClientOverrides();
  return {
    appIdUri: overrides.appIdUri ?? '',
    clientId: overrides.clientId ?? '',
    defaultAppIdUri: derivedClientConfig().appIdUri,
  };
});
