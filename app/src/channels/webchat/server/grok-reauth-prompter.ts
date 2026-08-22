/**
 * Supplies the device code that a Grok re-auth notice carries.
 *
 * `src/providers/grok-reauth.ts` (the Grok payload) decides that a credential
 * is permanently dead and DMs an admin about it. On its own that message can
 * only say "go and reconnect". This file upgrades it to a URL and a code, so
 * the reconnect happens on the phone that received the DM instead of costing
 * a trip to a desktop.
 *
 * WHY A DYNAMIC IMPORT. The payload only exists once `/add-grok` has run.
 * A static import would make this overlay fail to build on every install that
 * has no Grok — which is most of them. Same reason `grok-status.ts` duplicates
 * the credentials path rather than importing it: the overlay may not depend on
 * a provider being installed. The specifier is held in a `string`-typed
 * variable so TypeScript does not try to resolve a module that is legitimately
 * absent from this tree.
 *
 * WHY IT LIVES HERE AND NOT IN THE PAYLOAD. The device flow spawns a
 * container and already lives in this overlay. Duplicating it into the payload
 * would mean two implementations of a docker-spawning scraper, and the payload
 * must not depend on webchat. The registry inverts that: the payload declares
 * the hole, whoever can fill it does.
 */

import { getGrokLoginProgress, startGrokLogin } from './grok-auth-flow.js';
import { log } from '../../../log.js';

/** Mirrors `ReauthPrompt` in the payload. Duplicated for the reason above. */
interface ReauthPrompt {
  verificationUrl: string;
  userCode: string;
  expiresInMs?: number;
}

type PrompterRegistrar = (fn: (() => Promise<ReauthPrompt | null>) | null) => void;

/**
 * How long to wait for the CLI to print a device code.
 *
 * The code comes from scraping a spawned container's output, so the wait
 * covers an image pull on a cold host as well as the CLI's own startup. It is
 * bounded because the caller is a credential sweep, not a request: if no code
 * appears the notice still goes out, just without one.
 */
const CODE_WAIT_MS = 30_000;
const POLL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function devicePrompt(): Promise<ReauthPrompt | null> {
  const start = startGrokLogin();
  // 'already-running' is not a failure: the wizard may have started a login
  // in another tab, and minting a second device code would invalidate the
  // first. Fall through and report on whichever one is live.
  if (!start.started && start.error !== 'already-running') return null;

  const deadline = Date.now() + CODE_WAIT_MS;
  while (Date.now() < deadline) {
    const p = getGrokLoginProgress();
    if (p.verificationUrl && p.userCode) {
      return {
        verificationUrl: p.verificationUrl,
        userCode: p.userCode,
        expiresInMs: p.expiresInMs ?? undefined,
      };
    }
    // Finished without ever producing a code — a spawn failure, or a login
    // that completed on its own. Either way there is nothing to tell anyone.
    if (!p.running && p.outcome !== null) return null;
    await sleep(POLL_MS);
  }
  return null;
}

/**
 * Register the prompter, if the Grok payload is installed.
 *
 * Returns whether it registered, for the caller's log line. Never throws: an
 * install without Grok is the normal case, not an error.
 */
export async function registerGrokReauthPrompter(): Promise<boolean> {
  // `string`-typed, not a literal — see the header.
  const specifier: string = '../../../providers/grok-reauth.js';
  let mod: { registerGrokReauthPrompter?: PrompterRegistrar };
  try {
    mod = (await import(specifier)) as { registerGrokReauthPrompter?: PrompterRegistrar };
  } catch {
    return false; // Grok not installed — nothing to attach to.
  }
  if (typeof mod.registerGrokReauthPrompter !== 'function') {
    // Installed, but an older payload with no registry. The notice still goes
    // out from the payload side; it just cannot carry a code.
    log.debug('Grok payload has no re-auth prompter registry — notices will omit the device code');
    return false;
  }
  mod.registerGrokReauthPrompter(devicePrompt);
  return true;
}

/** Test seam. */
export const __devicePromptForTest = devicePrompt;
