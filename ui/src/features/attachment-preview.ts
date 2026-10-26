// Pure logic behind the attachment drawer: which renderer a file gets, the small
// syntax highlighter, the CSV parser and the drawer-width rules. No DOM and no
// vendored imports, so it runs under the Node unit tests.
//
// The highlighter is a deliberate few dozen lines rather than a dependency: a
// preview needs comments, strings, numbers and keywords told apart, not a full
// grammar, and a highlighting library would be the bundle's largest module.

import { CLICK_SLOP_PX, clampSize, nextPreset, sizeForKey } from '../core/resizer.js';

export interface AttachmentFile {
  url: string;
  filename: string;
  mime?: string;
  size?: number;
}

export type PreviewKind = 'pdf' | 'video' | 'audio' | 'html' | 'markdown' | 'csv' | 'json' | 'code' | 'text';

/** Text previews past this size are not fetched: the file is offered as a download instead. */
export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;
/** HTML renders up to this size (the server's cap for the framed page). */
export const HTML_PREVIEW_MAX = 5 * 1024 * 1024;
/** CSV previews stop rendering rows here; a larger table is unreadable in a drawer anyway. */
export const CSV_ROW_LIMIT = 1000;

export function fileExt(filename: string): string {
  const m = /\.([A-Za-z0-9_+-]+)$/.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

const MEDIA_VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);
const MEDIA_AUDIO = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus']);
const PLAIN_TEXT = new Set(['txt', 'log', 'text', 'out']);

/**
 * Which renderer the drawer uses, or null for "no preview" (the chip stays a
 * download). The extension decides first: agents' files often arrive typed
 * application/octet-stream, so the MIME type is only a fallback.
 */
export function previewKind(filename: string, mime = ''): PreviewKind | null {
  const ext = fileExt(filename);
  const m = (mime || '').toLowerCase();
  if (ext === 'pdf' || m === 'application/pdf') return 'pdf';
  if (MEDIA_VIDEO.has(ext) || m.startsWith('video/')) return 'video';
  if (MEDIA_AUDIO.has(ext) || m.startsWith('audio/')) return 'audio';
  if (ext === 'md' || ext === 'markdown' || m === 'text/markdown') return 'markdown';
  if (ext === 'csv' || ext === 'tsv' || m === 'text/csv') return 'csv';
  if (ext === 'json' || m === 'application/json') return 'json';
  if (ext === 'html' || ext === 'htm' || m === 'text/html') return 'html';
  if (codeLanguage(filename)) return 'code';
  if (PLAIN_TEXT.has(ext) || m.startsWith('text/')) return 'text';
  if (ext === '' && /^(readme|license|copying|notice|authors|changelog)$/i.test(filename)) return 'text';
  return null;
}

// ── Highlighting ────────────────────────────────────────────────────────────

interface Lang {
  line?: string[];
  block?: [string, string][];
  strings?: string[];
  keywords?: string;
  markup?: boolean;
  diff?: boolean;
}

const C_LIKE = { line: ['//'], block: [['/*', '*/']] as [string, string][], strings: ['"', "'"] };
const JS_KW =
  'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield';
const TS_KW = `${JS_KW} abstract as declare enum implements interface keyof namespace private protected public readonly type`;

const LANGS: Record<string, Lang> = {
  js: { ...C_LIKE, strings: ['"', "'", '`'], keywords: JS_KW },
  ts: { ...C_LIKE, strings: ['"', "'", '`'], keywords: TS_KW },
  py: {
    line: ['#'],
    strings: ['"""', "'''", '"', "'"],
    keywords:
      'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  },
  sh: {
    line: ['#'],
    strings: ['"', "'"],
    keywords: 'case do done echo elif else esac exit export fi for function if in local return set then until while',
  },
  go: {
    ...C_LIKE,
    strings: ['"', "'", '`'],
    keywords:
      'break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var',
  },
  rust: {
    ...C_LIKE,
    keywords:
      'as async await break const continue crate else enum false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  },
  c: {
    ...C_LIKE,
    line: ['//', '#'],
    keywords:
      'auto bool break case char class const continue default delete do double else enum extern false float for if include int long namespace new nullptr private protected public return short signed sizeof static struct switch template this true typedef union unsigned using virtual void volatile while',
  },
  java: {
    ...C_LIKE,
    keywords:
      'abstract boolean break byte case catch char class const continue default do double else enum extends false final finally float for fun if implements import in instanceof int interface is long new null object override package private protected public return short static super switch this throw throws true try val var void when while',
  },
  csharp: {
    ...C_LIKE,
    keywords:
      'abstract async await bool break case catch class const continue default do double else enum false finally float for foreach if in int interface internal namespace new null out override private protected public readonly return static string struct switch this throw true try using var virtual void while',
  },
  rb: {
    line: ['#'],
    strings: ['"', "'"],
    keywords:
      'begin break case class def do else elsif end ensure false for if in module next nil not or raise rescue return self super then true unless until when while yield',
  },
  php: {
    ...C_LIKE,
    line: ['//', '#'],
    keywords:
      'abstract array as break case catch class const continue default do echo else elseif extends false final for foreach function if implements interface namespace new null private protected public return static switch this throw true try use while',
  },
  sql: {
    line: ['--'],
    block: [['/*', '*/']],
    strings: ["'", '"'],
    keywords:
      'add all alter and as asc between by case create delete desc distinct drop else end exists from group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table then union update values view when where with',
  },
  css: { block: [['/*', '*/']], strings: ['"', "'"], keywords: 'important media import keyframes root' },
  yaml: { line: ['#'], strings: ['"', "'"], keywords: 'true false null yes no on off' },
  toml: { line: ['#'], strings: ['"""', '"', "'"], keywords: 'true false' },
  json: { strings: ['"'], keywords: 'true false null' },
  lua: {
    line: ['--'],
    strings: ['"', "'"],
    keywords:
      'and break do else elseif end false for function if in local nil not or repeat return then true until while',
  },
  swift: {
    ...C_LIKE,
    keywords:
      'as break case class continue default defer do else enum extension false for func guard if import in init inout let nil private protocol public return self static struct switch throw true try var where while',
  },
  r: {
    line: ['#'],
    strings: ['"', "'"],
    keywords: 'break else FALSE for function if in NA next NULL repeat return TRUE while',
  },
  make: {
    line: ['#'],
    strings: ['"', "'"],
    keywords: 'ifeq ifneq ifdef ifndef else endif include define endef export',
  },
  ini: { line: ['#', ';'], strings: ['"', "'"], keywords: 'true false' },
  markup: { markup: true },
  diff: { diff: true },
  plain: {},
};

const EXT_LANG: Record<string, string> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'js',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'ts',
  py: 'py',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  fish: 'sh',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  hpp: 'c',
  java: 'java',
  kt: 'java',
  kts: 'java',
  scala: 'java',
  cs: 'csharp',
  rb: 'rb',
  php: 'php',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  less: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  lua: 'lua',
  swift: 'swift',
  r: 'r',
  mk: 'make',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  diff: 'diff',
  patch: 'diff',
};

/** The highlighter language for a file name, or null when it is not source code. */
export function codeLanguage(filename: string): string | null {
  const ext = fileExt(filename);
  if (EXT_LANG[ext]) return EXT_LANG[ext];
  if (/^(makefile|gnumakefile)$/i.test(filename)) return 'make';
  if (/^dockerfile$/i.test(filename) || ext === 'dockerfile') return 'sh';
  return null;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const span = (cls: string, text: string) => `<span class="hl-${cls}">${escapeHtml(text)}</span>`;

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

function stickyMatch(re: RegExp, code: string, at: number): string | null {
  re.lastIndex = at;
  const m = re.exec(code);
  return m ? m[0] : null;
}

/** End index (exclusive) of a string opened by `q` at `at`. */
function stringEnd(code: string, at: number, q: string): number {
  const multiline = q.length === 3 || q === '`';
  let i = at + q.length;
  while (i < code.length) {
    if (code[i] === '\\') {
      i += 2;
      continue;
    }
    if (code.startsWith(q, i)) return i + q.length;
    if (!multiline && code[i] === '\n') return i;
    i++;
  }
  return code.length;
}

function highlightDiff(code: string): string {
  return code
    .split('\n')
    .map((line) =>
      /^(\+\+\+|---|@@)/.test(line)
        ? span('meta', line)
        : line.startsWith('+')
          ? span('add', line)
          : line.startsWith('-')
            ? span('del', line)
            : escapeHtml(line),
    )
    .join('\n');
}

function highlightMarkup(code: string): string {
  let out = '';
  let i = 0;
  const TAG = /<\/?[A-Za-z][\w:.-]*/y;
  const ATTR = /[^\s=>/"']+/y;
  while (i < code.length) {
    if (code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4);
      const stop = end === -1 ? code.length : end + 3;
      out += span('c', code.slice(i, stop));
      i = stop;
      continue;
    }
    const tag = code[i] === '<' ? stickyMatch(TAG, code, i) : null;
    if (!tag) {
      out += escapeHtml(code[i]);
      i++;
      continue;
    }
    out += span('t', tag);
    i += tag.length;
    // Inside the tag: attribute names and quoted values, up to '>'.
    while (i < code.length && code[i] !== '>') {
      const c = code[i];
      if (c === '"' || c === "'") {
        const end = code.indexOf(c, i + 1);
        const stop = end === -1 ? code.length : end + 1;
        out += span('s', code.slice(i, stop));
        i = stop;
        continue;
      }
      const attr = /\s|=|\//.test(c) ? null : stickyMatch(ATTR, code, i);
      if (attr) {
        out += span('a', attr);
        i += attr.length;
        continue;
      }
      out += escapeHtml(c);
      i++;
    }
    if (code[i] === '>') {
      out += span('t', '>');
      i++;
    }
  }
  return out;
}

/**
 * Escaped HTML for `code`, with comments, strings, numbers and keywords wrapped
 * in `hl-*` spans. Every byte of input text passes through escapeHtml, so the
 * result is safe for v-html whatever the file contains.
 */
export function highlight(code: string, langName: string | null): string {
  const lang = LANGS[langName ?? 'plain'] ?? LANGS.plain;
  if (lang.diff) return highlightDiff(code);
  if (lang.markup) return highlightMarkup(code);
  const keywords = new Set((lang.keywords ?? '').split(' ').filter(Boolean));
  const strings = lang.strings ?? [];
  let out = '';
  let plain = '';
  const flush = () => {
    if (plain) out += escapeHtml(plain);
    plain = '';
  };
  let i = 0;
  scan: while (i < code.length) {
    for (const [open, close] of lang.block ?? []) {
      if (code.startsWith(open, i)) {
        const end = code.indexOf(close, i + open.length);
        const stop = end === -1 ? code.length : end + close.length;
        flush();
        out += span('c', code.slice(i, stop));
        i = stop;
        continue scan;
      }
    }
    for (const lc of lang.line ?? []) {
      if (code.startsWith(lc, i)) {
        const end = code.indexOf('\n', i);
        const stop = end === -1 ? code.length : end;
        flush();
        out += span('c', code.slice(i, stop));
        i = stop;
        continue scan;
      }
    }
    for (const q of strings) {
      if (code.startsWith(q, i)) {
        const stop = stringEnd(code, i, q);
        flush();
        out += span('s', code.slice(i, stop));
        i = stop;
        continue scan;
      }
    }
    const prev = i > 0 ? code[i - 1] : '';
    if (!/[\w$]/.test(prev)) {
      const num = /\d/.test(code[i]) ? stickyMatch(NUMBER, code, i) : null;
      if (num) {
        flush();
        out += span('n', num);
        i += num.length;
        continue;
      }
      const word = stickyMatch(IDENT, code, i);
      if (word) {
        if (keywords.has(word)) {
          flush();
          out += span('k', word);
        } else {
          plain += word;
        }
        i += word.length;
        continue;
      }
    }
    plain += code[i];
    i++;
  }
  flush();
  return out;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV: quoted fields may hold the delimiter, newlines and doubled
 * quotes. Stops after `maxRows` rows. A trailing newline does not make an
 * empty last row.
 */
export function parseCsv(text: string, delimiter = ',', maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
      if (rows.length >= maxRows) return rows;
    } else {
      field += c;
    }
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

export function csvDelimiter(filename: string): string {
  return fileExt(filename) === 'tsv' ? '\t' : ',';
}

// ── Drawer width ────────────────────────────────────────────────────────────
// The drawer sizes through the same helpers as the room sidebar
// (core/resizer.ts): clamping, arrow-key steps, the click/drag slop and the
// next preset are shared. What is the drawer's own is everything that depends
// on the window — its maximum, its percentage presets and their names — and
// Shift for bigger steps.

export const DRAWER_WIDTH_KEY = 'webchat.attachmentDrawerWidth';
export const DRAWER_MIN = 320;
export const DRAWER_DEFAULT = 560;
/** The sidebar and chat keep at least this much of the window beside the drawer. */
const CHAT_MIN = 480;

export function drawerMax(viewport: number): number {
  return Math.max(DRAWER_MIN, viewport - CHAT_MIN);
}

export function clampDrawerWidth(width: number, viewport: number): number {
  if (!Number.isFinite(width)) return Math.min(DRAWER_DEFAULT, drawerMax(viewport));
  return clampSize(width, DRAWER_MIN, drawerMax(viewport));
}

export const RESIZE_STEP = 16;

/**
 * The new width for a key pressed on the resize separator, or null for a key it
 * ignores. The drawer is on the right, so ArrowLeft widens it (the edge moves
 * left) — the direction the handle visibly travels. Shift takes bigger steps.
 */
export function resizeByKey(key: string, width: number, viewport: number, big = false): number | null {
  // Up/Down step too, the way Left/Right do (Up widens).
  const k = key === 'ArrowUp' ? 'ArrowLeft' : key === 'ArrowDown' ? 'ArrowRight' : key;
  return sizeForKey(k, width, {
    min: DRAWER_MIN,
    max: drawerMax(viewport),
    step: big ? RESIZE_STEP * 4 : RESIZE_STEP,
    growsToward: 'left',
  });
}

// ── Single-pointer resize (WCAG 2.5.7) ──────────────────────────────────────
// Dragging is not the only way: a plain click or tap on the separator steps
// the width through three presets, narrow → default → wide → narrow.

/** A press that moves less than this is a click, never the start of a drag. */
export const TAP_SLOP = CLICK_SLOP_PX;

export function isTap(dx: number, dy = 0): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP;
}

export interface DrawerPreset {
  label: string;
  width: number;
}

const PRESET_FRACTIONS: [string, number][] = [
  ['Narrow', 0.3],
  ['Default', 0.45],
  ['Wide', 0.65],
];

/**
 * The presets for this viewport, clamped to the drawer's limits. On a window
 * small enough that two clamp to the same width, the duplicate is dropped.
 */
export function drawerPresets(viewport: number): DrawerPreset[] {
  const out: DrawerPreset[] = [];
  for (const [label, f] of PRESET_FRACTIONS) {
    const width = clampDrawerWidth(viewport * f, viewport);
    if (!out.some((p) => p.width === width)) out.push({ label, width });
  }
  return out;
}

/**
 * The width a click moves to: the next preset wider than the current width,
 * or back to the narrowest after the widest. A width left between presets by a
 * drag goes to the next preset up, so the cycle is always predictable.
 */
export function nextPresetWidth(width: number, viewport: number): number {
  // +1: a width within a pixel of a preset counts as that preset.
  return nextPreset(
    width + 1,
    drawerPresets(viewport).map((p) => p.width),
  );
}

/** What a screen reader hears for a width: the preset's name when it is one. */
export function drawerWidthText(width: number, viewport: number): string {
  const preset = drawerPresets(viewport).find((p) => Math.abs(p.width - width) <= 1);
  return preset ? `${preset.label}, ${width} pixels` : `${width} pixels`;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

/** The viewer's saved width, or null when there is none or storage is unavailable. */
export function loadDrawerWidth(storage: KV | null | undefined): number | null {
  try {
    const raw = storage?.getItem(DRAWER_WIDTH_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveDrawerWidth(storage: KV | null | undefined, width: number): void {
  try {
    storage?.setItem(DRAWER_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // private mode / blocked storage: the width just isn't remembered
  }
}

export function formatSize(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Where the drawer's frame loads an HTML attachment from: the same file, served
 * for a frame under a CSP of its own. A srcdoc or blob: frame would inherit the
 * app's CSP, whose script-src 'self' blocks the page's inline scripts.
 */
export function htmlFrameUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}view=frame`;
}
