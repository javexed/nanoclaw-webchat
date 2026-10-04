/**
 * Staged spawn env: a spawn prepared while another one in the same group is
 * still computing its env reads the previous env, never an empty one.
 */
import { describe, expect, it } from 'vitest';

import { stagedEnv } from './staged-env.js';

describe('stagedEnv', () => {
  it('keeps the previous env readable while the next one is computed', async () => {
    let release: (env: Record<string, string>) => void = () => {};
    let calls = 0;
    const stage = stagedEnv(async () => {
      calls++;
      if (calls === 1) return { OPENCODE_CTX: '8192' };
      return new Promise((r) => (release = r));
    });
    await stage.prepare('ag');
    const second = stage.prepare('ag');
    // A concurrent spawn resolving now must not see {}.
    expect(stage.resolve('ag')).toEqual({ OPENCODE_CTX: '8192' });
    release({ OPENCODE_CTX: '16384' });
    await second;
    expect(stage.resolve('ag')).toEqual({ OPENCODE_CTX: '16384' });
  });

  it('a failed compute leaves no stale env behind', async () => {
    let fail = false;
    const stage = stagedEnv(async () => {
      if (fail) throw new Error('boom');
      return { A: '1' };
    });
    await stage.prepare('ag');
    fail = true;
    await expect(stage.prepare('ag')).rejects.toThrow('boom');
    expect(stage.resolve('ag')).toEqual({});
  });

  it('groups are independent', async () => {
    const stage = stagedEnv(async (id) => ({ ID: id }));
    await stage.prepare('a');
    expect(stage.resolve('a')).toEqual({ ID: 'a' });
    expect(stage.resolve('b')).toEqual({});
  });
});
