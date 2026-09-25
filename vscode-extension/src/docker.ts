// Thin docker CLI wrapper — the same two verbs the central driver's Cli has
// (`run` for short commands, `start` for long-lived ones), async because the
// extension host must never block.
import { execFile, spawn, type ChildProcess } from 'node:child_process';

export interface Cli {
  run(args: string[], opts?: { timeoutMs?: number; input?: string }): Promise<string>;
  /** Long-running command; resolves with the exit code, streams lines to `onLine`. */
  start(
    args: string[],
    onLine?: (line: string) => void,
  ): { done: Promise<number | null>; kill: () => void; write: (s: string) => void };
}

export function realCli(bin: string): Cli {
  return {
    run(args, opts) {
      return new Promise((resolve, reject) => {
        const child = execFile(
          bin,
          args,
          { timeout: opts?.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            if (err) {
              const e = err as Error & { stderr?: string };
              e.message = `${bin} ${args.slice(0, 2).join(' ')}: ${String(stderr || err.message)
                .trim()
                .slice(0, 400)}`;
              reject(e);
            } else resolve(String(stdout));
          },
        );
        if (opts?.input !== undefined) child.stdin?.end(opts.input);
      });
    },
    start(args, onLine) {
      const child: ChildProcess = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      // Lines can span chunks: a relay data frame of one 64 KiB TCP read is an
      // ~87 KiB JSON line, far larger than a pipe read. Splitting each chunk on
      // its own cut such frames in two and dropped both halves as noise — small
      // frames (pings, telemetry) fit in one chunk and hid the bug. Keep the
      // trailing partial line per stream and finish it with the next chunk.
      const lineReader = () => {
        let rest = '';
        return (chunk: Buffer) => {
          rest += chunk.toString();
          let i;
          while ((i = rest.indexOf('\n')) !== -1) {
            const line = rest.slice(0, i).replace(/\r$/, '');
            rest = rest.slice(i + 1);
            if (line.trim()) onLine?.(line);
          }
        };
      };
      const outReader = lineReader();
      const errReader = lineReader();
      child.stdout?.on('data', outReader);
      child.stderr?.on('data', errReader);
      const done = new Promise<number | null>((resolve) => {
        child.on('close', (code) => {
          // Deliver a final unterminated line (a diagnostic printed without a newline).
          outReader(Buffer.from('\n'));
          errReader(Buffer.from('\n'));
          resolve(code);
        });
        child.on('error', () => resolve(null));
      });
      // A write can race the child's death (a killed attach client, a dropped
      // podman connection): the pipe is gone before 'close' fires and the write
      // fails with EPIPE. That is a normal end of a pipe, not an exception the
      // extension host should see.
      child.stdin?.on('error', () => {});
      return {
        done,
        kill: () => child.kill(),
        write: (s: string) => {
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || !stdin.writable) return;
          try {
            stdin.write(s);
          } catch {
            // same race, synchronous form
          }
        },
      };
    },
  };
}

/** Map a docker error to the driver's failure taxonomy (mirrors normalizeDockerError). */
export function classifyDockerError(msg: string): { kind: string; retryable: boolean; detail?: string } {
  if (/manifest unknown|pull access denied|not found: manifest|No such image/i.test(msg))
    return { kind: 'image-unavailable', retryable: true };
  if (/Cannot connect to the Docker daemon|daemon is not running|pipe\/docker_engine|error during connect/i.test(msg))
    return { kind: 'runtime-unavailable', retryable: true };
  if (/no space left|cannot allocate memory/i.test(msg)) return { kind: 'resources-exhausted', retryable: true };
  return { kind: 'unknown', retryable: false, detail: msg.slice(0, 200) };
}
