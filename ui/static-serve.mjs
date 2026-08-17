// Minimal static server for the boot-order guard: serves app/public/webchat
// with no backend, so every /api request 404s. That is deliberate — the trace
// records a fetch in its POSITION regardless of the response, and a run with no
// server is reproducible in a way that a run against a live install is not.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [root, port] = process.argv.slice(2);
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' ) p = '/index.html';
  const f = path.join(root, p);
  // resolve() both sides and anchor on the separator: a bare prefix check
      // passes sibling dirs sharing the name as a prefix (root-backup/), and an
      // unresolved join can dodge the check entirely. CI/dev only, loopback
      // bind — this is hygiene, not a reachable hole.
      if (!path.resolve(f).startsWith(path.resolve(root) + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404, {'content-type':'application/json'}); res.end('{}'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
}).listen(Number(port), '127.0.0.1');
