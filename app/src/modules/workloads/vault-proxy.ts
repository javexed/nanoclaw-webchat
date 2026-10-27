/**
 * The host's own calls to a credentialed API (Tailscale, Cloudflare) go out
 * through the OneCLI gateway as a OneCLI identity of their own, so the vault
 * adds the credential on the wire and NanoClaw never holds it. One undici
 * dispatcher per identity, renewed every five minutes.
 */
import fs from 'fs';
import { ProxyAgent } from 'undici';

import { onecliSettings } from '../../onecli-settings.js';

interface OneCLIClient {
  ensureAgent(input: { name: string; identifier: string }): Promise<unknown>;
  getContainerConfig(input: {
    agent: string;
  }): Promise<{ env: Record<string, string | undefined>; caCertificate?: string }>;
}
const ONECLI_SDK = '@onecli-sh/sdk';
const dispatchers = new Map<string, { d: ProxyAgent; until: number }>();

/** A dispatcher whose requests leave through OneCLI as `identity`. `what` names the caller in errors. */
export async function vaultDispatcher(identity: string, name: string, what: string): Promise<ProxyAgent> {
  const cached = dispatchers.get(identity);
  if (cached && cached.until > Date.now()) return cached.d;
  const { gateway, url, apiKey } = onecliSettings();
  if (gateway !== 'onecli') throw new Error(`${what} needs the OneCLI gateway; this install uses ${gateway}`);
  // Loaded by name: the SDK arrives with the OneCLI gateway skill (as drafter.ts does).
  const { OneCLI } = (await import(ONECLI_SDK)) as {
    OneCLI: new (o: { url: string; apiKey: string }) => OneCLIClient;
  };
  const client = new OneCLI({ url, apiKey });
  await client.ensureAgent({ name, identifier: identity });
  const cfg = await client.getContainerConfig({ agent: identity });
  const raw = cfg.env.HTTPS_PROXY ?? cfg.env.HTTP_PROXY;
  if (!raw) throw new Error(`OneCLI gave no proxy for ${what}`);
  // The proxy URL is container-side; the host reaches OneCLI at ONECLI_URL's host.
  let host = '127.0.0.1';
  try {
    host = new URL(url).hostname || host;
  } catch {
    // keep loopback; the request that follows reports the real failure
  }
  const ca = cfg.caCertificate
    ? Buffer.from(cfg.caCertificate)
    : cfg.env.NODE_EXTRA_CA_CERTS && fs.existsSync(cfg.env.NODE_EXTRA_CA_CERTS)
      ? fs.readFileSync(cfg.env.NODE_EXTRA_CA_CERTS)
      : null;
  if (!ca) throw new Error('OneCLI gave no CA certificate');
  const d = new ProxyAgent({ uri: raw.replaceAll('host.docker.internal', host), requestTls: { ca } });
  const old = cached?.d;
  dispatchers.set(identity, { d, until: Date.now() + 5 * 60_000 });
  void old?.close().catch(() => undefined);
  return d;
}
