/**
 * The OneCLI gateway's settings, for overlay code that talks to it from the
 * host. Core does not export them (gateways are skill-installed), so read them
 * the way the OneCLI provider does — process env, then `.env` — and say which
 * gateway is selected, so a caller can stand down under a different one.
 */
import { readEnvFile } from './env.js';

export interface OnecliSettings {
  /** The selected gateway (NANOCLAW_GATEWAY_PROVIDER), lower-cased; 'onecli' when unset. */
  gateway: string;
  url: string;
  apiKey: string;
}

export function onecliSettings(): OnecliSettings {
  const env = readEnvFile(['NANOCLAW_GATEWAY_PROVIDER', 'ONECLI_URL', 'ONECLI_API_KEY']);
  return {
    gateway: (process.env.NANOCLAW_GATEWAY_PROVIDER || env.NANOCLAW_GATEWAY_PROVIDER || 'onecli').trim().toLowerCase(),
    url: process.env.ONECLI_URL || env.ONECLI_URL || '',
    apiKey: process.env.ONECLI_API_KEY || env.ONECLI_API_KEY || '',
  };
}
