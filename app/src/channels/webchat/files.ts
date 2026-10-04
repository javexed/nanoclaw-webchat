/**
 * File upload (multipart, or chunked for large/resumable files) + serve for
 * webchat. Files land under data/webchat/uploads/<roomId>/<uuid><.ext>, not a
 * group folder: a multi-agent room has no single one.
 */
import http from 'http';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { once } from 'events';

import Busboy from 'busboy';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import type { InboundMessage } from '../adapter.js';
import {
  storeWebchatFileMessage,
  getWebchatRoom,
  MAIN_THREAD,
  threadToSessionKey,
  resolveBoundedThread,
  type FileMeta,
} from './db.js';
import { broadcast } from './state.js';

const MAX_UPLOAD_SIZE = 8 * 1024 * 1024 * 1024; // 8GB: files and chunks live on the data disk
// An upload is dropped after this long WITHOUT a chunk. Counted from the first
// chunk, it cut every upload longer than five minutes in two: the first part
// was deleted, the rest was taken for a new upload that could never complete.
const CHUNK_UPLOAD_TIMEOUT = 5 * 60 * 1000;

/**
 * Where chunks wait: under DATA_DIR (the large disk), not os.tmpdir() (the
 * root disk, which a gigabyte upload can fill). An upload's state lives in
 * memory only, so chunks left from before a restart can never complete: the
 * first upload after start clears them.
 */
function chunkRoot(): string {
  return path.join(DATA_DIR, 'webchat', 'chunks');
}
/**
 * Whether the data disk can take an upload of `size` bytes: its chunks and the
 * file put together from them are on disk at the same time (twice the size),
 * with a margin left for everything else. Up to 8 GB per file, a few at once
 * per person: without this, one person could fill the disk.
 */
export const UPLOAD_DISK_MARGIN = 512 * 1024 * 1024;
export function uploadFits(size: number, freeBytes: number): boolean {
  return freeBytes >= 2 * size + UPLOAD_DISK_MARGIN;
}
function freeDataBytes(): number {
  try {
    const st = fs.statfsSync(DATA_DIR);
    return st.bavail * st.bsize;
  } catch {
    return Number.POSITIVE_INFINITY; // cannot tell: do not refuse on that
  }
}

let staleChunksCleared = false;
function clearStaleChunks(): void {
  if (staleChunksCleared) return;
  staleChunksCleared = true;
  try {
    fs.rmSync(chunkRoot(), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const pendingChunkedUploads = new Map<
  string,
  {
    roomId: string;
    filename: string;
    mime: string;
    totalChunks: number;
    receivedChunks: Set<number>;
    tempDir: string;
    sender: string;
    senderUserId: string;
    timer: ReturnType<typeof setTimeout>;
    cumulativeSize: number;
    /** Each stored chunk's size: the running total stays exact when a chunk is sent again. */
    chunkSizes: Map<number, number>;
  }
>();

// Cap concurrent open uploads per user: each holds a temp dir + a 5-minute
// timeout, so an uncapped user could pin thousands (disk/memory DoS).
const MAX_OPEN_UPLOADS_PER_USER = 5;
const userActiveUploads = new Map<string, Set<string>>();

// Per-uploadId lock: parallel chunks would both pass the size check and exceed
// the cap; serialised, the disk-stat-sum check inside is authoritative.
const uploadLocks = new Map<string, Promise<unknown>>();
async function withUploadLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = uploadLocks.get(uploadId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  uploadLocks.set(uploadId, next);
  try {
    return await next;
  } finally {
    if (uploadLocks.get(uploadId) === next) {
      uploadLocks.delete(uploadId);
    }
  }
}

export interface FileHooks {
  /** Inbound chat from a connected client → router. `threadId` is the session
   * key (null = the room's main/default thread). */
  onInbound: (roomId: string, message: InboundMessage, threadId: string | null) => void;
}

export function uploadsDir(roomId: string): string {
  return path.join(DATA_DIR, 'webchat', 'uploads', sanitizeId(roomId));
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cleanupChunkedUpload(uploadId: string): void {
  const upload = pendingChunkedUploads.get(uploadId);
  if (!upload) return;
  clearTimeout(upload.timer);
  try {
    fs.rmSync(upload.tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  pendingChunkedUploads.delete(uploadId);
  releaseUploadSlot(upload.senderUserId, uploadId);
}

function reserveUploadSlot(senderUserId: string, uploadId: string): boolean {
  let set = userActiveUploads.get(senderUserId);
  if (!set) {
    set = new Set();
    userActiveUploads.set(senderUserId, set);
  }
  if (set.size >= MAX_OPEN_UPLOADS_PER_USER) return false;
  set.add(uploadId);
  return true;
}

function releaseUploadSlot(senderUserId: string, uploadId: string): void {
  const set = userActiveUploads.get(senderUserId);
  if (!set) return;
  set.delete(uploadId);
  if (set.size === 0) userActiveUploads.delete(senderUserId);
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// JSON envelope cap per chunk request (a 512 KB chunk is ≈ 700 KB base64 + JSON).
const MAX_CHUNK_BODY_BYTES = 2 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
  }
}

function readBody(req: http.IncomingMessage, maxBytes = MAX_CHUNK_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      body += d;
    });
    req.on('end', () => resolve(body));
    req.on('error', (err) => reject(err));
  });
}

// At or below: inlined as base64 `attachments[].data`, which session-manager
// stages to `<sessionDir>/inbox/<msgId>/`. Above: a `hostPath` attachment it
// copies directly (containers can't reach webchat's address for a URL).
const INLINE_ATTACHMENT_THRESHOLD = 25 * 1024 * 1024;

function inboundForFile(
  _roomId: string,
  messageId: string,
  fileMeta: FileMeta,
  caption: string,
  senderIdentity: string,
  senderUserId: string,
  localFilePath: string,
): InboundMessage {
  const attachmentType = fileMeta.mime.startsWith('image/') ? 'image' : 'file';

  let attachment:
    | { name: string; type: string; data: string; size: number; mime: string }
    | { name: string; type: string; hostPath: string; size: number; mime: string }
    | null = null;

  if (fileMeta.size <= INLINE_ATTACHMENT_THRESHOLD) {
    try {
      const data = fs.readFileSync(localFilePath).toString('base64');
      attachment = {
        name: fileMeta.filename,
        type: attachmentType,
        data,
        size: fileMeta.size,
        mime: fileMeta.mime,
      };
    } catch (err) {
      log.warn('Webchat: failed to inline attachment for inbound', {
        localFilePath,
        err: err instanceof Error ? err.message : err,
      });
    }
  } else {
    // Large file: pass the host-side path so session-manager can copy it
    // into the session inbox without base64 encoding.
    attachment = {
      name: fileMeta.filename,
      type: attachmentType,
      hostPath: localFilePath,
      size: fileMeta.size,
      mime: fileMeta.mime,
    };
  }

  // With an attachment the formatter already tells the agent where the file was
  // saved; without one (read error) the URL hint says it exists.
  const text = attachment
    ? caption
    : caption
      ? `[File: ${fileMeta.filename} (${fileMeta.mime}, ${fileMeta.size} bytes) at ${fileMeta.url}]\n${caption}`
      : `[File: ${fileMeta.filename} (${fileMeta.mime}, ${fileMeta.size} bytes) at ${fileMeta.url}]`;

  const content: Record<string, unknown> = {
    text,
    sender: senderIdentity,
    senderId: senderUserId,
    senderName: senderIdentity,
  };
  if (attachment) content.attachments = [attachment];

  return {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    isGroup: true,
    content,
  };
}

export async function handleMultipartUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roomId: string,
  senderIdentity: string,
  senderUserId: string,
  hooks: FileHooks,
  threadId: string = MAIN_THREAD,
): Promise<void> {
  if (!(await getWebchatRoom(roomId))) {
    log.warn('Webchat upload rejected: room not found', { roomId });
    return json(res, 404, { error: 'Room not found' });
  }
  // Bound the client-supplied thread_id exactly like the WS send path, so an
  // arbitrary ?thread_id= can't lazily spawn unbounded per-thread sessions.
  threadId = await resolveBoundedThread(roomId, threadId);

  const dir = uploadsDir(roomId);
  fs.mkdirSync(dir, { recursive: true });

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    log.warn('Webchat upload rejected: bad content-type', { roomId, contentType });
    return json(res, 400, { error: 'Content-Type must be multipart/form-data' });
  }

  const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 } });
  let fileInfo: {
    id: string;
    filename: string;
    mime: string;
    size: number;
    path: string;
    localPath: string;
  } | null = null;
  let limitHit = false;
  let caption = '';
  // Resolves when the disk write is flushed: 'end'/'finish' fire when the READ
  // side ends, and reading earlier yields an empty buffer for small files.
  let writeDone: Promise<void> = Promise.resolve();

  busboy.on('field', (name, value) => {
    if (name === 'caption') caption = value.trim();
  });

  busboy.on('file', (_fieldname, stream, info) => {
    const id = randomUUID();
    const ext = path.extname(info.filename) || '';
    const safeFilename = `${id}${ext}`;
    const filePath = path.join(dir, safeFilename);
    let size = 0;

    const ws = fs.createWriteStream(filePath);
    writeDone = new Promise<void>((resolve, reject) => {
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    });
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    stream.pipe(ws);

    stream.on('limit', () => {
      limitHit = true;
      ws.destroy();
      try {
        fs.unlinkSync(filePath);
      } catch {
        // best-effort
      }
    });

    stream.on('end', () => {
      if (!limitHit) {
        fileInfo = {
          id,
          filename: info.filename,
          mime: info.mimeType || 'application/octet-stream',
          size,
          path: `/api/files/${encodeURIComponent(sanitizeId(roomId))}/${safeFilename}`,
          localPath: filePath,
        };
      }
    });
  });

  busboy.on('finish', () => {
    if (limitHit) {
      log.warn('Webchat upload rejected: file size limit hit', { roomId });
      return json(res, 413, {
        error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
      });
    }
    if (!fileInfo) {
      log.warn('Webchat upload rejected: busboy finished with no file part', { roomId, contentType });
      return json(res, 400, { error: 'No file uploaded' });
    }

    writeDone
      .then(async () => {
        const finishedFileInfo = fileInfo!;
        const fileMeta: FileMeta = {
          url: finishedFileInfo.path,
          filename: finishedFileInfo.filename,
          mime: finishedFileInfo.mime,
          size: finishedFileInfo.size,
        };
        const stored = await storeWebchatFileMessage(roomId, senderIdentity, 'user', caption, fileMeta, threadId);
        await broadcast(roomId, { type: 'message', ...stored });
        hooks.onInbound(
          roomId,
          inboundForFile(
            roomId,
            stored.id,
            fileMeta,
            caption,
            senderIdentity,
            senderUserId,
            finishedFileInfo.localPath,
          ),
          threadToSessionKey(threadId),
        );
        const { localPath: _localPath, ...publicFileInfo } = finishedFileInfo;
        json(res, 200, { ...publicFileInfo, caption });
      })
      .catch((err) => {
        log.warn('Webchat upload: write stream errored', { roomId, err: err instanceof Error ? err.message : err });
        json(res, 500, { error: 'Upload write failed' });
      });
  });

  busboy.on('error', (err) => {
    log.warn('Webchat upload failed', { err: err instanceof Error ? err.message : err });
    json(res, 500, { error: 'Upload failed' });
  });
  req.pipe(busboy);
}

export async function handleChunkedUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roomId: string,
  senderIdentity: string,
  senderUserId: string,
  hooks: FileHooks,
  threadId: string = MAIN_THREAD,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return json(res, 413, { error: 'Request body too large' });
    throw err;
  }
  let parsed: {
    uploadId: string;
    chunkIndex: number;
    totalChunks: number;
    filename: string;
    mime: string;
    data: string;
    caption?: string;
    /** The whole file's size, sent with each chunk: an oversized file is refused at its first. */
    size?: number;
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const { uploadId, chunkIndex, totalChunks, filename, mime, data } = parsed;
  // chunkIndex must be a non-negative integer < totalChunks. String values like
  // "../../etc/foo" would otherwise reach `path.join(tempDir, String(chunkIndex))`
  // and escape the per-upload temp directory.
  if (
    !uploadId ||
    !filename ||
    !data ||
    typeof totalChunks !== 'number' ||
    !Number.isInteger(totalChunks) ||
    totalChunks < 1 ||
    typeof chunkIndex !== 'number' ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= totalChunks
  ) {
    return json(res, 400, { error: 'Missing or invalid required fields' });
  }

  // Validate uploadId as UUID to prevent path traversal in tempDir.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
    return json(res, 400, { error: 'Invalid uploadId format' });
  }

  if (!(await getWebchatRoom(roomId))) {
    return json(res, 404, { error: 'Room not found' });
  }

  // Held for the whole chunk flow, including the final reassemble.
  const result = await withUploadLock(
    uploadId,
    async (): Promise<{ status: number; body: unknown } | { kind: 'reassemble' }> => {
      let upload = pendingChunkedUploads.get(uploadId);
      if (!upload && chunkIndex > 0) {
        // Its state is gone (timed out, or central restarted): starting over
        // from here would accept chunks for an upload that can never complete.
        return { status: 410, body: { error: 'Upload expired. Try again.' } };
      }
      if (!upload && typeof parsed.size === 'number' && parsed.size > MAX_UPLOAD_SIZE) {
        return {
          status: 413,
          body: { error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit` },
        };
      }
      if (!upload) {
        // The whole file, as the page states it; an older page that does not:
        // the chunk count times this chunk's size.
        const expected =
          typeof parsed.size === 'number' && parsed.size > 0
            ? parsed.size
            : totalChunks * Buffer.byteLength(data, 'base64');
        if (!uploadFits(expected, freeDataBytes())) {
          return { status: 507, body: { error: 'Not enough disk space on the server for this file.' } };
        }
        // First chunk: reserve a per-user slot (MAX_OPEN_UPLOADS_PER_USER).
        if (!reserveUploadSlot(senderUserId, uploadId)) {
          return {
            status: 429,
            body: {
              error: `Too many concurrent uploads (max ${MAX_OPEN_UPLOADS_PER_USER}). Wait for one to complete.`,
            },
          };
        }
        clearStaleChunks();
        const tempDir = path.join(chunkRoot(), uploadId);
        fs.mkdirSync(tempDir, { recursive: true });
        upload = {
          roomId,
          filename,
          mime: mime || 'application/octet-stream',
          totalChunks,
          receivedChunks: new Set(),
          tempDir,
          sender: senderIdentity,
          senderUserId,
          timer: setTimeout(() => cleanupChunkedUpload(uploadId), CHUNK_UPLOAD_TIMEOUT),
          cumulativeSize: 0,
          chunkSizes: new Map(),
        };
        pendingChunkedUploads.set(uploadId, upload);
      } else if (totalChunks !== upload.totalChunks) {
        return { status: 400, body: { error: 'totalChunks mismatch' } };
      } else {
        clearTimeout(upload.timer);
        upload.timer = setTimeout(() => cleanupChunkedUpload(uploadId), CHUNK_UPLOAD_TIMEOUT);
      }

      const chunkBuf = Buffer.from(data, 'base64');

      // Authoritative size check: the running total of what this upload has
      // written, exact under the per-uploadId lock. (Stat-summing every stored
      // chunk on each chunk grew with the square of the count: millions of
      // stats, on the event loop, for a multi-gigabyte file.)
      const onDisk = upload.cumulativeSize - (upload.chunkSizes.get(chunkIndex) ?? 0);
      if (onDisk + chunkBuf.length > MAX_UPLOAD_SIZE) {
        cleanupChunkedUpload(uploadId);
        return {
          status: 413,
          body: { error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit` },
        };
      }
      fs.writeFileSync(path.join(upload.tempDir, String(chunkIndex)), chunkBuf);
      upload.receivedChunks.add(chunkIndex);
      upload.chunkSizes.set(chunkIndex, chunkBuf.length);
      upload.cumulativeSize = onDisk + chunkBuf.length;

      if (upload.receivedChunks.size < upload.totalChunks) {
        return {
          status: 200,
          body: { ok: true, received: upload.receivedChunks.size, total: upload.totalChunks },
        };
      }
      return { kind: 'reassemble' };
    },
  );

  if ('status' in result) {
    return json(res, result.status, result.body);
  }

  // All chunks received — reassemble outside the lock so multiple distinct
  // uploads don't queue behind each other.
  const upload = pendingChunkedUploads.get(uploadId);
  if (!upload) {
    return json(res, 410, { error: 'Upload state lost during reassemble' });
  }
  clearTimeout(upload.timer);

  // One last authoritative size check before writing to the final dir —
  // belt-and-braces against an interleave we missed. Cheap (totalChunks
  // stat calls).
  let totalSize = 0;
  for (let i = 0; i < totalChunks; i++) {
    try {
      totalSize += fs.statSync(path.join(upload.tempDir, String(i))).size;
    } catch {
      // missing chunk — ignore
    }
  }
  if (totalSize > MAX_UPLOAD_SIZE) {
    cleanupChunkedUpload(uploadId);
    return json(res, 413, {
      error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
    });
  }

  const dir = uploadsDir(roomId);
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const ext = path.extname(filename) || '';
  const safeFilename = `${id}${ext}`;
  const finalPath = path.join(dir, safeFilename);

  // Each write waits for the stream to drain: queued without waiting, a
  // multi-gigabyte file sat in memory whole before it reached the disk.
  const writeStream = fs.createWriteStream(finalPath);
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(upload.tempDir, String(i));
    if (!writeStream.write(fs.readFileSync(chunkPath))) await once(writeStream, 'drain');
  }
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', () => resolve());
    writeStream.on('error', reject);
    writeStream.end();
  });

  fs.rmSync(upload.tempDir, { recursive: true, force: true });
  pendingChunkedUploads.delete(uploadId);
  releaseUploadSlot(senderUserId, uploadId);

  const fileMeta: FileMeta = {
    url: `/api/files/${encodeURIComponent(sanitizeId(roomId))}/${safeFilename}`,
    filename,
    mime: upload.mime,
    size: totalSize,
  };
  const caption = parsed.caption || '';
  // Bound the client-supplied thread_id (same rule as the WS path) before it
  // keys a session — applied at finalize so it runs once, not per chunk.
  threadId = await resolveBoundedThread(roomId, threadId);
  const stored = await storeWebchatFileMessage(roomId, upload.sender, 'user', caption, fileMeta, threadId);
  await broadcast(roomId, { type: 'message', ...stored });
  hooks.onInbound(
    roomId,
    inboundForFile(roomId, stored.id, fileMeta, caption, upload.sender, upload.senderUserId, finalPath),
    threadToSessionKey(threadId),
  );

  return json(res, 200, { ...fileMeta, caption });
}

export function handleFileServe(res: http.ServerResponse, roomId: string, filename: string): void {
  // Path-traversal guard: the URL roomId is sanitized at write time, so
  // refuse anything that looks unsafe here too. Filenames are uuid+ext we
  // generated; reject suspicious shapes.
  if (filename.includes('..') || filename.includes('/') || roomId.includes('..') || roomId.includes('/')) {
    res.writeHead(403);
    res.end();
    return;
  }
  const filePath = path.join(uploadsDir(roomId), filename);
  const ext = path.extname(filename);
  const mime = MIME[ext] || 'application/octet-stream';
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return json(res, 404, { error: 'File not found' });
  }
  // Strip CR/LF/quote/backslash from the filename before inlining into a
  // header — guards header injection at the response surface.
  const safeName = filename.replace(/[\r\n"\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${safeName}"`,
    // private: uploads are per-room data, never for a shared proxy cache.
    'Cache-Control': 'private, max-age=31536000, immutable',
    // Sandbox the response into an opaque origin so HTML/SVG uploads cannot
    // read the PWA's localStorage token. nosniff stops MIME sniffing.
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}
