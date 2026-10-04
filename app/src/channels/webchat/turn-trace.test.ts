/**
 * The turn record built from status events: what it keeps, how tool time is
 * derived, and the size cap that must hold whatever a turn emits.
 */
import { describe, expect, it } from 'vitest';

import { endpointHost, fitTrace, TraceBuilder, TRACE_MAX_BYTES, TRUNCATED_MARK } from './turn-trace.js';

const meta = { agent: 'AG', harness: 'pi', model: 'example-model:4b', host: 'models.example:11434' };

describe('TraceBuilder', () => {
  it('keeps full reasoning blocks when the provider sends them, like the live bubble', () => {
    const b = new TraceBuilder(meta, 1000);
    b.add({ kind: 'reasoning', text: 'first line', detail: 'first line\nsecond line\nthird', at: 1100 });
    b.add({ kind: 'reasoning', text: 'second line', detail: null, at: 1101 });
    expect(b.build().reasoning).toEqual(['first line\nsecond line\nthird']);
  });

  it('falls back to the feed lines when no block ever arrives', () => {
    const b = new TraceBuilder(meta, 1000);
    b.add({ kind: 'reasoning', text: 'a', detail: null, at: 1100 });
    b.add({ kind: 'reasoning', text: 'b', detail: null, at: 1200 });
    expect(b.build().reasoning).toEqual(['a', 'b']);
  });

  it('times each tool until the next event and the turn until done', () => {
    const b = new TraceBuilder(meta, 1000);
    b.add({ kind: 'tool', text: 'Read', detail: 'src/a.ts', at: 1100 });
    b.add({ kind: 'tool', text: 'Bash', detail: 'ls', at: 1350 });
    b.add({ kind: 'progress', text: 'Task notification', detail: null, at: 1400 });
    b.end('done', 2000);
    const t = b.build();
    expect(t.tools.map((x) => [x.name, x.target, x.ms, x.ok])).toEqual([
      ['Read', 'src/a.ts', 250, null],
      ['Bash', 'ls', 50, null],
    ]);
    expect(t.notes).toEqual([{ kind: 'progress', text: 'Task notification', at: 1400 }]);
    expect(t).toMatchObject({ ...meta, startedAt: 1000, endedAt: 2000, durationMs: 1000, outcome: 'done' });
  });

  it('a failure notice marks the turn as an error and survives the done after it', () => {
    const b = new TraceBuilder(meta, 1000);
    b.error('Model not found', 1500);
    b.end('done', 1600);
    expect(b.build()).toMatchObject({ outcome: 'error', notes: [{ kind: 'error', text: 'Model not found' }] });
  });

  it('a stall closes the open tool and says so', () => {
    const b = new TraceBuilder(meta, 1000);
    b.add({ kind: 'tool', text: 'Bash', detail: 'sleep 999', at: 1100 });
    b.end('stalled', 9100);
    const t = b.build();
    expect(t.outcome).toBe('stalled');
    expect(t.tools[0]!.ms).toBe(8000);
    expect(t.notes.map((n) => n.kind)).toEqual(['stalled']);
  });
});

describe('fitTrace', () => {
  it('leaves a small trace untouched', () => {
    const t = new TraceBuilder(meta, 1).build();
    t.reasoning = ['short'];
    expect(JSON.parse(fitTrace(t))).toMatchObject({ reasoning: ['short'], truncated: false });
  });

  it('caps a huge turn under the limit, cutting reasoning first and marking the cut', () => {
    const b = new TraceBuilder(meta, 0);
    for (let i = 0; i < 40; i++)
      b.add({ kind: 'reasoning', text: 'x', detail: `block ${i} ` + 'é'.repeat(20_000), at: i });
    for (let i = 0; i < 50; i++) b.add({ kind: 'tool', text: 'Read', detail: `f${i}.ts`, at: 100 + i });
    const t = b.build();
    const json = fitTrace(t);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    const back = JSON.parse(json);
    expect(back.truncated).toBe(true);
    expect(back.reasoning[0]).toMatch(/^block 0 /);
    expect(back.reasoning[back.reasoning.length - 1].endsWith(TRUNCATED_MARK)).toBe(true);
    expect(back.tools).toHaveLength(50); // tools kept while reasoning could still be cut
  });

  it('still fits when tools alone overflow', () => {
    const b = new TraceBuilder(meta, 0);
    for (let i = 0; i < 300; i++) b.add({ kind: 'tool', text: 'Bash', detail: 'y'.repeat(299) + i, at: i });
    const json = fitTrace(b.build(), 20_000);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(20_000);
    expect(JSON.parse(json).truncated).toBe(true);
  });
});

describe('endpointHost', () => {
  it('keeps host and port, never credentials or path', () => {
    expect(endpointHost('http://user:pw@models.example:11434/v1')).toBe('models.example:11434');
    expect(endpointHost('https://api.example.com/v1/chat')).toBe('api.example.com');
    expect(endpointHost(null)).toBeNull();
    expect(endpointHost('not a url')).toBeNull();
  });
});
