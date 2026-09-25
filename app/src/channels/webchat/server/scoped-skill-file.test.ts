/**
 * An agent writes its own scoped-skills tree, so a link it planted there must
 * not turn an admin's read or save of SKILL.md into one of a host file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-skill-'));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: TMP,
}));

const { openScopedSkillFile, readScopedSkillFile, scopedSkillsDir } = await import('./skills-store.js');

const GID = 'ag-1';
const secret = path.join(TMP, 'host-secret.env');

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'v2-sessions'), { recursive: true, force: true });
  fs.mkdirSync(scopedSkillsDir(GID), { recursive: true });
  fs.writeFileSync(secret, 'WEBCHAT_TOKEN=do-not-read\n');
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('scoped skill files', () => {
  it('reads and writes a real SKILL.md', () => {
    fs.mkdirSync(path.join(scopedSkillsDir(GID), 'ok'));
    fs.writeFileSync(path.join(scopedSkillsDir(GID), 'ok', 'SKILL.md'), 'hello');
    expect(readScopedSkillFile(GID, 'ok')).toBe('hello');
    const fd = openScopedSkillFile(GID, 'ok', fs.constants.O_WRONLY);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, 'saved');
    fs.closeSync(fd);
    expect(readScopedSkillFile(GID, 'ok')).toBe('saved');
  });

  it('refuses a SKILL.md that is a link, for reading and for writing', () => {
    fs.mkdirSync(path.join(scopedSkillsDir(GID), 'evil'));
    fs.symlinkSync(secret, path.join(scopedSkillsDir(GID), 'evil', 'SKILL.md'));
    expect(() => readScopedSkillFile(GID, 'evil')).toThrow();
    expect(() => openScopedSkillFile(GID, 'evil', fs.constants.O_WRONLY)).toThrow();
    expect(fs.readFileSync(secret, 'utf8')).toBe('WEBCHAT_TOKEN=do-not-read\n');
  });

  it('refuses a skill directory that is a link', () => {
    const outside = path.join(TMP, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'SKILL.md'), 'not a skill of this agent');
    fs.symlinkSync(outside, path.join(scopedSkillsDir(GID), 'linked'));
    expect(() => readScopedSkillFile(GID, 'linked')).toThrow();
  });
});
