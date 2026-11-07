/**
 * Where an agent's SSH key targets come from (modules/deploy-keys). The agent
 * holding a key reaches that host:port in Allowlist mode, directly: SSH is not
 * TLS, so it cannot go through the credential gateway. `allowPrivate` is set
 * for a target an install admin named, the same line the install allowlist
 * draws for direct tunnels; a scoped admin's target must resolve publicly.
 *
 * A leaf module (no imports), so the deploy-key module can register without
 * pulling the egress filter into an import cycle.
 */
export interface KeyTarget {
  host: string;
  port: number;
  allowPrivate: boolean;
}

const keyTargetResolvers: Array<(agentGroupId: string) => Promise<KeyTarget[]>> = [];

export function registerKeyTargets(fn: (agentGroupId: string) => Promise<KeyTarget[]>): void {
  keyTargetResolvers.push(fn);
}

/** The agent's target for host:port. When several keys name it, one an install admin set wins. */
export async function keyTargetFor(agentGroupId: string, host: string, port: number): Promise<KeyTarget | null> {
  const h = host.toLowerCase().replace(/\.$/, '');
  let found: KeyTarget | null = null;
  for (const fn of keyTargetResolvers)
    for (const t of await fn(agentGroupId).catch(() => []))
      if (t.port === port && t.host.toLowerCase().replace(/\.$/, '') === h) {
        if (t.allowPrivate) return t;
        found ??= t;
      }
  return found;
}
