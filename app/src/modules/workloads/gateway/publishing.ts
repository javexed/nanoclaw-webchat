/**
 * Publishing routes: how people's browsers reach the gateway, and who the
 * gateway may believe they are. Each route kind brings its own edge and its
 * own identity proof:
 *
 *   tailnet     a Tailscale sidecar per app; `serve` adds Tailscale-User-Login,
 *               believed only from that app's own sidecar
 *   cloudflare  a Cloudflare Tunnel connector; Cf-Access-Jwt-Assertion,
 *               verified for that app's own Access application
 *
 * A route kind registers here when its module is set up and switched on. With
 * none registered, nothing can be published: `ncl workloads expose` says so.
 * The gateway asks the route's own kind for the identity of every request:
 * there is no shared header, cookie or fallback sign-in that one kind could
 * be tricked into accepting for another.
 */
import type { IncomingHttpHeaders } from 'http';

import type { AppRoute } from '../routes.js';

export const ROUTE_KINDS = ['tailnet', 'cloudflare'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

export const isRouteKind = (v: unknown): v is RouteKind => ROUTE_KINDS.includes(v as RouteKind);

/** A forwarded request as the gateway's check sees it. */
export interface GatewayRequest {
  /** The headers the browser's request reached Caddy with (after Caddy removed X-NanoClaw-*). */
  headers: IncomingHttpHeaders;
  /** The address that connected to Caddy: the edge (sidecar, connector), never a header. */
  peer: string;
}

/** A published app as a route kind needs to know it. */
export interface PublishedApp {
  id: string;
  /** The app's name, one DNS label. */
  app: string;
  hostname: string;
  agentGroupId: string;
}

/** Who a request is, as the route's edge proved it. */
export interface GatewayIdentity {
  /** A NanoClaw user id (`webchat:…`), the same one that person has in NanoClaw. */
  userId: string;
  displayName: string;
}

export interface PublishingRoute {
  kind: RouteKind;
  /** How a card names it: "your tailnet", "Cloudflare". */
  label: string;
  /** On, set up and usable right now. */
  enabled(): Promise<boolean>;
  /** The address an app is opened at, or null when this route cannot name one yet. */
  hostnameFor(app: string): Promise<string | null>;
  /** The person behind a request, or null when the edge did not prove one. */
  identify(req: GatewayRequest, app: PublishedApp): Promise<GatewayIdentity | null>;
  /** Bring up the route's edge for a newly published (or changed) app; problems surface in edgeState. */
  attach?(route: AppRoute): Promise<void>;
  /** Take the app's edge down: it was unpublished, deleted or moved to another route. */
  detach?(route: AppRoute): Promise<void>;
  /** Whether the app's edge is up, or what is wrong with it. */
  edgeState?(route: AppRoute): Promise<{ ready: boolean; problem?: string }>;
}

const routes = new Map<RouteKind, PublishingRoute>();

export function registerPublishingRoute(r: PublishingRoute): void {
  routes.set(r.kind, r);
}

export const publishingRoute = (kind: string): PublishingRoute | undefined =>
  isRouteKind(kind) ? routes.get(kind) : undefined;

/** The route kinds that are on now. */
export async function enabledRoutes(): Promise<PublishingRoute[]> {
  const out: PublishingRoute[] = [];
  for (const r of routes.values()) if (await r.enabled().catch(() => false)) out.push(r);
  return out;
}

export function __clearPublishingRoutesForTest(): void {
  routes.clear();
}
