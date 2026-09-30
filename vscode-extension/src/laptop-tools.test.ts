import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LaptopTools, globRegExp, toolDefinitions } from './laptop-tools.js';

let tmp: string;
let root: string;
let gitDir: string;
const put = (rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const g = (...args: string[]) =>
  execFileSync('git', [`--git-dir=${gitDir}`, `--work-tree=${root}`, ...args], { cwd: root, stdio: 'pipe' }).toString();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laptop-tools-'));
  root = path.join(tmp, 'copy');
  gitDir = path.join(tmp, 'git'); // outside the copy, as a proposal's is
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', `--separate-git-dir=${gitDir}`, root]);
  fs.rmSync(path.join(root, '.git')); // the pointer file: the copy itself carries no git metadata
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'Tess');
  put('src/cart.ts', 'export const price = (c: number) => `$${(c / 100).toFixed(2)}`;\nexport const x = 1;\n');
  put('README.md', '# cart\n');
  g('add', '-A');
  g('commit', '-qm', 'first');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tools = () => new LaptopTools(root, { gitDir, workTree: root });

describe('Read', () => {
  it('numbers lines like cat -n, honours offset and limit, and takes both path forms', async () => {
    put('many.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    const t = tools();
    expect((await t.call('Read', { file_path: 'many.txt', offset: 3, limit: 2 })).text).toBe(
      '     3\tline 3\n     4\tline 4',
    );
    expect((await t.call('Read', { file_path: '/workspace/project/README.md' })).text).toBe('     1\t# cart\n     2\t');
  });

  it('refuses anything outside the project: ../, other absolute paths, a link leading out, .git', async () => {
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'hunter2');
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(tmp, path.join(root, 'linkdir'));
    const t = tools();
    for (const p of [
      '../secret.txt',
      '/etc/passwd',
      'link.txt',
      'linkdir/secret.txt',
      '/workspace/project/../secret.txt',
    ])
      expect(await t.call('Read', { file_path: p }), p).toMatchObject({
        isError: true,
        text: expect.stringMatching(/outside the project/),
      });
    put('.git/config', '[x]');
    expect(await t.call('Read', { file_path: '.git/config' })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/inside \.git/),
    });
  });

  it('refuses a binary file, a directory, and a file that is not there', async () => {
    put('img.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const t = tools();
    expect((await t.call('Read', { file_path: 'img.png' })).text).toMatch(/binary/);
    expect((await t.call('Read', { file_path: 'src' })).text).toMatch(/directory/);
    expect((await t.call('Read', { file_path: 'nope.ts' })).text).toMatch(/does not exist/);
  });
});

describe('a malformed call', () => {
  it('is refused with what is wrong, never guessed at (the experiment sent an Edit without new_string)', async () => {
    const t = tools();
    await t.call('Read', { file_path: 'README.md' });
    const r = await t.call('Edit', { file_path: 'README.md', old_string: '# cart' });
    expect(r).toEqual({ isError: true, text: 'Edit: new_string (string) is required' });
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# cart\n');
    expect((await t.call('Read', { file_path: 'README.md', offset: '3' })).text).toBe('Read: offset must be a number');
    expect((await t.call('Read', { file_path: 'README.md', bogus: 1 })).text).toBe(
      'Read: bogus is not a parameter of Read',
    );
    expect((await t.call('Bash', { command: 'ls' })).text).toBe('unknown tool Bash');
  });
});

describe('Edit and Write', () => {
  it('edits only a file it has read, literally: a $ stays a $', async () => {
    const t = tools();
    const edit = {
      file_path: 'src/cart.ts',
      old_string: 'export const x = 1;',
      new_string: 'export const y = `$${2}`;',
    };
    expect((await t.call('Edit', edit)).text).toMatch(/read src\/cart.ts before changing it/);
    await t.call('Read', { file_path: 'src/cart.ts' });
    expect((await t.call('Edit', edit)).text).toBe('Edited src/cart.ts (1 replacement)');
    expect(fs.readFileSync(path.join(root, 'src/cart.ts'), 'utf8')).toBe(
      'export const price = (c: number) => `$${(c / 100).toFixed(2)}`;\nexport const y = `$${2}`;\n',
    );
  });

  it('wants old_string unique unless replace_all, and says when it is missing', async () => {
    put('a.txt', 'x\nx\ny\n');
    const t = tools();
    await t.call('Read', { file_path: 'a.txt' });
    expect((await t.call('Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'z' })).text).toMatch(
      /occurs 2 times/,
    );
    expect((await t.call('Edit', { file_path: 'a.txt', old_string: 'q', new_string: 'z' })).text).toMatch(/not found/);
    expect(
      (await t.call('Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'z', replace_all: true })).text,
    ).toBe('Edited a.txt (2 replacements)');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('z\nz\ny\n');
  });

  it('creates new files freely, overwrites only what it read, and never writes into .git', async () => {
    const t = tools();
    expect((await t.call('Write', { file_path: 'src/new/tax.ts', content: 'export {};\n' })).text).toBe(
      'Created src/new/tax.ts',
    );
    expect((await t.call('Write', { file_path: 'README.md', content: 'gone' })).text).toMatch(/read README.md before/);
    await t.call('Read', { file_path: 'README.md' });
    expect((await t.call('Write', { file_path: 'README.md', content: '# new\n' })).text).toBe('Wrote README.md');
    expect((await t.call('Write', { file_path: '.git/hooks/pre-commit', content: 'x' })).text).toMatch(/inside \.git/);
    expect((await t.call('Write', { file_path: '../escape.txt', content: 'x' })).text).toMatch(/outside the project/);
    expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
  });
});

describe('Glob and Grep', () => {
  it('Glob matches ** and {a,b}, newest first, and skips node_modules', async () => {
    put('src/a.js', '');
    put('node_modules/lib/index.ts', '');
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(root, 'src/a.js'), later, later);
    const t = tools();
    expect((await t.call('Glob', { pattern: 'src/**/*.{ts,js}' })).text).toBe('src/a.js\nsrc/cart.ts');
    expect((await t.call('Glob', { pattern: '**/*.ts' })).text).toBe('src/cart.ts');
    expect((await t.call('Glob', { pattern: '*.nothing' })).text).toBe('No files found');
  });

  it('Grep lists files, lines with context and numbers, or counts; filters by glob; limits', async () => {
    put('src/b.ts', 'one\nTwo\nthree\ntwo\n');
    const t = tools();
    expect((await t.call('Grep', { pattern: 'two', '-i': true })).text).toBe('src/b.ts');
    expect((await t.call('Grep', { pattern: 'two', output_mode: 'count', '-i': true })).text).toBe('src/b.ts:2');
    expect((await t.call('Grep', { pattern: '^Two$', output_mode: 'content', '-C': 1 })).text).toBe(
      'src/b.ts:1-one\nsrc/b.ts:2:Two\nsrc/b.ts:3-three',
    );
    expect((await t.call('Grep', { pattern: 'export', glob: '*.md' })).text).toBe('No matches found');
    expect(
      (await t.call('Grep', { pattern: 'o', output_mode: 'content', head_limit: 2 })).text.split('\n'),
    ).toHaveLength(2);
    expect((await t.call('Grep', { pattern: '(' })).text).toMatch(/not a valid regular expression/);
  });

  it('globRegExp', () => {
    expect(globRegExp('**/*.ts').test('a/b/c.ts')).toBe(true);
    expect(globRegExp('**/*.ts').test('c.ts')).toBe(true);
    expect(globRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globRegExp('*.{md,txt}').test('x.txt')).toBe(true);
    expect(globRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('read-only git', () => {
  it('status, diff, log, show and blame answer about the copy', async () => {
    put('src/cart.ts', 'changed\n');
    const t = tools();
    expect((await t.call('GitStatus', {})).text).toMatch(/ M src\/cart.ts/);
    expect((await t.call('GitDiff', { path: 'src/cart.ts' })).text).toMatch(/^\+changed$/m);
    const log = (await t.call('GitLog', { path: 'README.md' })).text;
    expect(log).toMatch(/Tess\n {4}first/);
    const head = log.split(' ')[0];
    expect((await t.call('GitShow', { revision: head, path: 'README.md' })).text).toBe('# cart');
    expect((await t.call('GitShow', { revision: 'HEAD' })).text).toMatch(/first[\s\S]*README.md/);
    expect((await t.call('GitBlame', { path: 'README.md', start_line: 1, end_line: 1 })).text).toMatch(/Tess .*# cart/);
  });

  it('never lets a revision or path become a git option or leave the project', async () => {
    const t = tools();
    for (const revision of ['--output=/tmp/pwned', '-p', 'HEAD..main', 'a b'])
      expect((await t.call('GitShow', { revision })).text, revision).toMatch(/is not a revision name/);
    expect((await t.call('GitLog', { path: '../../etc' })).text).toMatch(/outside the project/);
    expect(fs.existsSync('/tmp/pwned')).toBe(false);
  });

  it('never names a blob or tree by hash: every revision must be a commit', async () => {
    const blob = g('rev-parse', 'HEAD:README.md').trim();
    const t = tools();
    expect((await t.call('GitShow', { revision: blob })).text).toMatch(/expected commit type/);
    expect((await t.call('GitDiff', { from: blob, to: 'HEAD' })).text).toMatch(/expected commit type/);
  });

  it('says so when the copy has no history', async () => {
    const t = new LaptopTools(root, null);
    expect(await t.call('GitLog', {})).toEqual({ isError: true, text: 'this project copy has no git history' });
  });
});

describe('toolDefinitions', () => {
  it('declares every tool with its required fields, and no others', () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual([
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'GitStatus',
      'GitDiff',
      'GitLog',
      'GitShow',
      'GitBlame',
    ]);
    const edit = defs.find((d) => d.name === 'Edit')!.inputSchema;
    expect(edit.required).toEqual(['file_path', 'old_string', 'new_string']);
    expect(edit.additionalProperties).toBe(false);
  });
});

describe('what the copy leaves out stays out of the git tools', () => {
  it('refuses a left-out path at any revision and keeps it out of diffs and summaries', async () => {
    // As a snapshot does: the developer's commit has .env and a key; the copy's own commit drops them.
    put('.env', 'DB_PASSWORD=hunter2\n');
    const armour = (end: string) => `-----${end} RSA ${'PRIVATE'} KEY-----`; // built up, so no key-shaped literal is committed
    put('keys/deploy.pem', `${armour('BEGIN')}\nMIIEsecret\n${armour('END')}\n`);
    g('add', '-A');
    g('commit', '-qm', 'the developer commits secrets');
    fs.rmSync(path.join(root, '.env'));
    fs.rmSync(path.join(root, 'keys'), { recursive: true });
    put('secrets.json', '{"token":"s3cr3t-dropped-by-the-scan"}\n');
    g('add', '-A');
    g('commit', '-qm', 'snapshot');
    fs.rmSync(path.join(root, 'secrets.json'));
    g('add', '-A');
    g('commit', '-qm', 'the scan drops secrets.json');
    const base = g('rev-parse', 'HEAD').trim();
    const t = new LaptopTools(root, { gitDir, workTree: root }, { base, patterns: ['.env', '*.pem'] });
    for (const [name, input] of [
      ['GitShow', { revision: 'HEAD~2', path: '.env' }],
      ['GitShow', { revision: 'HEAD~2', path: 'keys/deploy.pem' }],
      ['GitShow', { revision: 'HEAD~1', path: 'secrets.json' }],
      ['GitLog', { path: '.env' }],
      ['GitDiff', { from: 'HEAD~2', to: 'HEAD~1', path: '.env' }],
    ] as const)
      expect((await t.call(name, input)).text, `${name} ${JSON.stringify(input)}`).toMatch(
        /left out of the project copy/,
      );
    const diff = (await t.call('GitDiff', { from: 'HEAD~3', to: 'HEAD' })).text;
    expect(diff).not.toMatch(/hunter2|MIIEsecret|s3cr3t/);
    expect((await t.call('GitDiff', { from: 'HEAD~2', to: 'HEAD~1' })).text).not.toMatch(/hunter2|MIIEsecret/);
    const summary = (await t.call('GitShow', { revision: 'HEAD~2' })).text;
    expect(summary).not.toMatch(/\.env|deploy\.pem/);
    // Everything else is as it was.
    expect((await t.call('GitShow', { revision: 'HEAD~3', path: 'README.md' })).text).toBe('# cart');
  });
});

describe('Grep', () => {
  it('stops a pattern that backtracks without end instead of freezing the editor', async () => {
    put('bad.txt', `${'a'.repeat(40)}b\n`);
    const t = new LaptopTools(root, { gitDir, workTree: root }, {}, 500);
    const started = Date.now();
    const r = await t.call('Grep', { pattern: '^(a+)+$', path: 'bad.txt' });
    expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/stopped/) });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
