/**
 * Host lifecycle extras — the fork's startup/shutdown hooks, registered on
 * upstream's host-lifecycle registry (src/host-lifecycle.ts).
 *
 * Until upstream grew that registry these three hooks lived as a patch on
 * src/index.ts (upstreamable/src__index.ts.patch, retired at the d7d9887e pin
 * bump). Same behaviour, no patched file: startup callbacks run at step 5 of
 * main() — DB and delivery ready, polls not yet started — and the shutdown
 * callback runs first thing in shutdown(), before any teardown step that
 * could hang.
 */
import { warmAgentImage } from '../../container-warm.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { GROK_USER_REFRESH_TICK_MS, refreshDueUserCredentials } from '../../channels/webchat/server/grok-user-creds.js';
import { realOnecliAdmin } from '../user-credentials/onecli-admin.js';
import { log } from '../../log.js';
import { preflightOneCLI } from '../../onecli-preflight.js';
import { resetCircuitBreaker } from '../../circuit-breaker.js';

onHostStart(() => {
  // Fire-and-forget: prime the host page cache for the agent image so the
  // first cold spawn after a restart/rebuild doesn't pay the cold-disk
  // penalty (see src/container-warm.ts).
  warmAgentImage();
});

onHostStart(async () => {
  // OneCLI gateway preflight — loud, non-fatal diagnostic so a missing / old /
  // unreachable credential gateway is caught here with its fix, rather than as
  // silent spawn failures (every room going dead). Don't block boot on it.
  await preflightOneCLI();
});

onHostShutdown(() => {
  // Shutdown watchdog: teardown gets 10s, then we exit CLEANLY anyway. A
  // single hanging await in any teardown step otherwise rides to systemd's
  // 90s SIGKILL, which marks the run "unclean" and inflates the crash
  // circuit breaker on every routine restart (observed repeatedly: attempts
  // climbed to 9 purely from slow stops). Exiting 0 here is honest — we WERE
  // asked to stop; the remaining teardown is best-effort cleanup, and every
  // component must already survive a hard kill (crash-consistency is the
  // design baseline).
  //
  // Armed from the FIRST step of shutdown() (stopHostModules runs before any
  // other teardown), so the window covers every await that follows.
  const watchdog = setTimeout(() => {
    log.warn('Shutdown watchdog fired — teardown exceeded 10s, exiting clean');
    resetCircuitBreaker();
    process.exit(0);
  }, 10_000);
  watchdog.unref();
});

/**
 * Renew member Grok credentials on a timer.
 *
 * The install-wide credential has its own sweep in the provider payload; this
 * is the per-member half, and it needs the vault because a member's ACCESS
 * token lives there. Same reasoning, same cadence: expiry is a function of
 * time, so renewal has to be too — a member whose token lapsed while they were
 * away would otherwise find their agent unauthenticated with a perfectly good
 * refresh token sitting on the host.
 *
 * Registered unconditionally: with no member credentials the sweep lists an
 * empty directory and returns.
 */
onHostStart(() => {
  const tick = () =>
    void refreshDueUserCredentials({
      updateSecretValue: (secretId, value) => realOnecliAdmin.updateSecretValue(secretId, value),
    });
  tick();
  const timer = setInterval(tick, GROK_USER_REFRESH_TICK_MS);
  timer.unref?.();
});
