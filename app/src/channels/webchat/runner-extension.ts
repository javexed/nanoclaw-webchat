/**
 * Served runner updates.
 *
 * Central keeps the current VS Code runner package and tells every runner the
 * version it should be on (in the welcome frame). The runner downloads it over
 * the same authenticated path it already uses, verifies the hash, and installs
 * it through VS Code's own command - no more passing .vsix files around.
 *
 * Publishing is an operator action on central: `scripts/publish-runner-extension.ts <vsix>`
 * (or the admin API later). The manifest is read per request so a publish
 * takes effect without a restart.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

export interface ExtensionManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
  publishedAt: string;
}

export const extensionDir = (): string => path.join(DATA_DIR, 'runner-extension');
const manifestPath = (): string => path.join(extensionDir(), 'manifest.json');

export function readExtensionManifest(): ExtensionManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as ExtensionManifest;
    if (!m || typeof m.version !== 'string' || typeof m.file !== 'string' || typeof m.sha256 !== 'string') return null;
    if (!fs.existsSync(path.join(extensionDir(), m.file))) return null;
    return m;
  } catch {
    return null;
  }
}

/** Absolute path of the published package, or null. */
export function publishedExtensionPath(): { manifest: ExtensionManifest; filePath: string } | null {
  const manifest = readExtensionManifest();
  if (!manifest) return null;
  return { manifest, filePath: path.join(extensionDir(), manifest.file) };
}

/** The version in `nanoclaw-<version>.vsix`, as vsce names packages. */
export function versionFromVsixName(file: string): string | null {
  const m = /^nanoclaw-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.vsix$/.exec(path.basename(file));
  return m ? m[1] : null;
}

/** Copy a package into the served directory and point the manifest at it. Older packages are kept for rollback. */
export function publishExtension(vsixPath: string, version?: string): ExtensionManifest {
  const v = version ?? versionFromVsixName(vsixPath);
  if (!v) throw new Error(`cannot tell the version from ${path.basename(vsixPath)}; pass it explicitly`);
  const bytes = fs.readFileSync(vsixPath);
  const dir = extensionDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `nanoclaw-${v}.vsix`;
  fs.writeFileSync(path.join(dir, file), bytes);
  const manifest: ExtensionManifest = {
    version: v,
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
  log.info('Runner extension published', { version: v, size: bytes.length });
  return manifest;
}

/** Semver-ish: is `a` newer than `b`? Only the three numbers count; malformed input is never "newer". */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}
