import { parse as parseYaml } from 'yaml';

/**
 * Frontmatter a kept skill may carry: what it is called and when to use it.
 *
 * A draft is written from conversation content, which can be steered by
 * whatever the agent read. Claude's skill frontmatter accepts more than a name
 * and description — `model`, `allowed-tools`, `hooks` and others — and a kept
 * skill loads into every later session of the agent. None of that is something
 * a learned skill should be able to set.
 *
 * Filtering the author's frontmatter line by line is not enough: Claude Code's
 * own split is lenient (a BOM, trailing spaces on the fences, a closer anywhere
 * on a line) and YAML has more ways to spell a key than a line regex can see.
 * So the frontmatter is never passed through. It is found at least as
 * leniently as Claude Code finds it, parsed with a real YAML parser, and only
 * `name` and `description` are read out — as strings — and written back into a
 * fresh two-line block. Frontmatter that does not parse, or a name or
 * description that is not a string, rejects the skill rather than guessing.
 */
const KEPT_FRONTMATTER_KEYS = new Set(['name', 'description']);

// Claude Code's frontmatter split, after it strips a BOM. Not anchored to line
// starts on the closing side, exactly like the original: the first `---`
// after the opener ends the block.
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;

/** One line, no fence: a value that can never reopen or close a block. */
function frontmatterValue(v: string): string {
  return JSON.stringify(
    v
      .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ')
      .replace(/-{3,}/g, '--')
      .trim(),
  );
}

export type SanitizedSkill = { ok: true; body: string; dropped: string[] } | { ok: false; error: string };

/**
 * Rebuild a SKILL.md with only a name and description in its frontmatter.
 * `fallback` supplies either when the author's frontmatter lacks it (or has
 * none at all) — the draft's own fields, or the skill's directory name.
 */
export function sanitizeSkillFrontmatter(
  raw: string,
  fallback: { name?: string; description?: string } = {},
): SanitizedSkill {
  const text = raw.replace(/^\ufeff+/, '');
  let rest = text;
  let fields: Record<string, unknown> = {};
  const dropped: string[] = [];
  // Leading blank lines are not frontmatter to Claude Code, but stripping a
  // block there too costs nothing and leaves no near-miss in the body.
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const m = FRONTMATTER_RE.exec(text.slice(lead.length));
  if (m) {
    let parsed: unknown;
    try {
      parsed = parseYaml(m[1] ?? '');
    } catch {
      return { ok: false, error: 'Skill frontmatter is not valid YAML' };
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'Skill frontmatter is not a mapping' };
      }
      fields = parsed as Record<string, unknown>;
    }
    for (const k of Object.keys(fields)) if (!KEPT_FRONTMATTER_KEYS.has(k)) dropped.push(k);
    rest = text.slice(lead.length + m[0].length);
  }
  for (const k of KEPT_FRONTMATTER_KEYS) {
    if (fields[k] !== undefined && typeof fields[k] !== 'string') {
      return { ok: false, error: `Skill frontmatter "${k}" must be a string` };
    }
  }
  const name = ((fields.name as string | undefined) ?? fallback.name ?? '').trim();
  const description = ((fields.description as string | undefined) ?? fallback.description ?? '').trim();
  if (!name) return { ok: false, error: 'Skill has no name' };
  const head = [`name: ${frontmatterValue(name)}`];
  if (description) head.push(`description: ${frontmatterValue(description)}`);
  return { ok: true, body: `---\n${head.join('\n')}\n---\n${rest}`, dropped };
}
