/**
 * An agent can plant a link anywhere in a tree its container writes. These
 * helpers are how the host reads and writes such a tree without following one
 * to a host file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdirNoFollow, readNoFollow, removeNoFollow, writeNoFollow } from './no-follow-fs.js';

let tmp: string;
let root: string;
let host: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-follow-'));
  root = path.join(tmp, 'group');
  host = path.join(tmp, 'host');
  fs.mkdirSync(root);
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, '.env'), 'WEBCHAT_TOKEN=secret\n');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const hostEnv = () => fs.readFileSync(path.join(host, '.env'), 'utf-8');

describe('writeNoFollow', () => {
  it('replaces a planted link instead of writing through it', () => {
    fs.symlinkSync(path.join(host, '.env'), path.join(root, 'note.md'));
    writeNoFollow(root, 'note.md', 'agent-visible note');
    expect(hostEnv()).toBe('WEBCHAT_TOKEN=secret\n');
    expect(fs.lstatSync(path.join(root, 'note.md')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(root, 'note.md'), 'utf-8')).toBe('agent-visible note');
  });

  it('replaces a dangling link without creating its target', () => {
    fs.symlinkSync(path.join(host, 'authorized_keys'), path.join(root, 'key'));
    writeNoFollow(root, 'key', 'ssh-ed25519 AAAA', 0o600);
    expect(fs.existsSync(path.join(host, 'authorized_keys'))).toBe(false);
    expect(fs.statSync(path.join(root, 'key')).mode & 0o777).toBe(0o600);
  });

  it('refuses a linked parent directory', () => {
    fs.symlinkSync(host, path.join(root, 'memory'));
    expect(() => writeNoFollow(root, 'memory/.env', 'x')).toThrow(/link|plain directory/);
    expect(hostEnv()).toBe('WEBCHAT_TOKEN=secret\n');
  });

  it('keeps the mode of the file it replaces', () => {
    fs.writeFileSync(path.join(root, 'index.md'), 'old');
    fs.chmodSync(path.join(root, 'index.md'), 0o664);
    writeNoFollow(root, 'index.md', 'new');
    expect(fs.statSync(path.join(root, 'index.md')).mode & 0o777).toBe(0o664);
  });

  it('creates missing parents as plain directories', () => {
    writeNoFollow(root, 'memory/system/credential-access.md', 'note');
    expect(fs.readFileSync(path.join(root, 'memory/system/credential-access.md'), 'utf-8')).toBe('note');
  });

  it('refuses a path that leaves its root', () => {
    expect(() => writeNoFollow(root, '../host/.env', 'x')).toThrow(/leaves its root/);
  });
});

describe('readNoFollow', () => {
  it('refuses to read through a link', () => {
    fs.symlinkSync(path.join(host, '.env'), path.join(root, 'deploy_key_x.pub'));
    expect(() => readNoFollow(root, 'deploy_key_x.pub')).toThrow();
  });

  it('reads a plain file, and returns null for a missing one', () => {
    fs.writeFileSync(path.join(root, 'a.md'), 'hi');
    expect(readNoFollow(root, 'a.md')).toBe('hi');
    expect(readNoFollow(root, 'b.md')).toBeNull();
  });
});

describe('mkdirNoFollow / removeNoFollow', () => {
  it('will not mkdir through a linked directory', () => {
    fs.symlinkSync(host, path.join(root, '.history'));
    expect(() => mkdirNoFollow(root, '.history/skill')).toThrow(/plain directory/);
    expect(fs.existsSync(path.join(host, 'skill'))).toBe(false);
  });

  it('removes a link itself, and refuses to remove through a linked parent', () => {
    fs.symlinkSync(path.join(host, '.env'), path.join(root, 'x'));
    removeNoFollow(root, 'x');
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
    expect(hostEnv()).toBe('WEBCHAT_TOKEN=secret\n');

    fs.symlinkSync(host, path.join(root, 'memory'));
    expect(() => removeNoFollow(root, 'memory/.env')).toThrow();
    expect(hostEnv()).toBe('WEBCHAT_TOKEN=secret\n');
  });
});
