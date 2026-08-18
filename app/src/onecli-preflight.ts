/**
 * OneCLI gateway preflight — a startup diagnostic.
 *
 * Agent spawns hard-require the OneCLI credential gateway (container-runner's
 * buildContainerArgs calls ensureAgent/applyContainerConfig and refuses to
 * spawn without it). When the gateway is unreachable or too old for the
 * installed @onecli-sh/sdk, EVERY spawn fails the same silent way and rooms
 * look dead. This probes the gateway at boot and logs the exact fix,
 * instead of leaving it to be reverse-engineered from 404/401/fetch-failed spam.
 *
 * Deliberately NON-FATAL: it logs loudly but never aborts startup — the gateway
 * may recover, non-OneCLI work may still function, and crash-looping the host on
 * a transient blip is worse than a warning.
 *
 * Deliberately PATIENT about *unreachable*, and only unreachable. Docker starts
 * the onecli containers and systemd starts the host, with nothing ordering the
 * two: on a reboot the first probe routinely loses that race by a second or so
 * and printed a permanent-looking UNREACHABLE error at every boot of a perfectly
 * healthy install — the operator's most alarming log line was also its least
 * true one. So an unreachable gateway is retried in the BACKGROUND (boot is
 * never delayed, per this hook's contract) and the error is only logged if it is
 * still unreachable when the budget runs out. A 404 (gateway too old) and an
 * unset URL are reported immediately: no amount of waiting fixes either.
 */
import { ONECLI_URL, ONECLI_API_KEY } from './config.js';
import { log } from './log.js';

const PROBE_TIMEOUT_MS = 5000;
/** How long to keep waiting on an unreachable gateway before calling it broken. */
const RETRY_BUDGET_MS = 60_000;
/** Gap between retries. Cheap enough to be frequent; a cold container is seconds, not minutes. */
const RETRY_INTERVAL_MS = 2_000;

/** HTTP status of the probe, `null` when the request threw, `'unset'` when there is no URL. */
export type GatewayProbe = number | null | 'unset';

export type PreflightVerdict = {
  level: 'info' | 'warn' | 'error';
  message: string;
};

/**
 * Map a gateway probe to a log verdict. Pure (no I/O) so it is unit-testable.
 *
 * `probe` is the HTTP status of `GET <ONECLI_URL>/v1/agents`, or `null` when the
 * request threw (unreachable), or `'unset'` when ONECLI_URL is absent. A 404
 * means the /v1 router doesn't exist → the gateway predates the SDK's API (the
 * version-coupling trap: SDK 2.x calls /v1/agents, an old gateway only has
 * /api/agents, so every ensureAgent 404s and nothing spawns). Any other status
 * (200/401/403/405) means /v1 is present → the gateway speaks the SDK's API.
 */
export function classifyGatewayProbe(probe: GatewayProbe, url?: string): PreflightVerdict {
  if (probe === 'unset') {
    return {
      level: 'warn',
      message:
        'OneCLI: ONECLI_URL is not set — agent containers cannot obtain credentials and will fail to spawn ' +
        '(unless a native-credential path is configured). Set ONECLI_URL in .env (on Linux the gateway binds to ' +
        'the docker-bridge IP, e.g. http://172.17.0.1:10254, not 127.0.0.1).',
    };
  }
  if (probe === null) {
    return {
      level: 'error',
      message:
        `OneCLI: gateway at ${url} is UNREACHABLE — agent spawns will fail until it is reachable. Check: ` +
        '`docker ps` shows the onecli container healthy; `docker port onecli` binds the host:port in ONECLI_URL ' +
        '(on Linux it MUST be the docker-bridge IP, not 127.0.0.1 — set ONECLI_BIND_HOST in ~/.onecli/.env then ' +
        '`cd ~/.onecli && docker compose up -d`).',
    };
  }
  if (probe === 404) {
    return {
      level: 'error',
      message:
        `OneCLI: gateway at ${url} is too OLD for the installed @onecli-sh/sdk (no /v1 API — ensureAgent will 404, ` +
        'so NO agents will spawn and every room goes silent). Upgrade the gateway: ' +
        '`cd ~/.onecli && docker compose pull && docker compose up -d` (back up first: pg_dumpall + tar the ' +
        'app-data volume). Also bump the CLI: `curl -fsSL onecli.sh/cli/install | sh`.',
    };
  }
  return {
    level: 'info',
    message: `OneCLI: gateway reachable at ${url} (HTTP ${probe}) — credential path OK`,
  };
}

/**
 * Is this probe worth waiting on?
 *
 * Only `null` (connection refused / DNS / timeout) is transient — that is the
 * boot-race shape. A 404 means the gateway is running but too old, and 'unset'
 * means it was never configured; both are operator-fix-required, so reporting
 * them a minute late would help nobody.
 */
export function isTransientProbe(probe: GatewayProbe): boolean {
  return probe === null;
}

export type GatewayWait = {
  /** True once the gateway returned a definite answer (reachable, or reachable-but-old). */
  settled: boolean;
  probe: GatewayProbe;
  attempts: number;
  waitedMs: number;
};

/**
 * Re-probe until the gateway answers or the budget is spent.
 *
 * `probe` and `sleep` are injected so this is testable without real time or a
 * real socket — the retry policy is the part worth pinning, and a test that
 * actually waited 60s would never be run.
 */
export async function awaitGateway(
  probe: () => Promise<GatewayProbe>,
  sleep: (ms: number) => Promise<void>,
  opts: { budgetMs?: number; intervalMs?: number } = {},
): Promise<GatewayWait> {
  const budgetMs = opts.budgetMs ?? RETRY_BUDGET_MS;
  const intervalMs = opts.intervalMs ?? RETRY_INTERVAL_MS;
  let waitedMs = 0;
  let attempts = 0;
  let last: GatewayProbe = null;

  while (waitedMs < budgetMs) {
    await sleep(intervalMs);
    waitedMs += intervalMs;
    attempts += 1;
    last = await probe();
    if (!isTransientProbe(last)) return { settled: true, probe: last, attempts, waitedMs };
  }
  return { settled: false, probe: last, attempts, waitedMs };
}

/** One probe of `GET <ONECLI_URL>/v1/agents`. Never throws: a throw IS the unreachable signal. */
async function probeGateway(): Promise<GatewayProbe> {
  if (!ONECLI_URL) return 'unset';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${ONECLI_URL.replace(/\/+$/, '')}/v1/agents`, {
      method: 'GET',
      headers: ONECLI_API_KEY ? { Authorization: `Bearer ${ONECLI_API_KEY}` } : {},
      signal: ctrl.signal,
    });
    return res.status;
  } catch {
    return null; // network error / timeout / DNS — unreachable
  } finally {
    clearTimeout(timer);
  }
}

/** unref'd so a host shutting down mid-wait is never held open by the retry timer. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Probe the OneCLI gateway and log a single actionable verdict. Never throws.
 *
 * Awaits exactly one probe, so boot is delayed by at most PROBE_TIMEOUT_MS —
 * the retry, when needed, runs detached.
 */
export async function preflightOneCLI(): Promise<void> {
  const first = await probeGateway();
  if (!isTransientProbe(first)) {
    const verdict = classifyGatewayProbe(first, ONECLI_URL);
    log[verdict.level](verdict.message);
    return;
  }

  log.info(
    `OneCLI: gateway at ${ONECLI_URL} did not answer the first probe — retrying for up to ` +
      `${Math.round(RETRY_BUDGET_MS / 1000)}s in the background (boot continues; this is the ` +
      'expected shape of a reboot, where Docker and systemd start us in either order).',
  );

  void awaitGateway(probeGateway, sleep).then((wait) => {
    const verdict = classifyGatewayProbe(wait.probe, ONECLI_URL);
    if (wait.settled && verdict.level === 'info') {
      log.info(
        `OneCLI: gateway came up ${Math.round(wait.waitedMs / 1000)}s after boot ` +
          `(${wait.attempts} probes) — the first probe was early, not a fault.`,
      );
    }
    log[verdict.level](verdict.message);
  });
}
