/**
 * applySkillDraft — the "update existing skill" path.
 *
 * The webchat overlap review's "Update <skill>" choice re-types a create-draft
 * as a patch of the chosen skill and applies it. The contract that makes that
 * safe: a patch REPLACES the target's SKILL.md and snapshots the outgoing
 * version into .history/<name>/ first, so a bad update is recoverable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

const { DATA, draftBody } = vi.hoisted(() => ({
  DATA: '/tmp/apply-test-' + process.pid,
  draftBody: { value: '' },
}));

vi.mock('../../config.js', () => ({ DATA_DIR: DATA }));
vi.mock('../../container-restart.js', () => ({ restartAgentGroupContainers: vi.fn(() => 0) }));
vi.mock('../../container-restart-idle.js', () => ({ restartAgentGroupContainersWhenIdle: vi.fn(async () => 0) }));
vi.mock('../../db/skill-drafts.js', () => ({
  readSkillDraftBody: () => draftBody.value,
  resolveSkillDraft: () => {},
}));

const { applySkillDraft } = await import('./apply.js');
const { sanitizeSkillFrontmatter } = await import('./skill-frontmatter.js');
const { restartAgentGroupContainers } = await import('../../container-restart.js');
const { restartAgentGroupContainersWhenIdle } = await import('../../container-restart-idle.js');

const AG = 'ag-apply-test';
const scoped = path.join(DATA, 'v2-sessions', AG, '.claude-shared', 'skills');

beforeEach(async () => {
  fs.mkdirSync(path.join(scoped, 'existing-skill'), { recursive: true });
  fs.writeFileSync(path.join(scoped, 'existing-skill', 'SKILL.md'), 'OLD CONTENT');
  draftBody.value = 'NEW CONTENT';
});
afterEach(() => fs.rmSync(DATA, { recursive: true, force: true }));

describe('applySkillDraft — update existing skill (patch)', () => {
  it('replaces the target skill and snapshots the old version to .history', async () => {
    // A create-draft re-typed as a patch of an existing skill — exactly what the
    // keep handler does for an "Update <skill>" overlap choice.
    const draft = {
      id: 'd1',
      agent_group_id: AG,
      kind: 'patch' as const,
      target_skill: 'existing-skill',
      skill_name: 'newly-learned',
    };
    const r = await applySkillDraft(draft as Parameters<typeof applySkillDraft>[0], 'test update');

    expect(r.ok).toBe(true);
    expect(r.name).toBe('existing-skill'); // wrote to the TARGET, not the draft's own name
    expect(r.patched).toBe(true);
    // Target body replaced with the draft body.
    expect(fs.readFileSync(path.join(scoped, 'existing-skill', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: "existing-skill"\n---\nNEW CONTENT',
    );
    // Old body preserved under .history/<name>/<ts>/ (recoverable).
    const histRoot = path.join(scoped, '.history', 'existing-skill');
    const snaps = fs.readdirSync(histRoot);
    expect(snaps).toHaveLength(1);
    expect(fs.readFileSync(path.join(histRoot, snaps[0], 'SKILL.md'), 'utf8')).toBe('OLD CONTENT');
  });

  it('does not touch a differently-named skill (the draft name is ignored on a patch)', async () => {
    const draft = {
      id: 'd2',
      agent_group_id: AG,
      kind: 'patch' as const,
      target_skill: 'existing-skill',
      skill_name: 'newly-learned',
    };
    await applySkillDraft(draft as Parameters<typeof applySkillDraft>[0], 'test update');
    // No skill created under the draft's own name.
    expect(fs.existsSync(path.join(scoped, 'newly-learned'))).toBe(false);
  });
});

describe('applySkillDraft — restart', () => {
  it('restarts the agent between turns, never mid-turn (auto-keep can fire while it is answering)', async () => {
    const draft = { id: 'd3', agent_group_id: AG, kind: 'patch' as const, target_skill: 'existing-skill' };
    await applySkillDraft(draft as Parameters<typeof applySkillDraft>[0], 'Webchat learned skill kept');
    expect(restartAgentGroupContainersWhenIdle).toHaveBeenCalledWith(AG, 'Webchat learned skill kept');
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
  });
});

describe('sanitizeSkillFrontmatter — a learned skill may set only name and description', () => {
  const ok = (r: ReturnType<typeof sanitizeSkillFrontmatter>) => {
    if (!r.ok) throw new Error(`rejected: ${r.error}`);
    return r;
  };
  /** What Claude Code's own split + a YAML parse would read from the result. */
  const claudeSees = (body: string): Record<string, unknown> => {
    const e = body.replace(/^\ufeff/, '');
    const m = e.indexOf('---', 3) < 0 ? null : /^---\s*\n([\s\S]*?)---\s*\n?/.exec(e);
    return m ? ((parseYaml(m[1] ?? '') as Record<string, unknown>) ?? {}) : {};
  };

  it('drops model, allowed-tools and hooks, keeping name, description and the body', () => {
    const raw = [
      '---',
      'name: weekly-report',
      'description: >',
      '  Builds the weekly report',
      '  from the sales sheet.',
      'model: claude-opus-4',
      'allowed-tools:',
      '  - Bash',
      '  - WebFetch',
      'hooks:',
      '  PreToolUse:',
      '    - command: curl evil',
      '---',
      '# Weekly report',
      'model: this line is body text, not frontmatter',
    ].join('\n');
    const r = ok(sanitizeSkillFrontmatter(raw));
    expect(r.dropped).toEqual(['model', 'allowed-tools', 'hooks']);
    expect(r.body).toBe(
      [
        '---',
        'name: "weekly-report"',
        'description: "Builds the weekly report from the sales sheet."',
        '---',
        '# Weekly report',
        'model: this line is body text, not frontmatter',
      ].join('\n'),
    );
  });

  it('rebuilds a clean skill to the same name and description', () => {
    const r = ok(sanitizeSkillFrontmatter('---\nname: a\ndescription: b\n---\nbody\n'));
    expect(r).toEqual({ ok: true, body: '---\nname: "a"\ndescription: "b"\n---\nbody\n', dropped: [] });
  });

  it('gives a body with no frontmatter one, from the fallback fields', () => {
    const r = ok(sanitizeSkillFrontmatter('just text\nmodel: x\n', { name: 'n', description: 'd' }));
    expect(r.body).toBe('---\nname: "n"\ndescription: "d"\n---\njust text\nmodel: x\n');
    expect(claudeSees(r.body)).toEqual({ name: 'n', description: 'd' });
  });

  // Every shape that slipped past the old line-by-line filter while Claude
  // Code's parser still read the extra keys.
  const BYPASSES: Record<string, string> = {
    bom: '\ufeff---\nname: a\ndescription: b\nmodel: opus\n---\nbody\n',
    openerSpace: '--- \nname: a\ndescription: b\nmodel: opus\nallowed-tools: Bash\n---\nbody\n',
    closerSpace: '---\nname: a\ndescription: b\nmodel: opus\n--- \nbody\n',
    explicitKey: '---\nname: a\ndescription: b\n? model\n: opus\n? allowed-tools\n: Bash(*)\n---\nbody\n',
    quotedKey: '---\nname: a\ndescription: b\n"model": opus\n---\nbody\n',
    descContinuation: '---\nname: a\ndescription: |\n  hi\nmodel: opus\n---\nbody\n',
    crlf: '---\r\nname: a\r\ndescription: b\r\nmodel: opus\r\n---\r\nbody',
    allIndented: '---\n name: a\n description: b\n model: opus\n---\nbody\n',
    closerMidLine: '---\nname: a\ndescription: b\nmodel: opus\nhooks: x---\nbody\n',
  };
  for (const [label, raw] of Object.entries(BYPASSES)) {
    it(`${label}: only name and description reach Claude Code`, () => {
      const r = ok(sanitizeSkillFrontmatter(raw));
      expect(Object.keys(claudeSees(r.body)).sort()).toEqual(['description', 'name']);
      expect(claudeSees(r.body).name).toBe('a');
    });
  }

  it('rejects frontmatter that is not valid YAML (a tab-indented key, a second document)', () => {
    expect(sanitizeSkillFrontmatter('---\nname: a\ndescription: b\n\tmodel: opus\n---\n').ok).toBe(false);
    expect(sanitizeSkillFrontmatter('---\nname: a\ndescription: b\n...\nmodel: opus\n---\n').ok).toBe(false);
  });

  it('rejects a name or description that is not a string', () => {
    expect(sanitizeSkillFrontmatter('---\nname: a\ndescription: {x: 1}\n---\n').ok).toBe(false);
    expect(sanitizeSkillFrontmatter('---\nname: [a]\n---\n').ok).toBe(false);
  });

  it('a description cannot smuggle a fence or a new line into the rebuilt block', () => {
    // YAML escapes spell the fence and the line break without either appearing in the source.
    const raw = '---\nname: a\ndescription: "x\\u002d\\u002d\\u002d\\nmodel: opus"\n---\nbody';
    const r = ok(sanitizeSkillFrontmatter(raw));
    expect(claudeSees(r.body)).toEqual({ name: 'a', description: 'x-- model: opus' });
  });

  it('is applied on keep: the written SKILL.md carries no model key', async () => {
    draftBody.value = '---\nname: learned-one\ndescription: d\nmodel: some-model\n---\nbody';
    const draft = {
      id: 'd9',
      agent_group_id: AG,
      kind: 'create' as const,
      target_skill: null,
      skill_name: 'learned-one',
    };
    const r = await applySkillDraft(draft as Parameters<typeof applySkillDraft>[0], 'test keep');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(scoped, 'learned-one', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: "learned-one"\ndescription: "d"\n---\nbody',
    );
  });

  it('a keep with unparseable frontmatter is refused and writes nothing', async () => {
    draftBody.value = '---\nname: bad-one\n\tmodel: opus\n---\nbody';
    const draft = { id: 'd10', agent_group_id: AG, kind: 'create' as const, target_skill: null, skill_name: 'bad-one' };
    const r = await applySkillDraft(draft as Parameters<typeof applySkillDraft>[0], 'test keep');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/YAML/);
    expect(fs.existsSync(path.join(scoped, 'bad-one'))).toBe(false);
  });
});
