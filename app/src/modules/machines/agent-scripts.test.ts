import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  installCommand,
  installScript,
  installScriptHash,
  reportScript,
  sshInstallCommand,
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

  it('quotes the token, so nothing in it runs, and keeps it out of every argv', () => {
    const c = installCommand('h', 1, 'p', "a'; rm -rf /; '");
    expect(c).toContain(String.raw`printf '%s' 'a'\''; rm -rf /; '\''' > "$D/token"`);
    expect(c).toContain('sudo NC_TOKEN_FILE="$D/token" sh "$D/install.sh"');
    expect(c).not.toMatch(/NC_TOKEN=/);
  });

  it('downloads into a private folder and runs the installer only if it is the one NanoClaw serves', () => {
    const c = installCommand('10.0.0.4', 7443, 'PIN', 'tok');
    expect(c).toMatch(/^umask 077 && D=\$\(mktemp -d\)/);
    expect(c).not.toContain('/tmp/nanoclaw-machine.sh');
    expect(c).toContain(
      `echo ${installScriptHash('10.0.0.4', 7443, 'PIN')}'  '"$D/install.sh" | sha256sum -c --status`,
    );
    expect(c.indexOf('sha256sum')).toBeLessThan(c.indexOf('sudo'));
    expect(c).toContain('rm -rf "$D"');
    const ssh = sshInstallCommand('10.0.0.4', 7443, 'PIN', 'password');
    expect(ssh).toMatch(/^IFS= read -r T; umask 077 && D=\$\(mktemp -d\)/);
    expect(ssh).toContain('sha256sum -c --status');
    expect(shOk(ssh).ok).toBe(true);
  });

  it('the command really runs only an intact installer, with the token from the private file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cmd-'));
    try {
      const served = installScript('10.0.0.4', 7443, 'PIN');
      // Stand-ins: curl writes the served (or a tampered) installer; sudo runs its command as is.
      const run = (body: string) => {
        fs.writeFileSync(path.join(dir, 'served'), body);
        const c = installCommand('10.0.0.4', 7443, 'PIN', 'tok-123').replace(
          'sudo NC_TOKEN_FILE="$D/token" sh "$D/install.sh"',
          `{ cp "$D/token" ${dir}/seen-token && cp "$D/install.sh" ${dir}/ran; }`,
        );
        return spawnSync(
          'sh',
          [
            '-c',
            `curl() { while [ "$1" != -o ]; do shift; done; cp ${dir}/served "$2"; }\nmktemp() { m=${dir}/d.$$; mkdir -m 700 "$m"; echo "$m"; }\n${c}`,
          ],
          {
            encoding: 'utf8',
          },
        );
      };
      const bad = run(`${served}\nrm -rf /\n`);
      expect(bad.status).not.toBe(0);
      expect(bad.stdout).toContain('did not arrive intact');
      expect(fs.existsSync(path.join(dir, 'ran'))).toBe(false);
      const ok = run(served);
      expect(ok.status).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'ran'), 'utf8')).toBe(served);
      expect(fs.readFileSync(path.join(dir, 'seen-token'), 'utf8')).toBe('tok-123');
      // The private folder is gone afterwards.
      expect(fs.readdirSync(dir).filter((n) => n.startsWith('d.'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the installer reads the token from its file, sends it on stdin, locks, and installs nothing from elsewhere', () => {
    const s = installScript('10.0.0.4', 7443, 'PIN');
    expect(s).toContain('TOKEN=$(cat "$NC_TOKEN_FILE"); rm -f "$NC_TOKEN_FILE"');
    expect(s).not.toContain('NC_TOKEN:-');
    const enroll = s.slice(s.indexOf('REPLY=$('), s.indexOf('/enroll'));
    expect(enroll).toContain('--data-binary @-');
    expect(enroll).toMatch(/"\$DISK" \\\n {2}\| curl/);
    expect(s).not.toContain('get.docker.com');
    expect(s).not.toMatch(/\/tmp\//);
    expect(s).toContain('umask 077');
    expect(s.indexOf('umask 077')).toBeLessThan(s.indexOf('mkdir -p "$DIR"'));
    expect(s).toContain('mkdir "$LOCK"');
    expect(s.indexOf('mkdir "$LOCK"')).toBeLessThan(s.indexOf('/enroll'));
    expect(s).toContain('put "$DIR/cert.pem" 600');
    expect(s).toContain('put /etc/systemd/system/nanoclaw-machine.timer 644');
    expect(s).toContain('source $(hostname -I');
    const w = workerInstallScript('10.0.0.4', 7443, 'PIN');
    expect(w).toContain('umask 077');
    expect(w).toContain('mkdir "$LOCK"');
    expect(w).toContain('docker compose version');
  });

  it('put writes a file whole, with its mode set first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-put-'));
    try {
      const s = installScript('h', 1, 'p');
      const put = s.slice(s.indexOf('put() {'), s.indexOf('\n', s.indexOf('put() {')));
      const f = path.join(dir, 'unit');
      const r = spawnSync('sh', ['-c', `umask 022\n${put}\nprintf 'a\\nb\\n' | put ${f} 640`], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(f, 'utf8')).toBe('a\nb\n');
      expect(fs.statSync(f).mode & 0o777).toBe(0o640);
      expect(fs.readdirSync(dir)).toEqual(['unit']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two installs at once: the second one stops', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
    try {
      const s = installScript('h', 1, 'p');
      const lock = s.slice(s.indexOf('LOCK='), s.indexOf('URL="https'));
      const script = lock.replace('/run/nanoclaw-machine-install.lock', `${dir}/lock`);
      fs.mkdirSync(path.join(dir, 'lock'));
      const r = spawnSync('sh', ['-c', `set -eu\n${script}echo got-it`], { encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain('Another NanoClaw install is running');
      fs.rmdirSync(path.join(dir, 'lock'));
      const r2 = spawnSync('sh', ['-c', `set -eu\n${script}echo got-it`], { encoding: 'utf8' });
      expect(r2.stdout).toContain('got-it');
      expect(fs.existsSync(path.join(dir, 'lock'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
