/**
 * Global vitest setup.
 *
 * Audit redirection: src/audit.ts appends security events to
 * logs/audit.jsonl under cwd, and the suite EXERCISES the seams that emit —
 * every guard consult and every server-boot auth would otherwise write real
 * audit lines into the working tree on every test run. Point the file into
 * os.tmpdir() for the whole run instead; individual tests that assert on
 * audit output stub NANOCLAW_AUDIT_FILE over this and restore it after.
 *
 * Cleanup uses vitest's afterAll, NOT process.on('exit') — the first version
 * used the exit hook and leaked one file per worker, because the fork pool
 * tears workers down without running exit handlers. afterAll fires after
 * every test file, so the last one out removes the worker's file. This suite
 * just had a 43k-dir tmpdir purge; the setup file must not seed the next one.
 */
import { afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const auditFile = path.join(os.tmpdir(), `nanoclaw-test-audit-${process.pid}.jsonl`);
process.env.NANOCLAW_AUDIT_FILE = process.env.NANOCLAW_AUDIT_FILE || auditFile;

afterAll(() => {
  try {
    fs.rmSync(auditFile, { force: true });
  } catch {
    /* best-effort */
  }
});
