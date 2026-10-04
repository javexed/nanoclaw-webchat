// The runner's own log, kept beside its session: /workspace is the session
// folder on central (data/v2-sessions/<group>/<session>), so the file outlives
// the container. Without it a container's output is gone once the container
// is removed, and the host keeps only a crash's last lines: a turn that ended
// early left no trace of why. Everything a module logs (console.* and direct
// stderr writes) is copied, line by line with a timestamp, capped at 5 MB with
// one older file kept.
import fs from 'fs';
import path from 'path';
import { format } from 'util';

const MAX_BYTES = 5 * 1024 * 1024;

/** Copy console output and stderr writes into `file`. Returns an uninstaller. */
export function installRunnerLog(file: string): () => void {
  let size = 0;
  let off = false;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* not there yet */
  }

  function keep(text: string): void {
    if (off) return;
    try {
      const stamp = new Date().toISOString();
      const lines = text
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => `${stamp} ${l}\n`)
        .join('');
      if (!lines) return;
      const bytes = Buffer.byteLength(lines);
      if (size + bytes > MAX_BYTES) {
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // Already gone (removed or rotated elsewhere): the append recreates it.
        }
        size = 0;
      }
      fs.appendFileSync(file, lines);
      size += bytes;
    } catch {
      // No session folder (tests, a dev run): stop trying, never break logging.
      if (!fs.existsSync(path.dirname(file))) off = true;
    }
  }

  // Bun writes console output to the fd directly, Node routes it through
  // process.stderr.write: `inConsole` keeps the Node path from copying it twice.
  let inConsole = false;
  const stderrWrite = process.stderr.write;
  const write = stderrWrite.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!inConsole) keep(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;

  const methods = ['error', 'warn', 'log', 'info'] as const;
  const originals = methods.map((m) => console[m]);
  methods.forEach((m, i) => {
    const original = originals[i]!;
    console[m] = (...args: unknown[]) => {
      if (inConsole) return original.apply(console, args);
      inConsole = true;
      try {
        keep(format(...args));
        original.apply(console, args);
      } finally {
        inConsole = false;
      }
    };
  });

  return () => {
    process.stderr.write = stderrWrite;
    methods.forEach((m, i) => (console[m] = originals[i]!));
  };
}

if (!process.env.NANOCLAW_RUNNER_LOG_OFF) {
  installRunnerLog(process.env.NANOCLAW_RUNNER_LOG || '/workspace/.agent-runner.log');
}
