/**
 * Silence hallucinations — whisper-family models, given silence or room noise,
 * emit text they learned from subtitled video: "Thank you.", "Thanks for
 * watching!", "you", "[BLANK_AUDIO]", subtitle credits. Dictation would paste
 * those into the composer as if the user said them.
 *
 * Two kinds of output are dropped:
 *   - a non-speech marker on its own ("[BLANK_AUDIO]", "(silence)", "[Music]",
 *     "♪") — never something a person dictates, so it goes regardless of audio;
 *   - a transcript that is EXACTLY one of the known phrases (or a repeat of
 *     them), compared case- and punctuation-insensitively — but only when the
 *     clip itself was short or barely voiced. A real "thank you" has a
 *     voiced span behind it and is kept.
 * Words are never stripped out of a longer transcript: "thank you for the
 * review" is real speech and passes untouched.
 */

/** Normalized (lowercase, no punctuation, single spaces) phrases whisper emits on silence. */
export const HALLUCINATION_PHRASES: ReadonlySet<string> = new Set([
  'you',
  'thank you',
  'thank you very much',
  'thank you so much',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'thanks for watching and see you next time',
  'thank you for watching and see you next time',
  'please subscribe',
  'subscribe',
  'like and subscribe',
  'please like and subscribe',
  'dont forget to like and subscribe',
  'see you next time',
  'see you in the next video',
  'bye',
  'bye bye',
  'okay',
  'so',
  'oh',
  'um',
  'uh',
  'hmm',
  'the end',
  'subtitles by the amaraorg community',
  'subtitles by amaraorg',
  'transcription by castingwords',
  'transcribed by esoteric',
  'translated by',
  'subtitles by',
  'captions by',
]);

/** Bracketed/asterisked tags or music glyphs with nothing else around them. */
const NON_SPEECH_ONLY = /^(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+)\s*)+$/u;

/** Lowercase, drop punctuation (apostrophes and dots join — "don't" → "dont",
 *  "amara.org" → "amaraorg"), collapse whitespace. */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when every sentence of the transcript is a known silence phrase —
 *  "Thank you. Thank you." and "you you you" included, since whisper loops. */
export function isKnownHallucination(text: string): boolean {
  const parts = text
    .split(/[.!?…。]+(?=\s|$)/u)
    .map((p) => normalizeTranscript(p).replace(/\b(\w+)(?: \1\b)+/g, '$1'))
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => HALLUCINATION_PHRASES.has(p));
}

export interface ClipStats {
  durationMs: number;
  /** Total time across 20 ms windows whose RMS clears the speech floor. */
  voicedMs: number;
}

/** Same floor the PWA's recorder uses to tell speech frames from silence. */
export const SPEECH_RMS_FLOOR = 0.012;
const WINDOW_MS = 20;
/** A clip shorter than this is too brief to have carried a real sentence. */
export const SHORT_CLIP_MS = 1000;
/** Less voiced audio than this is a breath, a click, or room noise. */
export const MIN_VOICED_MS = 300;

/**
 * Duration + voiced time of a PCM16 mono WAV (what the PWA uploads). Returns
 * null for anything else — the caller then keeps the transcript, since without
 * stats it can't tell a hallucination from a real short reply.
 */
export function wavStats(wav: Buffer): ClipStats | null {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= wav.length) {
      if (wav.readUInt16LE(body) !== 1) return null; // not integer PCM
      channels = wav.readUInt16LE(body + 2);
      rate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (!rate || channels !== 1 || bits !== 16) return null;
      const end = Math.min(wav.length, body + size);
      const samples = Math.floor((end - body) / 2);
      const win = Math.max(1, Math.round((rate * WINDOW_MS) / 1000));
      let voicedWindows = 0;
      for (let start = 0; start < samples; start += win) {
        const n = Math.min(win, samples - start);
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const s = wav.readInt16LE(body + (start + i) * 2) / 0x8000;
          sum += s * s;
        }
        if (Math.sqrt(sum / n) >= SPEECH_RMS_FLOOR) voicedWindows++;
      }
      return { durationMs: (samples / rate) * 1000, voicedMs: voicedWindows * WINDOW_MS };
    }
    off = body + size + (size % 2);
  }
  return null;
}

/** The transcript to hand back: '' when it is a silence hallucination. */
export function filterHallucination(text: string, stats: ClipStats | null): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (NON_SPEECH_ONLY.test(trimmed)) return '';
  if (!stats || !isKnownHallucination(trimmed)) return trimmed;
  const nearSilent = stats.durationMs < SHORT_CLIP_MS || stats.voicedMs < MIN_VOICED_MS;
  return nearSilent ? '' : trimmed;
}
