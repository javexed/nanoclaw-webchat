// Expired sign-in at a front door (App Service EasyAuth, an identity-aware
// proxy), in a real browser: the built app on :A; while `expired`, every
// request (page, /api, /ws) is redirected to a login page on :B, another
// origin. Before the fix the app said the server was unreachable and a normal
// reload kept the cached app — only a hard refresh got back to the sign-in.
//
//   node reauth-probe.mjs [public dir]     (default ../app/public/webchat; build first)
//
// Checks: a normal reload reaches the sign-in; with nothing typed the app goes
// there by itself; with a draft it says so and waits for "Sign in again"; and
// right after a sign-in that did not take it waits too, so it cannot loop.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(process.argv[2] ?? new URL('../app/public/webchat', import.meta.url).pathname);
const A = 47811,
  B = 47812;
let expired = false;
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
const toLogin = (res, url) => {
  res.writeHead(302, { Location: `http://127.0.0.1:${B}/login?return=${encodeURIComponent(url)}` });
  res.end();
};
const app = http.createServer((req, res) => {
  if (expired) return toLogin(res, req.url);
  const u = new URL(req.url, `http://localhost:${A}`);
  if (u.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      u.pathname === '/api/auth/check'
        ? '{"ok":true}'
        : u.pathname.match(/rooms|agents|users|members|models|approvals|skills/)
          ? '[]'
          : '{}',
    );
  }
  const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(f).pipe(res);
});
app.on('upgrade', (req, socket) => {
  // no WS server: refused, or redirected while expired
  socket.end(
    expired
      ? `HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${B}/login\r\n\r\n`
      : 'HTTP/1.1 503 Unavailable\r\n\r\n',
  );
});
const login = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>LOGIN PAGE</h1>');
});
await new Promise((r) => app.listen(A, 'localhost', r));
await new Promise((r) => login.listen(B, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const onLogin = () => page.url().startsWith(`http://127.0.0.1:${B}/login`);
const loadApp = async () => {
  expired = false;
  await page.goto(`http://localhost:${A}/`);
  await page
    .waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 })
    .catch(async () => {
      await page.reload();
      await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
    });
  await page.evaluate(() => sessionStorage.removeItem('nanoclaw-reauth-at'));
};
try {
  // 1. A normal reload with the session gone reaches the login page (the worker asks the server first).
  await loadApp();
  expired = true;
  await page.reload().catch(() => {});
  await page.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  check('a normal reload goes to the sign-in, not the cached app', onLogin(), page.url());

  // 2. Nothing typed: the app notices on its own and goes to the sign-in.
  await loadApp();
  await page.waitForTimeout(1500);
  expired = true;
  await page.waitForURL(/\/login/, { timeout: 70000 }).catch(() => {});
  check('with nothing typed, the app goes to the sign-in by itself', onLogin(), page.url());

  // 3. A draft: the banner says so, the app stays, the button signs in.
  await loadApp();
  await page.evaluate(() => {
    const t = document.querySelector('#message-input');
    if (t) t.value = 'half-written message';
  });
  expired = true;
  const banner = await page
    .waitForFunction(
      () => document.querySelector('#connection-banner')?.textContent?.includes('Your sign-in expired'),
      null,
      { timeout: 70000 },
    )
    .then(
      () => true,
      () => false,
    );
  check(
    'with a draft, the banner says the sign-in expired and the app stays',
    banner && !onLogin(),
    await page
      .locator('#connection-banner')
      .textContent()
      .catch(() => ''),
  );
  if (banner) {
    await page.getByRole('button', { name: 'Sign in again' }).click();
    await page.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
    check('"Sign in again" goes to the sign-in', onLogin(), page.url());
  }

  // 4. A sign-in that did not take: the app went there moments ago and is back,
  // still expired. Nothing typed, yet it waits for "Sign in again" rather than loop.
  await loadApp();
  await page.evaluate(() => sessionStorage.setItem('nanoclaw-reauth-at', String(Date.now())));
  expired = true;
  const waited = await page
    .waitForFunction(
      () => document.querySelector('#connection-banner')?.textContent?.includes('Your sign-in expired'),
      null,
      { timeout: 70000 },
    )
    .then(
      () => true,
      () => false,
    );
  // The banner goes up just before an automatic sign-in too: give a navigation time to start.
  const left = await page.waitForURL(/\/login/, { timeout: 3000 }).then(
    () => true,
    () => false,
  );
  check('just after a sign-in, the app does not go there again by itself', waited && !left, page.url());
} finally {
  await browser.close();
  app.close();
  login.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
