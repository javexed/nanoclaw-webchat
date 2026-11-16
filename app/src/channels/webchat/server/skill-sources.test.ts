import { describe, it, expect } from 'vitest';

import { assertGithubUrl } from './skill-sources.js';

describe('assertGithubUrl', () => {
  it.each([
    'https://api.github.com/repos/o/r/contents/skills?ref=main',
    'https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md',
  ])('allows %s', (u) => expect(() => assertGithubUrl(u)).not.toThrow());

  it.each([
    'http://api.github.com/repos/o/r',
    'https://169.254.169.254/latest/meta-data',
    'https://api.github.com.evil.example/repos/o/r',
    'https://raw.githubusercontent.com:8443/o/r/main/x',
    'https://user@api.github.com/repos/o/r',
    'https://github.com/o/r',
    'not a url',
  ])('refuses %s', (u) => expect(() => assertGithubUrl(u)).toThrow('Not a GitHub URL'));
});
