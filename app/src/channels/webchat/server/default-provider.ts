/**
 * The install-wide default agent provider, as chosen in the setup wizard.
 *
 * `DEFAULT_AGENT_PROVIDER` (.env) decides what a NEW agent group runs when
 * nothing pins it.
 *
 * NEW GROUPS ONLY: container configs are stamped at creation with INSERT OR
 * IGNORE, so an existing group's row is never rewritten (db/container-configs.ts).
 *
 * A RESTART IS REQUIRED: config.ts reads the value into a module-level const at
 * import, and its consumers (group-init, container-configs) import that const
 * rather than reading process.env.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Providers a wizard engine can map to. `ollama` is a MODEL default, not a provider. */
export const DEFAULT_PROVIDER_KEY = 'DEFAULT_AGENT_PROVIDER';

export function readDefaultProvider(root = process.cwd()): string {
  const envFile = path.join(root, '.env');
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    const m = raw.match(new RegExp(`^${DEFAULT_PROVIDER_KEY}=(.*)$`, 'm'));
    return (m?.[1] ?? '').trim().toLowerCase() || 'claude';
  } catch {
    return 'claude'; // no .env yet — the built-in default
  }
}

/**
 * Would writing this value change anything?
 *
 * Kept separate so the caller can decide whether a restart is warranted: a
 * wizard finished on the engine that is already the default should not bounce
 * the host for a no-op.
 */
export function defaultProviderChanges(next: string, root = process.cwd()): boolean {
  return readDefaultProvider(root) !== next.toLowerCase();
}
