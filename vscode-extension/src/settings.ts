// Settings that decide where the sign-in token goes, which binary runs and what
// is mounted are read from the user's own settings only. A workspace folder is
// mounted into the agent's container, so its `.vscode/settings.json` may be
// the agent's writing; package.json marks these `machine` scope, and this
// reads past any workspace or folder value that still shows up.

export interface SettingsSource {
  inspect<T>(key: string): { globalValue?: T } | undefined;
}

/** The user-level value of `key` when it has the fallback's shape, else the fallback. */
export function userSetting<T>(c: SettingsSource, key: string, fallback: T): T {
  const v = c.inspect<T>(key)?.globalValue;
  if (v === undefined || v === null) return fallback;
  if (typeof v !== typeof fallback || Array.isArray(v) !== Array.isArray(fallback)) return fallback;
  return v;
}
