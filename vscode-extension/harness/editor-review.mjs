// Editor harness: runs the inline review inside a REAL VS Code (downloaded
// once, driven headless under xvfb), against the built extension. The engine
// has unit tests; this proves the part they cannot reach — edits landing in
// real documents, CodeLenses appearing, commands resolving hunks, blocks
// following the developer's typing, save on completion.
//
//   npm run harness:editor        (needs `npm run build` and `npm run build:core`)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import { runTests } from '@vscode/test-electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(HERE, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-editor-'));
try {
  await runTests({
    extensionDevelopmentPath: ext,
    extensionTestsPath: path.join(HERE, 'editor-suite.cjs'),
    launchArgs: [
      workspace,
      '--disable-gpu',
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
    extensionTestsEnv: {
      NCL_EDITOR_WS: workspace,
      ...(process.env.NCL_EDITOR_SHOT ? { NCL_EDITOR_SHOT: process.env.NCL_EDITOR_SHOT } : {}),
    },
  });
} catch (err) {
  console.error(`\x1b[31meditor harness failed\x1b[0m: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
