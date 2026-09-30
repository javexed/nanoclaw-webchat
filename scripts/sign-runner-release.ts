#!/usr/bin/env node
/**
 * sign-runner-release.ts — sign VS Code runner releases with the operator's key.
 *
 * Runs on the OPERATOR'S machine, where the extension is built, never on
 * central: the private key must not be where the artifacts are served from,
 * or a compromised central could sign its own. That is why this lives in the
 * overlay repo's scripts/ and not in the add-vscode-runner skill payload
 * (whose scripts are copied into central's install). It imports the message
 * format from the extension's own verifier, so there is one definition.
 *
 *   node scripts/sign-runner-release.ts keygen <keyfile>
 *       New Ed25519 key pair: <keyfile> (PKCS#8 PEM, 0600) and <keyfile>.pub
 *       (`ed25519:<base64>`, which central offers to laptops to pin).
 *
 *   node scripts/sign-runner-release.ts sign --key <keyfile> --server <url> <nanoclaw-X.Y.Z.vsix>
 *       Writes <vsix>.sig: over the package's sha256 and its version.
 *
 * Where the signature comes from, for sign and publish (every answer is
 * verified before use; --expect-key <ed25519:…|file.pub> also pins the key):
 *   --key <keyfile>          the key on this machine
 *   --signer https://…/sign  a remote signer (serve, below); its token from
 *                            NANOCLAW_SIGNER_TOKEN or --signer-token-file
 *   --signer 'cmd:<command>' a command reading the message on stdin, printing
 *                            {"key","signature"} or a base64 signature (then
 *                            --expect-key names the key)
 *
 *   node scripts/sign-runner-release.ts serve --key <keyfile> --listen <host:port> --token-file <file>
 *       [--allow-server <url,…>] [--confirm]
 *       The remote signer, on the machine that holds the key, so build hosts
 *       and CI never have it. Signs only for the listed installs;
 *       --confirm asks at this terminal before each signature. Logs every
 *       request. Put it behind TLS or a tailnet, not on an open network.
 *
 *   node scripts/sign-runner-release.ts publish --server <url> [--vsix <file> | --build]
 *       One command per release: builds (--build) or takes the package, signs
 *       it and uploads it to central. A package central already serves signed
 *       by the same key is left alone. Authenticates to central with
 *       NANOCLAW_TOKEN (the install's access token) as an admin.
 *
 * --server is the install's origin (https://host[:port], as in the Connect
 * link; the extension verifies against its origin): a signature for one install
 * does not verify for another. Node 22.18+ runs this directly; older, `npx tsx`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
  checkedSign,
  commandSigner,
  keyFileSigner,
  remoteSigner,
  signingService,
  type Signer,
} from '../vscode-extension/src/release-signer.ts';
import {
  generateReleaseKey,
  keyFingerprint,
  parsePublicKey,
  type ReleaseFacts,
  type ReleaseSignature,
} from '../vscode-extension/src/release-signing.ts';

function die(msg: string): never {
  console.error(`sign-runner-release: ${msg}`);
  process.exit(2);
}

function args(argv: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--build', '--confirm'].includes(a)) flags[a.slice(2)] = 'yes';
    else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      flags[a.slice(2)] = v;
    } else rest.push(a);
  }
  return { flags, rest };
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

function keygen(keyfile: string | undefined): void {
  if (!keyfile) die('usage: keygen <keyfile>');
  if (fs.existsSync(keyfile) || fs.existsSync(`${keyfile}.pub`)) die(`${keyfile} or ${keyfile}.pub already exists`);
  const { privatePem, publicKey } = generateReleaseKey();
  fs.writeFileSync(keyfile, privatePem, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(`${keyfile}.pub`, `${publicKey}\n`, { flag: 'wx' });
  console.log(`private key: ${keyfile} (keep it off central; back it up)`);
  console.log(`public key:  ${publicKey}`);
  console.log(`fingerprint: ${keyFingerprint(publicKey)}`);
}

function readPrivate(keyfile: string): string {
  const mode = fs.statSync(keyfile).mode & 0o077;
  if (mode && process.platform !== 'win32') die(`${keyfile} is readable by others; chmod 600 it`);
  return fs.readFileSync(keyfile, 'utf8');
}

/** A public key given inline or as a .pub file. */
function publicKeyArg(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = parsePublicKey(fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw);
  return key ?? die(`${raw} is not an ed25519:… public key`);
}

function signerFrom(flags: Record<string, string>): Signer {
  if (flags.key && flags.signer) die('pass --key or --signer, not both');
  if (flags.key) return keyFileSigner(readPrivate(flags.key), flags.key);
  const spec = flags.signer ?? die('say where to sign: --key <keyfile> or --signer <https://…|cmd:…>');
  if (spec.startsWith('cmd:')) return commandSigner(spec.slice(4), publicKeyArg(flags['expect-key']));
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    die(`--signer ${spec} is neither a URL nor cmd:…`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || url.hostname.endsWith('.ts.net'))))
    die('a remote signer needs https:// (or http:// on this machine or a tailnet name)');
  const token = flags['signer-token-file']
    ? fs.readFileSync(flags['signer-token-file'], 'utf8').trim()
    : process.env.NANOCLAW_SIGNER_TOKEN;
  if (!token) die('the remote signer needs a token: NANOCLAW_SIGNER_TOKEN or --signer-token-file');
  return remoteSigner(url.href, token);
}

async function signWith(signer: Signer, facts: ReleaseFacts, flags: Record<string, string>): Promise<ReleaseSignature> {
  try {
    return await checkedSign(signer, facts, publicKeyArg(flags['expect-key']));
  } catch (err) {
    die((err as Error).message);
  }
}

function vsixFacts(file: string, server: string, flags: Record<string, string>, sha256: string): ReleaseFacts {
  const version = flags.version ?? /nanoclaw-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.vsix$/.exec(file)?.[1];
  if (!version) die(`cannot tell the version from ${path.basename(file)}; pass --version`);
  return { kind: 'vsix', server, subject: version, sha256 };
}

const describe = (sig: ReleaseSignature): string =>
  `${sig.kind} ${sig.subject} for ${sig.server}, key ${keyFingerprint(sig.key)}`;

/** --server as the origin it must be: the extension verifies against its install's origin. */
function checkServer(flags: Record<string, string>): void {
  let origin: string;
  try {
    origin = new URL(flags.server).origin;
  } catch {
    die(`--server ${flags.server} is not a URL`);
  }
  if (flags.server.replace(/\/+$/, '') !== origin) die(`--server takes the install's origin only: ${origin}`);
  flags.server = origin;
}

async function signCmd(flags: Record<string, string>, file: string | undefined): Promise<void> {
  if (!file || !flags.server || !file.endsWith('.vsix'))
    die('usage: sign (--key <keyfile> | --signer <…>) --server <url> <nanoclaw-X.Y.Z.vsix>');
  checkServer(flags);
  const signer = signerFrom(flags);
  const facts = vsixFacts(file, flags.server, flags, await sha256File(file));
  const out = `${file}.sig`;
  const sig = await signWith(signer, facts, flags);
  fs.writeFileSync(out, `${JSON.stringify(sig, null, 2)}\n`);
  console.log(`${out}: ${describe(sig)}`);
}

function serveCmd(flags: Record<string, string>): void {
  if (!flags.key || !flags.listen || !flags['token-file'])
    die(
      'usage: serve --key <keyfile> --listen <host:port> --token-file <file> [--allow-server <url,…>] [--confirm]',
    );
  const signer = keyFileSigner(readPrivate(flags.key), flags.key);
  const token = fs.readFileSync(flags['token-file'], 'utf8').trim();
  if (token.length < 32) die(`${flags['token-file']} holds a short token; use at least 32 random characters`);
  const kinds: ReleaseFacts['kind'][] = ['vsix'];
  const servers = flags['allow-server'] ? flags['allow-server'].split(',').map((s) => s.trim()) : [];
  const m = /^(.*):(\d+)$/.exec(flags.listen) ?? die('--listen takes host:port');
  const host = m[1].replace(/^\[|\]$/g, '');
  // One question at a time: requests wait their turn at the terminal.
  let queue = Promise.resolve(true);
  const approve = flags.confirm
    ? (f: ReleaseFacts): Promise<boolean> =>
        (queue = queue.then(async () => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const a = await rl.question(`sign ${f.kind} ${f.subject} for ${f.server} (${f.sha256.slice(0, 12)})? [y/N] `);
          rl.close();
          return /^y(es)?$/i.test(a.trim());
        }))
    : undefined;
  const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
  http.createServer(signingService({ signer, token, servers, kinds, approve, log })).listen(Number(m[2]), host, () => {
    log(`signing ${kinds.join(', ')} for ${servers.length ? servers.join(', ') : 'any install'} on ${flags.listen}`);
  });
}

// ── publish ──────────────────────────────────────────────────────────────

function central(server: string): (p: string, init?: RequestInit) => Promise<{ status: number; body: any }> {
  const token = process.env.NANOCLAW_TOKEN ?? die("publish needs NANOCLAW_TOKEN (the install's access token)");
  const base = server.replace(/\/+$/, '');
  return async (p, init = {}) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'X-Webchat-CSRF': '1', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  };
}

const errorOf = (r: { status: number; body: any }): string =>
  `${r.status} ${r.body?.error ?? String(r.body).slice(0, 200)}`;

async function publishVsix(
  api: ReturnType<typeof central>,
  signer: Signer,
  flags: Record<string, string>,
  file: string,
): Promise<void> {
  const bytes = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const facts = vsixFacts(file, flags.server, flags, sha256);
  const now = await api('/api/runners/extension');
  const sameBytes = now.status === 200 && now.body.sha256 === sha256 && now.body.version === facts.subject;
  const expect = publicKeyArg(flags['expect-key']);
  if (sameBytes && now.body.signature && (!expect || now.body.signature.key === expect)) {
    console.log(
      `package ${facts.subject}: central already serves it signed (key ${keyFingerprint(now.body.signature.key)})`,
    );
    return;
  }
  const sig = await signWith(signer, facts, flags);
  const r = sameBytes
    ? await api('/api/runners/extension/signature', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sig),
      })
    : await api('/api/runners/extension', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-NanoClaw-Filename': path.basename(file),
          'X-NanoClaw-Signature': Buffer.from(JSON.stringify(sig)).toString('base64'),
        },
        body: bytes,
      });
  if (r.status !== 200) die(`central refused the package: ${errorOf(r)}`);
  console.log(`package ${sameBytes ? 'signature attached' : 'published'}: ${describe(sig)}`);
}

async function publishCmd(flags: Record<string, string>): Promise<void> {
  if (!flags.server) die('usage: publish --server <url> (--key … | --signer …) (--vsix <file> | --build)');
  checkServer(flags);
  const signer = signerFrom(flags);
  const api = central(flags.server);
  let vsix = flags.vsix;
  if (flags.build) {
    if (vsix) die('pass --vsix or --build, not both');
    const ext = path.join(import.meta.dirname, '..', 'vscode-extension');
    execFileSync('npm', ['run', 'package'], { cwd: ext, stdio: 'inherit' });
    const version = (JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8')) as { version: string })
      .version;
    vsix = path.join(ext, `nanoclaw-${version}.vsix`);
  }
  if (!vsix) die('publish needs --vsix <file> or --build');
  await publishVsix(api, signer, flags, vsix);
}

const [cmd, ...rest] = process.argv.slice(2);
const parsed = args(rest);
if (cmd === 'keygen') keygen(parsed.rest[0]);
else if (cmd === 'sign') await signCmd(parsed.flags, parsed.rest[0]);
else if (cmd === 'serve') serveCmd(parsed.flags);
else if (cmd === 'publish') await publishCmd(parsed.flags);
else die('usage: keygen <keyfile> | sign … | serve … | publish … (see the header of this file)');
