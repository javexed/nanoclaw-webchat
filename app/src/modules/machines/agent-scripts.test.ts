import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

import { installCommand, installScript, reportScript } from './agent-scripts.js';

const shOk = (script: string): { ok: boolean; err: string } => {
  const r = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
  return { ok: r.status === 0, err: r.stderr };
};

describe('the machine scripts', () => {
  it('are valid sh', () => {
    expect(shOk(installScript('10.0.0.4', 7443, 'abc+/=='))).toEqual({ ok: true, err: '' });
    expect(shOk(reportScript())).toEqual({ ok: true, err: '' });
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
