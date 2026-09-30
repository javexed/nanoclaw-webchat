/**
 * Where release signatures come from, for scripts/sign-runner-release.ts. The
 * extension never imports this: it only verifies (release-signing.ts).
 *
 *   key file   the PKCS#8 PEM on this machine (keygen).
 *   https://…  a remote signer: `sign-runner-release serve` on the machine
 *              that holds the key, so a build host or CI never has it.
 *   cmd:…      a command that signs the message on stdin (a hardware key's
 *              tool), printing `{"key","signature"}` or a bare base64 signature.
 *
 * Nothing a signer answers is trusted: every signature is verified against the
 * facts it should cover, and against the expected key when one is named,
 * before anything uses it (checkedSign).
 */
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  assembleSignature,
  normalizeServer,
  parsePublicKey,
  releaseMessage,
  signRelease,
  verifyRelease,
  type ReleaseFacts,
  type ReleaseKind,
  type ReleaseSignature,
} from './release-signing.ts';

export const SIGN_REQUEST_FORMAT = 'nanoclaw-runner-sign-request/1';

export interface Signer {
  /** For messages: where the signature comes from. */
  readonly label: string;
  sign(facts: ReleaseFacts): Promise<ReleaseSignature>;
}

export function keyFileSigner(privateKeyPem: string, label = 'key file'): Signer {
  return { label, sign: async (facts) => signRelease(facts, privateKeyPem) };
}

/** A signer's `{key, signature}` answer as a signature file; throws when it is not one. */
function fromAnswer(facts: ReleaseFacts, answer: unknown, fallbackKey?: string): ReleaseSignature {
  const a = (answer ?? {}) as { key?: unknown; signature?: unknown };
  const key = typeof a.key === 'string' ? a.key : fallbackKey;
  if (!key || !parsePublicKey(key)) throw new Error('the signer did not say which key it signed with');
  if (typeof a.signature !== 'string' || !a.signature) throw new Error('the signer answered no signature');
  return assembleSignature(facts, key, a.signature);
}

export function remoteSigner(url: string, token: string, fetchImpl: typeof fetch = fetch): Signer {
  return {
    label: url,
    async sign(facts) {
      const message = releaseMessage(facts);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          format: SIGN_REQUEST_FORMAT,
          kind: facts.kind,
          server: facts.server,
          subject: facts.subject,
          sha256: facts.sha256,
          message: message.toString('base64'),
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        let why = text.slice(0, 200);
        try {
          why = (JSON.parse(text) as { error?: string }).error ?? why;
        } catch {
          /* not JSON */
        }
        throw new Error(`the signer refused (${res.status}): ${why}`);
      }
      return fromAnswer(facts, JSON.parse(text));
    },
  };
}

/** `cmd` runs under sh with the message on stdin; `key` is needed when it prints only the signature. */
export function commandSigner(cmd: string, key?: string): Signer {
  return {
    label: `cmd:${cmd}`,
    async sign(facts) {
      const message = releaseMessage(facts);
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'inherit'] });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(stdout.trim()) : reject(new Error(`the signing command exited ${code}`)),
        );
        // A command that stops reading (or never starts) closes the pipe under
        // us: EPIPE here is not the failure — its exit status says what is.
        child.stdin.on('error', () => {});
        child.stdin.end(message);
      });
      if (out.startsWith('{')) return fromAnswer(facts, JSON.parse(out), key);
      return fromAnswer(facts, { signature: out }, key);
    },
  };
}

/** Sign through `signer`, then prove the answer: right facts, right key, a signature that verifies. */
export async function checkedSign(signer: Signer, facts: ReleaseFacts, expectKey?: string): Promise<ReleaseSignature> {
  const sig = await signer.sign(facts);
  if (expectKey && sig.key !== expectKey) throw new Error(`${signer.label} signed with another key than expected`);
  const why = verifyRelease(sig, facts, sig.key);
  if (why) throw new Error(`${signer.label} answered a bad signature: ${why}`);
  return sig;
}

export interface SigningServiceOptions {
  signer: Signer;
  /** The bearer token callers must send. */
  token: string;
  /** Installs it signs for (normalized URLs); empty = any. */
  servers: string[];
  kinds: ReleaseKind[];
  /** Asked before each signature (e.g. at the terminal); false refuses. */
  approve?: (facts: ReleaseFacts) => Promise<boolean>;
  log: (line: string) => void;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** The request handler for `serve`: POST /sign with a sign request, answers `{key, signature}`. */
export function signingService(opts: SigningServiceOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const servers = new Set(opts.servers.map((s) => normalizeServer(s) ?? s));
  const want = digest(opts.token);
  const answer = (res: ServerResponse, status: number, body: object): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return (req, res) => {
    const who = req.socket.remoteAddress ?? '?';
    if (req.method !== 'POST' || req.url !== '/sign') return answer(res, 404, { error: 'not found' });
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!timingSafeEqual(digest(bearer), want)) {
      opts.log(`refused ${who}: bad token`);
      return answer(res, 401, { error: 'bad token' });
    }
    let raw = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (d: string) => {
      raw += d;
      if (raw.length > 4096) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      void (async () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return answer(res, 400, { error: 'not JSON' });
        }
        if (body.format !== SIGN_REQUEST_FORMAT) return answer(res, 400, { error: 'unknown request format' });
        const facts = {
          kind: body.kind,
          server: body.server,
          subject: body.subject,
          sha256: body.sha256,
        } as ReleaseFacts;
        try {
          releaseMessage(facts);
        } catch (err) {
          return answer(res, 400, { error: (err as Error).message });
        }
        const what = `${facts.kind} ${facts.subject} for ${facts.server} (${String(facts.sha256).slice(0, 12)})`;
        if (!opts.kinds.includes(facts.kind)) {
          opts.log(`refused ${who}: ${what}: kind not allowed`);
          return answer(res, 403, { error: `this signer does not sign ${facts.kind} releases` });
        }
        if (servers.size && !servers.has(normalizeServer(facts.server) ?? '')) {
          opts.log(`refused ${who}: ${what}: server not allowed`);
          return answer(res, 403, { error: `this signer does not sign for ${facts.server}` });
        }
        if (opts.approve && !(await opts.approve(facts))) {
          opts.log(`refused ${who}: ${what}: not approved`);
          return answer(res, 403, { error: 'not approved' });
        }
        try {
          const sig = await opts.signer.sign(facts);
          opts.log(`signed ${who}: ${what}`);
          return answer(res, 200, { key: sig.key, signature: sig.signature });
        } catch (err) {
          opts.log(`failed ${who}: ${what}: ${(err as Error).message}`);
          return answer(res, 500, { error: 'signing failed' });
        }
      })();
    });
  };
}
