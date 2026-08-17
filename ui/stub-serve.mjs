// Static assets + a canned API, for the boot-order guard's second baseline.
//
// WHY THIS EXISTS. static-serve.mjs answers every /api with 404, which is
// reproducible but leaves a large blind spot: any wiring gated on a successful
// response never runs. Measured against a real install, 11 boot events were
// invisible to the guard — and the whole first-run WIZARD was invisible to
// both, because a real install that has been onboarded never opens it.
//
// So this reports `onboarding.complete: false` and an owner viewer: the two
// gates that unlock the wizard and the owner-only panels. It is the shape a
// FIRST-RUN install has, which is the shape least likely to be exercised by
// hand and most likely to break unnoticed.
//
// Every response is a fixed literal. No clocks, no randomness, no request
// counters — the guard diffs a sequence, so a body that varies between runs
// would make it flap and get re-recorded into meaninglessness.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [root, port] = process.argv.slice(2);

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

// Exact-path canned bodies. Anything unmatched under /api falls through to {}.
const API = {
  '/api/webchat/onboarding': { complete: false, canEdit: true },
  '/api/webchat/features': { owner: true, marketplace: true },
  '/api/webchat/auth': { methods: ['token'] },
  '/api/auth/info': { authed: true },
  '/api/auth/check': { ok: true },
  '/api/me/handle': { handle: 'guard' },
  '/api/agents': [],
  '/api/rooms': [],
  '/api/users': [],
  '/api/members': [],
  '/api/models': [],
  '/api/approvals/pending': [],
  '/api/skill-drafts': [],
  '/api/skills': [],
  '/api/tts/config': { enabled: false },
  '/api/stt/config': { enabled: false },
  '/api/learning/config': { enabled: false },
  '/api/workspace-credential': { ok: true },
  '/api/router/routes': { installed: false },
  '/api/ollama/local': { running: false },
  '/api/system/info': { version: 'guard' },
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);

    if (p.startsWith('/api/')) {
      const body = Object.prototype.hasOwnProperty.call(API, p) ? API[p] : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    const file = path.join(root, p === '/' ? '/index.html' : p);
    // resolve() both sides and anchor on the separator: a bare prefix check
      // passes sibling dirs sharing the name as a prefix (root-backup/), and an
      // unresolved join can dodge the check entirely. CI/dev only, loopback
      // bind — this is hygiene, not a reachable hole.
      if (!path.resolve(file).startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  })
  .listen(Number(port), '127.0.0.1');
