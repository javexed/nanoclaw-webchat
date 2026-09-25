/**
 * The OneCLI gateway's settings, for fork code that talks to it from the host.
 *
 * Credential gateways are skills now (`/add-onecli`, `/add-iron-proxy`), so
 * core no longer exports ONECLI_URL / ONECLI_API_KEY and trunk no longer
 * carries the OneCLI SDK. Read them the way the OneCLI gateway provider does —
 * process env first, then `.env` — and say which gateway is selected, so a
 * caller can stand down on an install that runs a different one.
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
