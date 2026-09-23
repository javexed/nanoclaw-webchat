/**
 * The install engine, exercised through a registered fake — a chain of
 * in-process steps, so nothing spawns. What is asserted is the contract every
 * feature now gets for free: the refusals and their order, progress stamping,
 * the log, and the restart-pending reading of a green chain this process
 * cannot yet see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetFeatureInstallsForTest,
  allPreflights,
  hasFeatureInstall,
  installStatus,
  listFeatureInstalls,
  registerFeatureInstall,
  skillPreflight,
  startFeatureInstall,
  type InstallStep,
} from './install-engine.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

function register(
  opts: {
    installed?: () => boolean;
    steps?: InstallStep[];
    preflight?: () => { code: string; error: string } | null;
  } = {},
) {
  let installed = false;
  registerFeatureInstall('thing', {
    label: 'Thing',
    restarts: true,
    installed: opts.installed ?? (() => installed),
    preflight: opts.preflight,
    steps: () =>
      opts.steps ?? [
        { call: () => undefined, label: 'first' },
        { call: () => undefined, label: 'second' },
      ],
  });
  return { setInstalled: (v: boolean) => (installed = v) };
}

beforeEach(() => _resetFeatureInstallsForTest());
afterEach(() => _resetFeatureInstallsForTest());

describe('install engine', () => {
  it('lists what is registered and throws on what is not', async () => {
    register();
    expect(listFeatureInstalls()).toEqual(['thing']);
    expect(hasFeatureInstall('other')).toBe(false);
    await expect(installStatus('other')).rejects.toThrow(/No install registered/);
  });

  it('starts idle: not running, not installed, no restart pending', async () => {
    register();
    expect(await installStatus('thing')).toMatchObject({
      feature: 'thing',
      running: false,
      installed: false,
      restartPending: false,
      exitCode: null,
      stepIndex: 0,
    });
  });

  it('a green chain this process cannot see reads as restart pending, not failure', async () => {
    register();
    expect(await startFeatureInstall('thing', '/nowhere')).toEqual({ started: true });
    await tick();
    const st = await installStatus('thing');
    expect(st).toMatchObject({ running: false, exitCode: 0, installed: false, restartPending: true, stepCount: 2 });
    expect(st.lines).toEqual(['→ first …', '→ second …']);
  });

  it('an install that lands in-process never claims a restart is pending', async () => {
    registerFeatureInstall('inplace', {
      label: 'In place',
      installed: () => false,
      steps: () => [{ call: () => undefined, label: 'x' }],
    });
    await startFeatureInstall('inplace', '/nowhere');
    await tick();
    expect(await installStatus('inplace')).toMatchObject({ exitCode: 0, installed: false, restartPending: false });
  });

  it('a `-c <script>` step is named after the shell, not the script text', async () => {
    registerFeatureInstall('sh', {
      label: 'Sh',
      installed: () => false,
      steps: () => [{ run: ['sh', ['-c', 'echo one two\nexit 0']] }],
    });
    await startFeatureInstall('sh', '/nowhere');
    expect((await installStatus('sh')).stepLabel).toBe('sh');
  });

  it('once installed, the same state is simply done', async () => {
    const { setInstalled } = register();
    await startFeatureInstall('thing', '/nowhere');
    await tick();
    setInstalled(true);
    expect(await installStatus('thing')).toMatchObject({ installed: true, restartPending: false });
  });

  it('refuses in order: installed, running, preflight', async () => {
    const { setInstalled } = register({
      steps: [{ call: () => new Promise((r) => setTimeout(r, 50)), label: 'slow' }],
    });
    setInstalled(true);
    expect(await startFeatureInstall('thing', '/nowhere')).toMatchObject({ started: false, code: 'already-installed' });
    setInstalled(false);
    expect(await startFeatureInstall('thing', '/nowhere')).toEqual({ started: true });
    expect(await startFeatureInstall('thing', '/nowhere')).toMatchObject({ started: false, code: 'already-running' });
    expect(await installStatus('thing')).toMatchObject({ running: true, stepIndex: 1, stepLabel: 'slow' });
  });

  it('a preflight refusal is returned as a code, and nothing runs', async () => {
    register({ preflight: () => ({ code: 'skill-missing', error: 'no skill' }) });
    expect(await startFeatureInstall('thing', '/nowhere')).toEqual({
      started: false,
      code: 'skill-missing',
      error: 'no skill',
    });
    expect((await installStatus('thing')).running).toBe(false);
  });

  it('a failing step ends the chain with its code and the error in the log', async () => {
    register({
      steps: [
        {
          call: () => {
            throw new Error('boom');
          },
          label: 'bad',
        },
        { call: () => undefined, label: 'never' },
      ],
    });
    await startFeatureInstall('thing', '/nowhere');
    await tick();
    const st = await installStatus('thing');
    expect(st).toMatchObject({ running: false, exitCode: 1, restartPending: false });
    expect(st.lines.join('\n')).toContain('✗ boom');
    expect(st.lines.join('\n')).not.toContain('never');
  });

  it('an idempotent install may run again while installed; args reach preflight, onStart and steps', async () => {
    const seen: string[] = [];
    registerFeatureInstall<{ who: string }>('again', {
      label: 'Again',
      idempotent: true,
      installed: () => true,
      status: () => ({ extra: 1 }),
      preflight: (_r, a) => (a.who === 'nobody' ? { code: 'who', error: 'no' } : null),
      onStart: (_r, a) => void seen.push('start:' + a.who),
      steps: (_r, a) => [{ call: () => void seen.push('step:' + a.who), label: a.who }],
    });
    expect(await startFeatureInstall('again', '/nowhere', { who: 'nobody' })).toMatchObject({ code: 'who' });
    expect(await startFeatureInstall('again', '/nowhere', { who: 'me' })).toEqual({ started: true });
    await tick();
    expect(seen).toEqual(['start:me', 'step:me']);
    expect(await installStatus('again')).toMatchObject({
      installed: true,
      restartPending: false,
      extra: 1,
      exitCode: 0,
    });
  });

  it('skillPreflight and allPreflights: first refusal wins, null when all clear', () => {
    const missing = skillPreflight('add-nothing');
    expect(missing('/nowhere')).toMatchObject({ code: 'skill-missing' });
    expect(allPreflights(() => null, missing)('/nowhere')).toMatchObject({ code: 'skill-missing' });
    expect(
      allPreflights(
        () => null,
        () => null,
      )('/nowhere'),
    ).toBeNull();
  });
});
