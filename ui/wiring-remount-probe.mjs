/**
 * wiring-remount-probe.mjs — does the Wiring view survive a second render?
 *
 * Reported from the field: Wiring sits on "Loading…" forever.
 *
 * The mechanism is a mount-host collision. `#matrix-canvas` is BOTH the
 * placeholder target and the Vue island's mount host:
 *
 *   refreshMatrix()  canvas.textContent = 'Loading…'   ← wipes the island's DOM
 *   mountMatrix()    if (matrixApp) return;            ← refuses to rebuild it
 *
 * and matrixApp was never unmounted. So the FIRST render works and every
 * render after it leaves the placeholder on screen with nothing to replace it —
 * until a full page reload.
 *
 * Two ways in, both real: reopening the view, or pressing Refresh while it is
 * open. Refresh is the tighter reproduction, so that is what this drives.
 */
import { chromium } from 'playwright';

const URL_BASE = process.argv[2] || 'http://127.0.0.1:3196/';
const ME = 'tester';

const ROOMS = [{ id: 'general', name: 'General', thread_count: 0, pinned: 0, archived: 0 }];
const TOPOLOGY = {
  rooms: [{ id: 'general', name: 'General' }],
  agents: [
    { id: 'a1', name: 'Assistant', modelId: null, modelName: null },
    { id: 'a2', name: 'Analyst', modelId: null, modelName: null },
  ],
  edges: [{ room: 'general', agent: 'a1' }],
  models: [],
  mcpServers: [],
  mcpEdges: [],
  skills: [],
  skillEdges: [],
};

const FAKE_WS = ({ rooms, me }) => {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen && this.onopen({ type: 'open' });
        this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'system', message: `Connected as ${me}` }) });
        this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'rooms', rooms }) });
      }, 0);
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose && this.onclose({ type: 'close' });
    }
    addEventListener() {}
    removeEventListener() {}
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  window.WebSocket = FakeWebSocket;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.addInitScript(FAKE_WS, { rooms: ROOMS, me: ME });

// Hermetic. Catch-all FIRST — Playwright matches routes last-registered-first,
// so the specific stubs must come after it or they never win.
await page.route('**/*', (route) => {
  let host = '';
  try {
    host = new URL(route.request().url()).hostname;
  } catch {
    return route.fallback();
  }
  const local = host === '' || host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  return local ? route.fallback() : route.abort('blockedbyclient');
});
await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
await page.route('**/api/auth/check*', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, userId: ME }) }),
);
await page.route('**/api/topology*', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TOPOLOGY) }),
);

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#room-list li[data-room-id="general"]', { timeout: 20000 });

// Open Wiring through the overflow menu, the way a person does.
await page.click('#overflow-btn').catch(() => {});
await page.click('[data-action="wiring"]');
await page.waitForTimeout(600);

const read = async () => {
  const t = (await page.locator('#matrix-canvas').textContent()) ?? '';
  return {
    text: t.trim().slice(0, 40),
    loading: t.includes('Loading'),
    // The island renders room and agent labels; the placeholder renders neither.
    rendered: (await page.locator('#matrix-canvas *').count()) > 0,
  };
};

const first = await read();
console.log(`  first open      : rendered=${first.rendered} loading=${first.loading}  "${first.text}"`);

// Press Refresh — same code path as reopening the view, one less moving part.
await page.click('#matrix-refresh');
await page.waitForTimeout(600);
const second = await read();
console.log(`  after Refresh   : rendered=${second.rendered} loading=${second.loading}  "${second.text}"`);

// The other way in, and the one actually reported: leave the view and come
// back. Goes through teardownMatrix rather than the refresh handler, so it is
// a genuinely separate path to the same collision.
await page.click('#matrix-back').catch(() => {});
await page.waitForTimeout(300);
await page.click('#overflow-btn').catch(() => {});
await page.click('[data-action="wiring"]');
await page.waitForTimeout(600);
const third = await read();
console.log(`  close + reopen  : rendered=${third.rendered} loading=${third.loading}  "${third.text}"`);

if (pageErrors.length) console.log('  page errors     :', pageErrors[0].split('\n')[0]);

const ok =
  first.rendered && !first.loading && second.rendered && !second.loading && third.rendered && !third.loading;
console.log('');
console.log(
  ok
    ? '  ✅ Wiring renders on first open, after Refresh, and after close + reopen.'
    : '  ❌ REPRODUCED: the view is stuck on the placeholder after a re-render.',
);

await browser.close();
process.exit(ok ? 0 : 1);
