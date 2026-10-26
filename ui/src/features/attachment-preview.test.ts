import { describe, expect, it } from 'vitest';
import {
  DRAWER_DEFAULT,
  DRAWER_MIN,
  DRAWER_WIDTH_KEY,
  clampDrawerWidth,
  codeLanguage,
  drawerMax,
  drawerPresets,
  drawerWidthText,
  isTap,
  nextPresetWidth,
  highlight,
  htmlFrameUrl,
  loadDrawerWidth,
  parseCsv,
  previewKind,
  resizeByKey,
  saveDrawerWidth,
} from './attachment-preview.js';

describe('previewKind', () => {
  it('decides by extension, even when the MIME type is generic', () => {
    expect(previewKind('report.pdf', 'application/octet-stream')).toBe('pdf');
    expect(previewKind('clip.mp4', 'application/octet-stream')).toBe('video');
    expect(previewKind('clip.MOV')).toBe('video');
    expect(previewKind('take.m4a')).toBe('audio');
    expect(previewKind('notes.md')).toBe('markdown');
    expect(previewKind('data.csv')).toBe('csv');
    expect(previewKind('data.tsv')).toBe('csv');
    expect(previewKind('config.json')).toBe('json');
    expect(previewKind('main.ts')).toBe('code');
    expect(previewKind('page.html')).toBe('html');
    expect(previewKind('page.HTM', 'application/octet-stream')).toBe('html');
    expect(previewKind('icon.svg')).toBe('code');
    expect(previewKind('run.log')).toBe('text');
    expect(previewKind('README')).toBe('text');
  });

  it('falls back to the MIME type', () => {
    expect(previewKind('blob', 'application/pdf')).toBe('pdf');
    expect(previewKind('blob', 'video/webm')).toBe('video');
    expect(previewKind('blob', 'text/plain')).toBe('text');
  });

  it('has no preview for binaries it cannot render', () => {
    expect(previewKind('archive.zip', 'application/zip')).toBeNull();
    expect(previewKind('model.bin')).toBeNull();
  });
});

describe('codeLanguage', () => {
  it('maps extensions and well-known names', () => {
    expect(codeLanguage('a.py')).toBe('py');
    expect(codeLanguage('a.tsx')).toBe('ts');
    expect(codeLanguage('Makefile')).toBe('make');
    expect(codeLanguage('Dockerfile')).toBe('sh');
    expect(codeLanguage('a.unknown')).toBeNull();
  });
});

describe('highlight', () => {
  it('escapes every character of the input', () => {
    const out = highlight('<img src=x onerror=alert(1)> & "q"', null);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('&amp;');
  });

  it('escapes inside highlighted tokens too', () => {
    const out = highlight('const s = "</span><script>x</script>"; // <b>', 'js');
    expect(out).not.toMatch(/<script>|<b>/);
    expect(out).toContain('<span class="hl-s">&quot;&lt;/span&gt;');
  });

  it('marks keywords, strings, numbers and comments', () => {
    const out = highlight('def f(x):\n    return x + 42  # done\n', 'py');
    expect(out).toContain('<span class="hl-k">def</span>');
    expect(out).toContain('<span class="hl-k">return</span>');
    expect(out).toContain('<span class="hl-n">42</span>');
    expect(out).toContain('<span class="hl-c"># done</span>');
  });

  it('does not take a keyword out of the middle of an identifier', () => {
    expect(highlight('format = 1', 'py')).not.toContain('hl-k');
    expect(highlight('x2 = y', 'js')).not.toContain('hl-n');
  });

  it('keeps an unterminated string to its own line', () => {
    const out = highlight("let a = 'oops\nlet b = 1", 'js');
    expect(out).toContain('<span class="hl-k">let</span> b');
  });

  it('colours markup tags, attributes and values', () => {
    const out = highlight('<a href="x">hi</a><!-- c -->', 'markup');
    expect(out).toContain('<span class="hl-t">&lt;a</span>');
    expect(out).toContain('<span class="hl-a">href</span>');
    expect(out).toContain('<span class="hl-s">&quot;x&quot;</span>');
    expect(out).toContain('<span class="hl-c">&lt;!-- c --&gt;</span>');
  });

  it('colours diff lines', () => {
    const out = highlight('@@ -1 +1 @@\n-old\n+new\n same', 'diff');
    expect(out).toContain('<span class="hl-meta">@@ -1 +1 @@</span>');
    expect(out).toContain('<span class="hl-del">-old</span>');
    expect(out).toContain('<span class="hl-add">+new</span>');
  });
});

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and newlines', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",2\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', '2'],
    ]);
  });

  it('handles CRLF, a BOM, empty fields and no trailing newline', () => {
    expect(parseCsv('﻿a,,c\r\n1,2,')).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
  });

  it('uses the given delimiter and row cap', () => {
    expect(parseCsv('a\tb\n1\t2\n3\t4', '\t', 2)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('drawer width', () => {
  it('clamps between the minimum and what leaves room for the chat', () => {
    expect(clampDrawerWidth(100, 1400)).toBe(DRAWER_MIN);
    expect(clampDrawerWidth(5000, 1400)).toBe(drawerMax(1400));
    expect(clampDrawerWidth(NaN, 1400)).toBe(DRAWER_DEFAULT);
    expect(clampDrawerWidth(700, 1400)).toBe(700);
  });

  it('moves with the keyboard: left widens, right narrows, Home/End jump', () => {
    expect(resizeByKey('ArrowLeft', 600, 1400)).toBe(616);
    expect(resizeByKey('ArrowRight', 600, 1400)).toBe(584);
    expect(resizeByKey('ArrowLeft', 600, 1400, true)).toBe(664);
    expect(resizeByKey('Home', 600, 1400)).toBe(DRAWER_MIN);
    expect(resizeByKey('End', 600, 1400)).toBe(drawerMax(1400));
    expect(resizeByKey('Enter', 600, 1400)).toBeNull();
  });

  it('remembers the width, and survives storage that throws', () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) };
    expect(loadDrawerWidth(store)).toBeNull();
    saveDrawerWidth(store, 612.4);
    expect(map.get(DRAWER_WIDTH_KEY)).toBe('612');
    expect(loadDrawerWidth(store)).toBe(612);

    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDrawerWidth(broken)).toBeNull();
    expect(() => saveDrawerWidth(broken, 500)).not.toThrow();
    expect(loadDrawerWidth(null)).toBeNull();
  });
});

describe('click to cycle preset widths', () => {
  it('tells a click from a drag by a 4px slop', () => {
    expect(isTap(0)).toBe(true);
    expect(isTap(3, 2)).toBe(true);
    expect(isTap(4)).toBe(false);
    expect(isTap(-3, -3)).toBe(false);
  });

  it('has narrow, default and wide presets within the limits', () => {
    expect(drawerPresets(2000).map((p) => [p.label, p.width])).toEqual([
      ['Narrow', 600],
      ['Default', 900],
      ['Wide', 1300],
    ]);
    // Clamped to the minimum and to the room the chat keeps.
    expect(drawerPresets(1000).map((p) => p.width)).toEqual([DRAWER_MIN, 450, drawerMax(1000)]);
  });

  it('drops presets that clamp to the same width on a small window', () => {
    const widths = drawerPresets(700).map((p) => p.width);
    expect(new Set(widths).size).toBe(widths.length);
  });

  it('cycles narrow → default → wide → narrow', () => {
    expect(nextPresetWidth(600, 2000)).toBe(900);
    expect(nextPresetWidth(900, 2000)).toBe(1300);
    expect(nextPresetWidth(1300, 2000)).toBe(600);
  });

  it('goes from a dragged width to the next preset up', () => {
    expect(nextPresetWidth(700, 2000)).toBe(900);
    expect(nextPresetWidth(400, 2000)).toBe(600);
    expect(nextPresetWidth(1500, 2000)).toBe(600);
  });

  it('names the preset in the accessible value text', () => {
    expect(drawerWidthText(900, 2000)).toBe('Default, 900 pixels');
    expect(drawerWidthText(700, 2000)).toBe('700 pixels');
  });
});

describe('htmlFrameUrl', () => {
  it('asks the server for the framed rendering of the same file', () => {
    expect(htmlFrameUrl('/api/files/r/a.html')).toBe('/api/files/r/a.html?view=frame');
    expect(htmlFrameUrl('/api/files/r/a.html?x=1')).toBe('/api/files/r/a.html?x=1&view=frame');
  });
});
