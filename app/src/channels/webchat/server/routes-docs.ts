// ── In-app documentation routes ──────────────────────────────────────────────
// Serves the docs that ship with an install (`docs/webchat/*.md`) to the PWA's
// Documentation view, so an operator can read them without a shell or the repo.
//
// The set is an explicit ALLOWLIST, not a glob over the directory, for two
// reasons. Security is the smaller one: a slug is matched by equality against
// this list and never joined into a path, so traversal has nothing to work
// with. The larger one is editorial — `app/docs/webchat/` also holds
// contributor notes (the boot-order guard, the dependency review, the e2e
// tier, a QA script), and a glob would publish each new one into the product
// the moment it landed. Adding a doc here is a deliberate act.
import fs from 'fs';
import path from 'path';

import { json } from './http.js';
import { log } from '../../../log.js';
import type { RouteCtx } from '../server.js';

export interface DocEntry {
  slug: string;
  title: string;
  /** Grouping for the list; ordering below is the reading order. */
  section: 'Getting started' | 'Using it' | 'Under the hood';
}

/** Order is the reading order the view renders; sections are its headings. */
export const DOCS: readonly DocEntry[] = [
  { slug: 'guide', title: 'Feature guide', section: 'Getting started' },
  { slug: 'install', title: 'Installing NanoClaw', section: 'Getting started' },

  { slug: 'threads', title: 'Per-room threads', section: 'Using it' },
  { slug: 'thread-context-sync', title: 'Thread context sync', section: 'Using it' },
  { slug: 'thread-engaged-agents', title: 'Thread engaged agents', section: 'Using it' },
  { slug: 'user-credentials', title: 'Per-member credentials', section: 'Using it' },
  { slug: 'user-credentials-oauth', title: 'Subscription (OAuth) credentials', section: 'Using it' },
  { slug: 'learning-loop', title: 'The learning loop', section: 'Using it' },
  { slug: 'agent-templates', title: 'Agent templates', section: 'Using it' },
  { slug: 'approval-prejudge', title: 'Approval pre-judge', section: 'Using it' },

  { slug: 'message-path', title: 'The message path', section: 'Under the hood' },
  { slug: 'architecture-diagram', title: 'Architecture diagram', section: 'Under the hood' },
  { slug: 'webchat', title: 'Channel reference', section: 'Under the hood' },
  { slug: 'security', title: 'Security model', section: 'Under the hood' },
] as const;

/**
 * Where the docs live in a composed install. The host runs from the install
 * root (the same assumption container-runner makes when it resolves the
 * project root for mounts), and `app/docs/webchat/` overlays to `docs/webchat/`.
 */
function docsRoot(): string {
  return path.join(process.cwd(), 'docs', 'webchat');
}

function screenshotsRoot(): string {
  return path.join(docsRoot(), 'screenshots');
}

/**
 * The allowlist filtered to what this install actually carries. A doc can be
 * absent legitimately — an install composed from an older app tree predates it —
 * and a list entry whose file is missing would render as a dead link.
 */
export function listAvailableDocs(): DocEntry[] {
  const root = docsRoot();
  return DOCS.filter((d) => {
    try {
      return fs.statSync(path.join(root, `${d.slug}.md`)).isFile();
    } catch {
      return false;
    }
  });
}

/** GET /api/docs — the list the view's sidebar renders. */
export async function rDocsGet(ctx: RouteCtx): Promise<void> {
  json(ctx.res, 200, { docs: listAvailableDocs() });
}

/** GET /api/docs/:slug — one doc's markdown, rendered client-side. */
export async function rDocGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const slug = m[1];
  // Equality against the allowlist. The slug never reaches path.join unless it
  // is one of the literals above, so there is no traversal surface here.
  const entry = DOCS.find((d) => d.slug === slug);
  if (!entry) return json(ctx.res, 404, { error: 'unknown doc' });

  let markdown: string;
  try {
    markdown = fs.readFileSync(path.join(docsRoot(), `${entry.slug}.md`), 'utf8');
  } catch (err) {
    log.warn('Doc read failed', { slug, err: String(err) });
    return json(ctx.res, 404, { error: 'doc not found in this install' });
  }
  json(ctx.res, 200, { slug: entry.slug, title: entry.title, markdown });
}

/** Screenshot filenames as they appear in the docs: no separators, no dots. */
const ASSET_NAME = /^[a-z0-9][a-z0-9-]*\.(png|gif)$/;

/**
 * GET /api/docs/asset/:name — the images the docs reference as
 * `./screenshots/<name>`. Guide.md is mostly screenshots, so without this the
 * view's most-read page is a column of broken images.
 */
export async function rDocAssetGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const name = m[1];
  if (!ASSET_NAME.test(name)) return json(ctx.res, 404, { error: 'unknown asset' });

  // Belt and braces over the regex: resolve, then require containment. The
  // regex already excludes '/' and '..', so this only ever fires if that
  // pattern is later loosened.
  const root = screenshotsRoot();
  const file = path.resolve(root, name);
  if (file !== path.join(root, name)) return json(ctx.res, 404, { error: 'unknown asset' });

  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    return json(ctx.res, 404, { error: 'asset not found in this install' });
  }
  ctx.res.writeHead(200, {
    'Content-Type': name.endsWith('.gif') ? 'image/gif' : 'image/png',
    'Content-Length': body.length,
    // Docs images change only when the install is recomposed, and the view
    // re-requests them on every page switch.
    'Cache-Control': 'private, max-age=3600',
  });
  ctx.res.end(body);
}
