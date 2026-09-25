import { describe, expect, it } from 'vitest';

import { apiUrl, fileCard, humanSize, safeLocalName, statusLine, uploadPath } from './chat-render.js';

describe('chat rendering helpers', () => {
  it('turns the agent status feed into one line, and hides it when the turn is done', () => {
    expect(statusLine('start', null, null)).toBe('Working…');
    expect(statusLine('tool', 'Read', 'src/app.ts')).toBe('Read: src/app.ts');
    expect(statusLine('tool', 'Bash', null)).toBe('Running Bash…');
    expect(statusLine('reasoning', 'Looking at\n the failing   test', null)).toBe('Looking at the failing test');
    expect(statusLine('progress', 'x'.repeat(400), null)!.length).toBe(160);
    expect(statusLine('stalled', null, null)).toMatch(/stuck/);
    expect(statusLine('done', null, null)).toBeNull();
  });

  it('renders a file card with escaped name and wired buttons; a broken meta degrades', () => {
    const html = fileCard('m1', {
      url: '/api/files/r/u.png',
      filename: '<b>shot</b>.png',
      mime: 'image/png',
      size: 2048,
    });
    expect(html).toContain('&lt;b&gt;shot&lt;/b&gt;.png');
    expect(html).toContain('data-file="open" data-id="m1"');
    expect(html).toContain('2.0 KB');
    expect(fileCard('m2', null)).toContain('unavailable');
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('only builds same-origin API URLs, so a message cannot send the token elsewhere', () => {
    expect(apiUrl('https://nc.example.com/', '/api/files/r1/a.png')).toBe('https://nc.example.com/api/files/r1/a.png');
    expect(apiUrl('https://nc.example.com', '/api/files/r1?thread_id=main')).toBe(
      'https://nc.example.com/api/files/r1?thread_id=main',
    );
    expect(apiUrl('https://nc.example.com/some/path?x=1#y', '/api/runners/extension/download')).toBe(
      'https://nc.example.com/api/runners/extension/download',
    );
    expect(() => apiUrl('https://nc.example.com', 'https://evil.example/api/x')).toThrow();
    expect(() => apiUrl('https://nc.example.com', '//evil.example/api/x')).toThrow();
    expect(() => apiUrl('https://nc.example.com', '/api/../admin')).toThrow();
  });

  it("uploads go to central's room upload route (not the file-serving path)", () => {
    expect(uploadPath('runner w1')).toBe('/api/rooms/runner%20w1/upload');
  });
  it('makes a filename safe to create locally', () => {
    expect(safeLocalName('../../etc/passwd')).toBe('passwd');
    expect(safeLocalName('a:b?.txt')).toBe('a_b_.txt');
    expect(safeLocalName('.hidden')).toBe('_hidden');
  });
});
