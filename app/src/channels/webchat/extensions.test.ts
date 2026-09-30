/**
 * Webchat extension points: inert with nothing installed, and an extension's
 * routes, startup and feature name reach the real server through them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WebchatServer } from './server.js';
import { loadServer, noopHooks, portOf, PROXY_ENV } from './test-server.js';

describe('extension points with nothing installed', () => {
  it('are inert', async () => {
    vi.resetModules();
    const ext = await import('./extensions.js');
    expect(ext.extensionRoutes()).toEqual([]);
    expect(ext.installedFeatures()).toEqual([]);
    expect(await ext.isRemotelyPlaced('ag-1')).toBe(false);
    expect(await ext.extensionSigninSections()).toEqual({});
    expect(() => ext.runServerStart({ chatInbound: () => {} })).not.toThrow();
    expect(() => ext.runChannelStart()).not.toThrow();
  });
});

describe('an installed extension', () => {
  let wc: WebchatServer | undefined;
  let server: typeof import('./server.js');
  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
    wc = undefined;
    vi.unstubAllEnvs();
  });

  async function start(install: (ext: typeof import('./extensions.js')) => void): Promise<string> {
    ({ server } = await loadServer(PROXY_ENV));
    install(await import('./extensions.js'));
    wc = await server.startWebchatServer(noopHooks);
    return `http://127.0.0.1:${portOf(wc)}`;
  }
  const as = (user: string) => ({ headers: { 'x-forwarded-user': user } });

  it('serves its routes through core dispatch, guards included', async () => {
    const base = await start((ext) =>
      ext.registerRoutes([
        { method: 'GET', path: '/api/probe-ext', h: (ctx) => void ctx.res.end(JSON.stringify({ who: ctx.userId })) },
        { method: 'GET', path: '/api/probe-ext/admin', guards: ['globalAdmin'], h: (ctx) => void ctx.res.end('{}') },
      ]),
    );
    // The first proxy sign-in becomes the owner; a second user holds no role.
    const res = await fetch(`${base}/api/probe-ext`, as('sam@example.org'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: 'webchat:sam@example.org' });
    expect((await fetch(`${base}/api/probe-ext/admin`, as('sam@example.org'))).status).toBe(200);
    expect((await fetch(`${base}/api/probe-ext/admin`, as('kim@example.org'))).status).toBe(403);
  });

  it('cannot shadow a core route', async () => {
    const base = await start((ext) =>
      ext.registerRoutes([
        { method: 'GET', path: '/api/webchat/features', h: (ctx) => void ctx.res.end('"shadowed"') },
      ]),
    );
    const body = await (await fetch(`${base}/api/webchat/features`, as('sam@example.org'))).json();
    expect(body).not.toBe('shadowed');
  });

  it('runs its startup, survives one that throws, and lists its feature for the UI', async () => {
    const started: string[] = [];
    const base = await start((ext) => {
      ext.onServerStart(() => {
        throw new Error('broken extension');
      });
      ext.onServerStart(() => void started.push('second'));
      ext.registerFeature('probe');
    });
    expect(started).toEqual(['second']);
    const body = (await (await fetch(`${base}/api/webchat/features`, as('sam@example.org'))).json()) as {
      extensions: string[];
    };
    expect(body.extensions).toEqual(['probe']);
  });
});
