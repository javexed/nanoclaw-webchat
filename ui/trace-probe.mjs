/**
 * trace-probe.mjs — do a reply's Thoughts survive a reload, without history
 * fetching any trace?
 *
 * Drives the built bundle against a fake socket:
 *   1. history carries one reply with `has_trace` and one without: only the
 *      first gets a Thoughts disclosure, and NO trace is fetched yet;
 *   2. opening it from the keyboard fetches the stored trace once and renders
 *      harness · model · host · duration, the tools and the reasoning; a second
 *      open does not fetch again;
 *   3. a live turn's expanded bubble and its reply's Thoughts render the same
 *      view from the status frames, and a `trace` frame makes the reply fetch
 *      its stored copy.
 *
 * Exit 0 = all held, 1 = an assertion failed, 2 = the page could not be driven.
 */
import { chromium } from 'playwright';

const URL_BASE = process.argv[2] || 'http://127.0.0.1:3198/';
const ME = 'tester';
const ROOM = { id: 'gardens', name: 'Gardens', thread_count: 0, pinned: 0, archived: 0 };
const T0 = Date.now() - 60_000;

const HISTORY = [
  { id: 'm-user', room_id: 'gardens', thread_id: 'main', sender: ME, sender_type: 'user', content: 'Read my notes', message_type: 'text', created_at: T0 },
  { id: 'm-hist', room_id: 'gardens', thread_id: 'main', sender: 'AG', sender_type: 'agent', content: 'Done reading.', message_type: 'text', created_at: T0 + 1000, has_trace: true },
  { id: 'm-plain', room_id: 'gardens', thread_id: 'main', sender: 'AG', sender_type: 'agent', content: 'Anything else?', message_type: 'text', created_at: T0 + 2000 },
];

const STORED = {
  'm-hist': {
    v: 1, agent: 'AG', harness: 'pi', model: 'example-model:4b', host: 'models.example:11434',
    startedAt: T0, endedAt: T0 + 12_300, durationMs: 12_300, outcome: 'done',
    tools: [{ name: 'Read', target: 'notes.md', at: T0 + 100, ms: 850, ok: true }],
    notes: [], reasoning: ['The notes are in notes.md, so read them first.'], truncated: false,
  },
  'm-live': {
    v: 1, agent: 'AG', harness: 'pi', model: 'example-model:4b', host: 'models.example:11434',
    startedAt: T0, endedAt: T0 + 2000, durationMs: 2000, outcome: 'done',
    tools: [{ name: 'Bash', target: 'ls -la', at: T0, ms: 40, ok: null }],
    notes: [], reasoning: ['STORED live reasoning'], truncated: false,
  },
};

const FAKE_WS = ({ room, me, history }) => {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      window.__sock = this;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen && this.onopen({ type: 'open' });
        this.push({ type: 'system', message: `Connected as ${me}` });
        this.push({ type: 'rooms', rooms: [room] });
      }, 0);
    }
    push(m) {
      this.onmessage && this.onmessage({ data: JSON.stringify(m) });
    }
    send(payload) {
      const m = JSON.parse(payload);
      if (m.type === 'join') {
        setTimeout(() => this.push({ type: 'history', room_id: m.room_id, thread_id: m.thread_id || 'main', messages: history }), 0);
      }
    }
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

let failures = 0;
function check(label, ok, got) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `   got ${JSON.stringify(got)}`}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const traceFetches = [];

  await page.addInitScript(FAKE_WS, { room: ROOM, me: ME, history: HISTORY });
  // Hermetic, catch-all FIRST (Playwright matches the last-registered route first).
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
  await page.route('**/api/webchat/onboarding*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"complete":true,"canEdit":false}' }),
  );
  await page.route(/\/api\/messages\/[^/]+\/trace$/, (r) => {
    const id = decodeURIComponent(new URL(r.request().url()).pathname.split('/')[3]);
    traceFetches.push(id);
    const trace = STORED[id];
    return trace
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message_id: id, trace }) })
      : r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"No trace for this message"}' });
  });

  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector(`#room-list li[data-room-id="${ROOM.id}"]`, { timeout: 20000 });
    await page.click(`#room-list li[data-room-id="${ROOM.id}"]`);
    await page.waitForSelector('[data-message-id="m-plain"]', { timeout: 10000 });
  } catch (e) {
    console.log('  ✗ could not open the room:', String(e).split('\n')[0]);
    if (pageErrors.length) console.log('    pageErrors:', pageErrors.slice(0, 3).join(' | ').slice(0, 500));
    await browser.close();
    process.exit(2);
  }

  console.log('history');
  const hist = '[data-message-id="m-hist"] details.thoughts';
  check('reply with has_trace shows Thoughts', (await page.locator(hist).count()) === 1, await page.locator(hist).count());
  check(
    'reply without a trace shows none',
    (await page.locator('[data-message-id="m-plain"] details.thoughts').count()) === 0,
    await page.locator('[data-message-id="m-plain"] details.thoughts').count(),
  );
  check('history fetched no trace', traceFetches.length === 0, traceFetches);

  if ((await page.locator(hist).count()) === 0) {
    // Nothing to open: the rest would only crash on a missing element.
    await browser.close();
    console.log(`\n❌ turn traces: ${failures} check(s) failed`);
    process.exit(1);
  }

  // Keyboard: focus the summary and press Enter.
  await page.focus(`${hist} > summary`);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${hist} .trace-meta`, { timeout: 5000 }).catch(() => {});
  const opened = await page.evaluate((sel) => {
    const d = document.querySelector(sel);
    return {
      open: !!d?.open,
      meta: d?.querySelector('.trace-meta')?.textContent ?? null,
      tool: [...(d?.querySelectorAll('.trace-tool') ?? [])].map((li) => li.textContent),
      okLabel: d?.querySelector('.trace-tool-ok')?.getAttribute('aria-label') ?? null,
      reasoning: d?.querySelector('.trace-reasoning')?.textContent ?? null,
      summary: d?.querySelector('summary')?.textContent ?? null,
    };
  }, hist);
  console.log('first open');
  check('opens from the keyboard', opened.open, opened.open);
  check('one fetch, for that reply', traceFetches.join() === 'm-hist', traceFetches);
  check('harness · model · host · duration', opened.meta === 'pi · example-model:4b · models.example:11434 · 12.3s', opened.meta);
  check('tool with target, time and result', opened.tool[0] === '✓Readnotes.md850ms' && opened.okLabel === 'Succeeded', opened);
  check('reasoning', opened.reasoning === STORED['m-hist'].reasoning[0], opened.reasoning);
  check('summary counts the reasoning', /Thoughts \(1\)/.test(opened.summary ?? ''), opened.summary);

  await page.click(`${hist} > summary`);
  await page.click(`${hist} > summary`);
  await page.waitForTimeout(200);
  check('reopening does not fetch again', traceFetches.length === 1, traceFetches);

  // ── A live turn ──
  console.log('live turn');
  const push = (m) => page.evaluate((x) => window.__sock.push(x), m);
  const base = { type: 'status', room_id: ROOM.id, agent_name: 'AG' };
  await push({ ...base, event: 'start' });
  await push({ type: 'turn_meta', room_id: ROOM.id, agent_name: 'AG', harness: 'pi', model: 'example-model:4b', host: 'models.example:11434' });
  await push({ ...base, event: 'tool', text: 'Bash', detail: 'ls -la' });
  await push({ ...base, event: 'reasoning', text: 'listing first', detail: 'listing first, then answer' });
  await page.waitForSelector('.thinking-bubble[data-agent="AG"]', { timeout: 5000 });
  await page.focus('.thinking-bubble[data-agent="AG"] .thinking-chevron');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const bubble = await page.evaluate(() => {
    const b = document.querySelector('.thinking-bubble[data-agent="AG"]');
    return {
      expanded: b?.classList.contains('expanded') ?? false,
      aria: b?.querySelector('.thinking-chevron')?.getAttribute('aria-expanded') ?? null,
      meta: b?.querySelector('.trace-meta')?.textContent ?? null,
      tool: b?.querySelector('.trace-tool-name')?.textContent ?? null,
      reasoning: b?.querySelector('.trace-reasoning')?.textContent ?? null,
    };
  });
  check('bubble expands from the keyboard', bubble.expanded && bubble.aria === 'true', bubble);
  check('bubble shows harness · model · host', bubble.meta === 'pi · example-model:4b · models.example:11434', bubble.meta);
  check('bubble shows the tool and full reasoning', bubble.tool === 'Bash' && bubble.reasoning === 'listing first, then answer', bubble);

  await push({
    type: 'message', id: 'm-live', room_id: ROOM.id, thread_id: 'main', sender: 'AG', sender_type: 'agent',
    content: 'Here is the listing.', message_type: 'text', created_at: Date.now(),
  });
  await page.waitForSelector('[data-message-id="m-live"]', { timeout: 5000 });
  const live = '[data-message-id="m-live"] details.thoughts';
  await page.click(`${live} > summary`);
  await page.waitForTimeout(150);
  const liveView = await page.evaluate((sel) => {
    const d = document.querySelector(sel);
    return {
      meta: d?.querySelector('.trace-meta')?.textContent ?? null,
      tool: d?.querySelector('.trace-tool-name')?.textContent ?? null,
      reasoning: d?.querySelector('.trace-reasoning')?.textContent ?? null,
    };
  }, live);
  check('reply carries the live turn, same view', liveView.tool === 'Bash' && /^pi · example-model:4b · models\.example:11434/.test(liveView.meta ?? '') && liveView.reasoning === 'listing first, then answer', liveView);
  check('live reply fetched nothing yet', traceFetches.length === 1, traceFetches);

  await push({ type: 'trace', room_id: ROOM.id, thread_id: 'main', message_id: 'm-live' });
  await page.click(`${live} > summary`);
  await page.click(`${live} > summary`);
  await page.waitForTimeout(300);
  const stored = await page.evaluate((sel) => document.querySelector(sel)?.querySelector('.trace-reasoning')?.textContent ?? null, live);
  check('after the trace frame it shows the stored copy', traceFetches.join() === 'm-hist,m-live' && stored === 'STORED live reasoning', { traceFetches, stored });

  if (pageErrors.length) {
    failures++;
    console.log('  ✗ page errors:', pageErrors.slice(0, 3).join(' | ').slice(0, 500));
  }
  await browser.close();
  console.log(failures ? `\n❌ turn traces: ${failures} check(s) failed` : '\n✅ turn traces: Thoughts load on demand and render the same live and stored');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
