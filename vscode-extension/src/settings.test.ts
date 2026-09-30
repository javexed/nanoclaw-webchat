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
      releaseSigningKey: { workspaceValue: 'ed25519:evil', workspaceFolderValue: 'ed25519:evil2' },
      slots: { workspaceValue: { '/workspace/project': '/home/dev' } },
    });
    expect(userSetting(c, 'serverUrl', '')).toBe('https://central.example');
    expect(userSetting(c, 'releaseSigningKey', '')).toBe('');
    expect(userSetting<Record<string, string>>(c, 'slots', {})).toEqual({});
    expect(userSetting(c, 'unknown', 'prompt')).toBe('prompt');
  });

  it("falls back when the user value does not have the setting's shape", () => {
    const c = source({
      mountAllowlist: { globalValue: '/home' },
      slots: { globalValue: ['/home'] },
      proposeIncludeIgnored: { globalValue: 'yes' },
      workspaceExcludes: { globalValue: ['.env'] },
    });
    expect(userSetting<string[]>(c, 'mountAllowlist', [])).toEqual([]);
    expect(userSetting<Record<string, string>>(c, 'slots', {})).toEqual({});
    expect(userSetting(c, 'proposeIncludeIgnored', false)).toBe(false);
    expect(userSetting<string[]>(c, 'workspaceExcludes', ['x'])).toEqual(['.env']);
  });
});

describe('setting reads', () => {
  it('go through userSetting, so a workspace cannot answer them (autoConnect is the one exception)', () => {
    const src = path.join(__dirname);
    const direct: string[] = [];
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      for (const m of text.matchAll(/(?:getConfiguration\('nanoclaw'\)|\bc|\bcfg)\s*\.get(?:<[^>]+>)?\('([\w.]+)'/g))
        direct.push(`${f}: ${m[1]}`);
    }
    expect(direct).toEqual(['extension.ts: autoConnect']);
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
