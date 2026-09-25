// Headless runner harness — an integration test of the REAL runner code, on
// this host, before a VSIX is ever packaged.
//
// It wires the extension's own RunnerAgent / RunnerLink / SessionRelay to a
// minimal central that uses the REAL runner-transport and runner-relay from
// the central tree, over a real localhost WebSocket, against a real docker
// container built from the real agent image, with a fake OneCLI gateway
// standing in for egress. Nothing here is a re-implementation: every moving
// part on the wire, in the container, and on the relay is the shipping code.
//
// It exists because three of four field bugs lived where unit tests do not
// reach: the forwarder's port ownership inside the container, the mailbox
// helper scripts run by `bun -e`, and a session left unsupervised after a
// reconnect. This reproduces all of those with real processes.
//
// Usage:  node harness/runner-harness.mjs [--runtime docker|podman] [--keep]
// Exit 0 iff every scenario passed.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

// ---- locate the two trees ------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..'); // vscode-extension/
const OUT = path.join(EXT, 'out'); // compiled runner core (CJS)
const STAGING = process.env.NANOCLAW_STAGING || '/opt/nanoclaw/staging';
const DIST = path.join(STAGING, 'dist'); // compiled central (ESM)

const extMod = (f) => import(pathToFileURL(path.join(OUT, f)).href);
const cenMod = (f) => import(pathToFileURL(path.join(DIST, f)).href);

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const RUNTIME = (() => {
  const i = argv.indexOf('--runtime');
  return i >= 0 ? argv[i + 1] : 'docker';
})();
const KEEP = argv.includes('--keep');
// Central reads its MCP relay address from env at import time; point it at the
// stand-in this harness starts, so the relay's MCP route is exercised for real.
const MCP_PORT = 34102;
process.env.WEBCHAT_MCP_RELAY_HOST = '127.0.0.1';
process.env.WEBCHAT_MCP_RELAY_PORT = String(MCP_PORT);
// Central's mailbox endpoint: the container syncs itself against this.
const MAILBOX_PORT = 34103;
process.env.WEBCHAT_RUNNER_MAILBOX_PORT = String(MAILBOX_PORT);
/** --only <substring>: run only scenarios whose name contains it (setup scenarios still run). */
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : null;
})();
const IMAGE = process.env.NANOCLAW_HARNESS_IMAGE;
if (!IMAGE)
  throw new Error("set NANOCLAW_HARNESS_IMAGE to this install's agent image (nanoclaw-agent-v2-<install slug>:latest)");

// ---- tiny test framework -------------------------------------------------
let passed = 0;
const failures = [];
const log = (m) => process.stdout.write(`${m}\n`);
async function scenario(name, fn, { always = false } = {}) {
  if (ONLY && !always && !name.includes(ONLY)) {
    log(`  \x1b[90mSKIP\x1b[0m ${name}`);
    return;
  }
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    log(`  \x1b[32mPASS\x1b[0m ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failures.push({ name, err });
    log(
      `  \x1b[31mFAIL\x1b[0m ${name} (${Date.now() - t0}ms)\n        ${String(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : err)}`,
    );
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, { timeoutMs = 15000, everyMs = 200, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ---- docker helpers (use the same bin the runner will) -------------------
import { execFile as _execFile } from 'node:child_process';
const execFile = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    _execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (e, so, se) => {
      if (!e) return resolve(String(so));
      // Keep what the process itself printed: that is usually the explanation.
      e.message = `${e.message.split('\n')[0]}\n        stdout: ${String(so).trim().slice(0, 300)}\n        stderr: ${String(se).trim().slice(0, 300)}`;
      reject(Object.assign(e, { stdout: String(so), stderr: String(se) }));
    });
  });
const rt = (args, opts) => execFile(RUNTIME, args, opts);

async function imageExists() {
  try {
    await rt(['image', 'inspect', IMAGE]);
    return true;
  } catch {
    return false;
  }
}

// ---- fake OneCLI gateway: CONNECT -> 200, then echo with a prefix --------
// `verbatim` echoes bytes unchanged (for large-transfer integrity checks);
// otherwise it prefixes each chunk with "echo:" (handy for the small tests).
function fakeGateway({ verbatim = false } = {}) {
  const sawAuth = [];
  const sawConnect = [];
  const server = net.createServer((sock) => {
    let head = Buffer.alloc(0);
    let connected = false;
    const onHead = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      const text = head.slice(0, end).toString();
      const m = /^CONNECT (\S+)/.exec(text);
      sawConnect.push(m ? m[1] : '(none)');
      const auth = /Proxy-Authorization: (.+)\r\n/.exec(text);
      sawAuth.push(auth ? auth[1].trim() : null);
      sock.off('data', onHead);
      connected = true;
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = head.slice(end + 4);
      const echo = (d) => sock.write(verbatim ? d : Buffer.concat([Buffer.from('echo:'), d]));
      sock.on('data', echo);
      if (rest.length) echo(rest);
    };
    sock.on('data', onHead);
    sock.on('error', () => {});
  });
  return {
    sawAuth,
    sawConnect,
    listen: () => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port))),
    close: () => server.close(),
  };
}

// ---- minimal central: real transport + relay, stub auth+pairing ----------
async function startCentral(transport, relay) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const conns = [];
  server.on('upgrade', (req, socket, head) => {
    // Auth is EasyAuth+Entra in production; the harness admits any socket and
    // pins a fixed identity, because the code under test is the runner, not
    // the token verifier (that has its own tests).
    wss.handleUpgrade(req, socket, head, (ws) => {
      let fp = null;
      ws.on('message', (data) => {
        let f;
        try {
          f = JSON.parse(String(data));
        } catch {
          return;
        }
        if (f.type === 'hello') {
          fp = f.machine.fingerprint;
          ws.send(
            JSON.stringify({
              type: 'welcome',
              userId: 'webchat:harness@example.test',
              displayName: 'Harness',
              keepaliveMs: 30000,
              pairing: 'approved',
            }),
          );
          transport.attachRunnerLink({ fingerprint: fp, userId: 'webchat:harness@example.test', ws });
          return;
        }
        if (f.type === 'pong') return;
        if (typeof f.type === 'string' && f.type.startsWith('relay.')) {
          relay.handleRelayFrame(fp, f);
          return;
        }
        transport.handleRunnerFrame(fp, f);
      });
      ws.on('close', () => {
        if (fp) transport.detachRunnerLink(fp, ws);
      });
      conns.push(ws);
    });
  });
  const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((res) => {
        for (const ws of conns) ws.terminate();
        wss.close();
        server.close(() => res());
      }),
  };
}

// ---- build a runner (link + agent) exactly as the extension does ---------
function makeRunner({ RunnerAgent, RunnerLink, realCli, storageRoot, serverUrl, fingerprint, WebSocketImpl, policy }) {
  const lines = [];
  let link;
  const runtime = switchableCli(realCli(RUNTIME));
  const agent = new RunnerAgent({
    cli: runtime.cli,
    runtime: RUNTIME,
    storageRoot,
    policy: () => policy ?? { slots: {}, allowlist: [] },
    send: (frame) => link.send(frame),
    log: (l) => lines.push(l),
    heartbeatMs: 1000,
  });
  link = new RunnerLink({
    serverUrl,
    machine: { fingerprint, hostname: 'harness', os: 'linux', arch: 'x64', runner: 'harness/1' },
    getToken: async () => 'harness-token',
    events: { state: () => {}, log: (l) => lines.push(l) },
    onRequest: (op, payload) => agent.handle(op, payload),
    onFrame: (frame) => agent.handleFrame(frame),
    WebSocketImpl,
  });
  return { agent, link, lines, logText: () => lines.join('\n'), runtime: runtime.state };
}

// The laptop's runtime going away (podman's machine did not survive a sleep)
// without touching the real one: while `down`, every command fails the way
// podman's client does, and the container itself keeps running underneath.
function switchableCli(inner) {
  const state = { down: false };
  const refuse = () =>
    new Error(
      'Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`',
    );
  return {
    state,
    cli: {
      run: (args, opts) => (state.down ? Promise.reject(refuse()) : inner.run(args, opts)),
      start: (args, onLine) => {
        if (!state.down) return inner.start(args, onLine);
        onLine?.(refuse().message);
        return { done: Promise.resolve(125), kill: () => {}, write: () => {} };
      },
    },
  };
}

// ---- a stand-in container the runner adopts ------------------------------
// A real agent needs OneCLI credentials the harness does not have, so the
// container runs `sleep` instead: every mechanic the runner drives — start
// --attach supervision, the forwarder over exec, the mailbox bun scripts —
// is identical regardless of the container's own command.
async function createContainer(name, key, workspace) {
  await rt([
    'create',
    '--name',
    name,
    '--label',
    `nanoclaw-install=${key.installSlug}`,
    '--label',
    `nanoclaw-group=${key.agentGroupId}`,
    '--label',
    `nanoclaw-session=${key.sessionId}`,
    '--label',
    'nanoclaw-role=agent',
    '-v',
    `${workspace}:/workspace`,
    // Production shape: the runner gives an agent container NO network.
    '--network',
    'none',
    '--entrypoint',
    'sleep',
    IMAGE,
    'infinity',
  ]);
}
async function rmf(name) {
  await rt(['rm', '--force', name]).catch(() => {});
}

// A tiny CONNECT client, run INSIDE the container, that drives one tunnel
// end to end through the in-container forwarder.
const CLIENT = `
const net = require('net');
const s = net.connect(18080, '127.0.0.1', () =>
  s.write('CONNECT echo.internal:443 HTTP/1.1\\r\\nHost: echo.internal:443\\r\\n\\r\\nPING'));
let got = '';
s.on('data', (d) => { got += d.toString(); if (got.includes('echo:')) { console.log('CLIENT_OK ' + JSON.stringify(got)); process.exit(0); } });
setTimeout(() => { console.log('CLIENT_TIMEOUT ' + JSON.stringify(got)); process.exit(1); }, 4000);
`;

// ==========================================================================
async function main() {
  log(`\nRunner harness — runtime=${RUNTIME} image=${IMAGE}\n`);
  if (!(await imageExists())) {
    log(`\x1b[31mAgent image ${IMAGE} not found for ${RUNTIME}. Set NANOCLAW_HARNESS_IMAGE.\x1b[0m`);
    process.exit(2);
  }

  const [{ RunnerAgent }, { RunnerLink }, { realCli }, transport, relay, sessionDb, mailboxEndpoint] =
    await Promise.all([
      extMod('agent.js'),
      extMod('link.js'),
      extMod('docker.js'),
      cenMod('channels/webchat/runner-transport.js'),
      cenMod('channels/webchat/runner-relay.js'),
      cenMod('mailbox/sqlite/session-db.js'),
      cenMod('channels/webchat/runner-mailbox-endpoint.js'),
    ]);

  // Central's audit trail goes to a scratch file, not into this folder (it was shipped in a package once).
  process.env.NANOCLAW_AUDIT_FILE ??= path.join(os.tmpdir(), `ncl-harness-audit-${process.pid}.jsonl`);
  // Central's session store must not touch the install's real data/ file.
  const sessionsStore = await cenMod('channels/webchat/runner-sessions-store.js');
  sessionsStore.__setRunnerSessionStoreForTest(new sessionsStore.RunnerSessionStore(null));
  // No database here: fix the network policy per scenario (open unless a scenario tightens it).
  const egress = await cenMod('channels/webchat/egress-policy.js');
  egress.__setRunnerEgressForTest({ mode: 'open' });
  transport.__resetRunnerTransportForTest?.();
  relay.__resetRelayForTest?.();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-harness-'));
  const storageRoot = path.join(tmp, 'runner-storage');
  fs.mkdirSync(storageRoot, { recursive: true });
  const key = { installSlug: 'harness', agentGroupId: 'g-harness', sessionId: 'sess-harness-1' };
  const fingerprint = 'h'.repeat(64);
  const cname = 'ncl-harness-sess-harness-1';
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  // A previous run that was interrupted may have left its container behind.
  await rmf(cname);

  const gateway = fakeGateway();
  const gwPort = await gateway.listen();

  const central = await startCentral(transport, relay);
  let runner = makeRunner({ RunnerAgent, RunnerLink, realCli, storageRoot, serverUrl: central.url, fingerprint });

  const cleanup = async () => {
    try {
      runner?.link.stop();
    } catch {}
    await central.close().catch(() => {});
    gateway.close();
    await rmf(cname);
    if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else log(`(kept: ${tmp})`);
  };

  try {
    // 1) The wire: link connects, hello -> welcome -> approved, and central
    //    can round-trip a request to the real agent.
    await scenario(
      'link connects, is approved, and answers a request',
      async () => {
        runner.link.start();
        await until(() => runner.link.welcome?.pairing === 'approved', { what: 'welcome/approved' });
        assert(transport.isRunnerConnected(fingerprint), 'central should see the runner attached');
        // `status` on a not-yet-created container is the simplest real op.
        const res = await transport.runnerRequest(fingerprint, 'status', { name: cname }, 8000);
        assert(res.state === 'absent', `expected absent, got ${JSON.stringify(res)}`);
      },
      { always: true },
    );

    // Bring the container into being and adopt it.
    sessionDb.ensureSchema(path.join(workspace, 'inbound.db'), 'inbound');
    await createContainer(cname, key, workspace);

    // 2) Adoption + supervision + relay come up on `start`.
    await scenario(
      'start adopts the container, supervises it, and the relay listens',
      async () => {
        await transport.runnerRequest(fingerprint, 'start', { name: cname, key }, 15000);
        await until(() => /relay attached inside the container/.test(runner.logText()), {
          what: 'relay ready',
          timeoutMs: 20000,
        });
        const st = await transport.runnerRequest(fingerprint, 'status', { name: cname }, 8000);
        assert(st.state === 'running', `expected running, got ${JSON.stringify(st)}`);
      },
      { always: true },
    );

    // 3) The relay carries a CONNECT from inside the container, through
    //    central, to the gateway, as this session — credential and all.
    await scenario('a CONNECT tunnels container -> central -> gateway and echoes back', async () => {
      relay.registerRelayTarget(key, fingerprint, {
        host: '127.0.0.1',
        port: gwPort,
        username: 'agent-x',
        password: 's3cret-token',
      });
      const out = await rt(['exec', '-i', cname, 'bun', '-e', CLIENT], { timeout: 8000 });
      assert(/CLIENT_OK/.test(out), `client did not complete the tunnel: ${out.slice(0, 200)}`);
      assert(/echo:PING/.test(out), `payload did not echo: ${out.slice(0, 200)}`);
      assert(gateway.sawConnect.includes('echo.internal:443'), `gateway saw: ${JSON.stringify(gateway.sawConnect)}`);
      const expect = 'Basic ' + Buffer.from('agent-x:s3cret-token').toString('base64');
      assert(gateway.sawAuth.includes(expect), `credential not presented: ${JSON.stringify(gateway.sawAuth)}`);
    });

    // 3a') Network policy, end to end: a host not on the allowlist is refused by
    //      central before the gateway is dialled, and the client inside the
    //      container gets a proxy's answer — 403 with the reason — rather than
    //      a reset connection. A listed host still tunnels.
    await scenario(
      'the network policy refuses an unlisted host with a 403 the client can read; a listed host tunnels',
      async () => {
        egress.__setRunnerEgressForTest({ mode: 'host-only', allowlist: ['echo.internal'] });
        try {
          const probe = (host) => `
          const net = require('net');
          const s = net.connect(18080, '127.0.0.1', () => s.write('CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\nPING'));
          let got = '';
          s.on('data', (d) => { got += d.toString(); });
          s.on('close', () => { console.log('PROBE ' + JSON.stringify(got)); process.exit(0); });
          setTimeout(() => { console.log('PROBE ' + JSON.stringify(got)); process.exit(0); }, 4000);
        `;
          const before = gateway.sawConnect.length;
          const blocked = await rt(['exec', '-i', cname, 'bun', '-e', probe('paste.example')], { timeout: 10000 });
          assert(/403 Forbidden/.test(blocked), `expected a 403 for an unlisted host, got ${blocked.slice(0, 300)}`);
          assert(
            /blocked by NanoClaw network policy: paste\.example is not on the allowlist/.test(blocked),
            `the reason did not reach the client: ${blocked.slice(0, 300)}`,
          );
          assert(
            !gateway.sawConnect.slice(before).includes('paste.example:443'),
            'the gateway was dialled for a refused host',
          );
          assert(
            egress.listBlocked().some((b) => b.host === 'paste.example'),
            'the refusal was not recorded for the admin',
          );
          const allowed = await rt(['exec', '-i', cname, 'bun', '-e', probe('echo.internal')], { timeout: 10000 });
          assert(
            /200 Connection Established/.test(allowed) && /echo:PING/.test(allowed),
            `a listed host did not tunnel: ${allowed.slice(0, 300)}`,
          );
        } finally {
          egress.__setRunnerEgressForTest({ mode: 'open' });
        }
      },
    );

    // 3b) A large, sustained transfer both ways. An inference request/response
    //     is far bigger than a ping, and the forwarder base64-frames every
    //     chunk over the exec pipe: this proves the framing and throughput hold
    //     for a multi-megabyte body, so a failure in the field is the pipe, not
    //     the relay's data path.
    await scenario('the relay carries a multi-megabyte transfer intact', async () => {
      const bigGw = fakeGateway({ verbatim: true });
      const bigPort = await bigGw.listen();
      try {
        const bigKey = { installSlug: 'harness', agentGroupId: 'g-big', sessionId: 'sess-big' };
        // A second session on the SAME container/fingerprint, so the forwarder
        // multiplexes it alongside; register its target at the big gateway.
        relay.registerRelayTarget(bigKey, fingerprint, {
          host: '127.0.0.1',
          port: bigPort,
          username: 'x',
          password: 'y',
        });
        // The forwarder tags streams by the SessionRelay's key; reuse the live
        // relay (key = the main session) and point the main target at bigGw for
        // this one check.
        relay.registerRelayTarget(key, fingerprint, { host: '127.0.0.1', port: bigPort, username: 'x', password: 'y' });
        const SIZE = 6 * 1024 * 1024;
        const client = `
          const net = require('net');
          const SIZE = ${SIZE};
          const s = net.connect(18080, '127.0.0.1', () => s.write('CONNECT big.internal:443 HTTP/1.1\\r\\nHost: big.internal:443\\r\\n\\r\\n'));
          let established = false, sent = 0, recv = 0, sum = 0;
          const payload = Buffer.alloc(65536, 7);
          function pump() { while (sent < SIZE) { const n = Math.min(65536, SIZE - sent); if (!s.write(payload.slice(0, n))) { sent += n; s.once('drain', pump); return; } sent += n; } }
          s.on('data', (d) => {
            if (!established) { const i = d.indexOf('\\r\\n\\r\\n'); if (i === -1) return; established = true; const rest = d.slice(i + 4); for (const b of rest) sum += b; recv += rest.length; pump(); return; }
            for (const b of d) sum += b; recv += d.length;
            if (recv >= SIZE) { console.log('BIG_OK recv=' + recv + ' checksum=' + (sum === SIZE * 7)); process.exit(0); }
          });
          setTimeout(() => { console.log('BIG_TIMEOUT recv=' + recv + '/' + SIZE); process.exit(1); }, 30000);
        `;
        const out = await rt(['exec', '-i', cname, 'bun', '-e', client], { timeout: 35000 });
        assert(/BIG_OK/.test(out), `large transfer did not complete: ${out.slice(0, 200)}`);
        assert(/checksum=true/.test(out), `large transfer corrupted: ${out.slice(0, 200)}`);
      } finally {
        bigGw.close();
        // restore the main session's target for later scenarios
        relay.registerRelayTarget(key, fingerprint, {
          host: '127.0.0.1',
          port: gwPort,
          username: 'agent-x',
          password: 's3cret-token',
        });
      }
    });

    // 3b') A dropped pipe mid-transfer must pause bytes, not lose them. Kill the
    //      in-container attach client while a paced multi-megabyte transfer is
    //      in flight (exactly what a podman connection drop does to it); the
    //      agent's re-attach loop comes back and the transfer completes intact.
    await scenario('a dropped pipe mid-transfer pauses the tunnel; it completes intact after re-attach', async () => {
      const { ATTACH_MARK } = await extMod('relay.js');
      const bigGw = fakeGateway({ verbatim: true });
      const bigPort = await bigGw.listen();
      try {
        relay.registerRelayTarget(key, fingerprint, { host: '127.0.0.1', port: bigPort, username: 'x', password: 'y' });
        const SIZE = 4 * 1024 * 1024;
        const client = `
          const net = require('net');
          const SIZE = ${SIZE};
          const s = net.connect(18080, '127.0.0.1', () => s.write('CONNECT slow.internal:443 HTTP/1.1\\r\\nHost: slow.internal:443\\r\\n\\r\\n'));
          let established = false, sent = 0, recv = 0, sum = 0;
          const payload = Buffer.alloc(32768, 9);
          // Paced: ~32 KiB every 8 ms → ~4 MiB/s, so the drop lands mid-stream.
          const pump = () => { if (sent >= SIZE) return; const n = Math.min(32768, SIZE - sent); s.write(payload.slice(0, n)); sent += n; setTimeout(pump, 8); };
          s.on('data', (d) => {
            if (!established) { const i = d.indexOf('\\r\\n\\r\\n'); if (i === -1) return; established = true; const rest = d.slice(i + 4); for (const b of rest) sum += b; recv += rest.length; pump(); return; }
            for (const b of d) sum += b; recv += d.length;
            if (recv >= SIZE) { console.log('DROP_OK recv=' + recv + ' checksum=' + (sum === SIZE * 9)); process.exit(0); }
          });
          s.on('error', (e) => { console.log('DROP_ERR ' + e.code); process.exit(1); });
          s.on('close', () => { if (recv < SIZE) { console.log('DROP_CLOSED recv=' + recv); process.exit(1); } });
          setTimeout(() => { console.log('DROP_TIMEOUT recv=' + recv + '/' + SIZE); process.exit(1); }, 40000);
        `;
        const transfer = rt(['exec', '-i', cname, 'bun', '-e', client], { timeout: 45000 });
        await sleep(400); // transfer under way
        // Kill the attach client inside the container: the pipe "drops".
        const killed = await rt([
          'exec',
          cname,
          'sh',
          '-c',
          `me=$$; for p in /proc/[0-9]*; do pid=$(basename $p); [ "$pid" = "$me" ] && continue; if tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '${ATTACH_MARK}'; then kill -9 $pid && echo killed $pid; fi; done; true`,
        ]);
        assert(/killed \d+/.test(killed), `no attach client found to kill: ${killed}`);
        await until(() => /relay pipe for .* ended/.test(runner.logText()), {
          what: 'extension noticed the drop',
          timeoutMs: 10000,
        });
        const out = await transfer;
        assert(/DROP_OK/.test(out), `transfer did not complete across the drop: ${out.slice(0, 200)}`);
        assert(/checksum=true/.test(out), `transfer corrupted across the drop: ${out.slice(0, 200)}`);
        assert(
          /relay attached inside the container .*\(replayed \d+\)|relay attached inside the container/.test(
            runner.logText(),
          ),
          'no re-attach logged',
        );
      } finally {
        bigGw.close();
        relay.registerRelayTarget(key, fingerprint, {
          host: '127.0.0.1',
          port: gwPort,
          username: 'agent-x',
          password: 's3cret-token',
        });
      }
    });

    // 3d') Propose mode: the slot binds a CLONE, so the agent's edits land in a
    //      copy while the developer's working tree is untouched, and applying
    //      brings a chosen file across. This is the whole safety story for a
    //      team rollout, so it runs against a real repository and container.
    await scenario('propose mode: the agent edits a clone; the developer applies chosen files', async () => {
      const { execFileSync } = await import('node:child_process');
      const { applyProposal, proposalChanges } = await extMod('git-changes.js');
      const { RELAY_SENTINEL } = await extMod('remote-spec.js');
      const repo = path.join(tmp, 'devrepo');
      fs.mkdirSync(repo, { recursive: true });
      const sh = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      sh(['init', '-q']);
      sh(['config', 'user.email', 't@t']);
      sh(['config', 'user.name', 't']);
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
      sh(['add', '-A']);
      sh(['commit', '-qm', 'init']);
      fs.writeFileSync(path.join(repo, 'WIP.txt'), 'the developer is mid-edit\n'); // must never be disturbed
      const pname = 'ncl-harness-sess-propose';
      await rmf(pname);
      const fp3 = 'q'.repeat(64);
      const runner3 = makeRunner({
        RunnerAgent,
        RunnerLink,
        realCli,
        storageRoot: path.join(tmp, 'runner3'),
        serverUrl: central.url,
        fingerprint: fp3,
        policy: { slots: { '/workspace/project': repo }, allowlist: [tmp] },
      });
      try {
        runner3.link.start();
        await until(() => runner3.link.welcome?.pairing === 'approved', { what: 'runner3 welcome' });
        const pspec = {
          v: 1,
          key: { installSlug: 'harness', agentGroupId: 'g-prop', sessionId: 'sess-prop' },
          name: pname,
          labels: {},
          image: IMAGE,
          imagePolicy: 'machine',
          env: {
            HTTPS_PROXY: RELAY_SENTINEL,
            NANOCLAW_PROJECT_DIR: '/workspace/project',
            NANOCLAW_PROJECT_MODE: 'propose',
          },
          contributedEnv: {},
          command: ['sleep'],
          args: ['infinity'],
          containerLabels: {},
          mounts: [
            {
              kind: 'slot',
              class: 'allowlisted-extra',
              containerPath: '/workspace/project',
              mode: 'rw',
              propose: true,
            },
          ],
          resources: {},
          hardening: 'standard',
          stopGraceSeconds: 1,
          network: 'default',
        };
        await transport.runnerRequest(fp3, 'prepare', { spec: pspec }, 60000);
        assert(
          /proposal copy of/.test(runner3.logText()),
          `no proposal clone logged: ${runner3.logText().slice(-300)}`,
        );
        await transport.runnerRequest(fp3, 'start', { name: pname, key: pspec.key }, 30000);
        await until(
          async () => (await transport.runnerRequest(fp3, 'status', { name: pname }, 8000)).state === 'running',
          {
            what: 'proposal container running',
            timeoutMs: 30000,
          },
        );
        // The agent edits an existing file and adds one, inside the container.
        await rt([
          'exec',
          pname,
          'sh',
          '-c',
          'cd /workspace/project && printf "export const x = 2;\\n" > src/app.ts && printf "export const y = 1;\\n" > src/util.ts && ls WIP.txt 2>/dev/null; true',
        ]);
        const proposal = runner3.agent.currentProposal();
        assert(proposal, 'runner has no current proposal');
        const proposed = await proposalChanges(proposal);
        assert(proposed.length === 2, `expected 2 proposed files, got ${JSON.stringify(proposed)}`);
        // The developer's tree is untouched so far.
        assert(
          fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8') === 'export const x = 1;\n',
          'working tree was modified',
        );
        assert(!fs.existsSync(path.join(repo, 'src', 'util.ts')), 'new file leaked into the working tree');
        // The container never saw the uncommitted file.
        const sawWip = await rt([
          'exec',
          pname,
          'sh',
          '-c',
          'ls /workspace/project/WIP.txt 2>/dev/null || echo absent',
        ]);
        assert(/absent/.test(sawWip), `uncommitted developer file was visible to the agent: ${sawWip}`);
        // Apply one file only.
        const applied = await applyProposal(proposal, ['src/app.ts']);
        assert(applied.join() === 'src/app.ts', `apply returned ${JSON.stringify(applied)}`);
        assert(
          fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8') === 'export const x = 2;\n',
          'apply did not reach the working tree',
        );
        assert(!fs.existsSync(path.join(repo, 'src', 'util.ts')), 'unchosen file was applied');
        assert(
          fs.readFileSync(path.join(repo, 'WIP.txt'), 'utf8') === 'the developer is mid-edit\n',
          'apply disturbed the developer’s own work',
        );
      } finally {
        try {
          runner3.link.stop();
          runner3.agent.dispose();
        } catch {}
        await rmf(pname);
      }
    });

    // 3e) MCP through the relay: an agent's plain-HTTP call to central's MCP
    //     relay (http://, token-gated, credential injected on central) must
    //     tunnel out of a network-less container and come back — the proxy
    //     shape the daemon had to learn beyond CONNECT.
    await scenario('a plain-HTTP MCP call tunnels out of the container and back', async () => {
      const seen = [];
      const mcp = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url} host=${req.headers.host} tok=${req.headers['x-nanoclaw-relay'] ?? ''}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tools: ['create_issue'] }));
      });
      await new Promise((r) => mcp.listen(MCP_PORT, '127.0.0.1', r));
      try {
        // The agent's HTTP client, proxying to the in-container forwarder.
        const client = `
          const net = require('net');
          const s = net.connect(18080, '127.0.0.1', () => s.write(
            'GET http://host.docker.internal:${MCP_PORT}/relay/srv-1 HTTP/1.1\\r\\n' +
            'Host: host.docker.internal:${MCP_PORT}\\r\\n' +
            'X-NanoClaw-Relay: tok-abc\\r\\n' +
            'Proxy-Connection: keep-alive\\r\\n\\r\\n'));
          let got = '';
          s.on('data', (d) => { got += d.toString(); if (got.includes('}')) { console.log('MCP_OK ' + JSON.stringify(got)); process.exit(0); } });
          setTimeout(() => { console.log('MCP_TIMEOUT ' + JSON.stringify(got)); process.exit(1); }, 6000);
        `;
        const out = await rt(['exec', '-i', cname, 'bun', '-e', client], { timeout: 12000 });
        assert(/MCP_OK/.test(out), `MCP call did not complete: ${out.slice(0, 200)}`);
        assert(/create_issue/.test(out), `response body did not come back: ${out.slice(0, 200)}`);
        assert(seen.length === 1, `relay saw ${JSON.stringify(seen)}`);
        // Origin-form path, the token header preserved, the proxy-only header gone.
        assert(seen[0].startsWith('GET /relay/srv-1 '), `request was not rewritten to origin-form: ${seen[0]}`);
        assert(seen[0].includes('tok=tok-abc'), `relay token header lost: ${seen[0]}`);
        // The gateway was never involved: this destination is central's own.
        assert(!gateway.sawConnect.includes(`host.docker.internal:${MCP_PORT}`), 'MCP went through the egress gateway');
      } finally {
        mcp.close();
      }
    });

    // 3f) W2: the container syncs its own mailbox with central over the relay,
    //     instead of central reaching into the machine every two seconds. Real
    //     endpoint, real relay, real container: a message central holds reaches
    //     the agent, and an answer written in the container reaches central's
    //     outbox — where its delivery path reads it.
    await scenario('a placed session syncs its own mailbox with central over the relay', async () => {
      const http = await import('node:http');
      const { inboundDbPath, outboundDbPath } = await cenMod('mailbox/sqlite/paths.js');
      const mkey = { installSlug: 'harness', agentGroupId: 'harness-mbx', sessionId: 'sess-harness-mbx' };
      // The endpoint reads central's own data directory, so the session lives there.
      const inbound = inboundDbPath(mkey.agentGroupId, mkey.sessionId);
      const outbound = outboundDbPath(mkey.agentGroupId, mkey.sessionId);
      const sessionDir = path.dirname(inbound);
      fs.mkdirSync(sessionDir, { recursive: true });
      sessionDb.ensureSchema(inbound, 'inbound');
      sessionDb.ensureSchema(outbound, 'outbound');
      const server = http.createServer((req, res) => void mailboxEndpoint.handleMailboxRequest(req, res));
      await new Promise((r) => server.listen(MAILBOX_PORT, '127.0.0.1', r));
      const token = mailboxEndpoint.issueMailboxToken(mkey, fingerprint);
      try {
        const db = sessionDb.openInboundDb(inbound);
        db.prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, content, trigger, on_wake) VALUES (?, ?, 'chat', ?, ?, 1, 0)`,
        ).run('m-w2', 2, new Date().toISOString(), JSON.stringify({ text: 'hello over the relay' }));
        db.close();

        // Exactly what the syncer does, from inside a network-less container,
        // reaching central only through the relay.
        const viaRelay = `
          const T = ${JSON.stringify(token)};
          const base = 'http://host.docker.internal:${MAILBOX_PORT}';
          const res = await fetch(base + '/mailbox/inbound?after=0', { headers: { 'X-NanoClaw-Mailbox': T } });
          const body = await res.json();
          const post = await fetch(base + '/mailbox/outbound', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-NanoClaw-Mailbox': T },
            body: JSON.stringify({ rows: [{ id: 'o-w2', seq: 3, kind: 'chat', timestamp: new Date().toISOString(), content: JSON.stringify({ text: 'answered from the container' }) }] }),
          });
          const bad = await fetch(base + '/mailbox/inbound?after=0', { headers: { 'X-NanoClaw-Mailbox': 'not-my-token' } });
          console.log('RELAY_MBX ' + JSON.stringify({ pulled: body.rows.map((r) => r.id), posted: (await post.json()).inserted, refused: bad.status }));
        `;
        const out = await rt(['exec', '-e', 'HTTP_PROXY=http://127.0.0.1:18080', '-i', cname, 'bun', '-e', viaRelay], {
          timeout: 20000,
        });
        assert(/RELAY_MBX/.test(out), `mailbox over the relay failed: ${out.slice(0, 300)}`);
        assert(/"pulled":\["m-w2"\]/.test(out), `the agent did not receive central's message: ${out}`);
        assert(/"posted":1/.test(out), `central did not accept the answer: ${out}`);
        assert(/"refused":403/.test(out), `a wrong token was not refused: ${out}`);

        const outDb = sessionDb.openOutboundDb(outbound);
        const rows = outDb.prepare('SELECT id FROM messages_out').all();
        outDb.close();
        assert(rows.length === 1 && rows[0].id === 'o-w2', `central's outbox: ${JSON.stringify(rows)}`);
      } finally {
        server.close();
        mailboxEndpoint.revokeMailboxToken(mkey);
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    });

    // 3g) Files ride the same path: an attachment central saved for a message
    //     comes down, a file the agent sent (send_file) goes up — binary, a few
    //     megabytes, byte-exact, through the real relay.
    await scenario(
      'files travel with the mailbox: an attachment comes down, a sent file goes up, byte-exact',
      async () => {
        const http = await import('node:http');
        const crypto = await import('node:crypto');
        const { inboundDbPath } = await cenMod('mailbox/sqlite/paths.js');
        const fkey = { installSlug: 'harness', agentGroupId: 'harness-files', sessionId: 'sess-harness-files' };
        const sessionDir = path.dirname(inboundDbPath(fkey.agentGroupId, fkey.sessionId));
        fs.mkdirSync(path.join(sessionDir, 'inbox/m-att'), { recursive: true });
        const down = crypto.randomBytes(3 * 1024 * 1024 + 17);
        fs.writeFileSync(path.join(sessionDir, 'inbox/m-att/shot.png'), down);
        const server = http.createServer((req, res) => void mailboxEndpoint.handleMailboxRequest(req, res));
        await new Promise((r) => server.listen(MAILBOX_PORT, '127.0.0.1', r));
        const token = mailboxEndpoint.issueMailboxToken(fkey, fingerprint);
        try {
          const viaRelay = `
          const crypto = require('crypto');
          const T = ${JSON.stringify(token)};
          const base = 'http://host.docker.internal:${MAILBOX_PORT}';
          const got = Buffer.from(await (await fetch(base + '/mailbox/file?path=' + encodeURIComponent('inbox/m-att/shot.png'), { headers: { 'X-NanoClaw-Mailbox': T } })).arrayBuffer());
          const up = crypto.createHash('sha256').update('x').digest().toString('hex').repeat(40000);
          const put = await fetch(base + '/mailbox/file?path=' + encodeURIComponent('outbox/o-file/report.txt'), { method: 'PUT', headers: { 'X-NanoClaw-Mailbox': T, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(up) });
          console.log('RELAY_FILES ' + JSON.stringify({ downSha: crypto.createHash('sha256').update(got).digest('hex'), downLen: got.length, put: put.status, upSha: crypto.createHash('sha256').update(up).digest('hex') }));
        `;
          const out = await rt(
            ['exec', '-e', 'HTTP_PROXY=http://127.0.0.1:18080', '-i', cname, 'bun', '-e', viaRelay],
            { timeout: 60000 },
          );
          const m = /RELAY_FILES (.*)/.exec(out);
          assert(m, `file transfer over the relay failed: ${out.slice(0, 300)}`);
          const r = JSON.parse(m[1]);
          const want = crypto.createHash('sha256').update(down).digest('hex');
          assert(
            r.downLen === down.length && r.downSha === want,
            `attachment arrived altered: ${r.downLen} bytes, sha ${r.downSha.slice(0, 12)} vs ${want.slice(0, 12)}`,
          );
          assert(r.put === 200, `upload refused: ${r.put}`);
          const landed = fs.readFileSync(path.join(sessionDir, 'outbox/o-file/report.txt'));
          assert(
            crypto.createHash('sha256').update(landed).digest('hex') === r.upSha,
            "sent file landed altered in central's outbox",
          );
        } finally {
          server.close();
          mailboxEndpoint.revokeMailboxToken(fkey);
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      },
    );

    // 3c) Enforcement: the container has no network of its own. A direct
    //     connection out fails, while the same destination through the relay
    //     works — so the tunnel via central is the only egress, by construction.
    await scenario('the container has no network: direct egress fails, the relay is the only way out', async () => {
      const mode = (await rt(['inspect', '--format', '{{.HostConfig.NetworkMode}}', cname])).trim();
      assert(mode === 'none', `expected NetworkMode none, got ${mode}`);
      const direct = `
        const net = require('net');
        const s = net.connect(443, '1.1.1.1');
        s.on('connect', () => { console.log('DIRECT_CONNECTED'); process.exit(0); });
        s.on('error', (e) => { console.log('DIRECT_FAILED ' + e.code); process.exit(0); });
        setTimeout(() => { console.log('DIRECT_TIMEOUT'); process.exit(0); }, 4000);
      `;
      const out = await rt(['exec', cname, 'bun', '-e', direct], { timeout: 8000 });
      assert(/DIRECT_FAILED|DIRECT_TIMEOUT/.test(out), `container reached the internet directly: ${out.slice(0, 120)}`);
      // …and the relay path still works from the same network-less container.
      const via = await rt(['exec', '-i', cname, 'bun', '-e', CLIENT], { timeout: 8000 });
      assert(/CLIENT_OK/.test(via), `relay broken under --network none: ${via.slice(0, 160)}`);
    });

    // 3d) The developer's workspace. Central declares the slot; the laptop binds
    //     its open folder; a real `prepare` creates the container with that
    //     mount read/write and no network; a file written inside appears on the
    //     host. This is what makes an agent on a laptop useful for coding.
    await scenario(
      'prepare binds the developer workspace slot rw: a file written inside appears on the host',
      async () => {
        const { RELAY_SENTINEL } = await extMod('remote-spec.js');
        const project = path.join(tmp, 'project');
        fs.mkdirSync(path.join(project, 'secrets'), { recursive: true });
        fs.mkdirSync(path.join(project, 'src'), { recursive: true });
        fs.writeFileSync(path.join(project, 'secrets', 'password.txt'), 'hunter2');
        fs.writeFileSync(path.join(project, '.env'), 'API_KEY=abc');
        fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export const x = 1;');
        const pname = 'ncl-harness-sess-proj';
        await rmf(pname);
        const runner2 = makeRunner({
          RunnerAgent,
          RunnerLink,
          realCli,
          storageRoot: path.join(tmp, 'runner2'),
          serverUrl: central.url,
          fingerprint: 'p'.repeat(64),
          policy: { slots: { '/workspace/project': project }, allowlist: [tmp] },
        });
        const fp2 = 'p'.repeat(64);
        try {
          runner2.link.start();
          await until(() => runner2.link.welcome?.pairing === 'approved', { what: 'runner2 welcome' });
          const pspec = {
            v: 1,
            key: { installSlug: 'harness', agentGroupId: 'g-proj', sessionId: 'sess-proj' },
            name: pname,
            labels: {},
            image: IMAGE,
            imagePolicy: 'machine',
            env: { HTTPS_PROXY: RELAY_SENTINEL, NANOCLAW_PROJECT_DIR: '/workspace/project' },
            contributedEnv: {},
            command: ['sleep'],
            args: ['infinity'],
            containerLabels: {},
            mounts: [{ kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/project', mode: 'rw' }],
            resources: {},
            hardening: 'standard',
            stopGraceSeconds: 1,
            network: 'default',
          };
          const prep = await transport.runnerRequest(fp2, 'prepare', { spec: pspec }, 60000);
          assert(prep.name === pname, `prepare returned ${JSON.stringify(prep)}`);
          assert(
            runner2.logText().includes(`slot /workspace/project ← ${fs.realpathSync(project)} (rw)`),
            `slot binding not logged: ${runner2.logText().slice(-300)}`,
          );
          await transport.runnerRequest(fp2, 'start', { name: pname, key: pspec.key }, 30000);
          await until(() => /relay attached inside the container/.test(runner2.logText()), {
            what: 'proj relay',
            timeoutMs: 30000,
          });
          // The same spec again must ADOPT the running container, not recreate it:
          // this is the path every reconnect and re-spawn takes, and it runs the
          // real inspect templates (a malformed one recreated live containers for weeks).
          const again = await transport.runnerRequest(fp2, 'prepare', { spec: pspec }, 60000);
          assert(
            again.reused === true,
            `second prepare did not adopt: ${JSON.stringify(again)}; log: ${runner2.logText().slice(-300)}`,
          );
          assert(
            !/recreating it/.test(runner2.logText()),
            `container was recreated on re-prepare: ${runner2.logText().slice(-300)}`,
          );
          const mode = (await rt(['inspect', '--format', '{{.HostConfig.NetworkMode}}', pname])).trim();
          assert(mode === 'none', `expected NetworkMode none, got ${mode}`);
          await rt([
            'exec',
            pname,
            'sh',
            '-c',
            'echo "written by the agent" > /workspace/project/hello-from-agent.txt && cat /workspace/project/hello-from-agent.txt',
          ]);
          const hostFile = path.join(project, 'hello-from-agent.txt');
          assert(fs.existsSync(hostFile), 'file written in the container did not appear on the host');
          assert(fs.readFileSync(hostFile, 'utf8').trim() === 'written by the agent', 'host file content mismatch');
          // And the agent sees files the developer already has.
          fs.writeFileSync(path.join(project, 'README.md'), '# hello');
          const seen = await rt(['exec', pname, 'cat', '/workspace/project/README.md']);
          assert(seen.trim() === '# hello', `container did not see the host file: ${seen}`);
          // Secret-like paths are hidden: the folder is empty and read-only, the .env is empty, code is intact.
          assert(
            runner2.logText().includes('hiding 2 secret-like path(s) under /workspace/project'),
            `no hiding logged: ${runner2.logText().slice(-400)}`,
          );
          const probe = await rt([
            'exec',
            pname,
            'sh',
            '-c',
            'echo "secrets:[$(ls -A /workspace/project/secrets | tr \'\\n\' \' \')]"; echo "env:[$(cat /workspace/project/.env)]"; echo "app:[$(cat /workspace/project/src/app.ts)]"; (echo leak > /workspace/project/secrets/new.txt 2>/dev/null && echo "secrets-writable") || echo "secrets-ro"; (echo more >> /workspace/project/.env 2>/dev/null && echo "env-writable") || echo "env-ro"',
          ]);
          assert(/secrets:\[\s*\]/.test(probe), `secrets folder visible: ${probe}`);
          assert(/env:\[\]/.test(probe), `.env content visible: ${probe}`);
          assert(/app:\[export const x = 1;\]/.test(probe), `source not readable: ${probe}`);
          assert(/secrets-ro/.test(probe) && /env-ro/.test(probe), `hidden paths writable: ${probe}`);
          assert(
            fs.readFileSync(path.join(project, 'secrets', 'password.txt'), 'utf8') === 'hunter2',
            'host secret altered',
          );
        } finally {
          try {
            runner2.link.stop();
          } catch {}
          await rmf(pname);
        }
      },
    );

    // 4) A stream for a session this machine was not given is refused, and the
    //    gateway is never dialed on its behalf.
    await scenario('the relay refuses a stream for an unplaced session', async () => {
      const other = { installSlug: 'harness', agentGroupId: 'g-other', sessionId: 'sess-other' };
      const before = gateway.sawConnect.length;
      // Ask central to open a stream naming a session not registered to this fp.
      relay.handleRelayFrame(fingerprint, {
        type: 'relay.open',
        streamId: 'x1',
        key: other,
        host: 'evil.example',
        port: 443,
      });
      await sleep(200);
      assert(gateway.sawConnect.length === before, 'gateway must not be dialed for an unplaced session');
    });

    // 8) A stale port holder (a forwarder from an older build, say) does not
    //    wedge the relay: the daemon evicts whatever holds :18080 and binds.
    await scenario('a stale process holding the relay port is evicted when the daemon starts', async () => {
      const stale = `
        const net = require('net');
        net.createServer(() => {}).listen(18080, '127.0.0.1', () => console.log('stale-bound'));
        setInterval(() => {}, 1000);
      `;
      // First, stop the live daemon so the port is free for the stale holder.
      await rt([
        'exec',
        cname,
        'sh',
        '-c',
        "me=$$; for p in /proc/[0-9]*; do pid=$(basename $p); [ \"$pid\" = \"$me\" ] && continue; if tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q 'nanoclaw relay tunnels CONNECT only'; then kill -9 $pid; fi; done; true",
      ]);
      await sleep(500);
      await rt(['exec', '-d', cname, 'bun', '-e', stale]);
      await sleep(600);
      const before = (runner.logText().match(/relay attached inside/g) || []).length;
      // The agent's loop sees the pipe end (daemon gone), gets no-daemon, starts a daemon (which evicts the stale holder), re-attaches.
      await until(() => (runner.logText().match(/relay attached inside/g) || []).length > before, {
        what: 're-attach after eviction',
        timeoutMs: 30000,
      });
      await until(
        async () =>
          /CLIENT_OK/.test(await rt(['exec', '-i', cname, 'bun', '-e', CLIENT], { timeout: 8000 }).catch(() => '')),
        { what: 'tunnel works after eviction', timeoutMs: 20000, everyMs: 1000 },
      );
    });

    // 9) Reconnect: a window reload loses the runner's state, but the container
    //    keeps running; central re-issues start and everything re-attaches
    //    (the central-side reconnect fix, exercised through the real link).
    await scenario('after a reconnect, re-issuing start re-adopts the running container', async () => {
      runner.link.stop();
      runner.agent.dispose(); // a window reload ends the old extension host — and with it the old re-attach loop
      await until(() => !transport.isRunnerConnected(fingerprint), { what: 'central sees disconnect' });
      // Fresh runner: brand-new agent with empty live map, as after a reload.
      runner = makeRunner({ RunnerAgent, RunnerLink, realCli, storageRoot, serverUrl: central.url, fingerprint });
      runner.link.start();
      await until(() => runner.link.welcome?.pairing === 'approved', { what: 're-welcome' });
      // The container is still there; central re-issues start (its resume path).
      await transport.runnerRequest(fingerprint, 'start', { name: cname, key }, 15000);
      await until(() => /relay attached inside the container/.test(runner.logText()), {
        what: 'relay back after reconnect',
        timeoutMs: 20000,
      });
      const st = await transport.runnerRequest(fingerprint, 'status', { name: cname }, 8000);
      assert(st.state === 'running', `expected running after reconnect, got ${JSON.stringify(st)}`);
      let out = '';
      try {
        out = await rt(['exec', '-i', cname, 'bun', '-e', CLIENT], { timeout: 8000 });
      } catch (e) {
        out = String(e.stdout || e.message);
      }
      assert(
        /CLIENT_OK/.test(out),
        `tunnel broken after reconnect: ${out.slice(0, 200)}\n        runner log tail: ${runner.logText().slice(-700).replace(/\n/g, '\n          ')}`,
      );
    });

    // 10) Sleep and resume (S5): the runtime stops answering under a live,
    //     supervised session. The runner must tell central once, never call it
    //     terminal, and pick the container back up when the runtime answers.
    await scenario('a runtime that goes away holds the session; it resumes when the runtime answers', async () => {
      const runtimeFrames = [];
      const events = [];
      transport.onRunnerRuntime((fp, reachable) => runtimeFrames.push(reachable));
      const offEvents = transport.onRunnerEvent((fp, e) => events.push(e.kind));
      // Make sure it is supervised by THIS runner first.
      await transport.runnerRequest(fingerprint, 'start', { name: cname, key, resume: true }, 15000);
      const attachesBefore = (runner.logText().match(/supervision channel dropped/g) || []).length;
      runner.runtime.down = true;
      // Kill the supervision pipe the way a sleeping VM does.
      await rt(['exec', cname, 'true']).catch(() => {});
      runner.agent['live'].get(cname)?.wait?.kill();
      await until(() => runtimeFrames.includes(false), {
        what: 'central told the runtime is unreachable',
        timeoutMs: 20000,
      });
      // Status tells the truth rather than "absent".
      let refused = null;
      await transport.runnerRequest(fingerprint, 'status', { name: cname }, 8000).catch((e) => (refused = e));
      assert(
        refused?.failure?.kind === 'runtime-unavailable',
        `status while down should refuse retryably, got ${JSON.stringify(refused?.failure ?? refused)}`,
      );
      await sleep(7000); // past the first re-attach attempt
      assert(!events.includes('terminal'), `no terminal while the runtime is merely away; events=${events.join(',')}`);
      runner.runtime.down = false;
      await until(() => runtimeFrames[runtimeFrames.length - 1] === true, {
        what: 'central told the runtime is back',
        timeoutMs: 30000,
      });
      await until(() => (runner.logText().match(/supervision channel dropped/g) || []).length > attachesBefore, {
        what: 'drop noticed',
      });
      await until(() => /answers again/.test(runner.logText()), {
        what: 're-attach after runtime returns',
        timeoutMs: 30000,
      });
      const st = await transport.runnerRequest(fingerprint, 'status', { name: cname }, 8000);
      assert(st.state === 'running', `container should have survived, got ${JSON.stringify(st)}`);
      assert(!events.includes('terminal'), `no terminal after resuming; events=${events.join(',')}`);
      await until(
        async () =>
          /CLIENT_OK/.test(await rt(['exec', '-i', cname, 'bun', '-e', CLIENT], { timeout: 8000 }).catch(() => '')),
        { what: 'tunnel works after resume', timeoutMs: 30000, everyMs: 1000 },
      );
      offEvents();
    });

    // 11) A container that stopped while nobody watched is over: a resume
    //     refuses (central then respawns) and never revives the corpse.
    await scenario('a resume never revives a container that stopped while the machine was away', async () => {
      runner.link.stop();
      runner.agent.dispose();
      await until(() => !transport.isRunnerConnected(fingerprint), { what: 'central sees disconnect' });
      await rt(['stop', '-t', '1', cname]);
      runner = makeRunner({ RunnerAgent, RunnerLink, realCli, storageRoot, serverUrl: central.url, fingerprint });
      runner.link.start();
      await until(() => runner.link.welcome?.pairing === 'approved', { what: 're-welcome' });
      let refused = null;
      await transport
        .runnerRequest(fingerprint, 'start', { name: cname, key, resume: true }, 15000)
        .catch((e) => (refused = e));
      assert(
        refused && /no container/.test(refused.message),
        `expected a no-container refusal, got ${refused ? refused.message : 'success'}`,
      );
      const st = await transport.runnerRequest(fingerprint, 'status', { name: cname }, 8000);
      assert(st.state === 'absent', `the corpse should be cleared for the respawn, got ${JSON.stringify(st)}`);
    });
  } finally {
    await cleanup();
  }

  log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  log(`\x1b[31mHARNESS CRASHED\x1b[0m\n${err && err.stack ? err.stack : err}`);
  process.exit(3);
});
