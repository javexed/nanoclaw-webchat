/**
 * Publish a VS Code runner package for laptops to update from.
 *   pnpm exec tsx scripts/publish-runner-extension.ts <path/to/nanoclaw-X.Y.Z.vsix> [version]
 *
 * The package's signature (`<vsix>.sig`, made on the operator's own machine by
 * scripts/sign-runner-release.ts in the overlay repo) is published with it
 * when it lies next to the package; one that does not match is refused, and so
 * is a package without one once the install has a release key.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getClientOverrides } from '../src/channels/webchat/runner-client-config.js';
import { publishExtension } from '../src/channels/webchat/runner-extension.js';

const [, , vsix, version] = process.argv;
if (!vsix) {
  console.error('usage: publish-runner-extension.ts <vsix> [version]');
  process.exit(2);
}
const sigFile = `${vsix}.sig`;
const signature = fs.existsSync(sigFile) ? (JSON.parse(fs.readFileSync(sigFile, 'utf8')) as unknown) : undefined;
// The same key the upload route holds signatures to.
initDb(path.join(DATA_DIR, 'v2.db'));
const releaseKey = (await getClientOverrides()).releaseKey ?? null;
const m = publishExtension(vsix, version, signature, releaseKey);
console.log(
  `published ${m.file} (${m.size} bytes, sha256 ${m.sha256.slice(0, 16)}) as version ${m.version}${m.signature ? ', signed' : ''}`,
);
