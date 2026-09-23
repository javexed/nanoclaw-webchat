/**
 * Skill payload guard.
 *
 * A skill's `nc:copy` is a whole-file overwrite (`git show <branch>:<file> > <file>`).
 * Pointed at a file trunk owns, it silently replaces trunk's current version with
 * whatever the payload branch held when it was cut. That is how add-grok rolled
 * back the agent image for weeks: it copied container/Dockerfile and build.sh,
 * dropping rtk, the bun version, the pinned build frontend and the registry retry
 * on every deploy, with nothing failing.
 *
 * Two invariants, checked over every skill in the composed tree:
 *
 * 1. `nc:copy` never targets a trunk-owned build, image, lockfile or barrel file.
 *    Skills add to those with `nc:append` / `nc:json-merge` instead.
 * 2. An `nc:append` into container/Dockerfile is anchored at the
 *    `nanoclaw:image-layers` region and is safe under the engine's undo
 *    (`removeSkill`, the journal played backwards), which deletes every line
 *    matching one the skill added anywhere in the file: no blank lines, no
 *    `USER` lines, and no line trunk's Dockerfile already has.
 *
 * Verified by hand, not by this repo's CI (the registry-skills harness that
 * exercises apply + undo runs only in upstream's workflow): applying add-grok
 * and replaying its journal restored container/Dockerfile and all three
 * provider barrels byte-for-byte, with `USER node` untouched.
 *
 * Deliberately NOT checked: whether copied files' imports resolve. The payload
 * lives on a remote branch; the build (tsc) already fails loudly on that, which
 * is how the missing grok-reauth.ts was found. This guard exists for the failure
 * that made no noise.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');

/** Files skills must never replace wholesale. */
const TRUNK_OWNED = new Set([
  'container/Dockerfile',
  'container/build.sh',
  'container/cli-tools.json',
  'container/install-cli-tools.sh',
  'container/entrypoint.sh',
  'container/agent-runner/package.json',
  'container/agent-runner/bun.lock',
  'package.json',
  'pnpm-lock.yaml',
]);

/** Provider/channel barrels are append targets; copying one erases other skills' lines. */
const isBarrel = (p: string): boolean => /(^|\/)(providers|channels)\/index\.ts$/.test(p);

interface Fence {
  skill: string;
  kind: string;
  attrs: Record<string, string>;
  body: string[];
}

function readFences(): Fence[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const fences: Fence[] = [];
  for (const skill of fs.readdirSync(SKILLS_DIR)) {
    const file = path.join(SKILLS_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^```nc:([a-z-]+)(.*)$/);
      if (!open) continue;
      const attrs: Record<string, string> = {};
      for (const tok of open[2].trim().split(/\s+/).filter(Boolean)) {
        const at = tok.indexOf(':');
        if (at > 0) attrs[tok.slice(0, at)] = tok.slice(at + 1);
      }
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== '```'; i++) body.push(lines[i]);
      fences.push({ skill, kind: open[1], attrs, body });
    }
  }
  return fences;
}

const fences = readFences();

describe('skill payloads never replace trunk-owned files', () => {
  it('finds skills to check (guards against a vacuous pass)', () => {
    expect(fences.some((f) => f.kind === 'copy')).toBe(true);
  });

  it('no nc:copy targets a build, image, lockfile or barrel file', () => {
    const offenders = fences
      .filter((f) => f.kind === 'copy')
      .flatMap((f) =>
        f.body
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.split(/\s+/).pop() as string)
          .filter((dest) => TRUNK_OWNED.has(dest) || isBarrel(dest))
          .map((dest) => `${f.skill}: ${dest}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe('Dockerfile layers are inserted, anchored and undo-safe', () => {
  const dockerfilePath = path.join(ROOT, 'container', 'Dockerfile');
  const trunk = fs.existsSync(dockerfilePath) ? fs.readFileSync(dockerfilePath, 'utf8') : '';
  const appends = fences.filter((f) => f.kind === 'append' && f.attrs.to === 'container/Dockerfile');

  it('trunk carries the image-layers region', () => {
    expect(trunk).toContain('# >>> nanoclaw:image-layers');
    expect(trunk).toContain('# <<< nanoclaw:image-layers');
  });

  for (const f of appends) {
    describe(f.skill, () => {
      it('is anchored at nanoclaw:image-layers, not appended to the end of the file', () => {
        expect(f.attrs.at).toBe('nanoclaw:image-layers');
      });

      it('has no blank lines and no USER lines', () => {
        expect(f.body.filter((l) => l.trim() === '')).toEqual([]);
        expect(f.body.filter((l) => /^\s*USER\b/.test(l))).toEqual([]);
      });

      it("shares no line with trunk's Dockerfile, so the engine's undo cannot delete trunk lines", () => {
        // Compare against trunk as composed, before this skill is applied: a line
        // the skill inserted itself would otherwise match trivially.
        const trunkLines = new Set(
          trunk
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean),
        );
        const alreadyApplied = trunkLines.has(f.body[0]?.trim() ?? '');
        const collisions = alreadyApplied ? [] : f.body.map((l) => l.trim()).filter((l) => trunkLines.has(l));
        expect(collisions).toEqual([]);
      });
    });
  }
});
