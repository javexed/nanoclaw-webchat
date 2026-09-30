/**
 * A bundle is copied into an agent's writable tree after extraction, so a link
 * inside it would aim that tree at a host path. Imports refuse any member that
 * is not a plain file or directory.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { nonPlainTarMembers } from './agent-transfer.js';

describe('nonPlainTarMembers', () => {
  it('names links and other non-file members, and passes plain files and dirs', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-links-'));
    try {
      const tree = path.join(tmp, 'tree');
      fs.mkdirSync(path.join(tree, 'files', 'workspace'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'manifest.json'), '{}');
      fs.symlinkSync('/etc/passwd', path.join(tree, 'files', 'workspace', 'note.md'));
      const tgz = path.join(tmp, 'b.tgz');
      execFileSync('tar', ['-czf', tgz, '-C', tree, 'manifest.json', 'files']);
      expect(await nonPlainTarMembers(tgz)).toEqual([expect.stringContaining('files/workspace/note.md')]);

      fs.rmSync(path.join(tree, 'files', 'workspace', 'note.md'));
      fs.writeFileSync(path.join(tree, 'files', 'workspace', 'note.md'), 'plain');
      execFileSync('tar', ['-czf', tgz, '-C', tree, 'manifest.json', 'files']);
      expect(await nonPlainTarMembers(tgz)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
