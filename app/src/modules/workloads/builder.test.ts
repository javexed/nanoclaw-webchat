import { describe, expect, it } from 'vitest';

import { builderCacheVolume, builderName, changedImages, cleanManifest } from './builder.js';

const blob = (c: string): string => `blobs/sha256/${c.repeat(64)}`;

describe('the image a build hands back', () => {
  it('keeps exactly one image, tagged only with the name NanoClaw chose', () => {
    const text = JSON.stringify([
      {
        Config: blob('a'),
        RepoTags: ['nanoclaw-agent:latest', 'alpine:3.22'],
        Layers: [blob('b'), blob('c'), blob('b')],
      },
    ]);
    const { manifest, members } = cleanManifest(text, 'nc-x-notes-api:built');
    expect(JSON.parse(manifest)).toEqual([
      { Config: blob('a'), RepoTags: ['nc-x-notes-api:built'], Layers: [blob('b'), blob('c'), blob('b')] },
    ]);
    expect(members).toEqual([blob('a'), blob('b'), blob('c')]);
  });

  it.each([
    [
      'two images',
      JSON.stringify([
        { Config: blob('a'), Layers: [] },
        { Config: blob('b'), Layers: [] },
      ]),
    ],
    ['no image', '[]'],
    ['a path outside the blobs', JSON.stringify([{ Config: '../../etc/passwd', Layers: [] }])],
    ['a layer elsewhere', JSON.stringify([{ Config: blob('a'), Layers: ['/abs/layer.tar'] }])],
    ['a layer that is not a string', JSON.stringify([{ Config: blob('a'), Layers: [{}] }])],
    ['not JSON', '{'],
  ])('refuses %s', (_what, text) => {
    expect(() => cleanManifest(text, 'x:built')).toThrow();
  });

  it('notices any protected image whose id changed or that disappeared', () => {
    const before = new Map([
      ['nanoclaw-agent-v2-x:latest', 'sha256:1'],
      ['alpine:3.22@sha256:aa', 'sha256:2'],
    ]);
    expect(changedImages(before, new Map(before))).toEqual([]);
    expect(changedImages(before, new Map([['nanoclaw-agent-v2-x:latest', 'sha256:9']]))).toEqual([
      'nanoclaw-agent-v2-x:latest',
      'alpine:3.22@sha256:aa',
    ]);
  });

  it('names builders from a hash of the whole agent id', () => {
    expect(builderName('ag-1111-abcdefgh')).not.toBe(builderName('ag-2222-abcdefgh'));
    expect(builderName('ag-1')).toMatch(/^ncb-[a-z0-9]+-[a-f0-9]{12}$/);
    expect(builderCacheVolume('ag-1')).toBe(`${builderName('ag-1')}-cache`);
  });
});
