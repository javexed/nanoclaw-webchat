import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ CONTAINER_IMAGE: 'nanoclaw-agent:latest', CONTAINER_IMAGE_BASE: 'nanoclaw-agent' }));
vi.mock('./container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker' }));
const logs = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('./log.js', () => ({ log: { info: logs.info, error: logs.error, warn: vi.fn(), debug: vi.fn() } }));
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock, exec: vi.fn() }));

const { ensureFreshAgentImage, resetImageFreshnessState, REBUILD_BACKOFF_MS } =
  await import('./agent-image-freshness.js');

const TAG = 'nanoclaw-agent:ag-1';

/** inspect() answering the base id and the per-agent image's labels. */
function images(baseId: string | null, derivedFrom: string | null, source: string | null = 'derived') {
  return vi.fn(async (ref: string, format: string) => {
    if (ref === 'nanoclaw-agent:latest') return baseId;
    return format.includes('image-source') ? source : derivedFrom;
  });
}

describe('ensureFreshAgentImage', () => {
  beforeEach(() => {
    logs.info.mockReset();
    logs.error.mockReset();
    execFileMock.mockReset();
    resetImageFreshnessState();
  });

  it('rebuilds an image built on an older base, before the spawn goes on', async () => {
    const order: string[] = [];
    const build = vi.fn(async () => void order.push('build'));
    await ensureFreshAgentImage('ag-1', TAG, { imageBuild: true, inspect: images('sha256:new', 'sha256:old'), build });
    order.push('spawn');
    expect(build).toHaveBeenCalledWith('ag-1');
    expect(order).toEqual(['build', 'spawn']);
  });

  it('leaves an image already on the current base alone', async () => {
    const build = vi.fn(async () => {});
    await ensureFreshAgentImage('ag-1', TAG, { imageBuild: true, inspect: images('sha256:new', 'sha256:new'), build });
    expect(build).not.toHaveBeenCalled();
  });

  it('rebuilds its own image when the derived-from label is missing', async () => {
    const build = vi.fn(async () => {});
    await ensureFreshAgentImage('ag-1', TAG, { imageBuild: true, inspect: images('sha256:new', '<no value>'), build });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('never rebuilds an image that is not this agent’s own tag', async () => {
    const build = vi.fn(async () => {});
    const inspect = images('sha256:new', 'sha256:old');
    for (const tag of ['registry.example.com/custom:1', 'nanoclaw-agent:ag-2', 'other-agent:ag-1']) {
      await ensureFreshAgentImage('ag-1', tag, { imageBuild: true, inspect, build });
    }
    expect(build).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('never rebuilds an image NanoClaw did not derive, even under its tag', async () => {
    const build = vi.fn(async () => {});
    for (const source of ['<no value>', 'hardened', null]) {
      await ensureFreshAgentImage('ag-1', TAG, {
        imageBuild: true,
        inspect: images('sha256:new', '<no value>', source),
        build,
      });
    }
    expect(build).not.toHaveBeenCalled();
  });

  it('logs a failed rebuild and lets the spawn go on with the existing image', async () => {
    const build = vi.fn(async () => {
      throw new Error('apt mirror down');
    });
    await expect(
      ensureFreshAgentImage('ag-1', TAG, { imageBuild: true, inspect: images('sha256:new', 'sha256:old'), build }),
    ).resolves.toBeUndefined();
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining('rebuild failed'),
      expect.objectContaining({ agentGroupId: 'ag-1', err: 'apt mirror down' }),
    );
  });

  it('after a failure, leaves the same agent and base alone for the backoff, then tries again', async () => {
    let t = 1_000_000;
    const now = () => t;
    const build = vi.fn(async () => {
      throw new Error('apt mirror down');
    });
    const deps = { imageBuild: true, inspect: images('sha256:new', 'sha256:old'), build, now };
    await ensureFreshAgentImage('ag-1', TAG, deps);
    t += 60_000;
    await ensureFreshAgentImage('ag-1', TAG, deps);
    expect(build).toHaveBeenCalledTimes(1);
    t += REBUILD_BACKOFF_MS;
    await ensureFreshAgentImage('ag-1', TAG, deps);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('a new base is tried at once, even inside the backoff of the old one', async () => {
    const build = vi.fn(async () => {
      throw new Error('apt mirror down');
    });
    await ensureFreshAgentImage('ag-1', TAG, { imageBuild: true, inspect: images('sha256:b1', 'sha256:old'), build });
    await ensureFreshAgentImage('ag-1', TAG, { imageBuild: true, inspect: images('sha256:b2', 'sha256:old'), build });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('builds once for concurrent spawns of the same agent', async () => {
    let release!: () => void;
    const build = vi.fn(() => new Promise<void>((r) => (release = r)));
    const deps = { imageBuild: true, inspect: images('sha256:new', 'sha256:old'), build };
    const a = ensureFreshAgentImage('ag-1', TAG, deps);
    const b = ensureFreshAgentImage('ag-1', TAG, deps);
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([a, b]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('runs one rebuild at a time across agents; the other spawn starts on its existing image', async () => {
    let release!: () => void;
    const build = vi.fn((id: string) => (id === 'ag-1' ? new Promise<void>((r) => (release = r)) : Promise.resolve()));
    const inspect = images('sha256:new', 'sha256:old');
    const a = ensureFreshAgentImage('ag-1', 'nanoclaw-agent:ag-1', { imageBuild: true, inspect, build });
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    await ensureFreshAgentImage('ag-2', 'nanoclaw-agent:ag-2', { imageBuild: true, inspect, build });
    expect(build).toHaveBeenCalledTimes(1);
    release();
    await a;
    await ensureFreshAgentImage('ag-2', 'nanoclaw-agent:ag-2', { imageBuild: true, inspect, build });
    expect(build).toHaveBeenLastCalledWith('ag-2');
  });

  it('does nothing where the driver cannot build, or without a base to compare with', async () => {
    const build = vi.fn(async () => {});
    await ensureFreshAgentImage('ag-1', TAG, { imageBuild: false, inspect: images('sha256:new', 'sha256:old'), build });
    await ensureFreshAgentImage('ag-1', TAG, { imageBuild: true, inspect: images(null, 'sha256:old'), build });
    expect(build).not.toHaveBeenCalled();
  });

  it('inspects through execFile with an argument list, never a shell string', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], cb: (e: unknown, r: unknown) => void) =>
      cb(null, { stdout: '<no value>\n', stderr: '' }),
    );
    const build = vi.fn(async () => {});
    await ensureFreshAgentImage('ag-1', TAG, { imageBuild: true, build });
    expect(execFileMock).toHaveBeenCalled();
    for (const call of execFileMock.mock.calls) {
      expect(call[0]).toBe('docker');
      expect(Array.isArray(call[1])).toBe(true);
      expect(call[1].slice(0, 3)).toEqual(['image', 'inspect', '--format']);
    }
    expect(execFileMock.mock.calls[0][1].at(-1)).toBe('nanoclaw-agent:latest');
  });
});
