/**
 * Deploy keys are held on the host: nothing private lands in the agent's
 * folder or its read-only view, and the API never returns a private half.
 * Keys are generated at test time; host keys come from a stubbed scan.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-keys-'));
const GROUPS = path.join(ROOT, 'groups');
const DATA = path.join(ROOT, 'data');
const groupDir = path.join(GROUPS, 'g1');

vi.mock('../../config.js', () => ({ GROUPS_DIR: GROUPS, DATA_DIR: DATA }));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => (id === 'ag-1' ? { id: 'ag-1', folder: 'g1', name: 'G1' } : undefined),
  getAllAgentGroups: async () => [{ id: 'ag-1', folder: 'g1', name: 'G1' }],
}));
vi.mock('../../db/sessions.js', () => ({ getSessionsByAgentGroup: async () => [] }));
vi.mock('../../module-sweep.js', () => ({ registerModuleSweep: () => {} }));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: async () => {} }));
vi.mock('../../container-runner.js', () => ({ isContainerRunning: () => false }));
vi.mock('../tool-secrets/index.js', () => ({ refreshCredentialNote: async () => {} }));
vi.mock('../user-credentials/onecli-admin.js', () => ({ realOnecliAdmin: {} }));
const hooks = vi.hoisted(() => ({
  env: [] as Array<(g: string) => Record<string, string>>,
  targets: [] as Array<(g: string) => Promise<Array<{ host: string; port: number; allowPrivate: boolean }>>>,
}));
vi.mock('../../seam/index.js', () => ({
  registerContainerEnvResolver: (fn: (g: string) => Record<string, string>) => hooks.env.push(fn),
  registerSessionPrepareHook: () => {},
}));
vi.mock('../../channels/webchat/egress-key-targets.js', () => ({
  registerKeyTargets: (fn: (typeof hooks.targets)[number]) => hooks.targets.push(fn),
}));
vi.mock('../../cli/crud.js', () => ({ registerResource: () => {} }));

const dk = await import('./index.js');
const { deployKeyMount } = await import('./mount.js');

/** A host key line for `host`, as ssh-keyscan prints it. */
let hostKey = '';
beforeAll(() => {
  const f = path.join(ROOT, 'hostkey');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', f, '-N', '', '-q']);
  hostKey = fs.readFileSync(`${f}.pub`, 'utf-8').trim().split(/\s+/).slice(0, 2).join(' ');
  dk._setHostKeyScanForTest(async (host) => (host === 'unreachable.example.com' ? [] : [`${host} ${hostKey}`]));
  fs.mkdirSync(groupDir, { recursive: true });
});
afterEach(async () => {
  for (const k of await dk.listDeployKeys('ag-1')) await dk.deleteDeployKey('ag-1', k.name);
});
afterAll(() => {
  dk._setHostKeyScanForTest(null);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((e) => (e.isFile() ? [path.join(e.parentPath, e.name)] : []));
}
const isPrivate = (f: string): boolean => fs.readFileSync(f, 'latin1').includes('PRIVATE KEY');

describe('a key is held on the host', () => {
  it('lands in the store, never in the agent folder or its view, and is listed with a command', async () => {
    const key = await dk.createDeployKey('ag-1', 'app', 'deploy@192.0.2.10', 'install');
    expect(key).toMatchObject({ name: 'app', target: 'deploy@192.0.2.10', command: 'ssh app' });
    expect(JSON.stringify(key)).not.toContain('PRIVATE');
    expect(key.publicKey).toMatch(/^ssh-ed25519 /);

    const store = path.join(DATA, 'deploy-keys', 'ag-1');
    expect(fs.statSync(store).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(store, 'app.key')).mode & 0o777).toBe(0o600);
    expect(isPrivate(path.join(store, 'app.key'))).toBe(true);

    expect(filesUnder(groupDir).filter(isPrivate)).toEqual([]);
    const mount = deployKeyMount('ag-1')!;
    expect(mount).toMatchObject({ containerPath: '/run/nanoclaw-ssh', readonly: true, mountClass: 'group-state' });
    expect(mount.hostPath).toBe(path.join(DATA, 'v2-sessions', 'ag-1', 'ssh-view'));
    const view = filesUnder(mount.hostPath);
    expect(view.filter(isPrivate)).toEqual([]);
    expect(view.map((f) => path.basename(f)).sort()).toEqual(['app.pub', 'config', 'known_hosts']);
    const config = fs.readFileSync(path.join(mount.hostPath, 'config'), 'utf-8');
    expect(config).toContain('Host app\n  HostName 192.0.2.10\n  User deploy\n');
    expect(config).toContain('IdentityAgent /run/nanoclaw-ssh/agent.sock');
    expect(config).toContain('IdentityFile /run/nanoclaw-ssh/app.pub');
    expect(config).toContain('StrictHostKeyChecking yes');
    expect(config).not.toMatch(/\.key\b/);
  });

  it('is not usable until its host key is pinned, and says so', async () => {
    const key = await dk.createDeployKey('ag-1', 'far', 'git@unreachable.example.com');
    expect(key.command).toBeUndefined();
    expect(key.hostKeyMissing).toBe(true);
    expect(fs.readFileSync(path.join(deployKeyMount('ag-1')!.hostPath, 'config'), 'utf-8')).not.toContain('Host far');
  });

  it('re-targeting keeps the key; rotating replaces it and clears Exposed', async () => {
    await dk.createDeployKey('ag-1', 'app', 'deploy@192.0.2.10');
    const store = path.join(DATA, 'deploy-keys', 'ag-1');
    const before = fs.readFileSync(path.join(store, 'app.key'));
    const moved = await dk.setDeployKeyTarget('ag-1', 'app', 'ops@192.0.2.11');
    expect(moved.target).toBe('ops@192.0.2.11');
    expect(fs.readFileSync(path.join(store, 'app.key')).equals(before)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(path.join(store, 'app.json'), 'utf-8'));
    fs.writeFileSync(path.join(store, 'app.json'), JSON.stringify({ ...meta, exposed: true }));
    expect((await dk.listDeployKeys('ag-1'))[0].exposed).toBe(true);

    const rotated = await dk.rotateDeployKey('ag-1', 'app');
    expect(rotated.exposed).toBeUndefined();
    expect(rotated.target).toBe('ops@192.0.2.11');
    expect(rotated.publicKey).not.toBe(moved.publicKey);
    expect(fs.readFileSync(path.join(store, 'app.key')).equals(before)).toBe(false);
  });

  it('delete removes every file of the key', async () => {
    await dk.createDeployKey('ag-1', 'app', 'deploy@192.0.2.10');
    expect(await dk.deleteDeployKey('ag-1', 'app')).toBe(true);
    expect(fs.readdirSync(path.join(DATA, 'deploy-keys', 'ag-1')).filter((f) => f.startsWith('app.'))).toEqual([]);
    expect(await dk.deleteDeployKey('ag-1', 'app')).toBe(false);
  });

  it('refuses bad names, bad targets and unknown agents', async () => {
    await expect(dk.createDeployKey('ag-1', '../x')).rejects.toThrow(/Name must be/);
    await expect(dk.createDeployKey('ag-1', 'ok', 'not a target')).rejects.toThrow(/Target must/);
    await expect(dk.createDeployKey('ag-404', 'ok')).rejects.toThrow(/no workspace/);
    await dk.createDeployKey('ag-1', 'app');
    await expect(dk.createDeployKey('ag-1', 'app')).rejects.toThrow(/already exists/);
  });
});

describe('what the container and the egress filter get', () => {
  it('an agent with no key gets no mount and no env; one with a key gets both', async () => {
    expect(deployKeyMount('ag-1')).toBeNull();
    expect(hooks.env.map((fn) => fn('ag-1'))).toEqual([{}]);
    await dk.createDeployKey('ag-1', 'app', 'deploy@192.0.2.10');
    expect(deployKeyMount('ag-1')).not.toBeNull();
    expect(hooks.env.map((fn) => fn('ag-1'))).toEqual([{ SSH_AUTH_SOCK: '/run/nanoclaw-ssh/agent.sock' }]);
  });

  it('each target on port 22; private addresses only for an install admin’s target', async () => {
    await dk.createDeployKey('ag-1', 'ka', 'deploy@a.example.com', 'install');
    await dk.createDeployKey('ag-1', 'kb', 'deploy@b.example.com', 'agent');
    await dk.createDeployKey('ag-1', 'kc');
    const got = (await Promise.all(hooks.targets.map((fn) => fn('ag-1')))).flat();
    expect(got).toEqual([
      { host: 'a.example.com', port: 22, allowPrivate: true },
      { host: 'b.example.com', port: 22, allowPrivate: false },
    ]);
  });
});
