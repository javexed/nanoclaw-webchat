// What the agents did on this machine, kept on this machine: one JSON object
// per line in the extension's global storage, rotated at 1 MB with three files
// kept (activity.jsonl, .1, .2). Recording never throws: a full disk costs the
// log, never the action being logged.
//
// recordActivity() is the one entry point; anything in the extension may call
// it once initActivityLog() ran at activation (before that it is a no-op).
import fs from 'node:fs';
import path from 'node:path';

export const ACTIVITY_FILE = 'activity.jsonl';
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_FILES = 3;

export class ActivityLog {
  readonly file: string;
  constructor(
    readonly dir: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly files = DEFAULT_FILES,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(dir, ACTIVITY_FILE);
  }

  append(event: string, fields: Record<string, unknown> = {}): void {
    try {
      const line = `${JSON.stringify({ t: this.now().toISOString(), event, ...fields })}\n`;
      fs.mkdirSync(this.dir, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      /* the log is best effort */
    }
  }

  /** activity.jsonl → .1 → .2 …; the oldest falls off. */
  private rotate(): void {
    const name = (i: number) => (i === 0 ? this.file : `${this.file}.${i}`);
    fs.rmSync(name(this.files - 1), { force: true });
    for (let i = this.files - 2; i >= 0; i--) {
      if (fs.existsSync(name(i))) fs.renameSync(name(i), name(i + 1));
    }
  }
}

let active: ActivityLog | null = null;

export function initActivityLog(dir: string): ActivityLog {
  active = new ActivityLog(dir);
  return active;
}

/**
 * Record one thing that happened, e.g. `recordActivity('proposal.apply', { file })`.
 * Events in use: session.start, session.stop, proposal.apply, proposal.reject,
 * review, change.keep, change.revert, stop-all.
 */
export function recordActivity(event: string, fields: Record<string, unknown> = {}): void {
  active?.append(event, fields);
}

/** The current log file, or null before activation. */
export function activityLogFile(): string | null {
  return active?.file ?? null;
}
