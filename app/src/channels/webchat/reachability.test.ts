/**
 * Reachability preflight: verdict/fix mapping (classifyReachability) and the
 * fast skip paths of probeContainerReachability that never spawn a container.
 */
import { describe, it, expect } from 'vitest';

import { classifyReachability, probeContainerReachability } from './reachability.js';

const URL = 'http://host.docker.internal:11434';

describe('classifyReachability', () => {
  it('connected with a 2xx/4xx status → ok', async () => {
    for (const status of [200, 401, 403, 404]) {
      const r = classifyReachability(URL, { stage: 'connected', status });
      expect(r.verdict).toBe('ok');
      expect(r.httpStatus).toBe(status);
      expect(r.fix).toBeUndefined();
    }
  });

  it('connected but HTTP 5xx → incompatible (reachable, wrong/broken API)', async () => {
    const r = classifyReachability(URL, { stage: 'connected', status: 502 });
    expect(r.verdict).toBe('incompatible');
    expect(r.detail).toContain('502');
  });

  it('TCP timeout → timeout with a firewall fix (ufw rule for the docker bridge)', async () => {
    const r = classifyReachability(URL, { stage: 'tcp', result: 'timeout' });
    expect(r.verdict).toBe('timeout');
    expect(r.fix).toContain('ufw allow from 172.17.0.0/16');
    expect(r.fix).toContain('port 11434');
  });

  it('ECONNREFUSED → refused with a 0.0.0.0 bind fix', async () => {
    const r = classifyReachability(URL, { stage: 'tcp', result: 'error', code: 'ECONNREFUSED' });
    expect(r.verdict).toBe('refused');
    expect(r.fix).toContain('OLLAMA_HOST=0.0.0.0');
  });

  it('DNS failures → dns', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
      expect(classifyReachability(URL, { stage: 'tcp', result: 'error', code }).verdict).toBe('dns');
    }
  });

  it('unknown socket error → error', async () => {
    expect(classifyReachability(URL, { stage: 'tcp', result: 'error', code: 'EHOSTUNREACH' }).verdict).toBe('error');
  });

  it('unrecognized shape → error', async () => {
    expect(classifyReachability(URL, {}).verdict).toBe('error');
  });
});

describe('probeContainerReachability skip paths (no container spawned)', () => {
  it('empty endpoint → skipped', async () => {
    expect((await probeContainerReachability('')).verdict).toBe('skipped');
    expect((await probeContainerReachability(null)).verdict).toBe('skipped');
  });

  it('non-loopback endpoint → skipped (rides the egress proxy, not a direct dial)', async () => {
    // A hosted/LAN endpoint must not be probed directly — that path is proxied.
    const r = await probeContainerReachability('https://api.example.com/v1');
    expect(r.verdict).toBe('skipped');
    expect(r.probedUrl).toBe('https://api.example.com/v1');
  });

  it('LAN IP endpoint → skipped', async () => {
    expect((await probeContainerReachability('http://192.168.0.100:11434')).verdict).toBe('skipped');
  });
});
