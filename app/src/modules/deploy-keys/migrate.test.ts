/**
 * Moving private keys out of agent folders. Keys are generated at test time.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-migrate-'));
const GROUPS = path.join(ROOT, 'groups');
const DATA = path.join(ROOT, 'data');
vi.mock('../../config.js', () => ({ GROUPS_DIR: GROUPS, DATA_DIR: DATA }));
vi.mock('../../db/agent-groups.js', () => ({
  getAllAgentGroups: async () => [
    { id: 'ag-1', folder: 'one', name: 'One' },
    { id: 'ag-2', folder: 'two', name: 'Two' },
  ],
}));

const { checkGivenTargets, findKeyFiles, migrateKeys, nameFor, targetFromConfig, formatPlan } =
  await import('./migrate.js');
const store = await import('./store.js');

function keygen(file: string, comment: string, pass = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', file, '-N', pass, '-C', comment, '-q']);
}

beforeEach(() => {
  fs.rmSync(GROUPS, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  const one = path.join(GROUPS, 'one');
  keygen(path.join(one, 'deploy_key_app'), 'deploy@192.0.2.10');
  keygen(path.join(one, '.ssh', 'id_ed25519'), 'someone@laptop');
  fs.writeFileSync(
    path.join(one, '.ssh', 'config'),
    'Host box\n  HostName 192.0.2.20\n  User root\n  IdentityFile /workspace/agent/.ssh/id_ed25519\n',
  );
  keygen(path.join(one, 'locked'), 'x', 'secret-pass');
  // Never searched: dependency trees and fixtures carry sample keys.
  keygen(path.join(one, 'node_modules', 'ssh2', 'test', 'fixtures', 'k'), 'fixture');
  // Source that only mentions the header (assembled here, so this file is no key-shaped text).
  const header = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
  fs.writeFileSync(path.join(one, 'notes.js'), `const h = '${header}';\n`);
  // A comment that looks like user@host is not a target on a key NanoClaw did not make.
  keygen(path.join(GROUPS, 'two', 'tools', 'deploy'), 'builder@laptop');
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('finding keys', () => {
  it('finds key files by content, skipping dependency trees, fixtures and source that only mentions a header', () => {
    expect(findKeyFiles(path.join(GROUPS, 'one'))).toEqual(['.ssh/id_ed25519', 'deploy_key_app', 'locked']);
  });

  it('never follows a link', () => {
    fs.symlinkSync(path.join(GROUPS, 'two'), path.join(GROUPS, 'one', 'elsewhere'));
    expect(findKeyFiles(path.join(GROUPS, 'one'))).not.toContain('elsewhere/tools/deploy');
  });

  it('names keys as slugs, keeping deploy-key names', () => {
    const taken = new Set<string>();
    expect(nameFor('deploy_key_app', taken)).toBe('app');
    expect(nameFor('.ssh/id_ed25519', taken)).toBe('id-ed25519');
    expect(nameFor('x/id_ed25519', taken)).toBe('id-ed25519-2');
  });

  it('reads a target from the agent’s SSH config by identity file', () => {
    const cfg =
      'Host a b\n  HostName 192.0.2.5\n  User git\n  IdentityFile /workspace/agent/k\nHost *\n  User nobody\n';
    expect(targetFromConfig(cfg, 'k')).toBe('git@192.0.2.5');
    expect(targetFromConfig(cfg, 'other')).toBeUndefined();
  });
});

describe('migrating', () => {
  it('the dry run lists names and targets and changes nothing', async () => {
    const r = await migrateKeys({ dryRun: true });
    const text = formatPlan(r, true);
    expect(text).toContain('deploy_key_app → app  deploy@192.0.2.10');
    expect(text).toContain('.ssh/id_ed25519 → id-ed25519  root@192.0.2.20');
    expect(text).toContain('locked → locked  [skipped: passphrase-protected or unreadable]');
    expect(text).toContain('tools/deploy → deploy  [target needed: ncl deploy-keys set-target, or Admin]');
    expect(text).toContain('3 keys would move');
    expect(text).not.toContain('PRIVATE');
    expect(fs.existsSync(path.join(GROUPS, 'one', 'deploy_key_app'))).toBe(true);
    expect(fs.existsSync(path.join(DATA, 'deploy-keys'))).toBe(false);
  });

  it('imports, marks exposed, backs up 0600, and removes the originals', async () => {
    const r = await migrateKeys({ dryRun: false });
    expect(r.imported).toBe(3);
    expect(fs.existsSync(path.join(GROUPS, 'one', 'deploy_key_app'))).toBe(false);
    expect(fs.existsSync(path.join(GROUPS, 'one', 'deploy_key_app.pub'))).toBe(false);
    expect(fs.existsSync(path.join(GROUPS, 'one', '.ssh', 'id_ed25519'))).toBe(false);
    expect(fs.existsSync(path.join(GROUPS, 'one', 'locked'))).toBe(true);
    expect(fs.statSync(r.backup!).mode & 0o777).toBe(0o600);
    const listed = execFileSync('tar', ['tzf', r.backup!], { encoding: 'utf-8' }).trim().split('\n').sort();
    expect(listed).toEqual([
      'one/.ssh/id_ed25519',
      'one/.ssh/id_ed25519.pub',
      'one/deploy_key_app',
      'one/deploy_key_app.pub',
      'two/tools/deploy',
      'two/tools/deploy.pub',
    ]);

    const one = store.listStored('ag-1');
    expect(one.map((k) => [k.name, k.meta.targets, k.meta.exposed, k.meta.targetSetBy])).toEqual([
      ['app', ['deploy@192.0.2.10'], true, 'agent'],
      ['id-ed25519', ['root@192.0.2.20'], true, 'agent'],
    ]);
    expect(one.every((k) => k.meta.target === undefined)).toBe(true);
    expect(store.listStored('ag-2').map((k) => [k.name, k.meta.targets])).toEqual([['deploy', undefined]]);

    // A second run finds nothing new.
    expect((await migrateKeys({ dryRun: false })).imported).toBe(0);
  });

  it('--trust-targets records the found targets as an install admin’s', async () => {
    await migrateKeys({ dryRun: false, trustTargets: true });
    expect(store.listStored('ag-1').map((k) => k.meta.targetSetBy)).toEqual(['install', 'install']);
  });

  it('--group moves one agent’s keys, and its dry run lists only that agent', async () => {
    const dry = formatPlan(await migrateKeys({ dryRun: true, group: 'ag-2' }), true);
    expect(dry).toContain('two (ag-2)');
    expect(dry).not.toContain('one (ag-1)');
    expect(dry).toContain('1 key would move');
    const r = await migrateKeys({ dryRun: false, group: 'ag-2' });
    expect(r.imported).toBe(1);
    expect(store.listStored('ag-1')).toEqual([]);
    expect(fs.existsSync(path.join(GROUPS, 'one', 'deploy_key_app'))).toBe(true);
    await expect(migrateKeys({ dryRun: true, group: 'ag-404' })).rejects.toThrow(/No agent group/);
  });

  it('--targets gives a key several targets, as an install admin’s, replacing any found', async () => {
    const targets = checkGivenTargets({
      app: 'deploy@192.0.2.10, deploy@192.0.2.11',
      'id-ed25519': ['root@192.0.2.20', 'ops@198.51.100.7 via root@192.0.2.20'],
    });
    const dry = formatPlan(await migrateKeys({ dryRun: true, group: 'ag-1', targets }), true);
    expect(dry).toContain('deploy_key_app → app  deploy@192.0.2.10, deploy@192.0.2.11');
    await migrateKeys({ dryRun: false, group: 'ag-1', targets });
    expect(store.listStored('ag-1').map((k) => [k.name, k.meta.targets, k.meta.targetSetBy])).toEqual([
      ['app', ['deploy@192.0.2.10', 'deploy@192.0.2.11'], 'install'],
      ['id-ed25519', ['root@192.0.2.20', 'ops@198.51.100.7 via root@192.0.2.20'], 'install'],
    ]);
  });

  it('--targets is checked before anything moves', async () => {
    expect(() => checkGivenTargets({ app: 'not a target' })).toThrow(/Target must/);
    expect(() => checkGivenTargets({ '../x': 'a@192.0.2.1' })).toThrow(/not a key name/);
    expect(() => checkGivenTargets(['a@192.0.2.1'])).toThrow(/JSON object/);
    expect(() => checkGivenTargets({ app: 5 })).toThrow(/string or a list/);
    await expect(migrateKeys({ dryRun: false, targets: { app: ['a@192.0.2.1'] } })).rejects.toThrow(/needs --group/);
    await expect(migrateKeys({ dryRun: false, group: 'ag-1', targets: { nope: ['a@192.0.2.1'] } })).rejects.toThrow(
      /names no key/,
    );
    // Locked keys are not imported, so they cannot be named either.
    await expect(migrateKeys({ dryRun: true, group: 'ag-1', targets: { locked: ['a@192.0.2.1'] } })).rejects.toThrow(
      /names no key/,
    );
    expect(fs.existsSync(path.join(GROUPS, 'one', 'deploy_key_app'))).toBe(true);
    expect(fs.existsSync(path.join(DATA, 'deploy-keys'))).toBe(false);
  });
});
