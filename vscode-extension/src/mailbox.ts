// Helpers that run INSIDE a session's container, through the SQLite that ships
// with Bun in the agent image. That keeps proper database locking (the agent
// reads and writes the same files) and keeps a native database engine out of
// the extension.

/** Rows a dead container left claimed go back to pending. Run only while no agent is running against this file. */
export const REQUEUE_SCRIPT = `
const { Database } = require('bun:sqlite');
const fs = require('fs');
try {
  if (!fs.existsSync('/workspace/inbound.db')) { console.log(JSON.stringify({ requeued: 0 })); process.exit(0); }
  const db = new Database('/workspace/inbound.db');
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec('PRAGMA busy_timeout=5000');
  const r = db.prepare("UPDATE messages_in SET status='pending' WHERE status='processing'").run();
  console.log(JSON.stringify({ requeued: r.changes }));
} catch (e) {
  console.error('requeue failed: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
`;

/** Bun may print warnings before our payload; the result is the last JSON line. */
export function lastJsonLine(out: string): string {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));
  if (lines.length === 0) throw new Error(`mailbox helper produced no JSON: ${out.slice(0, 200)}`);
  return lines[lines.length - 1];
}
