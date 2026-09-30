/**
 * Reaching the credential gateway from central's own process: the egress
 * filter's way out for every filtered agent.
 */
import net from 'net';

import { onecliSettings } from '../../onecli-settings.js';
import { isSafeEgressHost } from './egress-policy.js';

export interface RelayTarget {
  host: string;
  port: number;
  username: string;
  password: string;
}

export const CONNECT_TIMEOUT_MS = 20_000;

/**
 * The spec names the gateway the way a CONTAINER reaches it (`host.docker.internal`);
 * this process is not a container and cannot resolve that. Central reaches the
 * same gateway at the address ONECLI_URL is configured with.
 */
export function gatewayHostForCentral(host: string): string {
  if (host !== 'host.docker.internal' && host !== 'host.containers.internal') return host;
  // A gateway the container reaches as "the host" is a port on central's own
  // machine. OneCLI may be bound to a specific address (ONECLI_URL); any other
  // gateway, or OneCLI without a URL, is reached on loopback.
  const { gateway, url } = onecliSettings();
  if (gateway === 'onecli' && url) {
    try {
      return new URL(url).hostname || '127.0.0.1';
    } catch {
      /* fall through */
    }
  }
  return '127.0.0.1';
}

export function connectThroughGateway(target: RelayTarget, host: string, port: number): Promise<net.Socket> {
  if (!isSafeEgressHost(host) || !Number.isInteger(port) || port <= 0 || port > 65535)
    return Promise.reject(new Error('refusing an unsafe CONNECT target'));
  const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: gatewayHostForCentral(target.host), port: target.port });
    const fail = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('gateway did not answer CONNECT in time')), CONNECT_TIMEOUT_MS);
    socket.once('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    socket.once('connect', () => {
      const auth = Buffer.from(`${target.username}:${target.password}`).toString('base64');
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${auth}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
      );
    });
    let preamble = '';
    const onData = (chunk: Buffer): void => {
      preamble += chunk.toString('latin1');
      const end = preamble.indexOf('\r\n\r\n');
      if (end === -1) {
        if (preamble.length > 16 * 1024) fail(new Error('gateway sent no CONNECT response'));
        return;
      }
      clearTimeout(timer);
      socket.off('data', onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(preamble)?.[1] ?? 0);
      if (status !== 200) {
        // The gateway's own refusal (a blocked host, a rate limit, a bad
        // token). Report the status, never the body — it may echo the request.
        return fail(new Error(`gateway refused the tunnel (HTTP ${status || 'malformed'})`));
      }
      // Anything the gateway already sent past the header belongs to the tunnel.
      const rest = Buffer.from(preamble.slice(end + 4), 'latin1');
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}
