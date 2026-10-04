// deploy/onecli-private-ports.sh decides, on every update, whether to move a
// local OneCLI's API and database off the docker bridge. Run here against a
// temp install and HOME with stub `pnpm`, `onecli`, `systemctl` and `ip` on
// PATH: the stubs record what was asked, nothing real is touched.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('deploy/onecli-private-ports.sh');
let root: string;
let install: string;
let home: string;
let bin: string;
let log: string;

function stub(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/** Another install whose service is a systemd unit with that working directory. */
function sibling(onecliUrl: string): string {
  const dir = path.join(root, 'other');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), `ONECLI_URL=${onecliUrl}\n`);
  stub(
    'systemctl',
    `case "$*" in
  *list-units*) [ "$1" = --system ] && echo "nanoclaw-other.service loaded active running NanoClaw" ;;
  *WorkingDirectory*) echo "${dir}" ;;
esac`,
  );
  return dir;
}

function run(env: Record<string, string> = {}): string {
  return execFileSync('bash', [SCRIPT], {
    cwd: install,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const ran = (): boolean => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('--private-ports');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-ports-'));
  install = path.join(root, 'install');
  home = path.join(root, 'home');
  bin = path.join(root, 'bin');
  log = path.join(root, 'pnpm.log');
  fs.mkdirSync(path.join(install, '.claude/skills/add-onecli/scripts'), { recursive: true });
  fs.writeFileSync(path.join(install, '.claude/skills/add-onecli/scripts/setup.ts'), '');
  fs.writeFileSync(path.join(install, '.env'), 'ONECLI_URL=http://172.17.0.1:10254\n');
  fs.mkdirSync(path.join(home, '.onecli'), { recursive: true });
  fs.writeFileSync(path.join(home, '.onecli/docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(home, '.onecli/.env'), 'ONECLI_BIND_HOST=172.17.0.1\n');
  fs.mkdirSync(bin);
  // The migration: records its args and moves ONECLI_URL, as setup.ts does.
  stub('pnpm', `echo "$*" >> "${log}"; sed -i 's#^ONECLI_URL=.*#ONECLI_URL=http://127.0.0.1:10254#' .env`);
  stub('onecli', 'exit 0');
  stub('systemctl', 'exit 0');
  stub('ip', 'exit 0');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform !== 'linux')('onecli-private-ports.sh', () => {
  it('migrates an install still dialing the API on the bridge', () => {
    const out = run();
    expect(ran()).toBe(true);
    expect(fs.readFileSync(log, 'utf8')).toContain(
      'exec tsx .claude/skills/add-onecli/scripts/setup.ts --private-ports',
    );
    expect(out).toContain('ONECLI_URL is now http://127.0.0.1:10254');
  });

  it('runs again harmlessly on an install already on loopback (idempotent step)', () => {
    fs.writeFileSync(path.join(install, '.env'), 'ONECLI_URL=http://127.0.0.1:10254\n');
    const out = run();
    expect(ran()).toBe(true);
    expect(out).not.toContain('ONECLI_URL is now');
  });

  it('skips a fresh compose, a remote gateway, no local OneCLI, and an opt-out', () => {
    fs.rmSync(path.join(install, '.env'));
    run();
    expect(ran()).toBe(false);
    fs.writeFileSync(path.join(install, '.env'), 'ONECLI_URL=https://vault.example.com\n');
    run();
    expect(ran()).toBe(false);
    fs.writeFileSync(path.join(install, '.env'), 'ONECLI_URL=http://172.17.0.1:10254\n');
    run({ NANOCLAW_SKIP_ONECLI_PRIVATE_PORTS: '1' });
    expect(ran()).toBe(false);
    fs.rmSync(path.join(home, '.onecli/docker-compose.yml'));
    run();
    expect(ran()).toBe(false);
  });

  it('leaves the bridge alone while another install on this host still dials it there', () => {
    const other = sibling('http://172.17.0.1:10254');
    expect(run()).toBe('');
    expect(ran()).toBe(false);
    // Once that one is on loopback too, this one moves.
    fs.writeFileSync(path.join(other, '.env'), 'ONECLI_URL=http://127.0.0.1:10254\n');
    run();
    expect(ran()).toBe(true);
  });

  it('never fails the update when the migration fails', () => {
    stub('pnpm', `echo "$*" >> "${log}"; exit 1`);
    expect(() => run()).not.toThrow();
    expect(ran()).toBe(true);
  });
});
