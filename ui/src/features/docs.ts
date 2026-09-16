// ── Documentation viewer ─────────────────────────────────────────────────────
// Renders the docs that ship with the install (`docs/webchat/*.md`, served by
// server/routes-docs.ts) inside the app, so an operator never needs a shell or
// the repo to answer "how do threads work".
//
// It shares the Help view: the hand-written cards stay as the landing page —
// they answer "how do the pieces fit together", which no reference doc does —
// and the doc list sits under them.
import { marked } from '/marked.min.js';
import DOMPurify from '/dompurify.min.js';

import { apiJson } from '../core/api.js';
import { $, esc } from '../core/dom.js';

interface DocEntry {
  slug: string;
  title: string;
  section: string;
}

let docs: DocEntry[] = [];
let loaded = false;

/**
 * Rewrites the two link shapes the docs use for their own tree, which mean
 * nothing to a browser at this origin:
 *
 *   ![alt](./screenshots/x.png)  → the asset route
 *   [text](other.md#anchor)      → in-app navigation, when `other` is served;
 *                                  otherwise the link is flattened to its text,
 *                                  because a dead link reads as a bug and the
 *                                  reader cannot tell that the target simply
 *                                  isn't published in-app.
 *
 * Done on the markdown rather than the DOM: marked emits the anchors already
 * resolved, and rewriting text is far less fiddly than walking nodes.
 */
export function rewriteDocLinks(md: string, known: ReadonlySet<string>): string {
  const withImages = md.replace(/!\[([^\]]*)\]\(\.?\/?screenshots\/([a-z0-9-]+\.(?:png|gif))\)/g, (_m, alt, file) => {
    return `![${alt}](/api/docs/asset/${file})`;
  });
  return withImages.replace(/\[([^\]]+)\]\(([a-z0-9-]+)\.md(#[a-z0-9-]*)?\)/g, (_m, text, slug, hash) => {
    return known.has(slug) ? `[${text}](#doc/${slug}${hash ?? ''})` : text;
  });
}

function renderNav(): void {
  const nav = $('#docs-nav');
  if (!nav) return;
  if (docs.length === 0) {
    nav.innerHTML = '<p class="docs-empty">This install ships no documentation.</p>';
    return;
  }
  const sections: string[] = [];
  let current = '';
  for (const d of docs) {
    if (d.section !== current) {
      if (current) sections.push('</ul>');
      sections.push(`<h3 class="docs-nav-head">${esc(d.section)}</h3><ul class="docs-nav-list">`);
      current = d.section;
    }
    sections.push(`<li><a class="docs-link" href="#doc/${esc(d.slug)}" data-doc="${esc(d.slug)}">${esc(d.title)}</a></li>`);
  }
  sections.push('</ul>');
  nav.innerHTML = `<h2 class="docs-nav-title">Documentation</h2>${sections.join('')}`;
}

/** Fetch the list once per session; the set only changes on a recompose. */
export async function loadDocs(): Promise<void> {
  if (loaded) return;
  try {
    const res = (await apiJson('/api/docs')) as { docs?: DocEntry[] };
    docs = res.docs ?? [];
    loaded = true;
  } catch (err) {
    console.error('Docs list failed', err);
    docs = [];
  }
  renderNav();
}

/**
 * Mermaid is 3.4MB, so it is fetched on demand — the first time a doc with a
 * diagram is opened — and never for the many docs that have none. Vendored and
 * same-origin like every other library here, so `script-src 'self'` covers it;
 * the bundle contains no eval/new Function, so it needs no CSP relaxation.
 */
let mermaidLoad: Promise<MermaidApi | null> | null = null;

interface MermaidApi {
  initialize(cfg: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidLoad) return mermaidLoad;
  mermaidLoad = new Promise<MermaidApi | null>((resolve) => {
    const el = document.createElement('script');
    el.src = '/mermaid.min.js';
    el.onload = () => resolve((window as unknown as { mermaid?: MermaidApi }).mermaid ?? null);
    // Resolve null rather than reject: a missing bundle must degrade to the
    // labelled source, not throw inside a doc render.
    el.onerror = () => resolve(null);
    document.head.appendChild(el);
  });
  return mermaidLoad;
}

/** Mermaid's own theme, picked from the app's — 'system' follows the OS. */
function mermaidTheme(): 'dark' | 'default' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return 'dark';
  if (attr === 'light') return 'default';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
}

let mermaidReady = false;

/**
 * Replace each fence with its rendered diagram. Per-block try/catch: one
 * malformed diagram keeps its source and the rest of the page still renders.
 */
async function renderMermaid(article: Element, fences: Element[]): Promise<void> {
  const mermaid = await loadMermaid();
  if (!mermaid) return; // labelled source stands
  if (!mermaidReady) {
    // securityLevel 'strict' escapes labels. The diagram text comes from the
    // install's own doc files (an allowlist on the server), not from anything
    // a user typed, so this is defence in depth rather than the load-bearing
    // control.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mermaidTheme() });
    mermaidReady = true;
  }
  for (const [i, code] of fences.entries()) {
    const pre = code.parentElement;
    if (!pre || !article.contains(pre)) continue;
    try {
      const { svg } = await mermaid.render(`docs-mmd-${Date.now()}-${i}`, code.textContent ?? '');
      const fig = document.createElement('figure');
      fig.className = 'docs-diagram';
      fig.innerHTML = svg;
      pre.replaceWith(fig);
    } catch (err) {
      console.error('Diagram render failed; keeping its source', err);
    }
  }
}

/** Show one doc; the landing cards and the list step aside while it is open. */
export async function openDoc(slug: string, hash = ''): Promise<void> {
  const article = $('#docs-article');
  const landing = $('#docs-landing');
  if (!article || !landing) return;

  const entry = docs.find((d) => d.slug === slug);
  article.innerHTML = `<p class="docs-loading">Loading ${esc(entry?.title ?? slug)}…</p>`;
  landing.hidden = true;
  article.hidden = false;

  let markdown: string;
  try {
    const res = (await apiJson(`/api/docs/${encodeURIComponent(slug)}`)) as { markdown?: string };
    markdown = res.markdown ?? '';
  } catch (err) {
    console.error('Doc load failed', err);
    article.innerHTML =
      '<p class="docs-error">That document could not be loaded. It may not ship with this install.</p>' +
      '<p><a class="docs-back" href="#docs">← All documentation</a></p>';
    return;
  }

  const known = new Set(docs.map((d) => d.slug));
  let html: string;
  try {
    // Same sanitizer contract as chat (transcript.ts): marked emits neither
    // forms nor style attributes, so forbidding them costs rendering nothing
    // and closes the CSP's deliberate style-src gap.
    html = DOMPurify.sanitize(marked.parse(rewriteDocLinks(markdown, known)), {
      FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'style'],
      FORBID_ATTR: ['style'],
    });
  } catch (err) {
    console.error('Doc render failed', err);
    html = `<pre class="docs-raw">${esc(markdown)}</pre>`;
  }

  article.innerHTML = `<p><a class="docs-back" href="#docs">← All documentation</a></p>${html}`;

  // Mermaid fences become diagrams. Until the bundle loads (or if it fails to)
  // they stay as labelled source, which is a readable fallback rather than a
  // wall of unexplained syntax where a picture obviously belongs.
  const fences = Array.from(article.querySelectorAll('pre > code.language-mermaid'));
  for (const code of fences) {
    code.parentElement?.classList.add('docs-mermaid');
  }
  if (fences.length > 0) void renderMermaid(article, fences);

  if (hash) {
    const target = article.querySelector(`#${CSS.escape(hash.slice(1))}`);
    if (target) target.scrollIntoView();
    else article.scrollIntoView();
  } else {
    article.scrollIntoView();
  }
}

/** Back to the landing cards + list. */
export function closeDoc(): void {
  const article = $('#docs-article');
  const landing = $('#docs-landing');
  if (article) {
    article.hidden = true;
    article.innerHTML = '';
  }
  if (landing) landing.hidden = false;
}

/**
 * One delegated listener for every doc link — the nav's, and the cross-links
 * inside a rendered doc, which do not exist when this is wired.
 */
export function wireDocLinks(root: ParentNode = document): void {
  root.addEventListener('click', (ev) => {
    const el = (ev.target as Element | null)?.closest('a');
    if (!el) return;
    const href = el.getAttribute('href') ?? '';
    if (href === '#docs') {
      ev.preventDefault();
      closeDoc();
      return;
    }
    const m = href.match(/^#doc\/([a-z0-9-]+)(#[a-z0-9-]*)?$/);
    if (!m) return;
    ev.preventDefault();
    void openDoc(m[1], m[2] ?? '');
  });
}
