/**
 * The edge network: one Docker bridge per install (`nc-tsedge-<install>`,
 * bridge `nct…`) that holds the publishing routes' edges and nothing else:
 * the tailnet sidecars and the Cloudflare connector. It is not internal (a
 * sidecar must reach Tailscale's control servers and relays, the connector
 * Cloudflare's edge), and containers on it do not talk to each other (ICC
 * off).
 *
 * The host rules (deploy/workloads-host-rules.sh) let a new connection from
 * it reach exactly one thing on this host, the gateway's port on the edge
 * address, and drop every other one, and drop forwarding from it into the
 * workload range, private and link-local ranges and the tailnet's own range.
 * As with workloads, NanoClaw checks this by trying (probeEdge): a throwaway
 * container on the edge network asks a listener on the host's edge address.
 *
 * Only the edges belong here: anything else found on it is disconnected.
 */
import { randomBytes } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import { INSTALL_SLUG } from '../../../config.js';
import { log } from '../../../log.js';
import { ensureHelperImage } from '../backup.js';
import { HELPER_IMAGE } from '../images.js';
import { dynamicRange, edgeBridgeName, edgeNetworkName, type EdgeConfig } from './config.js';
import { SIDECAR_LABEL, type DockerRun } from './sidecar.js';

/** Create the edge network when missing; refuse one that is not the shape the host rules rely on. */
export async function ensureEdgeNetwork(docker: DockerRun, cfg: EdgeConfig): Promise<void> {
  const name = edgeNetworkName();
  const info = await docker([
    'network',
    'inspect',
    name,
    '--format',
    '{{index .Options "com.docker.network.bridge.name"}} {{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{.Internal}}',
  ]).catch(() => null);
  if (info === null) {
    await docker([
      'network',
      'create',
      '--driver',
      'bridge',
      '--subnet',
      cfg.subnet,
      '--gateway',
      cfg.gateway,
      // Docker's own picks stay out of the sidecars' fixed addresses.
      '--ip-range',
      dynamicRange(cfg),
      '-o',
      `com.docker.network.bridge.name=${edgeBridgeName()}`,
      '-o',
      'com.docker.network.bridge.enable_icc=false',
      '--label',
      `nanoclaw-workload-tailnet=${INSTALL_SLUG}`,
      name,
    ]);
    log.info('Tailnet edge network created', { network: name, subnet: cfg.subnet });
    return;
  }
  const [bridge, subnet, gateway, icc] = info.trim().split(' ');
  if (bridge !== edgeBridgeName() || subnet !== cfg.subnet || gateway !== cfg.gateway || icc !== 'false')
    throw new Error(
      `the edge network ${name} is not the one NanoClaw expects (bridge ${edgeBridgeName()}, ${cfg.subnet}, ICC off): remove it so NanoClaw recreates it`,
    );
}

/** The labels an edge of this install carries (value: the install slug). */
export const CONNECTOR_LABEL = 'nanoclaw-workload-cloudflare';
const EDGE_LABELS = [SIDECAR_LABEL, CONNECTOR_LABEL];

/** Disconnect every container on the edge network that is not one of this install's edges. */
export async function evictStrangers(docker: DockerRun): Promise<string[]> {
  const out = await docker([
    'network',
    'inspect',
    edgeNetworkName(),
    '--format',
    '{{range $id, $c := .Containers}}{{$id}} {{$c.Name}}{{"\\n"}}{{end}}',
  ]).catch(() => '');
  const evicted: string[] = [];
  for (const line of out.split('\n')) {
    const [id, name] = line.trim().split(' ');
    if (!id) continue;
    const labels = await docker([
      'inspect',
      '-f',
      EDGE_LABELS.map((l) => `{{index .Config.Labels "${l}"}}`).join(' '),
      id,
    ]).catch(() => '');
    if (labels.split(/\s+/).includes(INSTALL_SLUG)) continue;
    await docker(['network', 'disconnect', '--force', edgeNetworkName(), id]).catch(() => undefined);
    evicted.push(name || id);
  }
  if (evicted.length) log.warn('Edge network: disconnected containers that are not its edges', { containers: evicted });
  return evicted;
}

export type EdgeIsolation = 'blocked' | 'open';

/**
 * Can a container on the edge network open a connection to this host on a
 * port that is not the gateway's? A listener on the edge address answers a
 * random token; a throwaway helper container asks for it.
 */
export async function probeEdge(docker: DockerRun, cfg: EdgeConfig): Promise<EdgeIsolation> {
  await ensureHelperImage();
  const token = randomBytes(12).toString('hex');
  const server = http.createServer((_req, res) => res.end(token));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, cfg.gateway, () => resolve());
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const stdout = await docker(
      [
        'run',
        '--rm',
        '--network',
        edgeNetworkName(),
        '--log-driver',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--memory',
        '64m',
        '--pids-limit',
        '16',
        HELPER_IMAGE(),
        'sh',
        '-c',
        `wget -q -T 4 -O- http://${cfg.gateway}:${port}/ 2>/dev/null; echo " rc=$?"`,
      ],
      60_000,
    );
    if (stdout.includes(token)) return 'open';
    if (/ rc=\d+/.test(stdout)) return 'blocked';
    throw new Error(`the edge probe gave no answer: ${stdout.slice(0, 200)}`);
  } finally {
    server.close();
  }
}
