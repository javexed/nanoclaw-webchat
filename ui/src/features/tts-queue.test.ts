import { describe, expect, it } from 'vitest';

import {
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  ReadAloudQueue,
  splitSentences,
  type ReadAloudBackend,
  type ReadAloudState,
} from './tts-queue.js';

describe('splitSentences', () => {
  it('splits on sentence ends, keeping the punctuation', () => {
    expect(
      splitSentences('The build passed on the first try. Deploying it to staging now! Want me to tag a release?'),
    ).toEqual(['The build passed on the first try.', 'Deploying it to staging now!', 'Want me to tag a release?']);
  });

  it('is empty for blank input and passes a single sentence through', () => {
    expect(splitSentences('   ')).toEqual([]);
    expect(splitSentences('no terminator at all')).toEqual(['no terminator at all']);
  });

  it('does not split on abbreviations, initials, decimals or dotted words', () => {
    expect(
      splitSentences(
        'Ask Dr. Smith about the e.g. clause in version 2.5 of the contract. J. Doe signed it on behalf of the team.',
      ),
    ).toEqual([
      'Ask Dr. Smith about the e.g. clause in version 2.5 of the contract.',
      'J. Doe signed it on behalf of the team.',
    ]);
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(splitSentences('He said "ship the fix today." (It was already merged.) Then he left the office.')).toEqual([
      'He said "ship the fix today."',
      '(It was already merged.)',
      'Then he left the office.',
    ]);
  });

  it('folds short fragments into the next sentence', () => {
    const out = splitSentences('OK. Sure. The migration ran cleanly against production.');
    expect(out).toEqual(['OK. Sure. The migration ran cleanly against production.']);
  });

  it('folds a short trailing fragment into the previous chunk', () => {
    const out = splitSentences('The migration ran cleanly against production. Done.');
    expect(out).toEqual(['The migration ran cleanly against production. Done.']);
    expect(MIN_CHUNK_CHARS).toBeGreaterThan('Done.'.length);
  });

  it('cuts an over-long sentence at a clause break, never past the limit', () => {
    const clause = 'this clause is part of a very long sentence without any full stop';
    const long = Array.from({ length: 10 }, () => clause).join(', ') + '.';
    const out = splitSentences(long);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe(long);
    expect(out[0].endsWith(',')).toBe(true);
  });

  it('collapses whitespace and newlines', () => {
    expect(splitSentences('First line of the reply here.\n\n  Second line of the reply here.')).toEqual([
      'First line of the reply here.',
      'Second line of the reply here.',
    ]);
  });
});

// ── Queue state machine ──────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A backend whose every synth and play is resolved by hand. */
function fakeBackend() {
  const synths: Array<{ text: string; signal: AbortSignal; d: Deferred<string> }> = [];
  const plays: Array<{ clip: string; signal: AbortSignal; d: Deferred<void> }> = [];
  const released: string[] = [];
  const backend: ReadAloudBackend<string> = {
    synth(text, signal) {
      const d = deferred<string>();
      signal.addEventListener('abort', () => d.reject(new Error('aborted')));
      synths.push({ text, signal, d });
      return d.promise;
    },
    play(clip, signal) {
      const d = deferred<void>();
      signal.addEventListener('abort', () => d.resolve());
      plays.push({ clip, signal, d });
      return d.promise;
    },
    release(clip) {
      released.push(clip);
    },
  };
  return { backend, synths, plays, released };
}
function makeQueue() {
  const fb = fakeBackend();
  const states: ReadAloudState[] = [];
  const errors: unknown[] = [];
  const q = new ReadAloudQueue(
    fb.backend,
    (s) => states.push(s),
    (e) => errors.push(e),
  );
  return { q, states, errors, ...fb };
}

describe('ReadAloudQueue', () => {
  it('plays sentences in order, prefetching the next while one plays', async () => {
    const { q, synths, plays, released, states } = makeQueue();
    q.start('m1', ['one', 'two', 'three']);
    expect(synths.map((s) => s.text)).toEqual(['one', 'two']); // head + one ahead
    expect(q.current).toEqual({ key: 'm1', phase: 'loading' });

    synths[0].d.resolve('clip1');
    await tick();
    expect(q.current.phase).toBe('playing');
    expect(plays.map((p) => p.clip)).toEqual(['clip1']);

    synths[1].d.resolve('clip2');
    plays[0].d.resolve();
    await tick();
    expect(plays.map((p) => p.clip)).toEqual(['clip1', 'clip2']);
    expect(synths.map((s) => s.text)).toEqual(['one', 'two', 'three']);
    expect(released).toEqual(['clip1']);

    synths[2].d.resolve('clip3');
    plays[1].d.resolve();
    await tick();
    plays[2].d.resolve();
    await tick();
    expect(q.current).toEqual({ key: null, phase: null });
    expect(q.pending).toBe(0);
    expect(released).toEqual(['clip1', 'clip2', 'clip3']);
    expect(states.at(-1)).toEqual({ key: null, phase: null });
  });

  it('enqueue appends a later reply behind the one speaking (auto-read)', async () => {
    const { q, synths, plays } = makeQueue();
    q.enqueue('m1', ['a']);
    synths[0].d.resolve('A');
    await tick();
    q.enqueue('m2', ['b']);
    expect(q.pending).toBe(2);
    expect(plays).toHaveLength(1); // m2 waits…
    expect(synths.map((s) => s.text)).toEqual(['a', 'b']); // …but is already synthesizing
    synths[1].d.resolve('B');
    plays[0].d.resolve();
    await tick();
    expect(q.current).toEqual({ key: 'm2', phase: 'playing' });
    expect(plays.map((p) => p.clip)).toEqual(['A', 'B']);
  });

  it('stop() is barge-in: aborts playback and synthesis, drops the queue', async () => {
    const { q, synths, plays, released } = makeQueue();
    q.start('m1', ['one', 'two', 'three']);
    synths[0].d.resolve('clip1');
    synths[1].d.resolve('clip2');
    await tick();
    expect(q.current.phase).toBe('playing');

    q.stop();
    expect(q.current).toEqual({ key: null, phase: null });
    expect(q.pending).toBe(0);
    expect(plays[0].signal.aborted).toBe(true);
    expect(synths[0].signal.aborted).toBe(true);
    await tick();
    expect(plays).toHaveLength(1); // nothing after the stop plays
    expect(released.sort()).toEqual(['clip1', 'clip2']);
  });

  it('a clip that finishes synthesizing after stop() never plays', async () => {
    const backend: ReadAloudBackend<string> = {
      synth: (t) => new Promise((r) => setTimeout(() => r(t), 5)), // ignores abort
      play: () => {
        throw new Error('must not play');
      },
    };
    const q = new ReadAloudQueue(backend);
    q.start('m1', ['late']);
    q.stop();
    await new Promise((r) => setTimeout(r, 15));
    expect(q.current).toEqual({ key: null, phase: null });
  });

  it('start() supersedes: the old message stops, the new one plays', async () => {
    const { q, synths, plays } = makeQueue();
    q.start('m1', ['old']);
    synths[0].d.resolve('OLD');
    await tick();
    q.start('m2', ['new']);
    expect(plays[0].signal.aborted).toBe(true);
    expect(q.current).toEqual({ key: 'm2', phase: 'loading' });
    synths[1].d.resolve('NEW');
    await tick();
    expect(plays.map((p) => p.clip)).toEqual(['OLD', 'NEW']);
    expect(q.current).toEqual({ key: 'm2', phase: 'playing' });
  });

  it('a failed sentence is reported and skipped, the rest still play', async () => {
    const { q, synths, plays, errors } = makeQueue();
    q.start('m1', ['bad', 'good']);
    synths[0].d.reject(new Error('tts 500'));
    synths[1].d.resolve('GOOD');
    await tick();
    expect(errors).toHaveLength(1);
    expect(plays.map((p) => p.clip)).toEqual(['GOOD']);
  });

  it('aborted synthesis is not reported as an error', async () => {
    const { q, errors } = makeQueue();
    q.start('m1', ['one', 'two']);
    q.stop();
    await tick();
    expect(errors).toEqual([]);
  });

  it('holds on an autoplay refusal and resumes after a gesture', async () => {
    const { q, synths, plays } = makeQueue();
    q.enqueue('m1', ['one', 'two']);
    synths[0].d.resolve('clip1');
    await tick();
    plays[0].d.reject(Object.assign(new Error('gesture needed'), { name: 'NotAllowedError' }));
    await tick();
    expect(q.current).toEqual({ key: 'm1', phase: 'blocked' });
    expect(q.pending).toBe(2);

    q.resume();
    await tick();
    expect(plays.map((p) => p.clip)).toEqual(['clip1', 'clip1']); // same sentence, same clip
    expect(q.current.phase).toBe('playing');
  });

  it('resume() does nothing unless blocked; stop() clears a blocked queue', async () => {
    const { q, synths, plays } = makeQueue();
    q.resume();
    expect(synths).toHaveLength(0);
    q.enqueue('m1', ['one']);
    synths[0].d.resolve('clip1');
    await tick();
    plays[0].d.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    await tick();
    q.stop();
    q.resume();
    await tick();
    expect(plays).toHaveLength(1);
    expect(q.current).toEqual({ key: null, phase: null });
  });

  it('ignores empty sentences', () => {
    const { q, synths } = makeQueue();
    q.enqueue('m1', ['', '  ']);
    expect(synths).toHaveLength(0);
    expect(q.current).toEqual({ key: null, phase: null });
  });
});
