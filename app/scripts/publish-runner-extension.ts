/**
 * Publish a VS Code runner package for laptops to update from.
 *   pnpm exec tsx scripts/publish-runner-extension.ts <path/to/nanoclaw-X.Y.Z.vsix> [version]
 */
import { publishExtension } from '../src/channels/webchat/runner-extension.js';

const [, , vsix, version] = process.argv;
if (!vsix) {
  console.error('usage: publish-runner-extension.ts <vsix> [version]');
  process.exit(2);
}
const m = publishExtension(vsix, version);
console.log(`published ${m.file} (${m.size} bytes, sha256 ${m.sha256.slice(0, 16)}) as version ${m.version}`);
