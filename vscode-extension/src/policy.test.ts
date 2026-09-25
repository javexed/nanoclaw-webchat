import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_WORKSPACE_EXCLUDES,
  WORKSPACE_SLOT,
  effectiveSlots,
  findExcluded,
  matchesExclude,
  pickWorkspaceFolder,
} from './policy.js';

describe('effectiveSlots', () => {
  it('fills the workspace slot with the first open folder, lets an explicit binding win, and honours off', () => {
    expect(effectiveSlots({}, ['/home/dev/proj', '/home/dev/other'], 'workspace')).toEqual({
      [WORKSPACE_SLOT]: '/home/dev/proj',
    });
    expect(effectiveSlots({ [WORKSPACE_SLOT]: '/elsewhere' }, ['/home/dev/proj'], 'workspace')).toEqual({
      [WORKSPACE_SLOT]: '/elsewhere',
    });
    expect(effectiveSlots({ '/workspace/extra': '/x' }, ['/home/dev/proj'], 'workspace')).toEqual({
      [WORKSPACE_SLOT]: '/home/dev/proj',
      '/workspace/extra': '/x',
    });
    expect(effectiveSlots({}, [], 'workspace')).toEqual({});
    expect(effectiveSlots({}, ['/home/dev/proj'], 'off')).toEqual({});
  });

  it('in a multi-root workspace binds the folder holding the file being edited, most specific first', () => {
    const roots = ['/home/dev/api', '/home/dev/web', '/home/dev/web/pkg'];
    expect(pickWorkspaceFolder(roots, '/home/dev/web/src/app.ts')).toBe('/home/dev/web');
    expect(pickWorkspaceFolder(roots, '/home/dev/web/pkg/x.ts')).toBe('/home/dev/web/pkg'); // nested root wins
    expect(pickWorkspaceFolder(roots, 'C:\\elsewhere\\x.ts')).toBe('/home/dev/api'); // outside: the first
    expect(pickWorkspaceFolder(roots)).toBe('/home/dev/api');
    expect(effectiveSlots({}, roots, 'workspace', '/home/dev/api/main.go')).toEqual({
      [WORKSPACE_SLOT]: '/home/dev/api',
    });
  });
});

describe('workspace excludes', () => {
  it('matches basenames anywhere, paths when the pattern has a slash, and the defaults catch the usual secrets', () => {
    for (const p of [
      'secrets',
      'a/b/secrets',
      '.env',
      'svc/.env.production',
      'certs/server.pem',
      'k/id_rsa',
      'id_rsa.pub',
      '.aws',
      'infra/terraform.tfstate.backup',
    ])
      expect(matchesExclude(p, DEFAULT_WORKSPACE_EXCLUDES), p).toBe(true);
    for (const p of ['src/app.ts', 'README.md', 'secretsauce.md', 'env.example', 'keys.md', 'package.json'])
      expect(matchesExclude(p, DEFAULT_WORKSPACE_EXCLUDES), p).toBe(false);
    expect(matchesExclude('infra/prod/vars.yml', ['infra/prod/**'])).toBe(true);
    expect(matchesExclude('infra/dev/vars.yml', ['infra/prod/**'])).toBe(false);
    expect(matchesExclude('deploy/config.local.json', ['*.local.json'])).toBe(true);
    expect(matchesExclude('a\\b\\secrets', DEFAULT_WORKSPACE_EXCLUDES)).toBe(true); // Windows separators
  });

  it('walks a tree, hides matched dirs whole, does not follow symlinks, skips .git/node_modules, and bounds itself', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-excl-'));
    const mk = (rel: string, content = 'x') => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    };
    mk('src/app.ts');
    mk('secrets/password.txt');
    mk('secrets/nested/deeper.txt');
    mk('.env');
    mk('svc/.env.prod');
    mk('certs/server.pem');
    mk('node_modules/pkg/.env'); // skipped: not descended
    mk('.git/config');
    fs.symlinkSync('/etc', path.join(root, 'id_rsa')); // a link named like a secret
    const { excluded, truncated } = findExcluded(root, DEFAULT_WORKSPACE_EXCLUDES, fs);
    const rels = excluded.map((e) => `${e.kind}:${e.rel}`).sort();
    expect(rels).toEqual(['dir:secrets', 'file:.env', 'file:certs/server.pem', 'file:id_rsa', 'file:svc/.env.prod']);
    expect(truncated).toBe(false);
    // bounded
    const many = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-excl-many-'));
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(many, `k${i}.pem`), 'x');
    const r = findExcluded(many, ['*.pem'], fs, { maxMatches: 10 });
    expect(r.truncated).toBe(true);
    expect(r.excluded.length).toBeLessThanOrEqual(10);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(many, { recursive: true, force: true });
  });
});
