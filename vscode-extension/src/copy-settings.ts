// The settings that shape the agent's copy of the project, under one name
// (`nanoclaw.agentCopy.*`), so the Settings editor shows them together. They
// replace four older names that read as unrelated and overlapped:
// `proposeIncludeIgnored` (all gitignored files) made `proposeIncludePaths`
// (some of them) do nothing, with nothing saying so. One list now covers both:
// `*` in it copies every gitignored file.
//
// A value set under an old name is moved to the new one at start-up
// (migrateCopySettings), and read from the old name until then. User settings
// only, as everywhere the agent's view is decided (settings.ts).

import type { SettingsSource } from './settings.js';

export const COPY_KEYS = {
  includeIgnored: 'agentCopy.includeIgnored',
  exclude: 'agentCopy.exclude',
  allowSecretsIn: 'agentCopy.allowSecretsIn',
} as const;

/** In `agentCopy.includeIgnored`: every gitignored file. */
export const ALL_IGNORED = '*';

const OLD = {
  includePaths: 'proposeIncludePaths',
  includeAll: 'proposeIncludeIgnored',
  exclude: 'workspaceExcludes',
  allowSecretsIn: 'proposeSecretScanAllow',
} as const;

const userValue = (c: SettingsSource, key: string): unknown => c.inspect<unknown>(key)?.globalValue;
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : undefined;

/** What the old names hold, as the new settings would: only for a new setting not yet set. */
export function migratedCopySettings(c: SettingsSource): Array<{ key: string; value: string[]; from: string[] }> {
  const out: Array<{ key: string; value: string[]; from: string[] }> = [];
  if (userValue(c, COPY_KEYS.includeIgnored) === undefined) {
    const paths = strings(userValue(c, OLD.includePaths)) ?? [];
    const all = userValue(c, OLD.includeAll) === true;
    const from = [OLD.includePaths, OLD.includeAll].filter((k) => userValue(c, k) !== undefined);
    // Ticked, every ignored file was copied: kept so (`*`), the listed paths beside it.
    if (from.length) out.push({ key: COPY_KEYS.includeIgnored, value: all ? [...paths, ALL_IGNORED] : paths, from });
  }
  for (const [key, old] of [
    [COPY_KEYS.exclude, OLD.exclude],
    [COPY_KEYS.allowSecretsIn, OLD.allowSecretsIn],
  ] as const) {
    const v = strings(userValue(c, old));
    if (userValue(c, key) === undefined && v) out.push({ key, value: v, from: [old] });
  }
  return out;
}

export interface CopySettings {
  /** Gitignored paths to copy anyway; `*` for all. */
  includeIgnored: string[];
  /** Left out of the copy; undefined: the built-in list. */
  exclude: string[] | undefined;
  /** Copied even when the secret scan finds a secret in them. */
  allowSecretsIn: string[];
}

/** The copy settings: each new name's value, else what its old name still holds. */
export function copySettings(c: SettingsSource): CopySettings {
  const migrated = new Map(migratedCopySettings(c).map((m) => [m.key, m.value]));
  const read = (key: string): string[] | undefined => strings(userValue(c, key)) ?? migrated.get(key);
  return {
    includeIgnored: read(COPY_KEYS.includeIgnored) ?? [],
    exclude: read(COPY_KEYS.exclude),
    allowSecretsIn: read(COPY_KEYS.allowSecretsIn) ?? [],
  };
}

/**
 * Move values set under the old names to the new ones, and clear the old: the
 * Settings editor then shows one set of copy settings. Returns what moved.
 */
export async function migrateCopySettings(
  c: SettingsSource & { update(key: string, value: unknown, global: true): Thenable<void> },
): Promise<string[]> {
  const moved: string[] = [];
  for (const m of migratedCopySettings(c)) {
    await c.update(m.key, m.value, true);
    for (const old of m.from) await c.update(old, undefined, true);
    moved.push(`${m.from.join(' + ')} → ${m.key}`);
  }
  return moved;
}
