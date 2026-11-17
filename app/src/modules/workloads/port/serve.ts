/**
 * What this machine's Tailscale serves, read with the `tailscale` CLI. Reading
 * needs no rights; changing it does (root or Tailscale's operator), which is
 * why NanoClaw only reads it: the owner runs deploy/workloads-tailnet-ports.sh
 * once, and each port it set up is handed to at most one app.
 *
 * A port is usable when it serves HTTPS on this machine's name, forwards all
 * of it (`/`) to the gateway's listener for that port on 127.0.0.1, and is
 * not on Funnel. Anything else on a port in the range is left alone and
 * reported.
 */
import type { TailscaleRunner } from '../../../channels/webchat/tailscale-serve.js';

export interface ServeView {
  /** This machine's tailnet name (node.tail1234.ts.net), or null when Tailscale is not up. */
  dns: string | null;
  usable: number[];
  /** Ports in the range that serve something else, or are on Funnel: why each cannot be used. */
  problems: Array<{ port: number; problem: string }>;
  /** Ports in the range that serve nothing yet. */
  missing: number[];
}

type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

/** Pure: the two JSON answers, read for these ports. */
export function readServe(statusJson: string, serveJson: string, ports: number[]): ServeView {
  let dns: string | null = null;
  try {
    const s = JSON.parse(statusJson) as { BackendState?: string; Self?: { DNSName?: string } };
    const name = (s.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    if (s.BackendState === 'Running' && name) dns = name;
  } catch {
    dns = null;
  }
  if (!dns) return { dns: null, usable: [], problems: [], missing: [...ports] };
  let cfg: ServeConfig = {};
  try {
    cfg = (JSON.parse(serveJson || '{}') as ServeConfig) ?? {};
  } catch {
    cfg = {};
  }
  const out: ServeView = { dns, usable: [], problems: [], missing: [] };
  for (const p of ports) {
    const key = `${dns}:${p}`;
    const web = cfg.Web?.[key];
    const tcp = cfg.TCP?.[String(p)];
    if (!web && !tcp) {
      out.missing.push(p);
      continue;
    }
    if (cfg.AllowFunnel?.[key]) {
      out.problems.push({ port: p, problem: `port ${p} is on Funnel (open to the internet)` });
      continue;
    }
    const handlers = Object.entries(web?.Handlers ?? {});
    const want = `http://127.0.0.1:${p}`;
    const exact =
      tcp?.HTTPS === true &&
      handlers.length === 1 &&
      handlers[0][0] === '/' &&
      (handlers[0][1].Proxy ?? '').replace(/\/$/, '') === want;
    if (exact) out.usable.push(p);
    else out.problems.push({ port: p, problem: `port ${p} serves something else` });
  }
  return out;
}

export async function serveView(run: TailscaleRunner, ports: number[]): Promise<ServeView> {
  const status = await run(['status', '--json']);
  if (!status.ok) return { dns: null, usable: [], problems: [], missing: [...ports] };
  const serve = await run(['serve', 'status', '--json']);
  return readServe(status.stdout, serve.ok ? serve.stdout : '{}', ports);
}
