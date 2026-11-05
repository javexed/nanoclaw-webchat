/**
 * Skill-use telemetry: stamped beside the skills dir, which containers see
 * read-only, never inside it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it } from 'bun:test';

import { stampSkillInvocation } from './learning-loop.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-'));
const skills = path.join(tmp, 'skills');
const usage = path.join(tmp, 'skill-usage');
const dirs = { skills, usage };

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('stampSkillInvocation', () => {
  it('stamps a scoped skill in the usage dir, continuing an older in-dir count', () => {
    fs.mkdirSync(path.join(skills, 'mine'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'mine', 'SKILL.md'), '---\ndescription: x\n---\n');
    fs.writeFileSync(path.join(skills, 'mine', '.invocations'), '4');

    stampSkillInvocation({ skill: 'mine' }, dirs);
    stampSkillInvocation({ skill: 'mine' }, dirs);

    expect(fs.readFileSync(path.join(usage, 'mine', '.invocations'), 'utf8')).toBe('6');
    expect(Number.isFinite(Date.parse(fs.readFileSync(path.join(usage, 'mine', '.last-invoked'), 'utf8')))).toBe(true);
    expect(fs.readFileSync(path.join(skills, 'mine', '.invocations'), 'utf8')).toBe('4');
  });

  it('skips pooled skills (links), unknown names and paths', () => {
    const pooled = path.join(tmp, 'pool', 'shared');
    fs.mkdirSync(pooled, { recursive: true });
    fs.writeFileSync(path.join(pooled, 'SKILL.md'), 'x');
    fs.symlinkSync(pooled, path.join(skills, 'shared'));

    stampSkillInvocation({ skill: 'shared', other: 'nope', bad: '../mine' }, dirs);

    expect(fs.existsSync(path.join(usage, 'shared'))).toBe(false);
    expect(fs.existsSync(path.join(usage, 'nope'))).toBe(false);
  });
});
