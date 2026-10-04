import { describe, expect, it } from 'vitest';

import { COPY_KEYS, copySettings, migrateCopySettings, migratedCopySettings } from './copy-settings.js';

/** User settings as VS Code's inspect sees them, with an update that writes back. */
function userSettings(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    inspect: <T>(key: string) => (values.has(key) ? { globalValue: values.get(key) as T } : undefined),
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

describe('the agent copy settings', () => {
  it('read the new names', () => {
    const c = userSettings({
      [COPY_KEYS.includeIgnored]: ['site-theme', ' '],
      [COPY_KEYS.exclude]: ['.env'],
      [COPY_KEYS.allowSecretsIn]: ['settings.py'],
    });
    expect(copySettings(c)).toEqual({
      includeIgnored: ['site-theme'],
      exclude: ['.env'],
      allowSecretsIn: ['settings.py'],
    });
    expect(copySettings(userSettings({}))).toEqual({ includeIgnored: [], exclude: undefined, allowSecretsIn: [] });
  });

  it('fall back to the old names until they move, the checkbox as `*`', () => {
    const c = userSettings({
      proposeIncludePaths: ['site-theme'],
      proposeIncludeIgnored: true,
      workspaceExcludes: ['.env', 'backups'],
      proposeSecretScanAllow: ['a.py'],
    });
    expect(copySettings(c)).toEqual({
      includeIgnored: ['site-theme', '*'],
      exclude: ['.env', 'backups'],
      allowSecretsIn: ['a.py'],
    });
    expect(copySettings(userSettings({ proposeIncludeIgnored: false })).includeIgnored).toEqual([]);
  });

  it('a new name already set wins over the old one', () => {
    const c = userSettings({ [COPY_KEYS.includeIgnored]: ['theme'], proposeIncludeIgnored: true });
    expect(copySettings(c).includeIgnored).toEqual(['theme']);
    expect(migratedCopySettings(c)).toEqual([]);
  });

  it('move to the new names and clear the old, once', async () => {
    const c = userSettings({
      proposeIncludePaths: ['site-theme'],
      proposeIncludeIgnored: false,
      workspaceExcludes: ['.env'],
      autoConnect: true,
    });
    expect(await migrateCopySettings(c)).toHaveLength(2);
    expect(Object.fromEntries(c.values)).toEqual({
      [COPY_KEYS.includeIgnored]: ['site-theme'],
      [COPY_KEYS.exclude]: ['.env'],
      autoConnect: true,
    });
    expect(await migrateCopySettings(c)).toEqual([]);
  });
});
