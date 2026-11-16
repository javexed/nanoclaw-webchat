import { afterEach, describe, it, expect, vi } from 'vitest';

import { assertGithubUrl, githubFetch } from './skill-sources.js';

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

describe('githubFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['https://api.github.com/repos/o/r/contents/s?ref=main', 'https://api.github.com/repos/o/r/contents/s?ref=main'],
    [
      'https://raw.githubusercontent.com/o/r/main/s/SKILL.md#x',
      'https://raw.githubusercontent.com/o/r/main/s/SKILL.md',
    ],
  ])('requests %s on its GitHub origin', async (input, expected) => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await githubFetch(input, {});
    expect(fetchMock).toHaveBeenCalledWith(expected, expect.anything());
  });

  it('never calls fetch for another host', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(githubFetch('https://169.254.169.254/latest', {})).rejects.toThrow('Not a GitHub URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
