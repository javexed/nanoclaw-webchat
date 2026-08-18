/**
 * first-open-probe.mjs — does tapping a room right after the app is resumed
 * actually open it?
 *
 * The reported symptom: the first room tapped after opening the app does not
 * open; tapping a DIFFERENT room and then tapping back works. This probe
 * reproduces the window that causes it.
 *
 * The window is real only on RESUME, not on a cold load: room rows are painted
 * from the WS `rooms` message, so on a cold load there is nothing to click
 * until the socket is already OPEN. After a resume the rows are still on
 * screen from the previous connection while `connect()` has just installed a
 * fresh CONNECTING socket — and `send()` on a CONNECTING socket throws.
 *
 * Socket generations:
 *   #1  opens, authenticates, delivers two rooms  (the previous session)
 *   #2  stays CONNECTING and throws on send()     (the resume reconnect)
 *
 * Generation #2 models a real browser exactly: WebSocket.send() on a socket in
 * CONNECTING state throws InvalidStateError. `state.ws?.send(...)` guards a
 * NULL socket, not a connecting one, so the throw lands mid-joinRoom.
 */
import { chromium } from 'playwright';

const URL_BASE = process.argv[2] || 'http://127.0.0.1:3197/';
const ME = 'tester';

const ROOMS = [
  { id: 'project-management', name: 'Project Management', thread_count: 0, pinned: 0, archived: 0 },
  { id: 'excavating', name: 'Excavating', thread_count: 0, pinned: 0, archived: 0 },
];

const FAKE_WS = ({ rooms, me }) => {
  let generation = 0;
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.generation = ++generation;
      window.__wsGeneration = this.generation;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;

      if (this.generation === 1) {
        // The previous, healthy session.
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1;
          window.__sock1 = this;
          this.onopen && this.onopen({ type: 'open' });
          this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'system', message: `Connected as ${me}` }) });
          this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'rooms', rooms }) });
        }, 0);
      } else {
        // The resume reconnect: still negotiating. The probe opens it by hand
        // later, to check the deferred join lands.
        this.readyState = 0;
        window.__sock2 = this;
      }
    }
    send(payload) {
      if (this.readyState !== 1) {
        // Exactly what a browser does. Recorded so the probe can prove the
        // throw happened rather than inferring it from the DOM.
        window.__sendThrewOn = (window.__sendThrewOn || []).concat(payload);
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          'InvalidStateError',
        );
      }
      window.__sent = (window.__sent || []).concat(payload);
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

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.addInitScript(FAKE_WS, { rooms: ROOMS, me: ME });

  // Hermetic: block egress, stub the API surface this path touches.
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
  // ORDER MATTERS: Playwright matches routes LAST-registered-first, so the
  // catch-all goes FIRST and the specific stubs after it. Registered the other
  // way round the catch-all swallows /api/auth/check, the identity probe fails,
  // and the onboarding wizard can cover the room list — a probe that then times
  // out looking for a row that is rendered but obscured.
  await page.route('**/api/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/auth/check*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, userId: ME }) }),
  );

  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });

  // Session 1 is up and the rooms are painted.
  try {
    await page.waitForSelector('#room-list li[data-room-id="project-management"]', { timeout: 20000 });
  } catch {
    // A bare "timeout waiting for selector" is unactionable on a runner you
    // cannot attach to. Dump what the page ACTUALLY looks like — the usual
    // causes are the onboarding wizard covering the list, an identity probe
    // that failed, or the rooms message never arriving.
    const diag = await page.evaluate(() => ({
      wsGeneration: window.__wsGeneration ?? null,
      roomListHtml: (document.querySelector('#room-list')?.innerHTML ?? '').slice(0, 300),
      roomRows: document.querySelectorAll('#room-list li[data-room-id]').length,
      identity: window.__probeIdentity ?? null,
      visibleTop: [...document.querySelectorAll('body > *, #app > *')]
        .filter((e) => e.id && !e.hidden)
        .map((e) => e.id)
        .slice(0, 20),
      wizardOpen: !!document.querySelector('#wizard:not([hidden])'),
      overlay: !!document.querySelector('.confirm-overlay, .modal-overlay'),
    }));
    console.log('  ✗ room rows never appeared. Page state:');
    for (const [k, v] of Object.entries(diag)) console.log(`      ${k}: ${JSON.stringify(v)}`);
    if (pageErrors.length) console.log('      pageErrors:', pageErrors.slice(0, 3).join(' | ').slice(0, 500));
    await browser.close();
    process.exit(2);
  }
  const gen1 = await page.evaluate(() => window.__wsGeneration);

  // ── The resume ───────────────────────────────────────────────────────────
  // The socket died while the app was backgrounded; coming back to a visible
  // tab is what triggers connect(). The rows stay on screen throughout.
  await page.evaluate(() => {
    window.__sock1.readyState = 3;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__wsGeneration === 2, null, { timeout: 5000 });

  const rowsStillThere = await page.locator('#room-list li[data-room-id]').count();

  // ── The tap ──────────────────────────────────────────────────────────────
  await page.click('#room-list li[data-room-id="project-management"]');
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => ({
    threw: (window.__sendThrewOn || []).length,
    roomName: document.querySelector('#room-name')?.textContent ?? '',
    inputDisabled: document.querySelector('#message-input')?.disabled ?? null,
    submitDisabled: document.querySelector('#message-form button[type=submit]')?.disabled ?? null,
    lastRoom: localStorage.getItem('lastRoom'),
    chatVisible: document.querySelector('#chat') ? !document.querySelector('#chat').hidden : null,
    activeRow: !!document.querySelector('#room-list li.active[data-room-id="project-management"]'),
  }));

  console.log('  socket generation after resume :', gen1, '->', await page.evaluate(() => window.__wsGeneration));
  console.log('  room rows still rendered       :', rowsStillThere);
  console.log('  send() threw (join swallowed)  :', after.threw > 0 ? `YES (${after.threw})` : 'no');
  console.log('');
  console.log('  --- what the user sees after tapping "Project Management" ---');
  console.log('  chat pane revealed             :', after.chatVisible, '   (ran BEFORE the throw)');
  console.log('  row marked active              :', after.activeRow, '   (ran BEFORE the throw)');
  console.log('  room-name header               :', JSON.stringify(after.roomName), '  <- expected "#project-management"');
  console.log('  message input disabled         :', after.inputDisabled, '  <- expected false');
  console.log('  submit button disabled         :', after.submitDisabled, '  <- expected false');
  console.log('  localStorage lastRoom          :', JSON.stringify(after.lastRoom), '  <- expected "project-management"');
  if (pageErrors.length) console.log('  page errors                    :', pageErrors[0].split('\n')[0]);

  const broken =
    after.threw > 0 && (after.inputDisabled === true || after.roomName !== '#project-management' || after.lastRoom !== 'project-management');

  // ── The deferred join ────────────────────────────────────────────────────
  // Skipping the send is only safe if the join actually happens once the socket
  // authenticates. Bring generation #2 up and check that it does — and that it
  // carries the thread, not a bare room_id.
  await page.evaluate(({ rooms, me }) => {
    const s = window.__sock2;
    if (!s) return;
    s.readyState = 1;
    s.onopen && s.onopen({ type: 'open' });
    s.onmessage && s.onmessage({ data: JSON.stringify({ type: 'system', message: `Connected as ${me}` }) });
    s.onmessage && s.onmessage({ data: JSON.stringify({ type: 'rooms', rooms }) });
  }, { rooms: ROOMS, me: ME });
  await page.waitForTimeout(300);

  const sent = await page.evaluate(() => (window.__sent || []).map((s) => JSON.parse(s)));
  const deferredJoin = sent.find((m) => m.type === 'join' && m.room_id === 'project-management');
  console.log('');
  console.log('  --- after the socket finishes connecting ---');
  console.log('  deferred join sent             :', deferredJoin ? 'YES' : 'NO');
  console.log('  join payload                   :', JSON.stringify(deferredJoin ?? null));

  const joinRecovered = !!deferredJoin && !!deferredJoin.thread_id;

  console.log('');
  if (broken) console.log('  ❌ REPRODUCED: the room did not finish opening.');
  else if (!joinRecovered) console.log('  ❌ room opened, but the deferred join never landed — history would be missing.');
  else console.log('  ✅ room opened fully, and the join landed once the socket came up.');

  await browser.close();
  process.exit(broken || !joinRecovered ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
