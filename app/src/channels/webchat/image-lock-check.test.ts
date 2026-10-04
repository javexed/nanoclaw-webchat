import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IMAGE_LOCK_CHECK } from './ollama-manage.js';

let root: string;
const LOCK = 'lock-v2\n';
const sha = createHash('sha256').update(LOCK).digest('hex');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lock-'));
  fs.mkdirSync(path.join(root, 'container/agent-runner'), { recursive: true });
  fs.mkdirSync(path.join(root, 'setup/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'container/agent-runner/bun.lock'), LOCK);
  fs.copyFileSync(path.join(process.cwd(), 'setup/lib/install-slug.sh'), path.join(root, 'setup/lib/install-slug.sh'));
  // A stand-in runtime: `image inspect` prints the label kept in ./label; `build` records its arguments.
  fs.writeFileSync(
    path.join(root, 'rt'),
    '#!/bin/sh\n[ "$1" = image ] && cat "$PWD/label"\n[ "$1" = build ] && echo "$*" >> "$PWD/runtime-builds"\nexit 0\n',
    { mode: 0o755 },
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** container/build.sh stand-in: records the call, and writes `fixed` as the new label. */
function build(fixed: string): void {
  fs.writeFileSync(
    path.join(root, 'container/build.sh'),
    `echo built >> "$PWD/builds"; "$CONTAINER_RUNTIME" build -t img .; printf '%s' '${fixed}' > "$PWD/label"\n`,
  );
}
/** A PATH holding every system command except `missing`, as on a host that lacks it. */
function pathWithout(missing: string): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const linked = new Set([missing]);
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (linked.has(name)) continue;
      linked.add(name);
      fs.symlinkSync(path.join(dir, name), path.join(bin, name));
    }
  }
  return bin;
}
const run = (PATH = process.env.PATH) =>
  spawnSync('bash', ['-c', IMAGE_LOCK_CHECK], {
    cwd: root,
    env: { PATH, CONTAINER_RUNTIME: path.join(root, 'rt') },
    encoding: 'utf8',
  });
const runtimeBuilds = () =>
  fs.existsSync(path.join(root, 'runtime-builds')) ? fs.readFileSync(path.join(root, 'runtime-builds'), 'utf8') : '';
const builds = () =>
  fs.existsSync(path.join(root, 'builds')) ? fs.readFileSync(path.join(root, 'builds'), 'utf8') : '';

describe('the agent image check after a harness install', () => {
  it('passes an image that carries the checkout lock, without rebuilding', () => {
    fs.writeFileSync(path.join(root, 'label'), sha);
    build(sha);
    expect(run().status).toBe(0);
    expect(builds()).toBe('');
  });

  it('rebuilds a stale image once, and passes when that fixes it', () => {
    fs.writeFileSync(path.join(root, 'label'), 'old');
    build(sha);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/stale/);
    expect(builds()).toBe('built\n');
    // Only this build skips the cache: nothing is pruned host-wide.
    expect(runtimeBuilds()).toBe('build --no-cache -t img .\n');
  });

  it('hashes the lock with shasum where sha256sum is missing (macOS)', () => {
    fs.writeFileSync(path.join(root, 'label'), sha);
    build(sha);
    const r = run(pathWithout('sha256sum'));
    expect(r.status).toBe(0);
    expect(builds()).toBe('');
  });

  it('hashes the lock with sha256sum where shasum is missing', () => {
    fs.writeFileSync(path.join(root, 'label'), sha);
    build(sha);
    const r = run(pathWithout('shasum'));
    expect(r.status).toBe(0);
    expect(builds()).toBe('');
  });

  it('fails when the image is still stale, so the chain stops before the restart', () => {
    fs.writeFileSync(path.join(root, 'label'), 'old');
    build('old');
    expect(run().status).toBe(1);
  });
});
