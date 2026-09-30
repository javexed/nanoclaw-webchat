import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SIGN_REQUEST_FORMAT,
  checkedSign,
  commandSigner,
  keyFileSigner,
  remoteSigner,
  signingService,
  type Signer,
  type SigningServiceOptions,
} from './release-signer.ts';
import { generateReleaseKey, verifyRelease, type ReleaseFacts } from './release-signing.ts';

const facts: ReleaseFacts = {
  kind: 'vsix',
  server: 'https://nanoclaw.example.test',
  subject: '0.16.0',
  sha256: 'ab'.repeat(32),
};
const TOKEN = 't'.repeat(40);

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function serve(
  opts: Partial<SigningServiceOptions> & { signer: Signer },
): Promise<{ url: string; log: string[] }> {
  const log: string[] = [];
  const server = http.createServer(
    signingService({ token: TOKEN, servers: [], kinds: ['vsix'], log: (l) => log.push(l), ...opts }),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sign`, log };
}

describe('checkedSign', () => {
  it('passes a good signature from a key file', async () => {
    const { privatePem, publicKey } = generateReleaseKey();
    const sig = await checkedSign(keyFileSigner(privatePem), facts, publicKey);
    expect(verifyRelease(sig, facts, publicKey)).toBeNull();
  });

  it('refuses a signature by another key than expected', async () => {
    const { privatePem } = generateReleaseKey();
    await expect(checkedSign(keyFileSigner(privatePem), facts, generateReleaseKey().publicKey)).rejects.toThrow(
      /another key/,
    );
  });

  it('refuses a signer that signed other facts', async () => {
    const { privatePem } = generateReleaseKey();
    const liar: Signer = {
      label: 'liar',
      sign: async (f) => ({
        ...(await keyFileSigner(privatePem).sign({ ...f, subject: '9.9.9' })),
        subject: f.subject,
      }),
    };
    await expect(checkedSign(liar, facts)).rejects.toThrow(/bad signature/);
  });
});

describe('remote signer', () => {
  it('signs through serve, and the answer verifies', async () => {
    const { privatePem, publicKey } = generateReleaseKey();
    const { url, log } = await serve({ signer: keyFileSigner(privatePem) });
    const sig = await checkedSign(remoteSigner(url, TOKEN), facts, publicKey);
    expect(verifyRelease(sig, facts, publicKey)).toBeNull();
    expect(log[0]).toMatch(/^signed .*vsix 0\.16\.0 for https:\/\/nanoclaw\.example\.test/);
  });

  it('refuses a wrong token', async () => {
    const { url, log } = await serve({ signer: keyFileSigner(generateReleaseKey().privatePem) });
    await expect(remoteSigner(url, 'nope').sign(facts)).rejects.toThrow(/401.*bad token/);
    expect(log[0]).toMatch(/bad token/);
  });

  it('keeps to its allow-lists', async () => {
    const signer = keyFileSigner(generateReleaseKey().privatePem);
    const { url } = await serve({ signer, servers: ['https://other.example.test/'], kinds: ['vsix'] });
    await expect(remoteSigner(url, TOKEN).sign(facts)).rejects.toThrow(/does not sign for/);
    const { url: url2 } = await serve({ signer, kinds: [] });
    await expect(remoteSigner(url2, TOKEN).sign(facts)).rejects.toThrow(/does not sign vsix/);
  });

  it('signs only what the operator approves', async () => {
    const signer = keyFileSigner(generateReleaseKey().privatePem);
    const { url } = await serve({ signer, approve: async () => false });
    await expect(remoteSigner(url, TOKEN).sign(facts)).rejects.toThrow(/not approved/);
  });

  it('refuses requests that cannot be signed', async () => {
    const { url } = await serve({ signer: keyFileSigner(generateReleaseKey().privatePem) });
    const post = (body: unknown) =>
      fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    expect((await post({ ...facts })).status).toBe(400); // no format
    expect((await post({ format: SIGN_REQUEST_FORMAT, ...facts, sha256: 'x' })).status).toBe(400);
    expect((await post({ format: SIGN_REQUEST_FORMAT, ...facts, kind: 'script' })).status).toBe(400);
    expect((await fetch(url.replace('/sign', '/'), { method: 'POST' })).status).toBe(404);
  });
});

describe('command signer', () => {
  it('takes {key, signature} JSON from the command', async () => {
    const { privatePem, publicKey } = generateReleaseKey();
    const sig = await keyFileSigner(privatePem).sign(facts);
    const cmd = `cat >/dev/null; echo '${JSON.stringify({ key: sig.key, signature: sig.signature })}'`;
    expect(verifyRelease(await checkedSign(commandSigner(cmd), facts), facts, publicKey)).toBeNull();
  });

  it('takes a bare signature when the key is named', async () => {
    const { privatePem, publicKey } = generateReleaseKey();
    const sig = await keyFileSigner(privatePem).sign(facts);
    const cmd = `cat >/dev/null; echo ${sig.signature}`;
    await expect(commandSigner(cmd).sign(facts)).rejects.toThrow(/which key/);
    expect(verifyRelease(await checkedSign(commandSigner(cmd, publicKey), facts), facts, publicKey)).toBeNull();
  });

  it('fails when the command does — never with EPIPE, however soon it closes its input', async () => {
    // The race CI lost (write EPIPE, unhandled): the command gone before its input is written. It depends on
    // timing, so no run is sure to hit it; these tries give it chances, and the handler makes a hit harmless.
    for (let i = 0; i < 25; i++) await expect(commandSigner('exit 3').sign(facts)).rejects.toThrow(/exited 3/);
    await expect(commandSigner('exec 0<&-; exit 4').sign(facts)).rejects.toThrow(/exited 4/);
  });
});
