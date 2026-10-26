/**
 * Silence-hallucination filter: the phrase list, the audio gate, and the
 * boundaries that keep real speech intact.
 */
import { describe, it, expect } from 'vitest';

import {
  HALLUCINATION_PHRASES,
  MIN_VOICED_MS,
  SHORT_CLIP_MS,
  filterHallucination,
  isKnownHallucination,
  normalizeTranscript,
  wavStats,
} from './stt-hallucination.js';

/** 16 kHz mono PCM16 WAV: `voicedMs` of a loud tone, then `silentMs` of zeros. */
function wav(voicedMs: number, silentMs: number, amplitude = 0.3): Buffer {
  const rate = 16000;
  const voiced = Math.round((rate * voicedMs) / 1000);
  const samples = voiced + Math.round((rate * silentMs) / 1000);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < voiced; i++) {
    buf.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude * 0x7fff), 44 + i * 2);
  }
  return buf;
}

const SILENT = { durationMs: 3000, voicedMs: 0 };
const SPOKEN = { durationMs: 2000, voicedMs: 900 };

describe('normalizeTranscript', () => {
  it('ignores case, punctuation and spacing; joins apostrophes and dots', () => {
    expect(normalizeTranscript('  Thanks for WATCHING!! ')).toBe('thanks for watching');
    expect(normalizeTranscript("Don't forget to like, and subscribe.")).toBe('dont forget to like and subscribe');
    expect(normalizeTranscript('Subtitles by the Amara.org community')).toBe('subtitles by the amaraorg community');
  });
});

describe('isKnownHallucination', () => {
  it.each([
    'Thank you.',
    'thank you',
    'THANK YOU!',
    'Thanks for watching!',
    'you',
    'You.',
    'Thank you. Thank you.',
    'you you you',
    'Subtitles by the Amara.org community',
    'Please like and subscribe!',
  ])('flags %j', (t) => expect(isKnownHallucination(t)).toBe(true));

  it.each([
    'Thank you for the review',
    'you should check the logs',
    'Thanks, that fixed it.',
    'Thank you. Now restart the service.',
    'watching the build',
    '',
  ])('keeps %j', (t) => expect(isKnownHallucination(t)).toBe(false));

  it('every listed phrase is already in normalized form', () => {
    for (const p of HALLUCINATION_PHRASES) expect(normalizeTranscript(p)).toBe(p);
  });
});

describe('filterHallucination', () => {
  it('drops standalone non-speech markers whatever the audio', () => {
    for (const t of ['[BLANK_AUDIO]', '(silence)', '[Music]', '*music*', '♪', '♪♪ ♪', '[ Silence ] (wind)']) {
      expect(filterHallucination(t, SPOKEN)).toBe('');
      expect(filterHallucination(t, null)).toBe('');
    }
  });

  it('keeps a marker that sits inside real words', () => {
    expect(filterHallucination('ship it [laughs]', SILENT)).toBe('ship it [laughs]');
  });

  it('drops a listed phrase on a near-silent clip', () => {
    expect(filterHallucination('Thank you.', SILENT)).toBe('');
    expect(filterHallucination('Thanks for watching!', { durationMs: 5000, voicedMs: 40 })).toBe('');
  });

  it('keeps a listed phrase the user actually said', () => {
    expect(filterHallucination('Thank you.', SPOKEN)).toBe('Thank you.');
  });

  it('never strips words from longer real speech, even on a quiet clip', () => {
    expect(filterHallucination('Thank you for the review', SILENT)).toBe('Thank you for the review');
  });

  it('keeps everything when the clip could not be measured', () => {
    expect(filterHallucination('Thank you.', null)).toBe('Thank you.');
  });

  it('gates on the voiced and duration boundaries', () => {
    const long = SHORT_CLIP_MS + 500;
    expect(filterHallucination('you', { durationMs: long, voicedMs: MIN_VOICED_MS - 20 })).toBe('');
    expect(filterHallucination('you', { durationMs: long, voicedMs: MIN_VOICED_MS })).toBe('you');
    expect(filterHallucination('you', { durationMs: SHORT_CLIP_MS - 1, voicedMs: 800 })).toBe('');
    expect(filterHallucination('you', { durationMs: SHORT_CLIP_MS, voicedMs: 800 })).toBe('you');
  });

  it('returns trimmed text and maps blank to empty', () => {
    expect(filterHallucination('  hello  ', SILENT)).toBe('hello');
    expect(filterHallucination('   ', SPOKEN)).toBe('');
  });
});

describe('wavStats', () => {
  it('measures duration and voiced time of a PCM16 mono WAV', () => {
    const s = wavStats(wav(600, 1400))!;
    expect(s.durationMs).toBeCloseTo(2000, 0);
    expect(s.voicedMs).toBeGreaterThanOrEqual(580);
    expect(s.voicedMs).toBeLessThanOrEqual(620);
  });

  it('counts quiet noise below the speech floor as unvoiced', () => {
    expect(wavStats(wav(2000, 0, 0.005))!.voicedMs).toBe(0);
  });

  it('returns null for anything that is not PCM16 mono WAV', () => {
    expect(wavStats(Buffer.alloc(4096, 1))).toBeNull();
    const stereo = wav(100, 100);
    stereo.writeUInt16LE(2, 22);
    expect(wavStats(stereo)).toBeNull();
  });

  it('feeds the filter end to end', () => {
    expect(filterHallucination('Thank you.', wavStats(wav(40, 2500)))).toBe('');
    expect(filterHallucination('Thank you.', wavStats(wav(700, 800)))).toBe('Thank you.');
  });
});
