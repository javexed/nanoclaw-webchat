// Content-addressed bundles: gzip(JSON(BundleDoc)) keyed by sha256 of the
// gzipped bytes. Central ships them in base64 chunks; we reassemble, verify the
// hash BEFORE trusting the content, and unpack under <cache>/<hash>/ once.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { BundleDoc } from './remote-spec.js';

export class BundleStore {
  private readonly partial = new Map<string, { total: number; parts: Array<string | undefined> }>();
  constructor(private readonly root: string) {}

  dirFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`bad bundle hash ${hash}`);
    return path.join(this.root, hash);
  }
  has(hash: string): boolean {
    try {
      return fs.existsSync(path.join(this.dirFor(hash), '.complete'));
    } catch {
      return false;
    }
  }
  missing(hashes: string[]): string[] {
    return hashes.filter((h) => !this.has(h));
  }

  /** Accept one chunk; returns true when the bundle is complete and stored. */
  accept(chunk: { hash: string; seq: number; total: number; data: string }): boolean {
    const dir = this.dirFor(chunk.hash);
    if (this.has(chunk.hash)) return true;
    let p = this.partial.get(chunk.hash);
    if (!p || p.total !== chunk.total) {
      // A filled array, not Array(n): holes are skipped by .some(), which made a
      // bundle look complete after its first chunk.
      p = { total: chunk.total, parts: Array.from({ length: chunk.total }, () => undefined as string | undefined) };
      this.partial.set(chunk.hash, p);
    }
    if (chunk.seq < 0 || chunk.seq >= p.total) throw new Error(`bundle chunk ${chunk.seq}/${chunk.total} out of range`);
    p.parts[chunk.seq] = chunk.data;
    if (p.parts.some((x) => x === undefined)) return false;
    const bytes = Buffer.from(p.parts.join(''), 'base64');
    this.partial.delete(chunk.hash);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== chunk.hash)
      throw new Error(`bundle hash mismatch: expected ${chunk.hash.slice(0, 12)}, got ${actual.slice(0, 12)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.bundle.gz'), bytes);
    unpackDoc(parseDoc(bytes), path.join(dir, 'tree'));
    fs.writeFileSync(path.join(dir, '.complete'), new Date().toISOString());
    return true;
  }

  /** Path of the unpacked tree (or the single file inside it for file bundles). */
  treePath(hash: string, file: boolean): string {
    const tree = path.join(this.dirFor(hash), 'tree');
    if (!file) return tree;
    const entries = fs.readdirSync(tree);
    if (entries.length !== 1) throw new Error(`file bundle ${hash.slice(0, 12)} has ${entries.length} entries`);
    return path.join(tree, entries[0]);
  }

  /** Copy an unpacked bundle into a fresh directory (seeding writable state). */
  seedInto(hash: string, dest: string): void {
    const doc = parseDoc(fs.readFileSync(path.join(this.dirFor(hash), '.bundle.gz')));
    unpackDoc(doc, dest);
  }
}

export function parseDoc(gz: Buffer): BundleDoc {
  const doc = JSON.parse(gunzipSync(gz).toString('utf8')) as BundleDoc;
  if (doc.v !== 1 || !Array.isArray(doc.files) || !Array.isArray(doc.dirs))
    throw new Error('unsupported bundle document');
  return doc;
}

/**
 * A bundle path as this machine can create it. Central's paths are Linux
 * names, and some are not legal on Windows — a session's inbox holds a folder
 * per routed message id, `<uuid>:<agent group>` — so a prepare died with
 * ENOENT on mkdir. Map the reserved characters exactly as WSL's drvfs does
 * (U+F000 + the character), so the container, which sees this directory
 * through the podman machine's WSL mount, reads the original name back.
 */
export function hostSafeRel(rel: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return rel;
  return rel
    .split('/')
    .map((seg) => seg.replace(/[<>:"|?*\u0001-\u001f]/g, (c) => String.fromCharCode(0xf000 + c.charCodeAt(0))))
    .join('/');
}

/** Write a document to `dest`; every entry is confined under dest (no `..`, no absolute paths). */
export function unpackDoc(doc: BundleDoc, dest: string, platform: NodeJS.Platform = process.platform): void {
  const root = path.resolve(dest);
  const inside = (raw: string): string => {
    const rel = hostSafeRel(raw, platform);
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`bundle entry escapes its root: ${raw}`);
    return full;
  };
  fs.mkdirSync(root, { recursive: true });
  for (const d of doc.dirs) fs.mkdirSync(inside(d), { recursive: true });
  for (const f of doc.files) {
    const full = inside(f.p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(f.d, 'base64'));
    try {
      fs.chmodSync(full, f.m & 0o777);
    } catch {
      /* Windows: modes are advisory */
    }
  }
}
