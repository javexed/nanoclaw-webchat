// ── Read-aloud queue ─────────────────────────────────────────────────────────
// Sentence-level playback for read aloud: a reply is split into sentences, the
// first is synthesized and starts playing while the next one is fetched, and
// replies that arrive while one is still speaking queue up behind it. Pure
// logic — the backend (server synthesis or the browser's Web Speech) is
// injected, so the state machine is unit-tested without audio.
//
// States: idle → loading (waiting on a clip) → playing → … → idle.
//         blocked: the browser refused to start audio without a user gesture
//         (iOS autoplay); the queue holds its place until resume().
// stop() is barge-in: in-flight synthesis is aborted, playback cut, the queue
// dropped. Nothing that was queued before a stop() can play after it.

/** Abbreviations whose trailing dot doesn't end a sentence (lowercase, no dot). */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'eg',
  'ie',
  'cf',
  'approx',
  'fig',
  'inc',
  'ltd',
]);
/** Fragments shorter than this ride along with the next sentence: one request
 *  per "OK." costs more in latency than it gains. */
export const MIN_CHUNK_CHARS = 24;
/** Longer sentences are cut at a clause boundary so the first audio starts soon. */
export const MAX_CHUNK_CHARS = 280;

/** Split speakable plain text into sentence-sized chunks, in order. */
export function splitSentences(text: string): string[] {
  const src = text.replace(/\s+/g, ' ').trim();
  if (!src) return [];
  const raw: string[] = [];
  let start = 0;
  // A terminator run (with closing quotes/brackets) followed by a space.
  const re = /[.!?…]+["'”’)\]]*(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const end = m.index + m[0].length;
    if (m[0] === '.') {
      const word = /([A-Za-z.]+)$/.exec(src.slice(start, m.index))?.[1] ?? '';
      const bare = word.replace(/\./g, '').toLowerCase();
      // "e.g." / "Dr." / a single initial ("J. Smith") don't end a sentence.
      if (ABBREVIATIONS.has(bare) || /^[A-Za-z]$/.test(bare) || word.includes('.')) continue;
    }
    raw.push(src.slice(start, end).trim());
    start = end;
  }
  if (start < src.length) raw.push(src.slice(start).trim());

  const out: string[] = [];
  let carry = '';
  for (const s of raw.filter(Boolean)) {
    const joined = carry ? `${carry} ${s}` : s;
    if (joined.length < MIN_CHUNK_CHARS) {
      carry = joined;
      continue;
    }
    carry = '';
    out.push(...splitLong(joined));
  }
  if (carry) {
    if (out.length && out[out.length - 1].length + carry.length < MAX_CHUNK_CHARS) out[out.length - 1] += ` ${carry}`;
    else out.push(carry);
  }
  return out;
}

/** Cut an over-long sentence at the last clause break (, ; :) before the limit,
 *  else the last space. */
function splitLong(s: string): string[] {
  const parts: string[] = [];
  let rest = s;
  while (rest.length > MAX_CHUNK_CHARS) {
    const window = rest.slice(0, MAX_CHUNK_CHARS);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    if (cut < MAX_CHUNK_CHARS / 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = MAX_CHUNK_CHARS - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export type ReadAloudPhase = 'loading' | 'playing' | 'blocked' | null;

export interface ReadAloudBackend<C> {
  /** Produce a playable clip. Rejects (or is aborted) on failure. */
  synth(text: string, signal: AbortSignal): Promise<C>;
  /** Play to the end. Resolves when finished or when `signal` aborts. Rejects
   *  with an error named 'NotAllowedError' when the browser wants a gesture. */
  play(clip: C, signal: AbortSignal): Promise<void>;
  /** Free a clip that will not be played again (object URLs). */
  release?(clip: C): void;
}

export interface ReadAloudState {
  key: string | number | null;
  phase: ReadAloudPhase;
}

interface Item<C> {
  key: string | number;
  text: string;
  clip?: Promise<C | null>;
}

export class ReadAloudQueue<C> {
  private items: Item<C>[] = [];
  private gen = 0;
  private pumping = -1; // gen of the running loop, -1 when none
  private ctl = new AbortController();
  private state: ReadAloudState = { key: null, phase: null };

  constructor(
    private backend: ReadAloudBackend<C>,
    private onChange: (s: ReadAloudState) => void = () => {},
    private onError: (err: unknown) => void = () => {},
  ) {}

  get current(): ReadAloudState {
    return this.state;
  }

  /** Sentences not yet finished, the playing one included. */
  get pending(): number {
    return this.items.length;
  }

  /** Read one message now, replacing whatever was playing or queued. */
  start(key: string | number, sentences: string[]): void {
    this.stop();
    this.enqueue(key, sentences);
  }

  /** Append a message's sentences behind anything already queued. */
  enqueue(key: string | number, sentences: string[]): void {
    const add = sentences.map((t) => t.trim()).filter(Boolean);
    if (!add.length) return;
    for (const text of add) this.items.push({ key, text });
    if (this.pumping !== this.gen) void this.pump(this.gen);
    // Already speaking: start fetching what plays next, as the loop would.
    else if (this.items[1]) void this.ensure(this.items[1]);
  }

  /** Barge-in: cut playback, abort synthesis, drop the queue. */
  stop(): void {
    this.gen++;
    this.ctl.abort();
    this.ctl = new AbortController();
    for (const it of this.items) this.discard(it);
    this.items = [];
    this.pumping = -1;
    this.set(null, null);
  }

  /** After a user gesture unlocked audio: carry on from the blocked sentence. */
  resume(): void {
    if (this.state.phase !== 'blocked') return;
    void this.pump(this.gen);
  }

  private set(key: string | number | null, phase: ReadAloudPhase): void {
    if (this.state.key === key && this.state.phase === phase) return;
    this.state = { key, phase };
    this.onChange(this.state);
  }

  private ensure(item: Item<C>): Promise<C | null> {
    if (!item.clip) {
      const signal = this.ctl.signal;
      item.clip = this.backend.synth(item.text, signal).catch((err) => {
        if (!signal.aborted) this.onError(err);
        return null;
      });
    }
    return item.clip;
  }

  private discard(item: Item<C>): void {
    const release = this.backend.release;
    if (item.clip && release) void item.clip.then((c) => c !== null && release(c));
  }

  private async pump(gen: number): Promise<void> {
    this.pumping = gen;
    const signal = this.ctl.signal;
    while (gen === this.gen && this.items.length) {
      const item = this.items[0];
      const clipP = this.ensure(item);
      // Prefetch one ahead: the next sentence synthesizes while this one plays.
      if (this.items[1]) void this.ensure(this.items[1]);
      this.set(item.key, 'loading');
      const clip = await clipP;
      if (gen !== this.gen) return;
      if (clip !== null) {
        this.set(item.key, 'playing');
        try {
          await this.backend.play(clip, signal);
        } catch (err) {
          if (gen !== this.gen) return;
          if ((err as { name?: string } | null)?.name === 'NotAllowedError') {
            // Autoplay refused: hold this sentence until resume().
            this.pumping = -1;
            this.set(item.key, 'blocked');
            return;
          }
          this.onError(err);
        }
        if (gen !== this.gen) return;
      }
      this.items.shift();
      if (clip !== null) this.backend.release?.(clip);
    }
    if (gen === this.gen) {
      this.pumping = -1;
      this.set(null, null);
    }
  }
}
