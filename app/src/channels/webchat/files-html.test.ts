/**
 * HTML attachments: a download when opened as a file, and rendered only for
 * the attachment drawer's frame, under a CSP that keeps the page out of the
 * app's origin and off the network.
 */
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import type { ServerResponse } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { DATA } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('os') as typeof import('os');
  return { DATA: mkdtempSync(`${tmpdir()}/webchat-html-`) };
});
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: DATA };
});

import { HTML_FRAME_CSP, HTML_FRAME_MAX, handleFileServe, handleHtmlFrame, uploadsDir } from './files.js';
import { guessMime } from './agent-delivery.js';

const ROOM = 'html-room';
const PAGE = '6f9619ff-8b86-d011-b42d-00cf4fc964ff.html';
const BIG = '7f9619ff-8b86-d011-b42d-00cf4fc964ff.html';
const PDF = '8f9619ff-8b86-d011-b42d-00cf4fc964ff.pdf';
const HTML = '<h1>hi</h1><script>parent.postMessage({type:"nanoclaw:compose",text:"x"},"*")</script>';

beforeAll(() => {
  fs.mkdirSync(uploadsDir(ROOM), { recursive: true });
  fs.writeFileSync(path.join(uploadsDir(ROOM), PAGE), HTML);
  fs.writeFileSync(path.join(uploadsDir(ROOM), PDF), '%PDF-1.4');
  fs.writeFileSync(path.join(uploadsDir(ROOM), BIG), Buffer.alloc(HTML_FRAME_MAX + 1, 0x20));
});
afterAll(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
});

interface Captured {
  status?: number;
  headers: Record<string, unknown>;
  body: string;
}

function capture(): { res: ServerResponse; out: Captured; done: Promise<void> } {
  let body = '';
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const out: Captured = { headers: {}, body: '' };
  const w = new Writable({
    write(chunk, _enc, cb) {
      body += chunk.toString();
      cb();
    },
  });
  w.on('finish', () => {
    out.body = body;
    finish();
  });
  const res = w as unknown as ServerResponse;
  res.writeHead = ((status: number, hdrs?: Record<string, unknown>) => {
    out.status = status;
    if (hdrs) Object.assign(out.headers, hdrs);
    return res;
  }) as ServerResponse['writeHead'];
  // json() ends the response itself; route that through the stream too.
  const end = w.end.bind(w);
  res.end = ((data?: string) => (data === undefined ? end() : end(data))) as ServerResponse['end'];
  return { res, out, done };
}

async function frame(file: string, dest: string | undefined): Promise<Captured> {
  const { res, out, done } = capture();
  handleHtmlFrame(res, ROOM, file, dest);
  await done;
  return out;
}

describe('handleHtmlFrame', () => {
  it('renders the page for an iframe, under the frame CSP', async () => {
    const out = await frame(PAGE, 'iframe');
    expect(out.status).toBe(200);
    expect(out.body).toBe(HTML);
    expect(out.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(out.headers['Content-Security-Policy']).toBe(HTML_FRAME_CSP);
    expect(out.headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(out.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('refuses anything but a frame — a top-level visit, a fetch, no header', async () => {
    for (const dest of ['document', 'empty', 'script', undefined]) {
      const out = await frame(PAGE, dest);
      expect(out.status).toBe(403);
      expect(out.body).not.toContain('<script>');
    }
  });

  it('renders HTML files only', async () => {
    expect((await frame(PDF, 'iframe')).status).toBe(404);
  });

  it('refuses path traversal', async () => {
    const { res, out } = capture();
    handleHtmlFrame(res, ROOM, '../../etc/passwd.html', 'iframe');
    expect(out.status).toBe(403);
    const second = capture();
    handleHtmlFrame(second.res, '..', PAGE, 'iframe');
    expect(second.out.status).toBe(403);
  });

  it('refuses a page past the size cap', async () => {
    expect((await frame(BIG, 'iframe')).status).toBe(413);
  });
});

describe('HTML_FRAME_CSP', () => {
  const directives = new Map(
    HTML_FRAME_CSP.split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name, values]),
  );

  it('sandboxes with scripts only — never the app origin, popups or navigation', () => {
    expect(directives.get('sandbox')).toEqual(['allow-scripts']);
  });

  it('keeps the page off the network', () => {
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('connect-src')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    for (const [name, values] of directives) {
      if (name === 'frame-ancestors') continue;
      for (const v of values) expect(v).not.toMatch(/^(https?:|\*|'self')/);
    }
  });

  it('can be framed by this app only', () => {
    expect(directives.get('frame-ancestors')).toEqual(["'self'"]);
  });
});

describe('opening an HTML file as a file', () => {
  it('is a download, still sandboxed', async () => {
    const { res, out, done } = capture();
    handleFileServe(res, ROOM, PAGE);
    await done;
    expect(out.status).toBe(200);
    expect(String(out.headers['Content-Disposition'])).toMatch(/^attachment;/);
    expect(String(out.headers['Content-Security-Policy'])).toMatch(/^sandbox\b/);
  });

  it('leaves other files inline', async () => {
    const { res, out, done } = capture();
    handleFileServe(res, ROOM, PDF);
    await done;
    expect(String(out.headers['Content-Disposition'])).toMatch(/^inline;/);
  });

  it("types an agent's .html file as text/html", () => {
    expect(guessMime('report.html')).toBe('text/html');
    expect(guessMime('REPORT.HTM')).toBe('text/html');
  });
});
