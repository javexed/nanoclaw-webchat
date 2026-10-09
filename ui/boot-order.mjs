// Boot-order guard: record the startup sequence and compare it to the baseline.
//
// WHY THIS EXISTS. The listener-set diff proves WHICH listeners attach; it
// cannot see ordering, and bootstrap is exactly where ordering IS the
// correctness property. `state.settings = loadSettings()` running after
// something that reads state.settings attaches every listener correctly and
// still yields a subtly wrong app — that diff reads 251 = 251 and says nothing.
//
// It is not hypothetical. Moving a single .vue import from one line of a
// feature module's import list to the next shifted EIGHT bootstrap events
// (the room-list drag listeners and five fetches) past the wizard's wiring,
// with the same event count and the same listener set. Nothing else saw it.
//
// This matters most while legacy.js is being retired: that file runs its blocks
// in source order, so every extraction is a chance to reorder side effects.
//
// Served STATICALLY from app/public/webchat with no backend. Every /api fetch
// 404s, which is fine and is the point: the trace still records the fetch in
// its position, and a run with no server is reproducible in a way that a run
// against a live install is not. Confirmed stable across repeated runs before
// this was made a gate.
//
//   node boot-order.mjs record <url>   → write a trace to stdout
//   node boot-order.mjs check  <url> <baseline.json>
import { chromium } from 'playwright';
import fs from 'node:fs';

const [mode, url, baselinePath] = process.argv.slice(2);

// The connectivity probe (core/ws.ts probeInternet) fires when the socket
// drops — on a reconnect TIMER, not in boot order — so where it lands among
// the wizard's wiring varies run to run (main went red on it, 2026-09-23, with
// "same events, REORDERED"), and on a loaded runner so does how often it has
// fired by the time the trace is read. Those fetches are checked as a SET —
// each one present, in any position, any number of times; every other event
// keeps its exact place.
//
// The same timer runs the session check first (diagnoseConnection →
// checkSessionExpired → /api/auth/check), so that fetch races the wizard's
// wiring too: main went red on it again, 2026-10-04, at the stubbed trace's
// auth check against on:wizard-grok-login:click. It is the same URL the boot
// path fetches in a fixed place, so the trace tells them apart by the call
// stack (the bundle is unminified on purpose) and only the reconnect one
// joins the set.
const TIMED = /^fetch:(https:\/\/(derp1\.tailscale\.com|www\.gstatic\.com)\/generate_204|\S+ \(reconnect\))$/;
const timed = (xs) => [...new Set(xs.filter((e) => TIMED.test(e)))].sort();
// How long a check waits for the probe fetches the baseline expects, past the
// settle delay. A real readiness signal instead of a longer fixed sleep: the
// common case returns as soon as they appear.
const TIMED_WAIT_MS = 15000;

async function trace(expectTimed = []) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__trace = [];
    const push = (s) => {
      try {
        window.__trace.push(s);
      } catch {}
    };
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
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '?');
        // Fired from the socket's reconnect path, not boot: see TIMED.
        const reconnect = /\bdiagnoseConnection\b/.test(new Error().stack ?? '');
        push('fetch:' + String(u).split('?')[0] + (reconnect ? ' (reconnect)' : ''));
      } catch {}
      return f.apply(this, args);
    };
    // Settings and auth come out of storage during boot; reading them in a
    // different order than before is the shape of an ordering regression.
    for (const store of ['localStorage', 'sessionStorage']) {
      const s = window[store];
      const get = s.getItem.bind(s);
      s.getItem = (k) => {
        push(`${store}.get:${k}`);
        return get(k);
      };
    }
  });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  // The ordered sequence is read at the settle mark, as the baseline was
  // recorded; only the probe set below may wait past it.
  const settled = await page.evaluate(() => window.__trace.slice());
  if (expectTimed.length) {
    await page
      .waitForFunction((want) => want.every((e) => window.__trace.includes(e)), expectTimed, {
        timeout: TIMED_WAIT_MS,
        polling: 100,
      })
      .catch(() => {}); // still missing → the comparison below reports it
  }
  const later = await page.evaluate(() => window.__trace.slice());
  await browser.close();
  // Settled order for everything, plus any probe fetch that landed late.
  return [...settled, ...later.slice(settled.length).filter((e) => TIMED.test(e))];
}

if (mode === 'record') {
  console.log(JSON.stringify(await trace(), null, 1));
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const raw = await trace(timed(baseline));

const got = raw.filter((e) => !TIMED.test(e));
const want = baseline.filter((e) => !TIMED.test(e));
if (JSON.stringify(got) === JSON.stringify(want) && JSON.stringify(timed(raw)) === JSON.stringify(timed(baseline))) {
  console.log(`boot order OK: ${raw.length} events match the baseline`);
  process.exit(0);
}

// Report the FIRST divergence rather than a full diff: boot order is a
// sequence, so everything after the first moved event is downstream noise.
console.error('❌ boot order changed.\n');
const n = Math.max(got.length, want.length);
for (let i = 0; i < n; i++) {
  if (got[i] !== want[i]) {
    console.error(`   first divergence at event ${i}:`);
    console.error(`     baseline: ${want[i] ?? '(end)'}`);
    console.error(`     this run: ${got[i] ?? '(end)'}`);
    break;
  }
}
console.error(`\n   baseline ${baseline.length} events · this run ${raw.length}`);
const lost = baseline.filter((e) => !raw.includes(e));
const gained = raw.filter((e) => !baseline.includes(e));
if (lost.length) console.error(`   only in baseline: ${lost.slice(0, 8).join(', ')}`);
if (gained.length) console.error(`   only in this run: ${gained.slice(0, 8).join(', ')}`);
if (!lost.length && !gained.length) {
  console.error('   same events, REORDERED — which is the case this guard exists for.');
}
console.error('\n   If the change is intended, re-record:');
console.error('     bash scripts/check-boot-order.sh --record');
process.exit(1);
