/**
 * The install promises every Claude group's settings.json declares the
 * tool-result guard. The Claude settings file is reconciled through the
 * provider contract's `claude-settings` transformer at every group init, so
 * that is the path these drive; if the wiring is dropped or the transformer is
 * renamed upstream, these go red.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import '../../provider-contracts/claude.js';
import { getProviderFileTransformer } from '../../provider-contracts/file-transformers.js';
import { CLAUDE_DEFAULT_SETTINGS, prepareClaudeMemorySettings } from '../../migrate-claude-memory-settings.js';
import { TOOL_RESULT_GUARD_COMMAND, withToolResultGuardHook } from './index.js';

const guardEntries = (content: string): unknown[] =>
  (JSON.parse(content).hooks.PostToolUse as unknown[]).filter((e) =>
    JSON.stringify(e).includes(TOOL_RESULT_GUARD_COMMAND),
  );

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('claude-settings reconcile plants the tool-result guard', () => {
  const transformer = (): NonNullable<ReturnType<typeof getProviderFileTransformer>> => {
    const t = getProviderFileTransformer('claude-settings');
    if (!t) throw new Error('claude-settings transformer not registered');
    return t;
  };

  it('adds the PostToolUse hook to upstream default settings', () => {
    const result = transformer().transform(CLAUDE_DEFAULT_SETTINGS, '/x/settings.json');
    expect(result.kind).toBe('replace');
    if (result.kind !== 'replace') return;
    expect(guardEntries(result.content)).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: TOOL_RESULT_GUARD_COMMAND, timeout: 10 }] },
    ]);
    // Upstream's own reconcile still ran: its PreCompact hook is intact.
    expect(result.content).toContain('compact-instructions.ts');
  });

  it('is idempotent — a reconciled file comes back unchanged', () => {
    const once = transformer().transform(CLAUDE_DEFAULT_SETTINGS, '/x/settings.json');
    if (once.kind !== 'replace') throw new Error('expected a replace');
    expect(transformer().transform(once.content, '/x/settings.json').kind).toBe('unchanged');
  });

  it("keeps the operator's own PostToolUse hooks and other settings", () => {
    const mine = { matcher: 'Write', hooks: [{ type: 'command', command: '/workspace/lint.sh' }] };
    const current = JSON.stringify({ env: { KEEP: '1' }, hooks: { PostToolUse: [mine] } });
    const result = transformer().transform(current, '/x/settings.json');
    if (result.kind !== 'replace') throw new Error('expected a replace');
    const out = JSON.parse(result.content);
    expect(out.hooks.PostToolUse[0]).toEqual(mine);
    expect(guardEntries(result.content)).toHaveLength(1);
    expect(out.env.KEEP).toBe('1');
  });

  it('a decoy that names the command but cannot run it does not count as declared', () => {
    const decoys = [
      // Right command, a matcher that matches no tool.
      { matcher: 'NoSuchTool', hooks: [{ type: 'command', command: TOOL_RESULT_GUARD_COMMAND }] },
      // The command as a substring of something else.
      { matcher: '*', hooks: [{ type: 'command', command: `true || ${TOOL_RESULT_GUARD_COMMAND}` }] },
      // Not a hook at all.
      { matcher: '*', note: TOOL_RESULT_GUARD_COMMAND, hooks: [] },
    ];
    for (const decoy of decoys) {
      const next = withToolResultGuardHook(JSON.stringify({ hooks: { PostToolUse: [decoy] } }));
      expect(next).not.toBeNull();
      const entries = JSON.parse(next as string).hooks.PostToolUse as unknown[];
      expect(entries).toContainEqual({
        matcher: '*',
        hooks: [{ type: 'command', command: TOOL_RESULT_GUARD_COMMAND, timeout: 10 }],
      });
    }
  });

  it('leaves malformed settings alone', () => {
    expect(transformer().transform('{not json', '/x/settings.json').kind).toBe('unchanged');
    expect(withToolResultGuardHook('[]')).toBeNull();
  });

  it('reaches an existing group at its next init (legacy path too)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-trg-'));
    tmpDirs.push(dir);
    // First init writes upstream's defaults verbatim; the next one reconciles.
    expect(prepareClaudeMemorySettings(dir)).toBe('created');
    expect(prepareClaudeMemorySettings(dir)).toBe('reconciled');
    const content = fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8');
    expect(guardEntries(content)).toHaveLength(1);
    expect(prepareClaudeMemorySettings(dir)).toBe('unchanged');
  });
});
