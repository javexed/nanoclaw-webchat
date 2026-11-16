/**
 * Targets in the key store: the old single-target shape still reads, lists are
 * validated, and each target gets its own SSH alias. Host keys are generated
 * at test time.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-store-'));
vi.mock('../../config.js', () => ({ GROUPS_DIR: path.join(ROOT, 'g'), DATA_DIR: path.join(ROOT, 'd') }));

const store = await import('./store.js');
const { renderConfig } = await import('./view.js');

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function hostKeyLine(): string {
  const f = path.join(fs.mkdtempSync(path.join(ROOT, 'hk-')), 'k');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', f, '-N', '', '-q']);
  return fs.readFileSync(`${f}.pub`, 'utf-8').trim().split(/\s+/).slice(0, 2).join(' ');
}

describe('reading targets', () => {
  it('reads the old single target and the new list', () => {
    expect(store.targetsOf({ target: 'deploy@192.0.2.10' })).toEqual(['deploy@192.0.2.10']);
    expect(store.targetsOf({ targets: ['a@192.0.2.1', 'b@192.0.2.2'] })).toEqual(['a@192.0.2.1', 'b@192.0.2.2']);
    expect(store.targetsOf({ targets: ['a@192.0.2.1'], target: 'old@192.0.2.9' })).toEqual(['a@192.0.2.1']);
    expect(store.targetsOf({})).toEqual([]);
  });

  it('drops malformed stored entries: they would become SSH config lines', () => {
    const meta = { targets: ['a@192.0.2.1', 'b@192.0.2.2\n  ProxyCommand x', 7, 'c@192.0.2.3 via a@192.0.2.1'] };
    expect(store.targetsOf(meta as never)).toEqual(['a@192.0.2.1', 'c@192.0.2.3 via a@192.0.2.1']);
    expect(store.targetsOf({ target: 'x@y\nHost *' })).toEqual([]);
  });

  it('writes the new shape, dropping the single field', () => {
    const meta = store.withTargets({ target: 'old@192.0.2.9', exposed: true }, ['a@192.0.2.1'], 'install');
    expect(meta).toEqual({ targets: ['a@192.0.2.1'], targetSetBy: 'install', exposed: true });
  });

  it('an old state file on disk still lists with its target', () => {
    const dir = store.groupStoreDir('ag-old');
    fs.writeFileSync(path.join(dir, 'app.key'), 'not a key', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'app.pub'), 'ssh-ed25519 AAAA… app\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ target: 'deploy@192.0.2.10', targetSetBy: 'agent' }));
    const [k] = store.listStored('ag-old');
    expect(store.targetsOf(k.meta)).toEqual(['deploy@192.0.2.10']);
    expect(store.hopsOf(k.meta)).toEqual(['deploy@192.0.2.10']);
  });
});

describe('validating a target list', () => {
  it('takes commas, new lines or an array; trims and drops duplicates, keeping order', () => {
    expect(store.normalizeTargets(' a@192.0.2.1, b@192.0.2.2\nc@host.example.com ,a@192.0.2.1')).toEqual([
      'a@192.0.2.1',
      'b@192.0.2.2',
      'c@host.example.com',
    ]);
    expect(store.normalizeTargets(['a@192.0.2.1', ' b@192.0.2.2 '])).toEqual(['a@192.0.2.1', 'b@192.0.2.2']);
  });

  it('accepts a jump listed earlier, and refuses one that is not', () => {
    expect(store.normalizeTargets('root@192.0.2.1, ops@198.51.100.7  via  root@192.0.2.1')).toEqual([
      'root@192.0.2.1',
      'ops@198.51.100.7 via root@192.0.2.1',
    ]);
    expect(() => store.normalizeTargets('ops@198.51.100.7 via root@192.0.2.1')).toThrow(/list root@192.0.2.1 before/);
    expect(() => store.normalizeTargets('ops@198.51.100.7 via root@192.0.2.1, root@192.0.2.1')).toThrow(/before/);
  });

  it('refuses anything that is not user@host, an empty list, and too many', () => {
    for (const bad of ['', ' , ', 'host-only', 'a@b c', 'Root@192.0.2.1', 'a@192.0.2.1;rm', '-oProxyCommand=x@h'])
      expect(() => store.normalizeTargets(bad)).toThrow(/Target must look like user@host/);
    expect(() => store.normalizeTargets('a@192.0.2.1 via')).toThrow(/Target must/);
    expect(() => store.normalizeTargets('a@192.0.2.1 by b@192.0.2.2')).toThrow(/Target must/);
    const many = Array.from({ length: store.MAX_TARGETS + 1 }, (_, i) => `u@192.0.2.${i + 1}`);
    expect(() => store.normalizeTargets(many)).toThrow(/at most/);
  });
});

describe('aliases and the SSH config', () => {
  const pinned = new Set(['192.0.2.1', '192.0.2.2', '198.51.100.7']);

  it('names the first target after the key and the rest <name>.2, <name>.3', () => {
    const r = store.resolveTargets('app', { targets: ['a@192.0.2.1', 'b@192.0.2.2', 'c@192.0.2.3'] }, pinned);
    expect(r.map((t) => [t.alias, t.user, t.host, t.usable])).toEqual([
      ['app', 'a', '192.0.2.1', true],
      ['app.2', 'b', '192.0.2.2', true],
      ['app.3', 'c', '192.0.2.3', false],
    ]);
  });

  it('a jump target is usable only when its jump is', () => {
    const meta = { targets: ['root@192.0.2.1', 'ops@198.51.100.7 via root@192.0.2.1'] };
    expect(store.resolveTargets('k', meta, pinned).map((t) => [t.alias, t.jump, t.usable])).toEqual([
      ['k', undefined, true],
      ['k.2', 'k', true],
    ]);
    expect(store.resolveTargets('k', meta, new Set(['198.51.100.7']))[1].usable).toBe(false);
    expect(store.hopsOf(meta)).toEqual(['root@192.0.2.1', 'ops@198.51.100.7']);
  });

  it('a single-target key renders exactly as before', () => {
    const key = { name: 'app', publicKey: 'ssh-ed25519 AAAA…', meta: { target: 'deploy@192.0.2.1' } };
    expect(renderConfig([key], pinned)).toBe(
      [
        '# Managed by NanoClaw: deploy keys for this agent. Read-only.',
        '',
        'Host app',
        '  HostName 192.0.2.1',
        '  User deploy',
        '  IdentityAgent /run/nanoclaw-ssh/agent.sock',
        '  IdentityFile /run/nanoclaw-ssh/app.pub',
        '  IdentitiesOnly yes',
        '  BatchMode yes',
        '  UserKnownHostsFile /run/nanoclaw-ssh/known_hosts',
        '  StrictHostKeyChecking yes',
        '  ProxyCommand bun /app/src/ssh-proxy.ts %h %p',
        '',
      ].join('\n'),
    );
  });

  it('a block per usable target; a jump target goes through its jump’s alias', () => {
    const key = {
      name: 'ops',
      publicKey: 'ssh-ed25519 AAAA…',
      meta: { targets: ['root@192.0.2.1', 'ops@198.51.100.7 via root@192.0.2.1', 'x@192.0.2.3'] },
    };
    const cfg = renderConfig([key], pinned);
    expect(cfg.match(/^Host .*/gm)).toEqual(['Host ops', 'Host ops.2']);
    const second = cfg.slice(cfg.indexOf('Host ops.2'));
    expect(second).toContain('  HostName 198.51.100.7\n  User ops\n');
    expect(second).toContain('  ProxyJump ops\n');
    expect(second).not.toContain('ProxyCommand');
    expect(cfg.slice(0, cfg.indexOf('Host ops.2'))).toContain('ProxyCommand bun /app/src/ssh-proxy.ts %h %p');
  });
});

describe('pinning supplied host keys', () => {
  it('pins lines for the named hosts only, ignoring hashed, other and malformed lines', () => {
    const a = hostKeyLine();
    const b = hostKeyLine();
    const text = [
      `198.51.100.7 ${a}`,
      `[192.0.2.50]:22,192.0.2.51 ${b}`,
      `192.0.2.99 ${b}`,
      `|1|hashed|entry ${a}`,
      '198.51.100.7 not-a-type AAAA',
      '# comment',
    ].join('\n');
    const got = store.pinFromKnownHosts('ag-pin', ['198.51.100.7', '192.0.2.50'], text);
    expect(got.sort()).toEqual(['192.0.2.50', '198.51.100.7']);
    const pinned = store.pinnedHosts(store.readKnownHosts('ag-pin'));
    expect([...pinned].sort()).toEqual(['192.0.2.50', '198.51.100.7']);
  });
});
