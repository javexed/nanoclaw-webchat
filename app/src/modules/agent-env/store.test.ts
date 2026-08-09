/**
 * Per-agent env store.
 *
 * The security-relevant behaviour is what is REFUSED and what is never returned:
 * a name that could smuggle a second variable through `docker -e`, a value that
 * cannot survive an argv round trip, and — most importantly — that listing gives
 * names without values. A value that can be read back has gained nothing over the
 * workspace file this tier exists to replace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmp: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-'));
  vi.resetModules();
  vi.doMock('../../config.js', () => ({ DATA_DIR: tmp }));
});

afterEach(async () => {
  vi.doUnmock('../../config.js');
  vi.resetModules();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const load = () => import('./store.js');

describe('agent env store', () => {
  it('round-trips a value and lists it by name', async () => {
    const s = await load();
    s.setAgentEnv('ag-1', 'SERVICE_API_KEY', 'abc123');
    expect(s.readAgentEnv('ag-1')).toEqual({ SERVICE_API_KEY: 'abc123' });
    expect(s.listAgentEnvNames('ag-1')).toEqual(['SERVICE_API_KEY']);
  });

  it('listing returns names only — never values', async () => {
    const s = await load();
    s.setAgentEnv('ag-1', 'SECRET_ONE', 'super-secret');
    expect(JSON.stringify(s.listAgentEnvNames('ag-1'))).not.toContain('super-secret');
  });

  it('scopes per agent — one group cannot see another', async () => {
    const s = await load();
    s.setAgentEnv('ag-1', 'A', '1');
    s.setAgentEnv('ag-2', 'B', '2');
    expect(s.listAgentEnvNames('ag-1')).toEqual(['A']);
    expect(s.listAgentEnvNames('ag-2')).toEqual(['B']);
  });

  it('writes the file 0600, and the directory 0700', async () => {
    const s = await load();
    s.setAgentEnv('ag-1', 'A', '1');
    const f = path.join(tmp, 'agent-env', 'ag-1.json');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(tmp, 'agent-env')).mode & 0o777).toBe(0o700);
  });

  it('refuses names that are not env tokens', async () => {
    const s = await load();
    for (const bad of ['lowercase', '1LEADING', 'HAS-DASH', 'HAS SPACE', 'A=B', 'X\nY', '', 'A'.repeat(65)])
      expect(s.isValidEnvName(bad)).toBe(false);
    for (const ok of ['A', '_X', 'SERVICE_API_KEY', 'A1_B2']) expect(s.isValidEnvName(ok)).toBe(true);
  });

  it('refuses values that cannot survive an argv round trip', async () => {
    const s = await load();
    expect(s.validateEnvValue('fine')).toBeNull();
    expect(s.validateEnvValue('two\nlines')).toHaveProperty('error');
    expect(s.validateEnvValue('carriage\rreturn')).toHaveProperty('error');
    expect(s.validateEnvValue('nul\0byte')).toHaveProperty('error');
    expect(s.validateEnvValue('x'.repeat(5000))).toHaveProperty('error');
    expect(s.validateEnvValue(42)).toHaveProperty('error');
  });

  // The file is operator-editable, so a bad entry can appear without going through
  // setAgentEnv. Dropping it beats handing it to `docker -e`.
  it('drops malformed entries on read rather than injecting them', async () => {
    const s = await load();
    fs.mkdirSync(path.join(tmp, 'agent-env'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'agent-env', 'ag-1.json'),
      JSON.stringify({ GOOD: 'yes', 'bad name': 'x', WITH_NEWLINE: 'a\nb', NUMBER: 7 }),
    );
    expect(s.readAgentEnv('ag-1')).toEqual({ GOOD: 'yes' });
  });

  it('survives a missing or corrupt file', async () => {
    const s = await load();
    expect(s.readAgentEnv('never-set')).toEqual({});
    fs.mkdirSync(path.join(tmp, 'agent-env'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agent-env', 'ag-x.json'), 'not json {');
    expect(s.readAgentEnv('ag-x')).toEqual({});
  });

  it('deletes by name and reports whether anything was removed', async () => {
    const s = await load();
    s.setAgentEnv('ag-1', 'A', '1');
    expect(s.deleteAgentEnv('ag-1', 'NOPE')).toBe(false);
    expect(s.deleteAgentEnv('ag-1', 'A')).toBe(true);
    expect(s.listAgentEnvNames('ag-1')).toEqual([]);
  });
});
