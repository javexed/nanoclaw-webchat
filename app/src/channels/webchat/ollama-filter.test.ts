import http from 'http';
import net from 'net';
import { Duplex } from 'stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ollamaRequestAllowed, serveOllamaFiltered } from './ollama-filter.js';

describe('what an agent may ask of Ollama', () => {
  it('inference in all three APIs, and read-only lookups', () => {
    for (const [m, p] of [
      ['POST', '/api/chat'],
      ['POST', '/api/generate'],
      ['POST', '/api/embed'],
      ['POST', '/api/show'],
      ['POST', '/v1/chat/completions'],
      ['POST', '/v1/messages'],
      ['POST', '/v1/messages/count_tokens?beta=true'],
      ['GET', '/api/tags'],
      ['GET', '/api/ps'],
      ['GET', '/v1/models'],
      ['GET', '/v1/models/qwen3:8b'],
      ['GET', '/'],
      ['HEAD', '/'],
    ])
      expect(ollamaRequestAllowed(m, p), `${m} ${p}`).toBe(true);
  });

  it('never pull, delete, create, copy, push, or a path dressed up as an allowed one', () => {
    for (const [m, p] of [
      ['POST', '/api/pull'],
      ['DELETE', '/api/delete'],
      ['POST', '/api/create'],
      ['POST', '/api/copy'],
      ['POST', '/api/push'],
      ['POST', '/api/blobs/sha256:abc'],
      ['GET', '/api/chat'],
      ['POST', '/api/chat/../pull'],
      ['POST', '//api/chat'],
      ['GET', '/v1/models/'],
      ['PUT', '/api/chat'],
    ])
      expect(ollamaRequestAllowed(m, p), `${m} ${p}`).toBe(false);
  });
});

describe('an agent connection to Ollama, through the filter', () => {
  let ollama: http.Server;
  let ollamaPort: number;
  let reached: string[];
  let front: net.Server;
  let frontPort: number;
  let refused: string[];

  beforeEach(async () => {
    reached = [];
    refused = [];
    ollama = http.createServer((req, res) => {
      reached.push(`${req.method} ${req.url}`);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // A streamed answer, as /api/chat gives one.
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"part":1}\n');
        setTimeout(() => res.end(`{"echo":${JSON.stringify(body)}}\n`), 20);
      });
    });
    ollamaPort = await new Promise<number>((r) =>
      ollama.listen(0, '127.0.0.1', () => r((ollama.address() as net.AddressInfo).port)),
    );
    front = net.createServer((sock) =>
      serveOllamaFiltered(sock, { host: '127.0.0.1', port: ollamaPort }, (m, p) => refused.push(`${m} ${p}`)),
    );
    frontPort = await new Promise<number>((r) =>
      front.listen(0, '127.0.0.1', () => r((front.address() as net.AddressInfo).port)),
    );
  });
  afterEach(async () => {
    await new Promise((r) => front.close(r));
    await new Promise((r) => ollama.close(r));
  });

  const ask = (method: string, path: string, body = '', agent?: http.Agent) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      // Content-Length stated, as curl and Ollama's own clients send it (Node's client
      // frames no body for a DELETE otherwise).
      const headers = { 'content-length': String(Buffer.byteLength(body)) };
      const req = http.request({ host: '127.0.0.1', port: frontPort, method, path, agent, headers }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      req.end(body);
    });

  it('passes inference through, streamed, and the body with it', async () => {
    const r = await ask('POST', '/api/chat', '{"model":"qwen3:8b"}');
    expect(r.status).toBe(200);
    expect(r.text).toContain('{"part":1}');
    expect(r.text).toContain('qwen3:8b');
    const m = await ask('POST', '/v1/messages', '{"model":"qwen3:8b"}');
    expect(m.status).toBe(200);
    expect(reached).toEqual(['POST /api/chat', 'POST /v1/messages']);
  });

  it('refuses pull, delete and create with a 403 that never reaches Ollama', async () => {
    for (const [method, path] of [
      ['POST', '/api/pull'],
      ['DELETE', '/api/delete'],
      ['POST', '/api/create'],
    ]) {
      const r = await ask(method, path, '{"model":"huge:405b"}');
      expect(r.status).toBe(403);
      expect(r.text).toContain('inference');
    }
    expect(reached).toEqual([]);
    expect(refused).toEqual(['POST /api/pull', 'DELETE /api/delete', 'POST /api/create']);
  });

  it('checks every request on a kept-alive connection, not just the first', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect((await ask('POST', '/api/chat', '{}', agent)).status).toBe(200);
      expect((await ask('POST', '/api/pull', '{}', agent)).status).toBe(403);
      expect((await ask('GET', '/api/tags', '', agent)).status).toBe(200);
    } finally {
      agent.destroy();
    }
    expect(reached).toEqual(['POST /api/chat', 'GET /api/tags']);
  });

  it('serves a relayed stream that is not a socket (the exec relay)', async () => {
    // Two cross-wired streams: one end handed to the filter, the other written as a client would.
    let toFilter!: Duplex;
    const fromClient: Buffer[] = [];
    const clientEnd = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        toFilter.push(chunk);
        cb();
      },
    });
    toFilter = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        fromClient.push(Buffer.from(chunk));
        clientEnd.push(chunk);
        cb();
      },
    });
    serveOllamaFiltered(toFilter, { host: '127.0.0.1', port: ollamaPort }, (m, p) => refused.push(`${m} ${p}`));
    clientEnd.write('POST /api/pull HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}');
    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(fromClient).toString()).toMatch(/^HTTP\/1.1 403/);
    expect(refused).toEqual(['POST /api/pull']);
    toFilter.destroy();
  });
});
