import { describe, expect, it } from 'vitest';

import { RTK_HOOK } from '../../group-init.js';
import { claudeSettingsTransformer } from '../../migrate-claude-memory-settings.js';
import { withRtkHook } from './index.js';

const rtkCount = (json: string): number =>
  (JSON.parse(json).hooks?.PreToolUse ?? []).filter((e: unknown) => JSON.stringify(e).includes('rtk hook claude'))
    .length;

describe('rtk hook on Claude groups', () => {
  it('adds the hook to a settings file that lacks it, keeping other hooks', () => {
    const before = JSON.stringify({
      env: { KEEP: '1' },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/workspace/custom.sh' }] }] },
    });
    const after = withRtkHook(before)!;
    const parsed = JSON.parse(after);
    expect(parsed.env).toEqual({ KEEP: '1' });
    expect(parsed.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/workspace/custom.sh' }] },
      RTK_HOOK,
    ]);
  });

  it('is idempotent and leaves malformed files alone', () => {
    const once = withRtkHook('{}')!;
    expect(withRtkHook(once)).toBeNull();
    expect(withRtkHook('{not json')).toBeNull();
    expect(withRtkHook('[]')).toBeNull();
  });

  it('runs through the Claude settings reconcile every spawn uses', () => {
    const r = claudeSettingsTransformer.transform('{"hooks":{}}', '/tmp/settings.json');
    expect(r.kind).toBe('replace');
    if (r.kind === 'replace') expect(rtkCount(r.content)).toBe(1);
    // A file that already has it is left as the reconcile left it.
    const again = claudeSettingsTransformer.transform(
      JSON.stringify({ hooks: { PreToolUse: [RTK_HOOK] } }),
      '/tmp/settings.json',
    );
    if (again.kind === 'replace') expect(rtkCount(again.content)).toBe(1);
  });
});
