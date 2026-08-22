import { describe, expect, it } from 'bun:test';

import { summarizeToolTarget } from './status-feed.js';

/**
 * pi runs its OWN tools, with lowercase names and its own argument keys, so
 * every case written for the Claude SDK's vocabulary misses them. Before this,
 * a pi agent's feed showed a bare verb — "write" with no hint of what was
 * written — and only after the provider started emitting tool_use at all
 * (previously it emitted nothing, so the feed read as idle mid-turn).
 */
describe('summarizeToolTarget — pi built-ins', () => {
  it('names the file for read/write/edit', () => {
    expect(summarizeToolTarget('write', { path: 'probe.txt', content: 'banana' })).toBe('probe.txt');
    expect(summarizeToolTarget('read', { path: 'notes.md' })).toBe('notes.md');
    expect(summarizeToolTarget('edit', { path: 'app.ts' })).toBe('app.ts');
  });

  it('names the command for bash', () => {
    expect(summarizeToolTarget('bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('still honours the Claude vocabulary it shares the switch with', () => {
    expect(summarizeToolTarget('Bash', { command: 'echo hi' })).toBe('echo hi');
    expect(summarizeToolTarget('Read', { file_path: '/tmp/x' })).toBe('/tmp/x');
  });

  it('falls back to the bare verb for a tool it does not know', () => {
    expect(summarizeToolTarget('somethingElse', { path: 'x' })).toBeNull();
  });
});
