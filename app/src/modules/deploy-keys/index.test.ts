/**
 * Deploy keys live in the group folder, which the agent's container can write.
 * A link the agent plants at a key's name must never turn a host read into a
 * host file shown in the UI, or a host write into one landing elsewhere.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GROUPS = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-keys-'));
const groupDir = path.join(GROUPS, 'g1');
const hostFile = path.join(GROUPS, 'host-env');

vi.mock('../../config.js', () => ({ GROUPS_DIR: GROUPS }));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async () => ({ id: 'ag-1', folder: 'g1', name: 'G1' }),
}));

const { createDeployKey, listDeployKeys, setDeployKeyTarget } = await import('./index.js');

beforeEach(() => {
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(hostFile, 'WEBCHAT_TOKEN=secret\n');
});
afterEach(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.rmSync(hostFile, { force: true });
});
afterAll(() => fs.rmSync(GROUPS, { recursive: true, force: true }));

describe('deploy keys and planted links', () => {
  it('never lists a linked .pub — that would show a host file in the UI', async () => {
    fs.symlinkSync(hostFile, path.join(groupDir, 'deploy_key_leak.pub'));
    fs.writeFileSync(path.join(groupDir, 'deploy_key_real.pub'), 'ssh-ed25519 AAAAC3Nz ops@example.com\n');
    const keys = await listDeployKeys('ag-1');
    expect(keys.map((k) => k.name)).toEqual(['real']);
    expect(JSON.stringify(keys)).not.toContain('WEBCHAT_TOKEN');
  });

  it('treats a dangling link at the name as taken, so nothing is written through it', async () => {
    const target = path.join(GROUPS, 'authorized_keys');
    fs.symlinkSync(target, path.join(groupDir, 'deploy_key_gh'));
    await expect(createDeployKey('ag-1', 'gh')).rejects.toThrow(/already exists/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('will not re-target a key through a linked .pub', async () => {
    fs.symlinkSync(hostFile, path.join(groupDir, 'deploy_key_gh.pub'));
    await expect(setDeployKeyTarget('ag-1', 'gh', 'git@example.com')).rejects.toThrow(/No key named/);
    expect(fs.readFileSync(hostFile, 'utf-8')).toBe('WEBCHAT_TOKEN=secret\n');
  });
});
