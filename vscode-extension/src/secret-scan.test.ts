import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureProposalClone, proposalGitDir } from './git-changes.js';
import { SCAN_CHUNK_BYTES, hasSecret, leaveOutSecrets, scanFile, utf16Of } from './secret-scan.js';

// Every fixture is fake and assembled at run time, so no whole token sits in
// this file for a secret scanner (ours, or the repository's leak gate) to find.
const j = (...parts: string[]) => parts.join('');
const run = (c: string, n: number) => c.repeat(n);
const alnum = (n: number) => run('Ab1', Math.ceil(n / 3)).slice(0, n);
const FAKE = {
  pemRsa: j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n'),
  pemOpenssh: j('-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----\n'),
  pemPlain: j('-----BEGIN ', 'PRIVATE', ' KEY-----\n'),
  pgp: j('-----BEGIN PGP ', 'PRIVATE KEY', ' BLOCK-----\n'),
  awsAkia: j('AK', 'IA', run('X', 16)),
  awsAsia: j('AS', 'IA', run('Y', 16)),
  ghp: j('gh', 'p_', alnum(36)),
  gho: j('gh', 'o_', alnum(36)),
  ghu: j('gh', 'u_', alnum(36)),
  ghs: j('gh', 's_', alnum(36)),
  ghr: j('gh', 'r_', alnum(36)),
  ghPat: j('github', '_pat_', alnum(40)),
  slack: j('xo', 'xb-', '000000000-FAKEFAKEFAKE'),
  stripeSk: j('sk', '_live_', alnum(24)),
  stripeRk: j('rk', '_live_', alnum(24)),
  google: j('AI', 'za', alnum(35)),
  anthropic: j('sk-', 'ant-', 'api03-', alnum(40)),
  openaiProj: j('sk-', 'proj-', alnum(40)),
  openaiLegacy: j('sk-', alnum(48)),
  npm: j('np', 'm_', alnum(36)),
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-scan-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

describe('hasSecret', () => {
  it.each(Object.entries(FAKE))('finds %s', (_name, token) => {
    expect(hasSecret(`const config = {\n  value: ${JSON.stringify(token)},\n};\n`)).toBe(true);
  });

  it('finds a long quoted literal after a secret-like name, in code, JSON and env-style files', () => {
    const v = alnum(20);
    for (const line of [
      `const apiKey = '${v}';`,
      `"password": "${v}"`,
      `API_KEY="${v}"`,
      `client_secret: '${v}'`,
      `token = "${v}"`,
    ])
      expect(hasSecret(line), line).toBe(true);
  });

  it('passes over references, placeholders, short values, prose and near misses', () => {
    for (const line of [
      'const password = process.env.DB_PASSWORD;',
      "password: '${DB_PASSWORD_FROM_ENV}'",
      'token: "{{ vault_token_reference }}"',
      "apiKey: '<your-api-key-goes-here>'",
      `secret = "${run('x', 32)}"`,
      "token: 'short1A'",
      "password: 'all-lower-case-words-only'",
      'label: "Enter your API token here"',
      j('AK', 'IA', 'short'),
      j('sk-', alnum(20)), // not 48, no known prefix
      'const ghp = ghp_; // the prefix alone',
      '-----BEGIN PUBLIC KEY-----',
      '-----BEGIN CERTIFICATE-----',
    ])
      expect(hasSecret(line), line).toBe(false);
  });
});

describe('scanFile', () => {
  it('skips a binary file (NUL in the head), scans the rest whole', () => {
    put('bin.dat', Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x01]), Buffer.from(FAKE.ghp)]));
    put('big.txt', `${'a'.repeat(3 * SCAN_CHUNK_BYTES)}\n${FAKE.ghp}\n`); // past what used to be read
    put('edge.txt', `${'a'.repeat(SCAN_CHUNK_BYTES - FAKE.ghp.length - 1)}\n${FAKE.ghp}`); // exactly one chunk
    put('clean-big.txt', 'a'.repeat(2 * SCAN_CHUNK_BYTES + 17));
    put('empty.txt', '');
    expect(scanFile(path.join(dir, 'bin.dat')).verdict).toBe('binary');
    expect(scanFile(path.join(dir, 'big.txt')).verdict).toBe('secret');
    expect(scanFile(path.join(dir, 'edge.txt')).verdict).toBe('secret');
    expect(scanFile(path.join(dir, 'clean-big.txt')).verdict).toBe('clean');
    expect(scanFile(path.join(dir, 'empty.txt')).verdict).toBe('clean');
  });

  it('finds a token that straddles two chunks', () => {
    const half = Math.floor(FAKE.ghp.length / 2);
    put('seam.txt', `${'a'.repeat(SCAN_CHUNK_BYTES - half - 1)} ${FAKE.ghp}\n`);
    expect(scanFile(path.join(dir, 'seam.txt')).verdict).toBe('secret');
  });

  it('reads UTF-16 text (either byte order, with or without a mark) instead of taking it for binary', () => {
    const le = Buffer.from(`const k = '${FAKE.awsAkia}';\n`, 'utf16le');
    const be = Buffer.from(le).swap16();
    put('le-bom.cs', Buffer.concat([Buffer.from([0xff, 0xfe]), le]));
    put('le.cs', le);
    put('be-bom.cs', Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    put('clean16.cs', Buffer.from('nothing to see here, just text\n', 'utf16le'));
    for (const f of ['le-bom.cs', 'le.cs', 'be-bom.cs']) expect(scanFile(path.join(dir, f)).verdict, f).toBe('secret');
    expect(scanFile(path.join(dir, 'clean16.cs')).verdict).toBe('clean');
    expect(utf16Of(Buffer.from([0x89, 0x50, 0x00, 0x01, 0x47, 0x0d, 0x0a, 0x1a]))).toBeNull(); // a PNG head is not text
  });
});

describe('unquoted values in configuration files', () => {
  const secret = alnum(24);
  it('are secrets in YAML, .properties, INI and TOML', () => {
    expect(hasSecret(`db:\n  password: ${secret}\n`, 'config/app.yaml')).toBe(true);
    expect(hasSecret(`api.key=${secret}\n`, 'src/main/resources/app.properties')).toBe(true);
    expect(hasSecret(`[auth]\nclient_secret = ${secret} # rotate\n`, 'settings.ini')).toBe(true);
    expect(hasSecret(`GITHUB_TOKEN=${secret}\n`, 'ci.toml')).toBe(true);
  });
  it('are not in code, and a reference or placeholder is not one anywhere', () => {
    expect(hasSecret(`const token = accessTokenFromEnvironment\n`, 'src/auth.ts')).toBe(false);
    expect(hasSecret(`password: \${DB_PASSWORD_FROM_VAULT}\n`, 'app.yaml')).toBe(false);
    expect(hasSecret(`token: xxxxxxxxxxxxxxxxxxxxxxxx\n`, 'app.yaml')).toBe(false);
    expect(hasSecret(`token_ttl: 3600\n`, 'app.yaml')).toBe(false);
  });
});

describe('leaveOutSecrets', () => {
  it('leaves out files with a hit (large ones too), keeps binary ones, and honours the allow list', () => {
    put('src/app.ts', 'export const x = 1;\n');
    put('src/config.ts', `export const key = '${FAKE.awsAkia}';\n`);
    put('deploy/id_deploy', FAKE.pemOpenssh);
    put('test/fixtures/fake-token.txt', FAKE.npm);
    put('assets/logo.png', Buffer.concat([Buffer.from([0x89, 0x00]), Buffer.from(FAKE.ghp)]));
    put('dist/bundle.js', `${'x'.repeat(SCAN_CHUNK_BYTES)}\n${FAKE.stripeSk}`);
    const files = [
      'src/app.ts',
      'src/config.ts',
      'deploy/id_deploy',
      'test/fixtures/fake-token.txt',
      'assets/logo.png',
      'dist/bundle.js',
    ];
    const r = leaveOutSecrets(dir, files, ['test/fixtures']);
    expect(r.leftOut.sort()).toEqual(['deploy/id_deploy', 'dist/bundle.js', 'src/config.ts']);
    expect(r.files.sort()).toEqual(['assets/logo.png', 'src/app.ts', 'test/fixtures/fake-token.txt']);
    // A basename glob works as in workspaceExcludes.
    expect(leaveOutSecrets(dir, files, ['config.ts', 'id_deploy', 'fake-token.txt', 'bundle.js']).leftOut).toEqual([]);
  });

  it('re-reads a file that changed since the last snapshot, and only then', () => {
    put('a.ts', 'export const a = 1;\n');
    expect(leaveOutSecrets(dir, ['a.ts']).leftOut).toEqual([]);
    const later = new Date(Date.now() + 5_000);
    put('a.ts', `export const a = '${FAKE.slack}';\n`);
    fs.utimesSync(path.join(dir, 'a.ts'), later, later);
    expect(leaveOutSecrets(dir, ['a.ts']).leftOut).toEqual(['a.ts']);
    put('a.ts', 'export const a = 2;\n');
    fs.utimesSync(path.join(dir, 'a.ts'), new Date(later.getTime() + 5_000), new Date(later.getTime() + 5_000));
    expect(leaveOutSecrets(dir, ['a.ts']).leftOut).toEqual([]);
  });

  it('keeps a file it cannot read: the copy reports it', () => {
    expect(leaveOutSecrets(dir, ['gone.ts'])).toEqual({ files: ['gone.ts'], leftOut: [] });
  });
});

describe('the proposal snapshot', () => {
  it('never copies a file with a secret into the clone; the allow list brings it back', async () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    sh(['init', '-q']);
    sh(['config', 'user.email', 't@t']);
    sh(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 1;\n');
    sh(['add', '-A']);
    sh(['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(repo, 'settings.py'), `ANTHROPIC = "${FAKE.anthropic}"\n`); // untracked, uncommitted
    fs.writeFileSync(path.join(repo, 'notes.md'), 'nothing to see\n');
    const clone = path.join(dir, 'proposal');
    try {
      const p = await ensureProposalClone(repo, clone, [], false, []);
      expect(p.secretsLeftOut).toEqual(['settings.py']);
      expect(fs.existsSync(path.join(clone, 'settings.py'))).toBe(false);
      expect(fs.readFileSync(path.join(clone, 'notes.md'), 'utf8')).toBe('nothing to see\n');
      // Not in the snapshot commit either: the agent's git sees no trace of it.
      const tree = execFileSync('git', [`--git-dir=${p.gitDir}`, 'ls-tree', '-r', '--name-only', p.base]).toString();
      expect(tree).not.toContain('settings.py');
      // The developer vouches for it: the next snapshot copies it.
      const again = await ensureProposalClone(repo, clone, [], false, ['settings.py']);
      expect(again.secretsLeftOut).toEqual([]);
      expect(fs.existsSync(path.join(clone, 'settings.py'))).toBe(true);
      // A clone holding a proposal is left alone: no snapshot, nothing scanned, nothing reported.
      fs.writeFileSync(path.join(clone, 'app.ts'), 'export const x = 2;\n');
      expect((await ensureProposalClone(repo, clone, [], false, [])).secretsLeftOut).toBeUndefined();
    } finally {
      for (const d of [clone, proposalGitDir(clone), `${clone}.nanoclaw-base`, `${clone}.nanoclaw-root`])
        fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
