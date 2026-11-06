// ssh ProxyCommand for deploy keys: `ProxyCommand bun /app/src/ssh-proxy.ts %h %p`.
//
// An agent on the open network reaches the target directly. An agent in
// Allowlist mode has no route out: everything leaves through the proxy in
// HTTPS_PROXY (NanoClaw's egress filter), which opens a tunnel to a deploy
// key's own target for the agent holding the key. So: try a direct connection
// briefly, then CONNECT through the proxy, then pipe stdin/stdout.
import net from 'net';

const DIRECT_TIMEOUT_MS = 2_500;
const [host, port] = process.argv.slice(2);
const proxyRaw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

function fail(msg: string): never {
  process.stderr.write(`ssh-proxy: ${msg}\n`);
  process.exit(1);
}

function pipe(sock: net.Socket, rest?: Buffer): void {
  if (rest?.length) process.stdout.write(rest);
  sock.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  process.stdin.pipe(sock);
  sock.on('end', () => process.exit(0));
  sock.on('close', () => process.exit(0));
  sock.on('error', (err) => fail(err.message));
}

function direct(): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const sock = net.connect(Number(port), host);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, DIRECT_TIMEOUT_MS);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function viaProxy(): void {
  if (!proxyRaw) fail(`cannot reach ${host}:${port}, and there is no proxy to try`);
  const proxy = new URL(proxyRaw);
  const auth = proxy.username
    ? Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
    : null;
  const sock = net.connect(Number(proxy.port || 80), proxy.hostname, () => {
    sock.write(
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
        (auth ? `Proxy-Authorization: Basic ${auth}\r\n` : '') +
        '\r\n',
    );
  });
  let head = Buffer.alloc(0);
  const onHead = (chunk: Buffer): void => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    sock.off('data', onHead);
    const status = head.subarray(0, end).toString().split('\r\n')[0] ?? '';
    if (!/^HTTP\/1\.[01] 200/.test(status))
      fail(
        /403/.test(status)
          ? `${host}:${port} is not open to this agent (${status}). A deploy key's target is reachable in Allowlist mode; otherwise an admin must allow it.`
          : `the proxy refused ${host}:${port}: ${status}`,
      );
    pipe(sock, head.subarray(end + 4));
  };
  sock.on('data', onHead);
  sock.on('error', (err) => fail(err.message));
}

if (!host || !port) fail('usage: ssh-proxy <host> <port>');
const sock = await direct();
if (sock) pipe(sock);
else viaProxy();
