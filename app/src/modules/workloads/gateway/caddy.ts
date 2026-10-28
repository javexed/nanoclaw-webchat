/**
 * The gateway's data plane: a Caddy container on the host network, configured
 * only by NanoClaw. It routes each app's hostname to the app's fixed address
 * on its agent's workload network and asks NanoClaw about every request
 * (forward_auth) before it does. Bodies stream through Caddy; NanoClaw only
 * ever sees the request line and headers of the check.
 *
 * What reaches an app is built from an allow-list of request headers. Nothing
 * that proves who someone is elsewhere — Authorization, NanoClaw's or the
 * edge's cookies, Cf-Access-*, Tailscale-*, X-Ms-*, a proxy identity header,
 * the client's X-Forwarded-* or Forwarded — is in it; the app gets the signed
 * X-NanoClaw-* identity instead, and fresh X-Forwarded-* that Caddy sets.
 * Cookies an app sets lose any Domain attribute, so an app can only set
 * cookies for its own host.
 *
 * Every value templated into the Caddyfile is checked first: hostnames,
 * targets (an address in the workload range), route ids and the secret.
 * Caddy's admin API is a Unix socket in the gateway's own 0700 folder,
 * reached only from inside the container.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { INSTALL_SLUG } from '../../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../../container-runtime.js';
import { log } from '../../../log.js';
import { dockerEnv } from '../docker.js';
import type { GatewayConfig } from './config.js';
import { gatewayDir } from './keys.js';

const run = promisify(execFile);

export const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** A workload service address: 198.18.0.0/15 (override.ts), with a port. */
export function validTarget(t: string): boolean {
  const m = /^198\.(18|19)\.(0|[1-9]\d{0,2})\.([1-9]\d{0,2}):([1-9]\d{0,4})$/.exec(t);
  if (!m) return false;
  const [c, d, p] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return c <= 255 && d <= 254 && p <= 65535;
}

export interface GatewaySite {
  /** The route's id: how the check finds the app. */
  id: string;
  hostname: string;
  /** address:port on the workload network. */
  target: string;
}

export function validSite(s: GatewaySite): boolean {
  return UUID_RE.test(s.id) && HOSTNAME_RE.test(s.hostname) && validTarget(s.target);
}

/**
 * Request headers an app receives as the browser sent them. Everything else
 * is dropped. The X-NanoClaw-* identity comes from NanoClaw's check, never
 * from the browser (removed before the check).
 */
export const FORWARDED_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Cache-Control',
  'Pragma',
  'Content-Type',
  'Content-Encoding',
  'Content-Language',
  'Cookie',
  'If-Match',
  'If-None-Match',
  'If-Modified-Since',
  'If-Unmodified-Since',
  'If-Range',
  'Range',
  'Origin',
  'Referer',
  'User-Agent',
  'X-Requested-With',
  'Connection',
  'Upgrade',
  'Sec-WebSocket-Key',
  'Sec-WebSocket-Version',
  'Sec-WebSocket-Protocol',
  'Sec-WebSocket-Extensions',
  'Sec-Fetch-Site',
  'Sec-Fetch-Mode',
  'Sec-Fetch-Dest',
  'Sec-Fetch-User',
  'Traceparent',
  'Tracestate',
  'X-NanoClaw-User',
  'X-NanoClaw-Name',
  'X-NanoClaw-Auth',
  'X-NanoClaw-Identity',
] as const;

/** The identity NanoClaw's check answers with. */
export const IDENTITY_HEADERS = ['X-NanoClaw-User', 'X-NanoClaw-Name', 'X-NanoClaw-Auth', 'X-NanoClaw-Identity'];

/**
 * Cookies that never reach an app: NanoClaw's own, and the sign-in cookies of
 * the edges a route may sit behind (Cloudflare Access, App Service).
 */
const CREDENTIAL_COOKIES =
  '(?i)(^|;\\s*)(nanoclaw_[^=;]*|__host-nanoclaw[^=;]*|cf_authorization|cf_appsession|appserviceauthsession[^=;]*)=[^;]*';

export const runDir = (): string => path.join(gatewayDir(), 'caddy');
/** Inside the container. */
const MOUNT = '/run/gw';
export const containerName = (): string => `nanoclaw-workload-gateway-${INSTALL_SLUG}`;

/** The Caddyfile for these sites. Pure: tested on its own. Throws on anything that is not checked. */
export function renderCaddyfile(cfg: GatewayConfig, sites: GatewaySite[], secret: string): string {
  if (!SECRET_RE.test(secret)) throw new Error('gateway secret has an unexpected shape');
  if (!Number.isInteger(cfg.port) || !Number.isInteger(cfg.internalPort))
    throw new Error('gateway ports must be numbers');
  if (!/^[0-9a-fA-F:.]+$/.test(cfg.bind)) throw new Error('gateway bind must be an IP address');
  const internal = `127.0.0.1:${cfg.internalPort}`;
  const bind = cfg.bind.includes(':') ? `[${cfg.bind}]` : cfg.bind;
  const out: string[] = [
    '{',
    `\tadmin unix/${MOUNT}/admin.sock`,
    '\tpersist_config off',
    '\tauto_https off',
    `\thttp_port ${cfg.port}`,
    `\tdefault_bind ${bind}`,
    '}',
  ];
  const seen = new Set<string>();
  for (const s of sites) {
    if (!validSite(s)) throw new Error(`refusing to render gateway site ${JSON.stringify(s.hostname)}`);
    if (seen.has(s.hostname)) throw new Error(`two gateway sites for ${s.hostname}`);
    seen.add(s.hostname);
    const auth = [`\t\t\theader_up X-NanoClaw-Gateway-Secret ${secret}`, `\t\t\theader_up X-NanoClaw-Route ${s.id}`];
    out.push(
      '',
      `http://${s.hostname} {`,
      '\troute {',
      // Nothing the browser sends may claim a NanoClaw identity.
      '\t\trequest_header -X-NanoClaw-*',
      '\t\t@nc_jwks path /.nanoclaw/jwks.json',
      `\t\treverse_proxy @nc_jwks ${internal} {`,
      '\t\t\theader_up -*',
      ...auth,
      '\t\t}',
      `\t\tforward_auth ${internal} {`,
      '\t\t\turi /gateway/check',
      ...auth,
      // The address that connected to Caddy (the edge), not anything it says.
      '\t\t\theader_up X-NanoClaw-Peer {http.request.remote.host}',
      `\t\t\tcopy_headers ${IDENTITY_HEADERS.join(' ')}`,
      '\t\t}',
      // The allow-list: keep the allowed headers that are present, drop all, put them back.
      ...FORWARDED_HEADERS.flatMap((h, i) => [
        `\t\t@nc_h${i} header ${h} *`,
        `\t\tvars @nc_h${i} nc_h${i} {http.request.header.${h}}`,
      ]),
      '\t\trequest_header -*',
      ...FORWARDED_HEADERS.flatMap((h, i) => [
        `\t\t@nc_k${i} vars_regexp nc_h${i} ^.`,
        `\t\trequest_header @nc_k${i} ${h} {vars.nc_h${i}}`,
      ]),
      `\t\trequest_header Cookie "${CREDENTIAL_COOKIES}" ""`,
      '\t\trequest_header Cookie "^;\\s*" ""',
      `\t\treverse_proxy ${s.target} {`,
      `\t\t\theader_up Host ${s.hostname}`,
      `\t\t\theader_up X-Forwarded-Host ${s.hostname}`,
      '\t\t\theader_up X-Forwarded-Proto https',
      '\t\t\theader_down Set-Cookie "(?i);\\s*domain=[^;]*" ""',
      '\t\t\tflush_interval -1',
      '\t\t}',
      '\t}',
      '}',
    );
  }
  out.push('', 'http:// {', '\trespond "Not found" 404', '}', '');
  return out.join('\n');
}

/**
 * Write the Caddyfile (a restarted container comes back with it) and load it
 * into the running Caddy through its admin socket, from inside the container
 * (the socket's path on the host can be longer than a socket path may be).
 * Caddy leaves an unchanged config alone.
 */
export async function applyConfig(text: string, quiet = false): Promise<boolean> {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runDir(), 'Caddyfile'), text, { mode: 0o600 });
  try {
    await docker(
      [
        'exec',
        containerName(),
        'caddy',
        'reload',
        '--config',
        `${MOUNT}/Caddyfile`,
        '--adapter',
        'caddyfile',
        '--address',
        `unix/${MOUNT}/admin.sock`,
      ],
      30_000,
    );
    return true;
  } catch (err) {
    if (quiet) return false;
    log.warn('Workload gateway: Caddy did not take the config', {
      err: String((err as { stderr?: string }).stderr || err).slice(0, 500),
    });
    return false;
  }
}

/** The `docker run` arguments after the name; their hash labels the container. */
export function runArgs(image: string, dir: string, uid: number, gid: number): string[] {
  return [
    // Not the install label: NanoClaw's startup sweep removes containers carrying it as leftover agents.
    '--label',
    `nanoclaw-workload-gateway=${INSTALL_SLUG}`,
    '--restart',
    'unless-stopped',
    // It must reach NanoClaw's check on 127.0.0.1 and the apps on their workload networks.
    '--network',
    'host',
    // NanoClaw's own user, so it can write the admin socket NanoClaw talks to.
    '--user',
    `${uid}:${gid}`,
    '--read-only',
    '--cap-drop',
    'ALL',
    // The image's caddy binary carries this file capability; without it in the bounding set exec fails.
    '--cap-add',
    'NET_BIND_SERVICE',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '256m',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=3',
    '--tmpfs',
    `/data:uid=${uid},gid=${gid}`,
    '--tmpfs',
    `/config:uid=${uid},gid=${gid}`,
    '-v',
    `${dir}:${MOUNT}`,
    image,
    'caddy',
    'run',
    '--config',
    `${MOUNT}/Caddyfile`,
    '--adapter',
    'caddyfile',
  ];
}

const docker = (args: string[], timeout = 120_000) => run(CONTAINER_RUNTIME_BIN, args, { env: dockerEnv(), timeout });

/**
 * Start the container when it is not running; replace it when its run
 * arguments changed (a new image pin, say). Returns true when it started one.
 */
export async function ensureContainer(cfg: GatewayConfig, initial: string): Promise<boolean> {
  const name = containerName();
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(runDir(), 0o700);
  const dir = fs.realpathSync(runDir());
  const args = runArgs(cfg.image, dir, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000);
  const spec = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
  const [state, have] = await docker([
    'inspect',
    '-f',
    '{{.State.Running}} {{index .Config.Labels "nanoclaw-workload-gateway-spec"}}',
    name,
  ])
    .then((r) => r.stdout.trim().split(' '))
    .catch(() => ['missing', '']);
  if (state === 'true' && have === spec) return false;
  if (state !== 'missing') await docker(['rm', '--force', name]);
  fs.writeFileSync(path.join(dir, 'Caddyfile'), initial, { mode: 0o600 });
  fs.rmSync(path.join(dir, 'admin.sock'), { force: true });
  await docker(['run', '-d', '--name', name, '--label', `nanoclaw-workload-gateway-spec=${spec}`, ...args]);
  log.info('Workload gateway: Caddy started', { name, bind: cfg.bind, port: cfg.port });
  return true;
}

/** Remove the container (the gateway was switched off or refused). */
export async function removeContainer(): Promise<boolean> {
  const name = containerName();
  const exists = await docker(['inspect', '-f', '{{.Id}}', name])
    .then(() => true)
    .catch(() => false);
  if (!exists) return false;
  await docker(['rm', '--force', name]);
  log.info('Workload gateway: Caddy removed', { name });
  return true;
}
