/**
 * The install-wide default agent provider, as chosen in the setup wizard.
 *
 * `DEFAULT_AGENT_PROVIDER` decides what a NEW agent group runs when nothing
 * pins it. It lived only in .env, so an operator who picked and authenticated an
 * engine in the wizard still got Claude agents afterwards — the choice governed
 * that one create step and nothing else.
 *
 * NEW GROUPS ONLY, and that is not this module's promise to keep: container
 * configs are stamped at creation with INSERT OR IGNORE, so an existing group's
 * row is never rewritten (see db/container-configs.ts, which calls that property
 * load-bearing). Changing the default cannot retroactively flip a running agent.
 *
 * A RESTART IS REQUIRED and is not avoidable from here. config.ts reads the
 * value into a module-level const at import, and both consumers
 * (group-init, container-configs) import that const rather than reading
 * process.env, so mutating the environment after boot changes nothing. The TTS
 * and STT installers get away with an in-process "activate" because their
 * consumers read process.env directly; this one cannot, so it restarts the way
 * the Codex and OpenCode installs already do.
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
