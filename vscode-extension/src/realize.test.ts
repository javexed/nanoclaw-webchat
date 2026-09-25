// Conformance bar: the argv the runner builds for the central fixture equals,
// flag for flag and in order, what drivers/docker-driver.ts emits for the same
// spec (see its "emits the agent container..." and hardening tests). The two
// laptop-owned decisions (runtime, uid) are tested as explicit rules.
import { describe, expect, it } from 'vitest';
import { createArgs, hostPathFor, substituteRelay, userArgs } from './realize.js';
import { RELAY_SENTINEL, type RemoteSpec } from './remote-spec.js';

const fixture = (): RemoteSpec => ({
  v: 1,
  key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
  name: 'ncl-spike-s1',
  labels: { 'nanoclaw-container-name': 'nanoclaw-v2-agent-one-1700000000000', 'nanoclaw-group-folder': 'agent-one' },
  image: 'nanoclaw-agent:spike-p0',
  env: { TZ: 'UTC', HTTPS_PROXY: RELAY_SENTINEL },
  contributedEnv: {},
  command: ['bash', '-c'],
  args: ['exec bun run /app/src/index.ts'],
  containerLabels: { 'session-channel': 'channel-abc' },
  mounts: [],
  resources: { shmSizeMb: 1024, pidsLimit: 2048 },
  hardening: 'standard',
  runAs: { uid: 501, gid: 1000 },
  stopGraceSeconds: 1,
  network: 'default',
});
const mounts = [
  {
    hostPath: '/home/dev/.vscode-server/data/User/globalStorage/nanoclaw.vscode/runner/state/data/v2-sessions/g1/s1',
    containerPath: '/workspace',
    mode: 'rw' as const,
  },
  { hostPath: '/home/dev/cache/abc/tree', containerPath: '/app/src', mode: 'ro' as const },
];
const relay = 'http://host.docker.internal:17321';

describe('createArgs', () => {
  it('docker on Linux (WSL remote): matches the docker driver argv for the fixture, in order, with the laptop uid', () => {
    const args = createArgs(fixture(), mounts, {
      runtime: 'docker',
      platform: 'linux',
      relayUrl: relay,
      localUser: { uid: 1000, gid: 1000 },
    });
    expect(args).toEqual([
      'create',
      '--rm',
      '--name',
      'ncl-spike-s1',
      '--label',
      'nanoclaw-install=spike',
      '--label',
      'nanoclaw-group=g1',
      '--label',
      'nanoclaw-session=s1',
      '--label',
      'nanoclaw-role=agent',
      '--label',
      'nanoclaw-container-name=nanoclaw-v2-agent-one-1700000000000',
      '--label',
      'nanoclaw-group-folder=agent-one',
      '--label',
      'session-channel=channel-abc',
      '--shm-size=1024m',
      '--cap-drop=ALL',
      '--security-opt',
      'no-new-privileges',
      '--init',
      '--pids-limit',
      '2048',
      '--user',
      '1000:1000',
      '-e',
      'TZ=UTC',
      '-e',
      `HTTPS_PROXY=${relay}`,
      '-v',
      `${mounts[0].hostPath}:/workspace`,
      '-v',
      `${mounts[1].hostPath}:/app/src:ro`,
      '--network',
      'none',
      '--entrypoint',
      'bash',
      'nanoclaw-agent:spike-p0',
      '-c',
      'exec bun run /app/src/index.ts',
    ]);
  });
  it('podman on Windows: keep-id user namespace, drive paths mapped to /mnt/<drive>, no network and no host alias', () => {
    const win = [
      {
        hostPath:
          'C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\globalStorage\\nanoclaw.vscode\\runner\\state\\data\\v2-sessions\\g1\\s1',
        containerPath: '/workspace',
        mode: 'rw' as const,
      },
    ];
    const a = createArgs(fixture(), win, { runtime: 'podman', platform: 'win32', relayUrl: relay });
    expect(a.join(' ')).toContain('--userns keep-id:uid=501,gid=1000 --user 501:1000');
    expect(a).toContain('-v');
    expect(a).toContain(
      '/mnt/c/Users/dev/AppData/Roaming/Code/User/globalStorage/nanoclaw.vscode/runner/state/data/v2-sessions/g1/s1:/workspace',
    );
    expect(a.join(' ')).toContain('--network none');
    expect(a.join(' ')).not.toContain('--add-host');
    expect(hostPathFor('D:/proj/x', { runtime: 'podman', platform: 'win32' })).toBe('/mnt/d/proj/x');
    expect(hostPathFor('C:\\x', { runtime: 'docker', platform: 'win32' })).toBe('C:\\x');
  });
  it('the uid rule: no runAs -> no user flags; local user wins over the spec numbers; podman pins the namespace', () => {
    const noUser = { ...fixture(), runAs: undefined };
    expect(
      userArgs(noUser, { runtime: 'podman', platform: 'linux', relayUrl: relay, localUser: { uid: 1, gid: 1 } }),
    ).toEqual([]);
    expect(userArgs(fixture(), { runtime: 'docker', platform: 'win32', relayUrl: relay })).toEqual([
      '--user',
      '501:1000',
    ]);
    expect(
      userArgs(fixture(), {
        runtime: 'podman',
        platform: 'linux',
        relayUrl: relay,
        localUser: { uid: 1001, gid: 1001 },
      }),
    ).toEqual(['--userns', 'keep-id:uid=1001,gid=1001', '--user', '1001:1001']);
  });
  it('omits pids for 0/negative, adds cpu/memory when set, every runtime/platform gets --network none and never a host alias', () => {
    const a = createArgs({ ...fixture(), resources: { pidsLimit: 0, cpus: '2', memoryMb: 8192 } }, [], {
      runtime: 'docker',
      platform: 'darwin',
      relayUrl: relay,
    });
    expect(a.join(' ')).not.toContain('--pids-limit');
    expect(a.join(' ')).toContain('--cpus 2 --memory 8192m');
    expect(a.join(' ')).not.toContain('--add-host');
    expect(a.join(' ')).toContain('--network none');
    // Even a spec that asks for a network gets none: the laptop asserts this.
    const n = createArgs({ ...fixture(), network: 'default' }, [], {
      runtime: 'podman',
      platform: 'linux',
      relayUrl: relay,
    });
    expect(n.join(' ')).toContain('--network none');
    expect(n.join(' ')).not.toContain('--add-host');
  });
  it('only the sentinel is substituted; other values are untouched', () => {
    expect(substituteRelay({ A: RELAY_SENTINEL, B: 'http://host.docker.internal:10255' }, 'R')).toEqual({
      A: 'R',
      B: 'http://host.docker.internal:10255',
    });
  });
});
