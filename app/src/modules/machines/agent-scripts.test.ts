import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  installCommand,
  installScript,
  reportScript,
  WORKER_HOST_RULES,
  workerHostRulesCommand,
  workerInstallScript,
  workerUpgradeCommand,
} from './agent-scripts.js';

const shOk = (script: string): { ok: boolean; err: string } => {
  const r = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
  return { ok: r.status === 0, err: r.stderr };
};

describe('the machine scripts', () => {
  it('are valid sh', () => {
    expect(shOk(installScript('10.0.0.4', 7443, 'abc+/=='))).toEqual({ ok: true, err: '' });
    expect(shOk(reportScript())).toEqual({ ok: true, err: '' });
    expect(shOk(workerInstallScript('10.0.0.4', 7443, 'abc+/=='))).toEqual({ ok: true, err: '' });
    expect(shOk(workerUpgradeCommand()).ok).toBe(true);
  });

  it('a worker join also installs the worker service; it fetches its files with the machine certificate', () => {
    expect(installScript('10.0.0.4', 7443, 'PIN')).toMatch(/ROLE=.*\n.*if \[ "\$ROLE" = worker \]/s);
    const w = workerInstallScript('10.0.0.4', 7443, 'PIN');
    expect(w).toContain('--cert $DIR/cert.pem --key $DIR/key.pem');
    expect(w).toContain('/worker/worker-main.js');
    expect(w).toContain('apt-get install -y -qq nodejs');
    expect(w).toContain('systemctl restart nanoclaw-worker.service');
  });

  it('the one-line command names the inbound rule needed when central is unreachable', () => {
    const c = installCommand('10.0.0.4', 7443, 'PIN', 'tok');
    expect(c).toContain("Can't reach NanoClaw at 10.0.0.4:7443");
    expect(c).toContain('destination 10.0.0.4, TCP 7443');
    expect(c).toContain("--pinnedpubkey 'sha256//PIN'");
    expect(shOk(c).ok).toBe(true);
  });

  it('quotes the token, so nothing in it runs', () => {
    const c = installCommand('h', 1, 'p', "a'; rm -rf /; '");
    expect(c).toContain(`NC_TOKEN='a'\\''; rm -rf /; '\\'''`);
  });

  it('the installer checks reachability first, installs Docker if missing, and keeps the token out of the script', () => {
    const s = installScript('10.0.0.4', 7443, 'PIN');
    expect(s.indexOf('/healthz')).toBeLessThan(s.indexOf('command -v docker'));
    expect(s).toContain('Docker not found: installing it with get.docker.com.');
    expect(s).toContain('TOKEN="${NC_TOKEN:-}"');
    expect(s).toContain('source $(hostname -I');
  });

  it("reports NanoClaw's own use from its slices, so other software can be told apart", () => {
    const r = reportScript();
    expect(r).toContain('/sys/fs/cgroup/nanoclaw*.slice');
    expect(r).toContain('"memNanoclawMb"');
    expect(r).toContain('"cpuNanoclaw"');
    expect(r).toContain('systemctl disable --now nanoclaw-machine.timer');
  });
});

describe('the worker installer and the workload host rules', () => {
  const H = 'a'.repeat(64);
  const hashes = { 'mux.js': H, 'worker-main.js': 'b'.repeat(64), 'workloads-host-rules.sh': 'c'.repeat(64) };

  it('fetches each file, checks it against the hash central computed, and only then uses it', () => {
    const w = workerInstallScript('10.0.0.4', 7443, 'PIN', hashes);
    expect(shOk(w)).toEqual({ ok: true, err: '' });
    expect(w).toContain(`fetch mux.js ${H}`);
    expect(w).toContain(`fetch workloads-host-rules.sh ${'c'.repeat(64)}`);
    expect(w).toContain('sha256sum -c --status');
    expect(w.indexOf('fetch workloads-host-rules.sh')).toBeLessThan(
      w.indexOf('workloads-host-rules.sh" --install-unit'),
    );
  });

  it('installs the same host rules as central, with their boot unit, before the worker service starts', () => {
    const w = workerInstallScript('10.0.0.4', 7443, 'PIN', hashes);
    expect(w).toContain('bash "$LIB/workloads-host-rules.sh" --install-unit');
    expect(w.indexOf('--install-unit')).toBeLessThan(w.indexOf('systemctl restart nanoclaw-worker.service'));
    expect(w).toContain('apt-get install -y -qq iptables');
    expect(workerHostRulesCommand()).toBe(`sudo bash ${WORKER_HOST_RULES} --install-unit`);
  });

  it('stops when central could not hash a file (or a hash is not one)', () => {
    const w = workerInstallScript('10.0.0.4', 7443, 'PIN', { 'mux.js': H, 'worker-main.js': 'nope' });
    expect(w).toContain('fetch worker-main.js missing');
    expect(w).toContain('fetch workloads-host-rules.sh missing');
    expect(w).toContain('NanoClaw could not serve $1');
  });

  it('the fetch step refuses a file whose hash does not match', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fetch-'));
    try {
      fs.writeFileSync(path.join(dir, 'served'), 'hello\n');
      const good = crypto.createHash('sha256').update('hello\n').digest('hex');
      const w = workerInstallScript('h', 1, 'p', hashes);
      const fn = w.slice(w.indexOf('fetch() {'), w.indexOf('\n}\n', w.indexOf('fetch() {')) + 3);
      // curl stands in for the download: it copies the served file to the -o path.
      const run = (hash: string) =>
        spawnSync(
          'sh',
          ['-c', `set -eu\nLIB=${dir}\nTLS=\nURL=\ncurl() { cp ${dir}/served "$2"; }\n${fn}\nfetch x.js ${hash}`],
          { encoding: 'utf8' },
        );
      const bad = run('0'.repeat(64));
      expect(bad.status).not.toBe(0);
      expect(bad.stdout).toContain('x.js did not arrive intact.');
      expect(fs.existsSync(path.join(dir, 'x.js'))).toBe(false);
      const ok = run(good);
      expect(ok.status).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'x.js'), 'utf8')).toBe('hello\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
