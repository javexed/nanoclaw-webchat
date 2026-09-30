/**
 * rtk hook wiring — the install promises every agent group's settings.json
 * carries the PreToolUse rtk hook (the binary rides the agent image). The
 * patcher backfills pre-existing groups on init; if that wiring is deleted
 * or drifts, these go red.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureHook, RTK_HOOK } from './group-init.js';

const ensureRtkHook = (f: string, initialized: string[]): void =>
  ensureHook(f, initialized, 'PreToolUse', RTK_HOOK, 'rtk hook');

const tmpFiles: string[] = [];
const tmpSettings = (content: object): string => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-ginit-')), 'settings.json');
  fs.writeFileSync(f, JSON.stringify(content, null, 2));
  tmpFiles.push(path.dirname(f));
  return f;
};

afterEach(async () => {
  for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('ensureRtkHook (backfill for pre-existing groups)', () => {
  it('adds the hook while preserving existing hooks', async () => {
    const f = tmpSettings({
      env: { KEEP: '1' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/workspace/custom.sh' }] }],
      },
    });
    const initialized: string[] = [];
    ensureRtkHook(f, initialized);
    const out = JSON.parse(fs.readFileSync(f, 'utf-8'));
    expect(JSON.stringify(out.hooks.PreToolUse)).toContain('rtk hook claude');
    expect(JSON.stringify(out.hooks.PreToolUse)).toContain('/workspace/custom.sh');
    expect(out.env.KEEP).toBe('1');
    expect(initialized).toContain('settings.json (added rtk hook)');
  });

  it('is idempotent — a second run changes nothing', async () => {
    const f = tmpSettings({ hooks: {} });
    ensureRtkHook(f, []);
    const once = fs.readFileSync(f, 'utf-8');
    const initialized: string[] = [];
    ensureRtkHook(f, initialized);
    expect(fs.readFileSync(f, 'utf-8')).toBe(once);
    expect(initialized).toHaveLength(0);
  });

  it('never throws on malformed JSON', async () => {
    const f = tmpSettings({});
    fs.writeFileSync(f, '{not json');
    expect(() => ensureRtkHook(f, [])).not.toThrow();
  });
});
