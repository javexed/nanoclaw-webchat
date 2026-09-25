/**
 * The exec-stream reader must reassemble lines that arrive split across
 * chunks. A relay data frame is an ~87 KiB JSON line; pipe reads are smaller,
 * so without carry-over both halves were dropped as noise — which cut every
 * large tunnelled transfer (an inference body) while pings sailed through.
 */
import { describe, expect, it } from 'vitest';

import { realCli } from './docker.js';

describe('Cli.start line reader', () => {
  it('reassembles a line split across chunks and delivers each line exactly once', async () => {
    const cli = realCli(process.execPath);
    // Built inside the child (an argv literal this large hits E2BIG); far larger than any single pipe read.
    const script = `
      const big = 'x'.repeat(200000);
      process.stdout.write('{"t":"a"}\\n');
      process.stdout.write('{"t":"b","b64":"' + big.slice(0, 120000));
      setTimeout(() => {
        process.stdout.write(big.slice(120000) + '"}\\n{"t":"c"}\\n');
        setTimeout(() => process.stdout.write('{"t":"tail-no-newline"}'), 20);
      }, 30);
    `;
    const lines: string[] = [];
    const proc = cli.start(['-e', script], (l) => lines.push(l));
    await proc.done;
    const parsed = lines.map((l) => JSON.parse(l) as { t: string; b64?: string });
    expect(parsed.map((p) => p.t)).toEqual(['a', 'b', 'c', 'tail-no-newline']);
    expect(parsed[1].b64).toHaveLength(200_000);
  });

  it('a write after the child died is dropped quietly, never an uncaught EPIPE', async () => {
    const cli = realCli(process.execPath);
    const proc = cli.start(['-e', 'process.exit(0)'], () => {});
    expect(await proc.done).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(() => proc.write('{"t":"late"}\n')).not.toThrow();
    // and no 'error' escapes as an unhandled event on the next tick
    await new Promise((r) => setTimeout(r, 20));
  });
});
