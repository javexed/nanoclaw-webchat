/**
 * `ncl deploy-keys`: every verb is host-only; set-target records an install
 * admin's targets; list never shows key material. Keys are generated at test
 * time; host keys come from a stubbed scan.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-cli-'));
const DATA = path.join(ROOT, 'data');

vi.mock('../../config.js', () => ({ GROUPS_DIR: path.join(ROOT, 'groups'), DATA_DIR: DATA }));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => (id === 'ag-1' ? { id: 'ag-1', folder: 'g1', name: 'G1' } : undefined),
  getAllAgentGroups: async () => [{ id: 'ag-1', folder: 'g1', name: 'G1' }],
}));
vi.mock('../../db/sessions.js', () => ({ getSessionsByAgentGroup: async () => [] }));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: async () => {} }));
vi.mock('../../container-runner.js', () => ({ isContainerRunning: () => false }));
vi.mock('../tool-secrets/index.js', () => ({ refreshCredentialNote: async () => {} }));
vi.mock('../user-credentials/onecli-admin.js', () => ({ realOnecliAdmin: {} }));

interface Op {
  hostOnly?: boolean;
  args?: Array<{ name: string; type: string; required?: boolean }>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  formatHuman?: (data: unknown) => string;
}
const reg = vi.hoisted(() => ({ ops: {} as Record<string, Op> }));
vi.mock('../../cli/crud.js', () => ({
  registerResource: (def: { customOperations: Record<string, Op> }) => Object.assign(reg.ops, def.customOperations),
}));

await import('./cli.js');
const keys = await import('./keys.js');

let hostKey = '';
beforeAll(() => {
  const f = path.join(ROOT, 'hostkey');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', f, '-N', '', '-q']);
  hostKey = fs.readFileSync(`${f}.pub`, 'utf-8').trim().split(/\s+/).slice(0, 2).join(' ');
  fs.rmSync(f);
  fs.rmSync(`${f}.pub`);
  keys._setHostKeyScanForTest(async (host) => (host.endsWith('.internal.test') ? [] : [`${host} ${hostKey}`]));
});
afterEach(async () => {
  for (const k of await keys.listDeployKeys('ag-1')) await keys.deleteDeployKey('ag-1', k.name);
});
afterAll(() => {
  keys._setHostKeyScanForTest(null);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const run = (verb: string, args: Record<string, unknown>): Promise<unknown> => reg.ops[verb].handler(args);

describe('ncl deploy-keys', () => {
  it('registers list, set-target and migrate, all host-only', () => {
    expect(Object.keys(reg.ops).sort()).toEqual(['list', 'migrate', 'set-target']);
    for (const op of Object.values(reg.ops)) expect(op.hostOnly).toBe(true);
    const setTarget = reg.ops['set-target'].args!;
    expect(setTarget.filter((a) => a.required).map((a) => a.name)).toEqual(['group', 'key', 'targets']);
    expect(reg.ops.migrate.args!.map((a) => a.name)).toEqual(['dry_run', 'group', 'all', 'trust_targets', 'targets']);
  });

  it('set-target records several targets as an install admin’s', async () => {
    await keys.createDeployKey('ag-1', 'app', 'deploy@192.0.2.10');
    const out = await run('set-target', {
      group: 'ag-1',
      key: 'app',
      targets: 'deploy@192.0.2.10,build@198.51.100.7',
    });
    expect(out).toMatchObject({
      agentGroupId: 'ag-1',
      keys: [
        {
          name: 'app',
          targets: [
            { target: 'deploy@192.0.2.10', command: 'ssh app' },
            { target: 'build@198.51.100.7', command: 'ssh app.2' },
          ],
        },
      ],
    });
    const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'deploy-keys', 'ag-1', 'app.json'), 'utf-8'));
    expect(meta).toMatchObject({ targets: ['deploy@192.0.2.10', 'build@198.51.100.7'], targetSetBy: 'install' });
    const text = reg.ops['set-target'].formatHuman!(out);
    expect(text).toContain('deploy@192.0.2.10  (ssh app)');
    expect(text).toContain('build@198.51.100.7  (ssh app.2)');
  });

  it('set-target pins a jump-only server from a known_hosts file', async () => {
    await keys.createDeployKey('ag-1', 'ops', 'root@192.0.2.1');
    const kh = path.join(ROOT, 'kh');
    fs.writeFileSync(kh, `far.internal.test ${hostKey}\n`);
    const targets = 'root@192.0.2.1,ops@far.internal.test via root@192.0.2.1';
    const without = (await run('set-target', { group: 'ag-1', key: 'ops', targets })) as {
      keys: Array<{ targets: Array<{ command?: string }> }>;
    };
    expect(without.keys[0].targets[1].command).toBeUndefined();
    const withKh = (await run('set-target', { group: 'ag-1', key: 'ops', targets, known_hosts: kh })) as {
      keys: Array<{ targets: Array<{ command?: string }> }>;
    };
    expect(withKh.keys[0].targets[1].command).toBe('ssh ops.2');
  });

  it('set-target refuses bad input before changing anything', async () => {
    await keys.createDeployKey('ag-1', 'app', 'deploy@192.0.2.10');
    await expect(run('set-target', { group: 'ag-404', key: 'app', targets: 'a@192.0.2.1' })).rejects.toThrow(
      /No agent group/,
    );
    await expect(run('set-target', { group: 'ag-1', key: 'nope', targets: 'a@192.0.2.1' })).rejects.toThrow(
      /No key named/,
    );
    await expect(run('set-target', { group: 'ag-1', key: 'app', targets: 'a@192.0.2.1,;x' })).rejects.toThrow(
      /Target must/,
    );
    await expect(
      run('set-target', { group: 'ag-1', key: 'app', targets: 'a@192.0.2.1', known_hosts: 'relative/kh' }),
    ).rejects.toThrow(/absolute path/);
    expect((await keys.listDeployKeys('ag-1'))[0].targets).toEqual([
      { target: 'deploy@192.0.2.10', command: 'ssh app' },
    ]);
  });

  it('list shows names, fingerprints and targets, never key material', async () => {
    await keys.createDeployKey('ag-1', 'app', ['deploy@192.0.2.10', 'deploy@192.0.2.11']);
    await keys.createDeployKey('ag-1', 'bare');
    const all = await run('list', {});
    const one = await run('list', { group: 'ag-1' });
    expect(one).toEqual(all);
    const json = JSON.stringify(all);
    expect(json).not.toMatch(/PRIVATE|ssh-ed25519/);
    const text = reg.ops.list.formatHuman!(all);
    expect(text).toContain('g1 (ag-1)');
    expect(text).toMatch(/ {2}app {2}SHA256:/);
    expect(text).toContain('deploy@192.0.2.11  (ssh app.2)');
    expect(text).toContain('[no target]');
    expect(text).not.toContain('ssh-ed25519');
    await expect(run('list', { group: 'ag-404' })).rejects.toThrow(/No agent group/);
  });

  it('migrate refuses an unknown group and bad --targets', async () => {
    await expect(run('migrate', { dry_run: true, group: 'ag-404' })).rejects.toThrow(/No agent group/);
    await expect(run('migrate', { dry_run: true, group: 'ag-1', targets: { app: 'nope' } })).rejects.toThrow(
      /Target must/,
    );
  });

  it('migrate moves nothing without --group or --all', async () => {
    await expect(run('migrate', {})).rejects.toThrow(/--group <id>, or pass --all/);
    await expect(run('migrate', { group: 'ag-1', all: true })).rejects.toThrow(/not both/);
    await expect(run('migrate', { dry_run: true })).resolves.toBeDefined();
  });

  it('every verb refuses a stray word, so "migrate help" changes nothing', async () => {
    for (const verb of ['list', 'set-target', 'migrate'])
      await expect(run(verb, { id: 'help', dry_run: false })).rejects.toThrow(
        new RegExp(`For help: ncl deploy-keys help ${verb}`),
      );
  });
});
