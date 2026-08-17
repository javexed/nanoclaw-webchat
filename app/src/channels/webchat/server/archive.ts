// ── Archive spool ────────────────────────────────────────────────────────────
// The plumbing under every export and import: one spawn point for tar, the
// upload spool, the in-flight import registry and its sweep.
//
// Shared rather than moved. Room import drives all of it, but so do system
// export, agent export and system import, none of which are in the room
// cluster. The registry is module state, so it moves with the functions that
// read it — two copies of it would each see half the in-flight imports.

// Staged agent imports awaiting apply: token → extracted bundle dir. 15-min
// TTL; apply or expiry removes the dir.
import Busboy from 'busboy';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import type { IncomingMessage } from 'http';
import os from 'os';
import path from 'path';

export const pendingAgentImports = new Map<string, { dir: string; at: number }>();

export const IMPORT_TTL_MS = 15 * 60 * 1000;

export function sweepPendingImports(): void {
  for (const [k, v] of pendingAgentImports) {
    if (Date.now() - v.at > IMPORT_TTL_MS) {
      fs.rmSync(v.dir, { recursive: true, force: true });
      pendingAgentImports.delete(k);
    }
  }
}

export function spawnTar(args: string[]): ReturnType<typeof spawn> {
  return spawn('tar', args);
}

export async function spoolUploadToTmp(req: IncomingMessage): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `ncl-upload-${randomUUID()}.tgz`);
  await new Promise<void>((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 16 * 1024 * 1024 * 1024, files: 1 } });
    let got = false;
    bb.on('file', (_name, stream) => {
      got = true;
      const out = fs.createWriteStream(tmpFile);
      stream.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    bb.on('error', reject);
    bb.on('close', () => {
      if (!got) reject(new Error('No file in upload'));
    });
    req.pipe(bb);
  });
  return tmpFile;
}
