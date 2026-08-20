/**
 * classifyGatewayProbe — maps a OneCLI gateway probe to a startup log verdict.
 * Pins the diagnostics for the failure modes that have actually bitten this
 * project: unset URL, unreachable gateway, and an old gateway (no /v1 API).
 *
 * awaitGateway pins the retry policy that keeps a reboot's Docker-vs-systemd
 * race from being reported as a broken install.
 */
import { describe, it, expect } from 'vitest';

import { awaitGateway, classifyGatewayProbe, isTransientProbe } from './onecli-preflight.js';

describe('classifyGatewayProbe', () => {
  it('ONECLI_URL unset → warn with set-it guidance', async () => {
    const v = classifyGatewayProbe('unset');
    expect(v.level).toBe('warn');
    expect(v.message).toMatch(/ONECLI_URL is not set/);
  });

  it('unreachable (null) → error mentioning binding / docker port', async () => {
    const v = classifyGatewayProbe(null, 'http://172.17.0.1:10254');
    expect(v.level).toBe('error');
    expect(v.message).toMatch(/UNREACHABLE/);
    expect(v.message).toMatch(/ONECLI_BIND_HOST|docker port/);
  });

  it('404 → error: gateway too old (version-coupling), with upgrade command', async () => {
    const v = classifyGatewayProbe(404, 'http://172.17.0.1:10254');
    expect(v.level).toBe('error');
    expect(v.message).toMatch(/too OLD|no \/v1/i);
    expect(v.message).toMatch(/docker compose pull/);
  });

  it('200 → info: credential path OK', async () => {
    const v = classifyGatewayProbe(200, 'http://172.17.0.1:10254');
    expect(v.level).toBe('info');
    expect(v.message).toMatch(/reachable.*OK/);
  });

  it('401/403/405 (endpoint exists, just auth/method) → treated as OK, not 404', async () => {
    for (const s of [401, 403, 405]) {
      expect(classifyGatewayProbe(s, 'http://x').level).toBe('info');
    }
  });
});

describe('isTransientProbe', () => {
  it('only an unreachable gateway is worth waiting on', async () => {
    expect(isTransientProbe(null)).toBe(true);
    // A too-old gateway and a missing URL both need a human; waiting hides them.
    expect(isTransientProbe(404)).toBe(false);
    expect(isTransientProbe('unset')).toBe(false);
    expect(isTransientProbe(200)).toBe(false);
  });
});

describe('awaitGateway', () => {
  /** Virtual clock: the retry policy is worth pinning, 60s of real waiting is not. */
  const clock = () => {
    let elapsed = 0;
    return { sleep: async (ms: number) => void (elapsed += ms), elapsed: () => elapsed };
  };

  it('a gateway that comes up late settles, and reports how long it took', async () => {
    const { sleep, elapsed } = clock();
    let calls = 0;
    // Refused twice (still binding its port), then answers — the reboot shape.
    const probe = async () => (++calls < 3 ? null : 200);

    const wait = await awaitGateway(probe, sleep, { budgetMs: 60_000, intervalMs: 2_000 });

    expect(wait.settled).toBe(true);
    expect(wait.probe).toBe(200);
    expect(wait.attempts).toBe(3);
    expect(wait.waitedMs).toBe(6_000);
    expect(elapsed()).toBe(6_000);
  });

  it('gives up at the budget rather than retrying forever', async () => {
    const { sleep } = clock();
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return null;
    };

    const wait = await awaitGateway(probe, sleep, { budgetMs: 10_000, intervalMs: 2_000 });

    expect(wait.settled).toBe(false);
    expect(wait.probe).toBeNull();
    expect(wait.waitedMs).toBe(10_000);
    expect(calls).toBe(5);
    // Giving up must still produce the actionable error, not silence.
    expect(classifyGatewayProbe(wait.probe, 'http://172.17.0.1:10254').level).toBe('error');
  });

  it('stops on a definite-but-bad answer instead of burning the budget', async () => {
    const { sleep } = clock();
    // 404 = gateway up but too old. Retrying cannot fix it, so report immediately.
    const wait = await awaitGateway(async () => 404, sleep, { budgetMs: 60_000, intervalMs: 2_000 });

    expect(wait.settled).toBe(true);
    expect(wait.attempts).toBe(1);
    expect(classifyGatewayProbe(wait.probe, 'http://x').message).toMatch(/too OLD/);
  });
});
