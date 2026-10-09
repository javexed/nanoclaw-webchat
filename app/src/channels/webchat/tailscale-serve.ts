/**
 * `tailscale serve` control — the host side of the webchat "Enable HTTPS over
 * Tailscale" action.
 *
 * `tailscale serve --bg <port>` puts an HTTPS reverse proxy in front of the
 * local webchat on the node's `*.ts.net` MagicDNS name, using Tailscale's
 * automatic Let's Encrypt cert. The result is `https://<node>.ts.net` with a
 * valid cert (a real browser secure context → PWA install / push / voice work)
 * proxying to `http://127.0.0.1:<port>`, where <port> is webchat's dedicated
 * Serve listener (WEBCHAT_SERVE_PORT, see servePortFor), not its main port.
 * Serve injects `Tailscale-User-Login`, which auth.ts believes only on that
 * listener and maps back to the same `webchat:tailscale:<login>` identity the
 * whois path produces, so an owner claimed over plain http-tailnet stays owner
 * once HTTPS is on.
 *
 * Two external prerequisites this module can only *report*, not fix:
 *   - HTTPS certificates must be enabled once, tailnet-wide, in the Tailscale
 *     admin console (DNS page). We detect that failure and hand back the link.
 *   - `tailscale serve` needs root or operator access to tailscaled. The
 *     community-scripts deploy runs as root; a self-hosted service user needs
 *     `sudo tailscale set --operator=<user>` once. We detect the permission
 *     error and answer with that command, the running user's name already
 *     filled in. Note that READING (`serve status`) is permitted for any
 *     user and only writing the config is gated — so a host reports
 *     "available, not active" right up until it refuses to enable.
 *
 * The tailscale invocations go through an injectable runner so the parsing and
 * error-classification logic is unit-tested without a real daemon.
 */
import { execFile } from 'child_process';
import os from 'os';

export interface TailscaleServeState {
  /** tailscaled is up and logged into a tailnet. */
  available: boolean;
  /** An HTTPS serve mapping already exists (best-effort; older CLIs lack --json). */
  active: boolean;
  /** `https://<node>.ts.net`, or null when it can't be determined. */
  url: string | null;
}

export interface EnableResult {
  ok: boolean;
  url?: string;
  error?: string;
  hint?: string;
  hintUrl?: string;
}

export interface RunResult {
  ok: boolean;
  notFound: boolean;
  stdout: string;
  stderr: string;
}

export type TailscaleRunner = (args: string[]) => Promise<RunResult>;

const defaultRunner: TailscaleRunner = (args) =>
  new Promise((resolve) => {
    execFile('tailscale', args, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        notFound: !!err && (err as NodeJS.ErrnoException).code === 'ENOENT',
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      });
    });
  });

/** Probe tailscaled: is it up, what's the HTTPS URL, and is serve already on? */
export async function getTailscaleServeState(runner: TailscaleRunner = defaultRunner): Promise<TailscaleServeState> {
  const status = await runner(['status', '--json']);
  if (!status.ok) return { available: false, active: false, url: null };

  let dns: string | null = null;
  let running = false;
  try {
    const j = JSON.parse(status.stdout) as { Self?: { DNSName?: string }; BackendState?: string };
    running = j.BackendState === 'Running';
    const raw = j.Self?.DNSName?.replace(/\.$/, '') ?? '';
    dns = raw || null;
  } catch {
    /* malformed status → treat as unavailable below */
  }
  const url = dns ? `https://${dns}` : null;

  let active = false;
  const serve = await runner(['serve', 'status', '--json']);
  if (serve.ok) {
    try {
      const cfg = JSON.parse(serve.stdout) as { Web?: Record<string, unknown>; TCP?: Record<string, unknown> };
      active = Object.keys(cfg.Web ?? {}).length > 0 || Object.keys(cfg.TCP ?? {}).length > 0;
    } catch {
      /* older CLI or no config → leave active=false */
    }
  }
  return { available: running, active, url };
}

/**
 * The port of webchat's dedicated Serve listener: WEBCHAT_SERVE_PORT, else the
 * main port + 10000 (3100 → 13100). Not main + 1: neighbouring ports are where
 * a second install on the same machine, and this one's other listeners, live.
 * `off` (or 0) disables the listener. Null when disabled or out of range.
 */
export function servePortFor(mainPort: number, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.WEBCHAT_SERVE_PORT || '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false') return null;
  // An ephemeral main port (0, as tests use) has no fixed neighbour to derive from.
  if (!raw && mainPort === 0) return null;
  const port = raw ? Number(raw) : mainPort + 10_000;
  return Number.isInteger(port) && port > 0 && port < 65_536 && port !== mainPort ? port : null;
}

/** One Serve web mapping: the `host:port` it answers on and the local port it proxies to. */
interface ServeMapping {
  hostPort: string;
  host: string;
  httpsPort: string;
  target: number;
}

/** The Serve web mappings whose root handler proxies to a port on loopback. */
export function serveMappings(serveStatusJson: string): ServeMapping[] {
  let cfg: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  try {
    cfg = JSON.parse(serveStatusJson);
  } catch {
    return [];
  }
  const out: ServeMapping[] = [];
  for (const [hostPort, web] of Object.entries(cfg?.Web ?? {})) {
    const proxy = web?.Handlers?.['/']?.Proxy ?? '';
    let target: URL;
    try {
      // `tailscale serve 3100` stores `http://127.0.0.1:3100`; a bare host:port is tolerated.
      target = new URL(/^[a-z+]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
    } catch {
      continue;
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) continue;
    const [host, p] = hostPort.toLowerCase().split(':');
    out.push({
      hostPort,
      host,
      httpsPort: p || '443',
      target: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
    });
  }
  return out;
}

export interface ServeRouting {
  /** Serve proxies to the dedicated Serve listener. Once true, the legacy path is closed. */
  dedicated: boolean;
  /** Names Serve fronts at the MAIN port (the legacy setup), as Serve's Host header carries them. */
  legacyHosts: ReadonlySet<string>;
}

/**
 * Where Serve sends this install's traffic, read from `tailscale serve status
 * --json`. Cached briefly; enabling Serve here clears it.
 */
const SERVE_ROUTING_TTL_MS = 60_000;
let routingCache: { key: string; routing: ServeRouting; at: number } | null = null;

export async function serveRouting(
  mainPort: number,
  servePort: number | null,
  runner: TailscaleRunner = defaultRunner,
): Promise<ServeRouting> {
  const key = `${mainPort}|${servePort}`;
  if (routingCache && routingCache.key === key && Date.now() - routingCache.at < SERVE_ROUTING_TTL_MS)
    return routingCache.routing;
  const serve = await runner(['serve', 'status', '--json']);
  const mappings = serve.ok ? serveMappings(serve.stdout) : [];
  const routing: ServeRouting = {
    dedicated: servePort !== null && mappings.some((m) => m.target === servePort),
    // As Host arrives: bare on 443, `name:port` otherwise. The bare name alone
    // matched no front but 443 (refusing a runner behind :8443), and would let
    // one port's front vouch for a request addressed to another.
    legacyHosts: new Set(
      mappings
        .filter((m) => m.target === mainPort)
        .map((m) => (m.httpsPort === '443' ? m.host : `${m.host}:${m.httpsPort}`)),
    ),
  };
  routingCache = { key, routing, at: Date.now() };
  return routing;
}

export function forgetServeRouting(): void {
  routingCache = null;
}

/**
 * The commands that move an existing Serve mapping from the main port to the
 * Serve listener, one per HTTPS port Serve answers on for this install. Empty
 * when nothing points at the main port, or Serve already uses the listener.
 */
export function serveMigrationCommands(serveStatusJson: string, mainPort: number, servePort: number): string[] {
  const mappings = serveMappings(serveStatusJson);
  if (mappings.some((m) => m.target === servePort)) return [];
  const ports = new Set(mappings.filter((m) => m.target === mainPort).map((m) => m.httpsPort));
  return [...ports].map((p) => `tailscale serve --bg --https=${p} ${servePort}`);
}

/** Read Serve's config and return serveMigrationCommands for it. */
export async function pendingServeMigration(
  mainPort: number,
  servePort: number,
  runner: TailscaleRunner = defaultRunner,
): Promise<string[]> {
  const serve = await runner(['serve', 'status', '--json']);
  return serve.ok ? serveMigrationCommands(serve.stdout, mainPort, servePort) : [];
}

/**
 * Turn on `tailscale serve --bg <port>`. Classifies the common failure modes
 * (certs not enabled, insufficient privilege, daemon down, binary missing) into
 * actionable hints so the UI can guide the operator instead of dumping stderr.
 */
export async function enableTailscaleServe(
  port: number,
  runner: TailscaleRunner = defaultRunner,
): Promise<EnableResult> {
  const state = await getTailscaleServeState(runner);
  if (!state.available) {
    return {
      ok: false,
      error: 'Tailscale is not running or not logged in on this machine.',
      hint: 'Run `tailscale up` first, then try again.',
    };
  }

  const run = await runner(['serve', '--bg', String(port)]);
  forgetServeRouting();
  if (run.ok) {
    const after = await getTailscaleServeState(runner);
    return { ok: true, url: after.url ?? state.url ?? undefined };
  }

  if (run.notFound) {
    return {
      ok: false,
      error: '`tailscale` is not installed on this machine.',
      hint: 'Install Tailscale, then try again.',
    };
  }

  const err = `${run.stdout}\n${run.stderr}`.toLowerCase();
  if (/https|certificate|\bcert\b/.test(err) && /enabl|not |admin|provision/.test(err)) {
    return {
      ok: false,
      error: 'HTTPS certificates are not enabled for your tailnet yet.',
      hint: 'Open the Tailscale admin console → DNS page, find "HTTPS Certificates", and click "Enable HTTPS" — then try again.',
      hintUrl: 'https://console.tailscale.com/admin/dns',
    };
  }
  if (/access denied|permission|operator|must be run|not permitted|are not allowed/.test(err)) {
    // Name the actual user and include sudo. Not the daemon's own suggestion:
    // its `$USER` is unexpanded on a web page.
    return {
      ok: false,
      error: 'This process is not allowed to configure `tailscale serve`.',
      hint: `Grant this user access once with \`sudo tailscale set --operator=${os.userInfo().username}\`, then try again.`,
    };
  }
  return { ok: false, error: (run.stderr || run.stdout || 'tailscale serve failed').trim().slice(0, 400) };
}

/**
 * The HTTPS address Tailscale Serve publishes THIS install at, read from
 * `tailscale serve status --json`: the `host:port` whose root handler proxies to
 * one of our local ports (the Serve listener, or the main port on an install
 * not yet moved over). `:443` is left off. Null when Serve does not front us
 * (another install may own the default 443 mapping on the same machine).
 */
export function serveUrlForPort(serveStatusJson: string, port: number | readonly number[]): string | null {
  const mappings = serveMappings(serveStatusJson);
  for (const p of typeof port === 'number' ? [port] : port) {
    const hit = mappings.find((m) => m.target === p);
    if (hit) return hit.httpsPort !== '443' ? `https://${hit.host}:${hit.httpsPort}` : `https://${hit.host}`;
  }
  return null;
}

/**
 * Where a browser should reach this install on the tailnet: Serve's HTTPS
 * address when Serve fronts our port, else — when webchat itself listens
 * beyond loopback — `http://<node>.ts.net:<port>`. Null when neither applies.
 */
export async function tailnetUrlForPort(
  port: number,
  listensBeyondLoopback: boolean,
  runner: TailscaleRunner = defaultRunner,
  servePort: number | null = null,
): Promise<string | null> {
  const serve = await runner(['serve', 'status', '--json']);
  if (serve.ok) {
    const viaServe = serveUrlForPort(serve.stdout, servePort === null ? [port] : [servePort, port]);
    if (viaServe) return viaServe;
  }
  if (!listensBeyondLoopback) return null;
  const status = await runner(['status', '--json']);
  if (!status.ok) return null;
  try {
    const dns = (JSON.parse(status.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, '');
    return dns ? `http://${dns}:${port}` : null;
  } catch {
    return null;
  }
}
