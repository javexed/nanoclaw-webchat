import { describe, expect, it } from 'vitest';

import { sanitizeSkillFrontmatter } from './skill-frontmatter.js';

describe('sanitizeSkillFrontmatter', () => {
  it('keeps an unquoted description with ": " in it, which YAML refuses', () => {
    const raw =
      '---\nname: become-precedence\ndescription: Fix "sudo: a password is required" on delegated tasks\n---\n\n# Body\n';
    const r = sanitizeSkillFrontmatter(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toContain('description: "Fix \\"sudo: a password is required\\" on delegated tasks"');
    expect(r.body).toContain('# Body');
  });

  it('still drops every other key from plain lines', () => {
    const r = sanitizeSkillFrontmatter('---\nname: x\nallowed-tools: Bash: rm\ndescription: d: e\n---\nbody\n');
    expect(r.ok && r.dropped).toEqual(['allowed-tools']);
    expect(r.ok && r.body).not.toContain('allowed-tools');
  });

  it('still refuses frontmatter that is neither YAML nor plain lines', () => {
    expect(sanitizeSkillFrontmatter('---\nname: x\n  nested: a: b\n---\nbody\n')).toEqual({
      ok: false,
      error: 'Skill frontmatter is not valid YAML',
    });
  });
});
