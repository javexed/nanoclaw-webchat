import type { App } from 'vue';
import { $ } from './dom.js';

/** Mount a Vue island into the element at `sel`, or return null when the host
 * is absent. Pair with `??=` so a mounted island is never created twice. */
export function mountIsland(sel: string, create: () => App): App | null {
  const host = $(sel);
  if (!host) return null;
  const app = create();
  app.mount(host);
  return app;
}
