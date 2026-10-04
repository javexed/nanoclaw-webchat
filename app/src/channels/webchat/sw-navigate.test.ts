/**
 * The service worker's page loads (public/webchat/sw.js navigate()): the
 * server is asked first, so a sign-in front door's redirect reaches the
 * browser — served from cache, an expired session only ever came back with a
 * hard refresh. Run in a sandbox with fetch and the cache stubbed.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, expect, it } from 'vitest';

const SW = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'webchat', 'sw.js'), 'utf8');
const shell = { type: 'basic', status: 200, from: 'cache' };

/** Load sw.js with `fetch` answering as given; returns a page load's response for `url`. */
function load(fetchAnswer: () => Promise<unknown>) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const sandbox = {
    self: {
      addEventListener: (name: string, fn: (e: unknown) => void) => (handlers[name] = fn),
      registration: { scope: 'https://chat.example/' },
      clients: {},
      skipWaiting: () => {},
    },
    caches: { match: async (key: unknown) => (key === '/' ? shell : undefined), open: async () => ({ put: () => {} }) },
    fetch: fetchAnswer,
    Response: class {
      constructor(
        readonly body: unknown,
        readonly init: { status: number },
      ) {}
      get status() {
        return this.init.status;
      }
    },
    URL,
    setTimeout,
    Promise,
    indexedDB: undefined,
  };
  vm.runInNewContext(SW, sandbox);
  return (url: string, mode = 'navigate') =>
    new Promise((resolve) => {
      handlers.fetch!({ request: { url, mode }, respondWith: (p: Promise<unknown>) => void p.then(resolve) });
    });
}

describe('sw.js page loads', () => {
  it('passes a sign-in redirect, 401 or 403 to the browser instead of the cached app', async () => {
    for (const answer of [
      { type: 'opaqueredirect', status: 0 },
      { type: 'basic', status: 401 },
      { type: 'basic', status: 403 },
    ])
      expect(await load(async () => answer)('https://chat.example/')).toBe(answer);
  });

  it('serves the cached shell when the server answers, so the page matches the cached scripts', async () => {
    expect(await load(async () => ({ type: 'basic', status: 200, from: 'network' }))('https://chat.example/')).toBe(
      shell,
    );
  });

  it('serves the cached shell when the server is slow or unreachable', async () => {
    expect(await load(() => new Promise(() => {}))('https://chat.example/')).toBe(shell); // NAV_TIMEOUT_MS, then the cache
    expect(await load(async () => Promise.reject(new TypeError('offline')))('https://chat.example/')).toBe(shell);
  }, 10_000);

  it("leaves the front door's own endpoints to the browser", () => {
    let answered = false;
    const handlers: Record<string, (e: unknown) => void> = {};
    vm.runInNewContext(SW, {
      self: { addEventListener: (n: string, fn: (e: unknown) => void) => (handlers[n] = fn), skipWaiting: () => {} },
      URL,
    });
    handlers.fetch!({
      request: { url: 'https://chat.example/.auth/login/aad', mode: 'navigate' },
      respondWith: () => (answered = true),
    });
    expect(answered).toBe(false);
  });
});
