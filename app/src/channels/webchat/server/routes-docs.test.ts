import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOCS, listAvailableDocs, rDocAssetGet, rDocGet, rDocsGet } from './routes-docs.js';

// The docs view serves files by name from the install, which is the shape that
// invites path traversal, and it publishes a chosen subset of a directory that
// also holds contributor notes. Both properties are pinned here: a slug is only
// ever honoured if it is one of the literals in DOCS, and an asset name that
// could escape the screenshots directory is refused before any read.

function fakeRes() {
  const chunks: string[] = [];
  let status = 0;
  let headers: Record<string, unknown> = {};
  return {
    headersSent: false,
    setHeader() {},
    writeHead(code: number, h?: Record<string, unknown>) {
      status = code;
      if (h) headers = h;
      this.headersSent = true;
    },
    end(body?: string | Buffer) {
      if (body) chunks.push(typeof body === 'string' ? body : body.toString('binary'));
    },
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get body() {
      return chunks.join('');
    },
  };
}

const ctx = (res: ReturnType<typeof fakeRes>) => ({ res }) as never;
const match = (...groups: string[]) => ['', ...groups] as unknown as RegExpMatchArray;

// The handlers resolve their root from process.cwd(), so the suite stands up a
// throwaway install-shaped tree and runs from it.
let tmp: string;
let cwd: string;

beforeAll(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-docs-'));
  const docs = path.join(tmp, 'docs', 'webchat', 'screenshots');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'webchat', 'guide.md'), '# Feature guide\n\nbody\n');
  fs.writeFileSync(path.join(tmp, 'docs', 'webchat', 'security.md'), '# Security\n');
  // A file that exists in the directory but is NOT in the allowlist.
  fs.writeFileSync(path.join(tmp, 'docs', 'webchat', 'e2e.md'), '# Contributor notes\n');
  fs.writeFileSync(path.join(docs, 'help.png'), 'PNGDATA');
  // Something outside the screenshots dir for traversal to aim at.
  fs.writeFileSync(path.join(tmp, 'docs', 'webchat', 'secret.md'), 'not an asset');
  process.chdir(tmp);
});

afterAll(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the doc allowlist', () => {
  it('lists only entries this install actually carries', async () => {
    const available = listAvailableDocs().map((d) => d.slug);
    expect(available).toEqual(['guide', 'security']);
    // The allowlist is much longer — the rest simply are not on disk here.
    expect(DOCS.length).toBeGreaterThan(available.length);
  });

  it('never lists a doc that is on disk but not allowlisted', () => {
    expect(fs.existsSync(path.join(tmp, 'docs', 'webchat', 'e2e.md'))).toBe(true);
    expect(listAvailableDocs().map((d) => d.slug)).not.toContain('e2e');
  });

  it('serves an allowlisted doc with its markdown', async () => {
    const res = fakeRes();
    await rDocGet(ctx(res), match('guide'));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ slug: 'guide', markdown: '# Feature guide\n\nbody\n' });
  });

  it('refuses a doc that exists on disk but is not allowlisted', async () => {
    const res = fakeRes();
    await rDocGet(ctx(res), match('e2e'));
    expect(JSON.parse(res.body)).toMatchObject({ error: 'unknown doc' });
  });

  it('refuses a traversal attempt rather than resolving it', async () => {
    for (const slug of ['../../package', '..%2f..%2fpackage', '../secret']) {
      const res = fakeRes();
      await rDocGet(ctx(res), match(slug));
      expect(JSON.parse(res.body)).toMatchObject({ error: 'unknown doc' });
    }
  });

  it('reports a doc that is listed but missing as not-found, not a crash', async () => {
    const res = fakeRes();
    // 'install' is allowlisted; this tree does not carry it.
    await rDocGet(ctx(res), match('install'));
    expect(JSON.parse(res.body)).toMatchObject({ error: 'doc not found in this install' });
  });

  it('the list route returns the available set', async () => {
    const res = fakeRes();
    await rDocsGet(ctx(res));
    expect(JSON.parse(res.body).docs.map((d: { slug: string }) => d.slug)).toEqual(['guide', 'security']);
  });
});

describe('doc assets', () => {
  it('serves a screenshot as an image', async () => {
    const res = fakeRes();
    await rDocAssetGet(ctx(res), match('help.png'));
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.body).toBe('PNGDATA');
  });

  it('refuses anything that is not a plain image name', async () => {
    for (const name of ['../secret.md', 'a/b.png', 'help.png/../../x', 'help.md', '.env', 'HELP.PNG']) {
      const res = fakeRes();
      await rDocAssetGet(ctx(res), match(name));
      expect(JSON.parse(res.body)).toMatchObject({ error: 'unknown asset' });
    }
  });

  it('reports a well-formed name that is absent as not-found', async () => {
    const res = fakeRes();
    await rDocAssetGet(ctx(res), match('nope.png'));
    expect(JSON.parse(res.body)).toMatchObject({ error: 'asset not found in this install' });
  });
});
