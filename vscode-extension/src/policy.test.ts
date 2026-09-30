import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_WORKSPACE_EXCLUDES,
  UNTRACKED_SECRET_EXCLUDES,
  WORKSPACE_SLOT,
  effectiveSlots,
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
    // Windows and macOS do not care about case; neither does the list.
    for (const p of ['.ENV', 'Config/Secrets', 'certs/SERVER.PEM', 'ID_RSA', '.Docker/Config.json'])
      expect(matchesExclude(p, DEFAULT_WORKSPACE_EXCLUDES), p).toBe(true);
    for (const p of [
      'prod.env',
      '.envrc',
      '.kube/config',
      'kubeconfig',
      'home/id_ecdsa',
      'id_dsa',
      'putty.ppk',
      '.docker/config.json',
      'ci/.docker/config.json',
      '.pgpass',
      'public/.htpasswd',
      '.vault-token',
      'infra/prod.tfstate',
      'infra/prod.tfstate.backup',
      'gcloud/application_default_credentials.json',
      'web/sites/default/settings.local.php',
      'wp-config.php',
      'vault.kdbx',
    ])
      expect(matchesExclude(p, DEFAULT_WORKSPACE_EXCLUDES), p).toBe(true);
    // Ordinary project files when tracked: only the snapshot's untracked list names them.
    for (const p of ['locales/en/auth.json', '.yarnrc.yml', 'env/prod.tfvars', 'dump.sql', 'test/fixture.db'])
      expect(matchesExclude(p, DEFAULT_WORKSPACE_EXCLUDES), p).toBe(false);
    for (const p of ['auth.json', '.yarnrc.yml', 'prod.tfvars', 'backup/dump.sql', 'data.sqlite3', 'app.db'])
      expect(matchesExclude(p, UNTRACKED_SECRET_EXCLUDES), p).toBe(true);
    expect(matchesExclude('src/db.ts', UNTRACKED_SECRET_EXCLUDES)).toBe(false);
  });
});

describe('the workspaceExcludes setting', () => {
  it("defaults to exactly the code's list (VS Code hands back the manifest default, not the code's)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const c = pkg.contributes.configuration;
    const props = Array.isArray(c)
      ? Object.assign({}, ...c.map((x: { properties: object }) => x.properties))
      : c.properties;
    expect(props['nanoclaw.workspaceExcludes'].default).toEqual([...DEFAULT_WORKSPACE_EXCLUDES]);
  });
});
