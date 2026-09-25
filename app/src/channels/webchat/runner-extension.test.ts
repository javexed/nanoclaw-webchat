import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get DATA_DIR() {
    return tmp;
  },
}));
const { isNewerVersion, publishExtension, publishedExtensionPath, readExtensionManifest, versionFromVsixName } =
  await import('./runner-extension.js');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-ext-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('served runner extension', () => {
  it('publishes a package, hashes it, and serves the manifest; a missing file makes the manifest void', () => {
    expect(readExtensionManifest()).toBeNull();
    const vsix = path.join(tmp, 'nanoclaw-0.7.3.vsix');
    fs.writeFileSync(vsix, 'PK pretend');
    const m = publishExtension(vsix);
    expect(m).toMatchObject({ version: '0.7.3', file: 'nanoclaw-0.7.3.vsix', size: 10 });
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readExtensionManifest()).toEqual(m);
    const served = publishedExtensionPath()!;
    expect(fs.readFileSync(served.filePath, 'utf8')).toBe('PK pretend');
    fs.rmSync(served.filePath);
    expect(readExtensionManifest()).toBeNull();
  });

  it('reads the version from the package name and compares versions numerically', () => {
    expect(versionFromVsixName('/x/nanoclaw-0.7.3.vsix')).toBe('0.7.3');
    expect(versionFromVsixName('other-1.0.0.vsix')).toBeNull();
    expect(isNewerVersion('0.7.3', '0.7.2')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.7.2', '0.7.2')).toBe(false);
    expect(isNewerVersion('0.7.1', '0.7.2')).toBe(false);
    expect(isNewerVersion('garbage', '0.7.2')).toBe(false);
  });
});
