// Boot-order trace: what happened during startup, in the order it happened.
//
// The listener-set diff proves WHICH listeners attach. It cannot see ordering,
// and bootstrap code is exactly where ordering IS the correctness property —
// `state.settings = loadSettings()` running after something that reads
// state.settings attaches every listener correctly and still yields a subtly
// wrong app. That diff would read 229 = 229 and say nothing.
//
// So record a SEQUENCE, not a set: every listener registration in registration
// order, plus network requests and storage reads interleaved with them. Two
// bundles producing the same trace booted the same way.
//
// Usage: node boot-trace.mjs <url>   → one JSON line on stdout
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:3100/';
const browser = await chromium.launch();
const page = await browser.newPage();

// Hermetic: nothing leaves the machine.
//
// On a dropped socket the app races two no-cors /generate_204 probes (Tailscale
// DERP + gstatic) to tell "you are offline" from "internet is fine, the server
// is not". The cold baseline has NO backend on purpose, so that path always
// runs here — and in CI, where there is no egress, those requests hang until
// they time out. A flake with a perfect disguise: it reddens whichever PR is
// running, never reproduces locally (a dev box has internet), and the log
// blames a Tailscale URL nobody put in the diff. It cost #285 and #296 a full
// cycle each before the cause was found.
//
// Abort them at the network layer instead. The trace is UNAFFECTED: the tracer
// wraps window.fetch and records the CALL synchronously, before the request
// leaves, so `fetch:https://derp1.tailscale.com/generate_204` still appears in
// the sequence exactly as the baselines already record it. Only the packet
// stops. `fallback()` rather than `continue()` for local URLs, so any specific
// route registered later still wins.
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

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.addInitScript(() => {
  window.__trace = [];
  const push = (s) => { try { window.__trace.push(s); } catch {} };

  const addEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      if (this instanceof Element && this.id) push(`on:${this.id}:${type}`);
      else if (this === window) push(`on:window:${type}`);
      else if (this === document) push(`on:document:${type}`);
    } catch {}
    return addEL.call(this, type, fn, opts);
  };

  const f = window.fetch;
  window.fetch = function (...args) {
    try {
      const u = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '?';
      push('fetch:' + String(u).split('?')[0]);
    } catch {}
    return f.apply(this, args);
  };

  // Settings and auth come out of storage during boot; reading them in a
  // different order than before is the shape of an ordering regression.
  for (const store of ['localStorage', 'sessionStorage']) {
    const s = window[store];
    const get = s.getItem.bind(s);
    s.getItem = (k) => { push(`${store}.get:${k}`); return get(k); };
  }
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2500);
const trace = await page.evaluate(() => window.__trace);
console.log(JSON.stringify({ trace, errors }));
await browser.close();
