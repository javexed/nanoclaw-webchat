import fs from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeContainerWritable,
  registerContainerConfigAugmentor,
  resolveContainerConfigAugmentation,
} from './container-runtime.js';

// This file was a PATCH against upstream's own container-runtime.test.ts until
// upstream gutted container-runtime.ts (the runtime logic moved behind the
// driver seam) and deleted the test with it. The seam surfaces it covers are
// still here and still ours, so it becomes a payload file rather than a patch
// against something that no longer exists.

describe('container config augmentors', () => {
  it('returns {} when no augmentor is registered (core default)', async () => {
    // Note: other suites may register augmentors; assert our key specifically.
    expect(resolveContainerConfigAugmentation('g-none').lenientOutput).toBeUndefined();
  });

  it('merges a registered augmentor keyed by agent group', async () => {
    registerContainerConfigAugmentor((id) => (id === 'g-ollama' ? { lenientOutput: true } : {}));
    expect(resolveContainerConfigAugmentation('g-ollama')).toMatchObject({ lenientOutput: true });
    expect(resolveContainerConfigAugmentation('g-other').lenientOutput).toBeUndefined();
  });

  it('isolates a throwing augmentor — never breaks spawning', async () => {
    registerContainerConfigAugmentor(() => {
      throw new Error('augmentor bug');
    });
    registerContainerConfigAugmentor((id) => (id === 'g-ok' ? { lenientOutput: true } : {}));
    // The throwing augmentor is swallowed; the healthy one still contributes.
    expect(resolveContainerConfigAugmentation('g-ok')).toMatchObject({ lenientOutput: true });
  });
});

describe('makeContainerWritable', () => {
  beforeEach(() => vi.restoreAllMocks());

  // Dirent-like stub — the walk keys off isDirectory()/isSymbolicLink().
  const dirent = (name: string, kind: 'dir' | 'file' | 'link') =>
    ({ name, isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' }) as fs.Dirent;

  it('no-ops when the host is not root (UIDs already match the container)', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const chown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
    makeContainerWritable('/opt/nanoclaw/groups/x', true);
    expect(chown).not.toHaveBeenCalled();
  });

  it('chowns just the top dir to UID 1000 when root and not recursive', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const chown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(() => [] as never);
    makeContainerWritable('/g');
    expect(chown).toHaveBeenCalledTimes(1);
    expect(chown).toHaveBeenCalledWith('/g', 1000, 1000);
    expect(readdir).not.toHaveBeenCalled(); // non-recursive: no descent
  });

  it('recursively lchowns the whole tree when root + recursive (covers outbound.db)', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const chown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ isDirectory: () => true } as fs.Stats); // top target
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === '/s') return [dirent('outbound.db', 'file'), dirent('outbox', 'dir')] as never;
      if (String(p) === '/s/outbox') return [dirent('file.png', 'file')] as never;
      return [] as never; // files → no children
    }) as typeof fs.readdirSync);
    makeContainerWritable('/s', true);
    const targets = chown.mock.calls.map((c) => c[0]);
    expect(targets).toEqual(expect.arrayContaining(['/s', '/s/outbound.db', '/s/outbox', '/s/outbox/file.png']));
    expect(chown).toHaveBeenCalledWith('/s/outbound.db', 1000, 1000);
  });

  it('SECURITY: lchowns a planted symlink but never follows or recurses through it', async () => {
    // The agent controls .claude-shared/session contents and could `ln -s / evil`.
    // The walk must lchown the link itself (harmless) and NEVER descend into its
    // target — otherwise a root host would chown the whole filesystem.
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const chown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ isDirectory: () => true } as fs.Stats); // top target is a real dir
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === '/s') return [dirent('evil', 'link')] as never; // `ln -s / evil`
      return [dirent('etc', 'dir'), dirent('root', 'dir')] as never; // would appear IF the link were followed
    }) as typeof fs.readdirSync);
    makeContainerWritable('/s', true);
    const targets = chown.mock.calls.map((c) => c[0]);
    expect(targets).toEqual(['/s', '/s/evil']); // link chowned, target NOT
    expect(readdir).not.toHaveBeenCalledWith('/s/evil', expect.anything()); // never traversed
    expect(targets).not.toContain('/s/evil/etc'); // nothing under the link target touched
  });
});
