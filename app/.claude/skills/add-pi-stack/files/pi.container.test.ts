import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';

import { registerProviderMessageObserver, type ProviderMessageEvent } from './hooks.js';
// A namespace import so the behavioural cases still run against a build that
// lacks one of the helpers.
import * as pi from './pi.js';
import type { ProviderEvent } from './types.js';

/**
 * A stand-in `pi` on PATH: records its argv, replays a fixture as its stdout,
 * and with FAKE_PI_HANG waits to be signalled, noting a SIGTERM (it writes
 * `<FAKE_PI_HANG>.ready` once its handler is installed).
 */
const FAKE_PI = `#!/usr/bin/env bun
const fs = require('fs');
if (process.env.FAKE_PI_ARGS) fs.appendFileSync(process.env.FAKE_PI_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_PI_ERR) process.stderr.write(process.env.FAKE_PI_ERR);
if (process.env.FAKE_PI_HANG) {
  process.on('SIGTERM', () => { fs.writeFileSync(process.env.FAKE_PI_HANG, 'TERM'); process.exit(143); });
  fs.writeFileSync(process.env.FAKE_PI_HANG + '.ready', '');
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(fs.readFileSync(process.env.FAKE_PI_OUT, 'utf8'));
}
`;

const root = mkdtempSync(path.join(tmpdir(), 'pi-provider-'));
const binDir = path.join(root, 'bin');
mkdirSync(binDir);
writeFileSync(path.join(binDir, 'pi'), FAKE_PI);
chmodSync(path.join(binDir, 'pi'), 0o755);

const savedEnv = { ...process.env };
let dir: string;
let argsFile: string;
let outFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(root, 'case-'));
  argsFile = path.join(dir, 'args.jsonl');
  outFile = path.join(dir, 'out.jsonl');
  process.env.PATH = `${binDir}:${savedEnv.PATH ?? ''}`;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_MODEL = 'test-model';
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_OUT = outFile;
  delete process.env.PI_TOOLS;
  delete process.env.PI_UNSERVABLE_MODEL;
  delete process.env.FAKE_PI_HANG;
  delete process.env.FAKE_PI_ERR;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(events: unknown[]): void {
  writeFileSync(outFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function messageEnd(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'message_end',
    message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [], stopReason: 'stop', ...extra },
  };
}

function thinkingDelta(delta: string): unknown {
  return { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta } };
}

function spawnedArgs(): string[][] {
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[]);
}

async function runOnce(provider: pi.PiProvider, prompt = 'hello'): Promise<ProviderEvent[]> {
  const q = provider.query({ prompt, cwd: dir, systemContext: { instructions: 'SYSTEM-INSTRUCTIONS' } });
  const events: ProviderEvent[] = [];
  for await (const ev of q.events) {
    events.push(ev);
    if (ev.type === 'result') q.end();
  }
  return events;
}

function resultOf(events: ProviderEvent[]): Extract<ProviderEvent, { type: 'result' }> {
  const r = events.filter((e) => e.type === 'result');
  expect(r).toHaveLength(1);
  return r[0] as Extract<ProviderEvent, { type: 'result' }>;
}

describe('pi provider — backend errors', () => {
  it('fails the turn when pi exits 0 with an errored assistant message, without the stall retry', async () => {
    fixture([
      thinkingDelta('I should answer this.'),
      messageEnd('', { stopReason: 'error', errorMessage: 'Connection error.' }),
    ]);
    const events = await runOnce(new pi.PiProvider());
    expect(events).toContainEqual({
      type: 'error',
      message: 'Connection error.',
      retryable: false,
      classification: 'network',
    });
    expect(resultOf(events).isError).toBe(true);
    expect(spawnedArgs()).toHaveLength(1);
  });

  it("treats a failure pi's own retry recovered from as success", async () => {
    fixture([
      messageEnd('', { stopReason: 'error', errorMessage: 'overloaded' }),
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: 'overloaded' },
      messageEnd('fine now'),
    ]);
    const events = await runOnce(new pi.PiProvider());
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(resultOf(events)).toEqual({ type: 'result', text: 'fine now' });
  });

  it('fails the turn when the retries are exhausted', async () => {
    fixture([
      messageEnd('', { stopReason: 'error', errorMessage: 'overloaded' }),
      { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'still overloaded' },
    ]);
    const events = await runOnce(new pi.PiProvider());
    expect(events).toContainEqual({ type: 'error', message: 'still overloaded', retryable: false });
    expect(resultOf(events).isError).toBe(true);
  });
});

describe('pi provider — reading the event stream', () => {
  it('keeps an event whose text contains U+2028 / U+2029 in one piece', async () => {
    const text = 'line one line two end';
    fixture([messageEnd(text)]);
    expect(resultOf(await runOnce(new pi.PiProvider())).text).toBe(text);
  });

  it('keeps an envelope written before a tool call when the turn ends with "Done."', async () => {
    const envelope = '<message to="room">the answer is 4</message>';
    fixture([messageEnd(envelope, { stopReason: 'toolUse' }), messageEnd('Done.')]);
    const text = resultOf(await runOnce(new pi.PiProvider())).text ?? '';
    expect(text).toContain(envelope);
    expect(text).toContain('Done.');
  });
});

describe('composeTurnText', () => {
  it('is the last message alone when no earlier one carried an envelope', () => {
    expect(pi.composeTurnText(['Let me check.', 'It is 4.'])).toBe('It is 4.');
  });

  it('carries an earlier envelope once, ahead of the last message', () => {
    const env = '<message to="room">hi</message>';
    expect(pi.composeTurnText([env, `noise ${env}`, 'Done.'])).toBe(`${env}\n\nDone.`);
  });

  it('does not carry an envelope the last message repeats', () => {
    const env = '<message to="room">hi</message>';
    expect(pi.composeTurnText([env, env])).toBe(env);
  });

  it('does not carry an envelope the message tool already sent', () => {
    const env = '<message to="room"> hi </message>';
    expect(pi.composeTurnText([env, 'Done.'], new Set(['room\u0000hi']))).toBe('Done.');
  });

  it('JsonLineSplitter splits on newline only and holds a partial line', () => {
    const s = new pi.JsonLineSplitter();
    expect(s.push('{"a":"x y"}\n{"b"')).toEqual(['{"a":"x y"}']);
    expect(s.push(':1}\n')).toEqual(['{"b":1}']);
    expect(s.push('tail')).toEqual([]);
    expect(s.flush()).toEqual(['tail']);
  });
});

describe('pi provider — memory', () => {
  const hook = { command: 'echo MEMORY-MARKER', legacyCommands: [], sources: ['startup', 'clear', 'compact'] as const };

  it('appends the memory hook output to the appended system prompt', async () => {
    fixture([messageEnd('ok')]);
    const provider = new pi.PiProvider();
    provider.registerMemorySessionHook(hook);
    await runOnce(provider);
    const args = spawnedArgs()[0];
    const system = args[args.indexOf('--append-system-prompt') + 1];
    expect(system).toContain('MEMORY-MARKER');
    expect(system).toContain('SYSTEM-INSTRUCTIONS');
  });

  it('leaves memory out of the replace-mode prompt', async () => {
    process.env.PI_TOOLS = 'none';
    fixture([messageEnd('ok')]);
    const provider = new pi.PiProvider();
    provider.registerMemorySessionHook(hook);
    await runOnce(provider);
    const args = spawnedArgs()[0];
    expect(args[args.indexOf('--system-prompt') + 1]).not.toContain('MEMORY-MARKER');
  });

  it('trims long memory with a note', async () => {
    const out = await pi.runPiMemoryHook({ ...hook, command: `printf '%0200d' 0` }, 50);
    expect(out?.startsWith('0'.repeat(50) + '\n')).toBe(true);
    expect(out).toContain('memory truncated to 50 characters');
  });

  it('runs the hook without blocking the event loop', async () => {
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 20);
    const out = await pi.runPiMemoryHook({ ...hook, command: 'sleep 0.3; echo SLOW' });
    expect(out).toBe('SLOW');
    expect(ticked).toBe(true);
  });

  it('a failing hook yields no memory', async () => {
    expect(await pi.runPiMemoryHook({ ...hook, command: 'exit 3' })).toBeUndefined();
  });
});

describe('pi provider — stopping', () => {
  it('sends SIGTERM first on abort, so pi can clean up', async () => {
    const marker = path.join(dir, 'term');
    process.env.FAKE_PI_HANG = marker;
    process.env.PI_STOP_GRACE_MS = '3000';
    const q = new pi.PiProvider().query({ prompt: 'hello', cwd: dir });
    const drained = (async () => {
      try {
        for await (const _ of q.events) void _;
      } catch {
        /* the aborted turn rejects */
      }
    })();
    for (let i = 0; i < 250 && !existsSync(`${marker}.ready`); i++) await Bun.sleep(20);
    q.abort();
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(20);
    expect(existsSync(marker) ? readFileSync(marker, 'utf-8') : null).toBe('TERM');
    await drained;
  });

  it('SIGKILLs a pi that ignores SIGTERM after the grace, and resolves once it has exited', async () => {
    process.env.PI_STOP_GRACE_MS = '100';
    const ready = path.join(dir, 'ready');
    const child = spawn(
      'bun',
      [
        '-e',
        `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000);`,
      ],
      { stdio: 'ignore', detached: true },
    );
    for (let i = 0; i < 250 && !existsSync(ready); i++) await Bun.sleep(20);
    const started = Date.now();
    await pi.stopProcessTree(child);
    expect(child.signalCode).toBe('SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});

describe('pi provider — unservable model', () => {
  it('fails the turn with a clear message and never spawns pi', async () => {
    process.env.PI_UNSERVABLE_MODEL = 'GPT-4o';
    fixture([messageEnd('should not run')]);
    const r = resultOf(await runOnce(new pi.PiProvider()));
    expect(r.isError).toBe(true);
    expect(r.error).toContain('GPT-4o');
    expect(r.error).toContain('local model');
    expect(spawnedArgs()).toHaveLength(0);
  });
});

describe('pi provider — reasoning detail', () => {
  it('sends the full thinking block as detail on thinking_end', async () => {
    const seen: ProviderMessageEvent[] = [];
    registerProviderMessageObserver((ev) => seen.push(ev));
    const full = 'First I add the numbers. Then I check';
    fixture([
      thinkingDelta('First I add the numbers. '),
      thinkingDelta('Then I check'),
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: full } },
      messageEnd('4'),
    ]);
    await runOnce(new pi.PiProvider());
    const withDetail = seen.filter((e) => e.kind === 'reasoning' && (e as { detail?: string }).detail === full);
    expect(withDetail).toHaveLength(1);
  });
});

describe('pi provider — images', () => {
  function writeModels(input: string[]): void {
    writeFileSync(
      path.join(dir, 'models.json'),
      JSON.stringify({ providers: { ollama: { models: [{ id: 'test-model', input }] } } }),
    );
  }

  it('passes an attached image as @path for a vision model', async () => {
    writeModels(['text', 'image']);
    const img = path.join(dir, 'cat.png');
    writeFileSync(img, 'png-bytes');
    fixture([messageEnd('a cat')]);
    const prompt = `<message from="room">look\n[image: cat.png — saved to ${img}]</message>`;
    await runOnce(new pi.PiProvider(), prompt);
    const args = spawnedArgs()[0];
    expect(args.slice(-2)).toEqual([`@${img}`, prompt]);
  });

  it('passes nothing for a text-only model, or for a file that is not there', () => {
    writeModels(['text']);
    const img = path.join(dir, 'cat.png');
    writeFileSync(img, 'png-bytes');
    expect(pi.imageFileArgs(`[image: cat.png — saved to ${img}]`, dir)).toEqual([]);
    writeModels(['text', 'image']);
    expect(pi.imageFileArgs(`[image: gone.png — saved to ${path.join(dir, 'gone.png')}]`, dir)).toEqual([]);
  });
});

describe('pi provider — stderr', () => {
  it('forwards pi stderr lines to the runner log', async () => {
    process.env.FAKE_PI_ERR = 'provider warning one\n';
    fixture([messageEnd('ok')]);
    const spy = spyOn(console, 'error');
    try {
      await runOnce(new pi.PiProvider());
      expect(spy.mock.calls.some((c) => c[0] === '[pi] provider warning one')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
