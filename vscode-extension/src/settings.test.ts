import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { userSetting, type SettingsSource } from './settings.js';

const source = (values: Record<string, Record<string, unknown>>): SettingsSource => ({
  inspect: <T>(key: string) => values[key] as { globalValue?: T } | undefined,
});

describe('userSetting', () => {
  it('takes the user value and never a workspace or folder one', () => {
    const c = source({
      serverUrl: { globalValue: 'https://central.example', workspaceValue: 'https://evil.example' },
      runtimePath: { workspaceValue: '/tmp/evil', workspaceFolderValue: '/tmp/evil2' },
      slots: { workspaceValue: { '/workspace/project': '/home/dev' } },
    });
    expect(userSetting(c, 'serverUrl', '')).toBe('https://central.example');
    expect(userSetting(c, 'runtimePath', '')).toBe('');
    expect(userSetting<Record<string, string>>(c, 'slots', {})).toEqual({});
    expect(userSetting(c, 'unknown', 'prompt')).toBe('prompt');
  });

  it("falls back when the user value does not have the setting's shape", () => {
    const c = source({
      mountAllowlist: { globalValue: '/home' },
      slots: { globalValue: ['/home'] },
      allowUnlabeledAgentImage: { globalValue: 'yes' },
      workspaceExcludes: { globalValue: ['.env'] },
    });
    expect(userSetting<string[]>(c, 'mountAllowlist', [])).toEqual([]);
    expect(userSetting<Record<string, string>>(c, 'slots', {})).toEqual({});
    expect(userSetting(c, 'allowUnlabeledAgentImage', false)).toBe(false);
    expect(userSetting<string[]>(c, 'workspaceExcludes', ['x'])).toEqual(['.env']);
  });
});

describe('package.json', () => {
  it('marks every setting but autoConnect machine-scoped, so a workspace cannot set it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    };
    const props = pkg.contributes.configuration.properties;
    const unscoped = Object.keys(props).filter((k) => props[k].scope !== 'machine');
    expect(unscoped).toEqual(['nanoclaw.autoConnect']);
  });
});
