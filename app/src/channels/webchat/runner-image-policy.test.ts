import { describe, expect, it } from 'vitest';

import { decodeRunnerImagePolicy } from './db.js';

describe('runner image policy', () => {
  it('unset means every runner builds the image itself; machine and pull only when chosen', () => {
    expect(decodeRunnerImagePolicy(null)).toBe('build');
    expect(decodeRunnerImagePolicy(undefined)).toBe('build');
    expect(decodeRunnerImagePolicy('nonsense')).toBe('build');
    expect(decodeRunnerImagePolicy('build')).toBe('build');
    expect(decodeRunnerImagePolicy('machine')).toBe('machine');
    expect(decodeRunnerImagePolicy('pull')).toBe('pull');
  });
});
