// role-matrix.mjs — does the UI show anyone a control they cannot use?
//
// WHY THIS EXISTS. Three separate privilege-leak bugs shipped in this UI and
// none of them was visible from the source:
//
//   1. Twelve Settings sections set `hidden` correctly and rendered anyway,
//      because `.settings-credentials { display: flex }` beats the user-agent
//      `[hidden] { display: none }` rule.
//   2. Three "+ New …" buttons had no gate at all.
//   3. The first fix for (2) wrote the gate inside a render that gets skipped
//      on an install with zero rooms — which hid the button from the OWNER.
//
// Reading the assignments told me the opposite of the truth in every case. So
// this guard asserts the rendered result in a real browser, from both sides:
// the controls a persona must NOT see, and the ones they MUST. Only checking
// the first half would pass a build where everything is broken and nothing
// renders at all.
//
// The personas are produced by rewriting the two role endpoints client-side;
// nothing server-side is involved, so this runs against the static bundle.
//
//   node role-matrix.mjs <url> [--inject-fault]
//
// --inject-fault un-hides the gated controls after load, simulating a removed
// gate. The self-test uses it to prove this guard can actually fail.
import { chromium } from 'playwright';

const URL = process.argv[2];
const INJECT_FAULT = process.argv.includes('--inject-fault');
const ME = 'webchat:role-matrix-probe';

// Expected visibility per persona. `true` = must be on screen, `false` = must
// not be. Anything absent from a persona's map is not asserted for them.
//
// The scoped-admin column is the point of the whole table: it is the only
// thing that distinguishes "gated on owner" from "gated on any admin". Wire
// both to the same flag and the other two columns still pass.
const MATRIX = {
  'non-owner': {
    'create-room-btn': false, // POST /api/rooms      guards:['owner']
    'create-agent-btn': false, // POST /api/agents     isAnyAdmin
    'create-model-btn': false, // POST /api/models     guards:['owner']
    'settings-wizard': false, // GET /api/workspace-credential  owner|globalAdmin
    'settings-selftest': false, // same probe as the wizard
    'settings-backup': false, // /api/system/export|import  guards:['owner']
    'settings-audit': false, // GET /api/webchat/audit-syslog  owner|globalAdmin
    'settings-secrets': false, // state.isOwnerView
    'settings-about': false, // GET /api/system/versions  anyAdmin
    'overflow-admin': false, // revealed on /api/users success — 403s for them
    // Marketplace off and not an owner → no route to either registry.
    'mtab-skills-btn': false,
    'mtab-mcp-btn': false
  },
  owner: {
    'create-room-btn': true,
    'create-agent-btn': true,
    'create-model-btn': true,
    'settings-wizard': true,
    'settings-selftest': true,
    'settings-backup': true,
    'settings-audit': true,
    'settings-secrets': true,
    'settings-about': true,
    'overflow-admin': true,
    // The regression this pins: with marketplace OFF an owner still reaches
    // the tabs, because that is where the registry sources are configured.
    'mtab-skills-btn': true,
    'mtab-mcp-btn': true,
  },
  'scoped-admin': {
    // Admin of one group, owner of nothing. May create agents; may not create
    // rooms or models, and cannot reach the workspace credential.
    'create-room-btn': false,
    'create-agent-btn': true,
    'create-model-btn': false,
    'settings-wizard': false,
    'settings-selftest': false,
    'settings-backup': false,
    'settings-audit': false,
    // anyAdmin, not owner — a scoped admin SEES this one. The row exists to
    // catch a future change that re-gates it on isOwnerView by mistake.
    'settings-about': true,
    // The page opens for them; what is IN it is decided block by block above.
    'overflow-admin': true,
    // Marketplace off and not an owner: the catalogs are off for them and the
    // source registries are not theirs to configure.
    'mtab-skills-btn': false,
    'mtab-mcp-btn': false,
  },
};

const ROLES = {
  'non-owner': null, // /api/users 403s
  owner: [{ kind: 'owner', agent_group_id: null }],
  'scoped-admin': [{ kind: 'admin', agent_group_id: 'g1' }],
};

// The app calls probeIsOwner() from the WebSocket's onopen, so a persona whose
// socket never opens has no roles at all and everything hides — which would
// make the "must be visible" half of the matrix fail for the wrong reason.
// A fake socket that opens immediately is the cheapest way to get there without
// a WebSocket server; the app only ever uses onopen/onmessage/onclose/send.
const FAKE_WS = () => {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({ type: 'open' });
        // An empty rooms list is the shape that broke the first fix, so it is
        // the shape worth defaulting to here.
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: 'rooms', rooms: [] }) });
      }, 0);
    }
    send() {}
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({ type: 'close' });
    }
    addEventListener() {}
    removeEventListener() {}
  }
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSED = 3;
  window.WebSocket = FakeWebSocket;
};

const UNHIDE = (ids) => {
  // Simulated regression: a gate that stopped running. Re-asserts on a timer so
  // it beats whatever the real gates do, whenever they do it.
  setInterval(() => {
    for (const id of ids) {
      const e = document.getElementById(id);
      if (e) e.removeAttribute('hidden');
    }
  }, 100);
};

async function runPersona(browser, persona) {
  const page = await browser.newPage();
  await page.addInitScript(FAKE_WS);
  if (INJECT_FAULT) await page.addInitScript(UNHIDE, Object.keys(MATRIX[persona]));

  // Hermetic: nothing leaves the machine. The /api/* stubs below cover what this
  // guard drives, but the app also races two no-cors /generate_204 probes
  // (Tailscale DERP + gstatic) whenever the socket looks down — and with a FAKE
  // websocket it always does. In CI there is no egress, so those hang until they
  // time out and redden a PR that never touched them. Registered FIRST so the
  // specific stubs below, added later, still take precedence; local URLs fall
  // through to them rather than being continued straight to the network.
  await page.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).hostname;
    } catch {
      return route.fallback();
    }
    const local = host === '' || host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    return local ? route.fallback() : route.abort('blockedbyclient');
  });

  const roles = ROLES[persona];
  await page.route('**/api/auth/check*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, userId: ME }) }),
  );
  await page.route('**/api/users*', (r) =>
    roles === null
      ? r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' })
      : r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ id: ME, display_name: 'probe', kind: 'webchat', roles }]),
        }),
  );
  // Owner|globalAdmin only — the probe behind the wizard and self-test.
  // Marketplace OFF, deliberately. These personas are checked in the state
  // where the Skills/MCP tabs used to become unreachable: the registry SOURCES
  // live on those tabs, so an owner must still get in to configure them (and
  // to switch the marketplace back on). Left unstubbed this defaulted to off
  // by accident; pinning it makes the scenario the point of the test.
  await page.route('**/api/webchat/features*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"marketplaceEnabled":false}' }),
  );
  await page.route('**/api/workspace-credential*', (r) =>
    persona === 'owner'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: '{"configured":true}' })
      : r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' }),
  );
  // /api/system/versions is anyAdmin, so this is the second row where a scoped
  // admin diverges from a non-owner — cheap extra discrimination for the table.
  await page.route('**/api/system/versions*', (r) =>
    persona === 'non-owner'
      ? r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' })
      : r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ nanoclaw: { version: '2.1.54', commit: null, dirty: null }, webchat: null, components: {} }),
        }),
  );
  await page.route('**/api/webchat/audit-syslog*', (r) =>
    persona === 'owner'
      ? r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ target: '', status: { sentCount: 0, droppedCount: 0, lastSentAt: null, lastError: null } }) })
      : r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' }),
  );
  // stub-serve reports a FIRST-RUN install, which auto-opens the wizard overlay
  // over the whole app and makes every control unclickable. That is right for
  // the boot-order guard and fatal here — the clicks below silently timed out
  // and every persona reported "hidden", which the non-owner rows would have
  // passed VACUOUSLY. Report an onboarded install instead; the wizard section's
  // own gate is /api/workspace-credential, which is still asserted above.
  await page.route('**/api/webchat/onboarding*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ complete: true, canEdit: persona === 'owner' }),
    }),
  );

  // `domcontentloaded`, not `networkidle`. The app holds long-lived requests
  // open, so networkidle can sit until the navigation timeout and turn a 30s
  // guard into a hang. The explicit waits below are what the gates actually
  // need — they are async fetches, not load events.
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  const seen = {};
  const want = MATRIX[persona];
  // checkVisibility walks ancestors, so a control inside a hidden pane counts
  // as not visible — which is the user-facing question. getComputedStyle on the
  // element alone does NOT, and reading it was how the CSS bug stayed hidden.
  const vis = (id) => page.evaluate((i) => !!document.getElementById(i)?.checkVisibility(), id);

  if ('create-room-btn' in want) seen['create-room-btn'] = await vis('create-room-btn');

  // Clicks must NOT be swallowed. A silently-failed click leaves every control
  // unrendered, which reads as "hidden" and passes the whole non-owner column
  // for entirely the wrong reason. Short timeout, loud failure.
  const click = async (sel) => {
    try {
      await page.click(sel, { timeout: 5000 });
    } catch {
      throw new Error(`role-matrix: could not click ${sel} as ${persona} — the probe cannot assert anything`);
    }
  };
  // …and the pane it opens must actually be open, or the assertions below are
  // measuring a screen that never appeared.
  const assertOpen = async (sel, what) => {
    if (!(await page.evaluate((s) => !!document.querySelector(s)?.checkVisibility(), sel)))
      throw new Error(`role-matrix: ${what} did not open as ${persona} — refusing to report a vacuous pass`);
  };

  // Manage → Agents, then the Models tab.
  await click('#overflow-btn');
  await page.waitForTimeout(250);
  await click('[data-action="agents"]');
  await page.waitForTimeout(1200);
  await assertOpen('#manage', 'the Manage pane');
  if ('create-agent-btn' in want) seen['create-agent-btn'] = await vis('create-agent-btn');
  // Marketplace is off for every persona here, so these assert the owner-only
  // escape hatch rather than the catalog feature.
  for (const id of ['mtab-skills-btn', 'mtab-mcp-btn']) if (id in want) seen[id] = await vis(id);
  await click('[data-mtab="models"]');
  await page.waitForTimeout(900);
  if ('create-model-btn' in want) seen['create-model-btn'] = await vis('create-model-btn');

  // Admin — the operator sections live here now, not in Settings (stage 2 of
  // the declutter). The menu entry is any-admin; the blocks inside self-hide
  // on 403, which is what makes a scoped admin's column meaningful.
  await click('#overflow-btn');
  await page.waitForTimeout(250);
  if ('overflow-admin' in want) seen['overflow-admin'] = await vis('overflow-admin');
  if (await vis('overflow-admin')) {
    await click('[data-action="admin"]');
    await page.waitForTimeout(2500);
    await assertOpen('#admin', 'the Admin view');
    // Every section gate is an async fetch, so they were given room to land.
    for (const id of Object.keys(want)) if (id.startsWith('settings-')) seen[id] = await vis(id);
  } else {
    // The surface itself is unreachable, so every section on it is too. Recorded
    // as hidden rather than skipped: the negative half of the matrix has to keep
    // asserting something, and this is the honest reading of what the persona
    // can see. If a regression ever makes the entry visible to them, the branch
    // above runs instead and measures the sections for real.
    for (const id of Object.keys(want)) if (id.startsWith('settings-')) seen[id] = false;
    await click('#overflow-btn'); // close the menu this step opened
  }

  await page.close();
  return seen;
}

const browser = await chromium.launch();
let failures = 0;
try {
  for (const persona of Object.keys(MATRIX)) {
    const seen = await runPersona(browser, persona);
    const want = MATRIX[persona];
    console.log(`\n${persona}`);
    for (const [id, expected] of Object.entries(want)) {
      const got = seen[id];
      const ok = got === expected;
      if (!ok) failures++;
      const label = expected ? 'must be VISIBLE' : 'must be hidden';
      console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(20)} ${label.padEnd(16)} got ${got ? 'visible' : 'hidden'}`);
    }
  }
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n❌ role matrix: ${failures} control(s) in the wrong state`);
  process.exit(1);
}
console.log('\n✅ role matrix: every control matches its server-side rule');
