// Package the extension as nanoclaw-<version>.vsix (the name central's publish
// step reads the version from).
//
// NANOCLAW_EXTENSION_ID=<publisher>.<name> packages it under an install's own
// id instead of the repo's default. The id is how VS Code tells extensions
// apart and how the web app's Connect link reaches this one (central reads it
// from the package when it is published), so an install that already runs a
// build under its own id keeps updating in place. The override lives with the
// install, never in the repo.
//
// NANOCLAW_LEGACY_EXTENSION_ID=<publisher>.<name> names the id this install's
// builds were published under before (src/legacy.ts): the packaged
// package.json carries it as `nanoclawLegacyId`, and the extension offers to
// remove that build and takes over its storage. Unset, there is no
// predecessor and none of that runs. Like the id override, it lives with the
// install, never in the repo.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, `nanoclaw-${pkg.version}.vsix`);
const vsce = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
const args = ['package', '--no-dependencies', '--allow-missing-repository', '--out', out];

const override = process.env.NANOCLAW_EXTENSION_ID?.trim();
const legacy = process.env.NANOCLAW_LEGACY_EXTENSION_ID?.trim();
if (!override && !legacy) {
  execFileSync(vsce, args, { cwd: root, stdio: 'inherit' });
} else {
  const packaged = { ...pkg };
  if (override) {
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\.([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(override);
    if (!m) throw new Error(`NANOCLAW_EXTENSION_ID must be <publisher>.<name>, got "${override}"`);
    packaged.publisher = m[1];
    packaged.name = m[2];
  }
  if (legacy) {
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(legacy))
      throw new Error(`NANOCLAW_LEGACY_EXTENSION_ID must be <publisher>.<name> in lower case, got "${legacy}"`);
    if (legacy === `${packaged.publisher}.${packaged.name}`.toLowerCase())
      throw new Error('NANOCLAW_LEGACY_EXTENSION_ID names the id this build is packaged under');
    packaged.nanoclawLegacyId = legacy;
  }
  // Package a copy: the repo's package.json is never rewritten.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-vsix-'));
  try {
    for (const f of ['.vscodeignore', 'README.md', 'LICENSE', 'media', 'dist']) {
      if (fs.existsSync(path.join(root, f))) fs.cpSync(path.join(root, f), path.join(tmp, f), { recursive: true });
    }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(packaged, null, 2));
    execFileSync(vsce, args, { cwd: tmp, stdio: 'inherit' });
    console.log(`packaged as ${packaged.publisher}.${packaged.name}${legacy ? ` (takes over from ${legacy})` : ''}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
