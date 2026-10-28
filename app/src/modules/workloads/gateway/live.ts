/**
 * Which published apps the gateway serves right now: the workload runs, its
 * service has an address, the route's kind is on and can name the app's
 * address. Everything else is left out of Caddy, so a stopped workload or a
 * switched-off route answers 404 at the gateway rather than reaching anything.
 */
import { getWorkload } from '../store.js';
import { listRoutes, type AppRoute } from '../routes.js';
import { validSite, type GatewaySite } from './caddy.js';
import { publishingRoute } from './publishing.js';

export async function siteFor(route: AppRoute): Promise<GatewaySite | null> {
  const kind = publishingRoute(route.kind);
  if (!kind || !(await kind.enabled().catch(() => false))) return null;
  const w = await getWorkload(route.workloadId);
  if (!w || w.state !== 'running' || w.agentGroupId !== route.agentGroupId) return null;
  const addr = w.addresses[route.service];
  const hostname = await kind.hostnameFor(route.app).catch(() => null);
  if (!addr || !hostname) return null;
  const site = { id: route.id, hostname, target: `${addr}:${route.port}` };
  return validSite(site) ? site : null;
}

export const isLive = async (route: AppRoute): Promise<boolean> => (await siteFor(route)) !== null;

export async function liveSites(): Promise<GatewaySite[]> {
  const out: GatewaySite[] = [];
  const hosts = new Set<string>();
  for (const r of await listRoutes()) {
    const s = await siteFor(r);
    if (s && !hosts.has(s.hostname)) {
      hosts.add(s.hostname);
      out.push(s);
    }
  }
  return out;
}
