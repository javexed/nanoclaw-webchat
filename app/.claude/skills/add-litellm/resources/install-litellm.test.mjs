/**
 * install-litellm.test.mjs — the installer's keyed/keyless decision, run as a
 * dry run in a scratch tree with a stub `docker` (no daemon, no network).
 * Runs with plain `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A tree shaped like an install (not a git checkout), holding `config` as the kept config.yaml. */
function dryRun(config, extraArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'install-litellm-'));
  try {
    const res = join(root, '.claude/skills/add-litellm/resources');
    mkdirSync(res, { recursive: true });
    for (const f of ['install-litellm.sh', 'gen-config.mjs']) copyFileSync(join(HERE, f), join(res, f));
    mkdirSync(join(root, 'data/litellm'), { recursive: true });
    writeFileSync(join(root, 'data/litellm/config.yaml'), config);
    // `docker ps` lists nothing; every inspect finds nothing.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\n[ "$1" = ps ] && exit 0\nexit 1\n');
    chmodSync(join(bin, 'docker'), 0o755);
    const out = spawnSync('bash', [join(res, 'install-litellm.sh'), '--dry-run', '--reuse-config', ...extraArgs], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CEILING_DIRECTORIES: root },
    });
    return { status: out.status, out: out.stdout + out.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('--reuse-config keeps a kept config keyed when it sets master_key, with no backends.json', () => {
  const r = dryRun('# hosts: (none)\nmodel_list: []\ngeneral_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /keyed \(proxy auth on\)/);
  assert.match(r.out, /--env-file/);
});

test('--reuse-config on a keyless config stays keyless', () => {
  const r = dryRun('# hosts: (none)\nmodel_list: []\n# no master_key here\n');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\(keyless, local-only\)/);
  assert.doesNotMatch(r.out, /--env-file/);
});
