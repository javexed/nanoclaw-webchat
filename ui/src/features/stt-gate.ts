// ── Dictation upload gate ────────────────────────────────────────────────────
// Whisper-family models invent text for silence ("Thank you.", "you"), so a
// segment that never really held speech is not worth uploading. The recorder
// counts how much of a segment cleared the RMS speech floor; one keyboard click
// or a cough clears it for a frame or two, a spoken word for far longer.

/** Below this per-frame RMS a frame counts as silence. */
export const STT_RMS_FLOOR = 0.012;
/** Least voiced time a segment needs before it is sent for transcription. */
export const STT_MIN_VOICED_MS = 200;
/** Least total length — shorter clips are a tap or a cut-off breath. */
export const STT_MIN_SEGMENT_MS = 300;

/** RMS of one PCM16 frame, 0–1. */
export function frameRms(int16: ArrayLike<number>): number {
  if (int16.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] / 0x8000;
    sum += s * s;
  }
  return Math.sqrt(sum / int16.length);
}

/** Should a closed segment be uploaded? */
export function segmentWorthSending(voicedMs: number, segmentMs: number): boolean {
  return voicedMs >= STT_MIN_VOICED_MS && segmentMs >= STT_MIN_SEGMENT_MS;
}
