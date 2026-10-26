// ── Voice: text-to-speech playback + speech-to-text dictation ────────────────
// Two halves that share nothing but their place in the composer UI:
//   TTS — "read aloud" on an agent message, server voices via /api/tts or the
//         browser's SpeechSynthesis as a fallback.
//   STT — mic capture → 16k WAV segments → /api/stt/transcribe → composer.
//
// State the Settings panels write is exposed through accessors: an imported
// binding cannot be assigned.
import { ref } from 'vue';
import { $ } from '../core/dom.js';
import { showToast } from '../core/toast.js';
import { apiJson, authFetch } from '../core/api.js';
import { STT_RMS_FLOOR, frameRms, segmentWorthSending } from './stt-gate.js';
import { ReadAloudQueue, splitSentences, type ReadAloudBackend } from './tts-queue.js';

// ── Text-to-speech ─────────────────────────────────────────────────────────
// Agent replies get a "read aloud" control. Two backends, one affordance:
// server-side synthesis (Kokoro / any OpenAI-compatible endpoint) when the host
// has WEBCHAT_TTS_ENABLED, else the browser's built-in Web Speech API (device
// voices, no backend). See src/channels/webchat/tts.ts and /add-webchat-tts.
//
// Playback is sentence by sentence (tts-queue.ts): the first sentence starts
// while the rest synthesize, and with auto-read on, replies delivered mid-turn
// queue behind the one speaking. Dictating or sending stops it all (barge-in).
let ttsServerEnabled = false; // set by loadTtsConfig from /api/tts/config
let ttsReadAloudEnabled = false; // workspace-level (owner-set) — gates the speaker
/** Which message is playing, and how far along. */
export const ttsActiveKey = ref<string | number | null>(null);
export const ttsPhase = ref<'loading' | 'playing' | null>(null);
async function loadTtsConfig() {
  armAudioUnlock();
  try {
    const r = await authFetch('/api/tts/config');
    if (r.ok) {
      const cfg = await r.json();
      ttsServerEnabled = cfg.enabled === true;
      ttsReadAloudEnabled = cfg.readAloud === true;
    }
  } catch {
    ttsServerEnabled = false;
  }
}
function speechAvailable() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}
// True when we can speak at all — server TTS on, or the browser has Web Speech.
function ttsAvailable() {
  return ttsServerEnabled || speechAvailable();
}
// Markdown → speakable plain text. Strips syntax so the voice reads prose, not
// backticks and brackets; fenced code collapses to a short placeholder rather
// than being read line by line.
function ttsPlainText(md?: any) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[>#\s]*/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Playback backend ───────────────────────────────────────────────────────
// One <audio> element for every clip: iOS only lets an element play without a
// fresh gesture once a gesture has started it, so the element is unlocked on
// the first tap and reused from then on.
type Clip = { kind: 'audio'; url: string } | { kind: 'speech'; text: string };
let ttsPlayer: HTMLAudioElement | null = null;
function player(): HTMLAudioElement {
  if (!ttsPlayer) ttsPlayer = new Audio();
  return ttsPlayer;
}
/** A 10 ms silent 8 kHz WAV: what the unlock gesture plays. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0Ya' + 'A'.repeat(218);
let audioUnlocked = false;
let unlockArmed = false;

/** Inside a user gesture: let later, gesture-less playback through (iOS). */
export function unlockAudio(): void {
  if (!audioUnlocked && ttsQueue.current.phase !== 'playing') {
    const a = player();
    a.src = SILENT_WAV;
    a.play().then(
      () => {
        audioUnlocked = true;
      },
      () => {},
    );
    // Web Speech is gated the same way on iOS; an empty utterance opens it.
    if (speechAvailable()) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }
  ttsQueue.resume();
}
/** The first tap or key anywhere unlocks audio, so auto-read can start on its own. */
function armAudioUnlock() {
  if (unlockArmed || typeof document === 'undefined') return;
  unlockArmed = true;
  const onGesture = () => {
    unlockAudio();
    // Stay armed while audio is still locked or a sentence waits on a gesture.
    if (audioUnlocked && ttsQueue.current.phase !== 'blocked') {
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('keydown', onGesture, true);
    }
  };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
}

const backend: ReadAloudBackend<Clip> = {
  async synth(text, signal) {
    if (ttsServerEnabled) {
      try {
        const r = await authFetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal,
        });
        if (!r.ok) throw new Error(`tts ${r.status}`);
        return { kind: 'audio', url: URL.createObjectURL(await r.blob()) };
      } catch (err) {
        if (signal.aborted) throw err;
        console.error('Server TTS failed; falling back to Web Speech', err);
      }
    }
    if (speechAvailable()) return { kind: 'speech', text };
    throw new Error('No speech backend');
  },
  play(clip, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return resolve();
      if (clip.kind === 'speech') {
        const utter = new SpeechSynthesisUtterance(clip.text);
        const onAbort = () => window.speechSynthesis.cancel();
        const finish = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        utter.addEventListener('end', finish);
        utter.addEventListener('error', (e) => {
          signal.removeEventListener('abort', onAbort);
          if (e.error === 'not-allowed') reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
          else resolve(); // 'interrupted' / 'canceled' — a stop, not a failure
        });
        signal.addEventListener('abort', onAbort, { once: true });
        window.speechSynthesis.speak(utter);
        return;
      }
      const a = player();
      const cleanup = () => {
        a.onended = null;
        a.onerror = null;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        a.pause();
        cleanup();
        resolve();
      };
      a.onended = () => {
        cleanup();
        resolve();
      };
      a.onerror = () => {
        cleanup();
        reject(new Error('Audio playback failed'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      a.src = clip.url;
      a.play().then(
        () => {
          audioUnlocked = true;
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
  },
  release(clip) {
    if (clip.kind === 'audio') URL.revokeObjectURL(clip.url);
  },
};

let ttsErrorShown = false;
const ttsQueue = new ReadAloudQueue<Clip>(
  backend,
  (s) => {
    ttsActiveKey.value = s.key;
    // 'blocked' (waiting on a tap to unlock audio) reads as still loading.
    ttsPhase.value = s.phase === 'blocked' ? 'loading' : s.phase;
  },
  (err) => {
    console.error('Read aloud failed', err);
    if (!ttsErrorShown) {
      ttsErrorShown = true;
      showToast('Audio playback failed', { kind: 'error' });
    }
  },
);

/** Stop reading and drop anything queued — also the barge-in for dictation and send. */
export function stopTts() {
  ttsQueue.stop();
  if (speechAvailable()) window.speechSynthesis.cancel();
}
/** Is the read-aloud affordance offered at all? Workspace-gated by the OWNER in
 *  Settings → Features; per-device switches confused shared rooms. */
export function ttsOffered(): boolean {
  return !!ttsReadAloudEnabled && ttsAvailable();
}

/** One message's button: the playing one stops, any other supersedes. getText is
 *  called at click time so the freshest bubble content is spoken. */
export function toggleTts(key: string | number, getText: () => string): void {
  if (ttsActiveKey.value === key) {
    stopTts();
    return;
  }
  stopTts();
  const text = (getText() || '').trim();
  if (text) speak(text, key);
}

function speak(text: string, key: string | number) {
  unlockAudio(); // a click: the gesture iOS wants before audio
  ttsErrorShown = false;
  ttsQueue.start(key, splitSentences(text));
}

// ── Auto-read (per viewer, per room) ──────────────────────────────────────────
// Hands-free mode: each agent reply in the open room is read as it arrives.
// A device preference, so localStorage — the same shape as `lastThread:<room>`.
const AUTO_READ_PREFIX = 'autoRead:';
export function autoReadEnabled(roomId: string | null | undefined): boolean {
  if (!roomId) return false;
  try {
    return localStorage.getItem(AUTO_READ_PREFIX + roomId) === '1';
  } catch {
    return false;
  }
}
export function setAutoRead(roomId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO_READ_PREFIX + roomId, '1');
    else localStorage.removeItem(AUTO_READ_PREFIX + roomId);
  } catch {
    /* private mode: the switch just won't persist */
  }
  if (on) unlockAudio(); // flipping the switch is a gesture
  else stopTts();
}
/** A freshly delivered agent reply in the open room: queue it if auto-read is on.
 *  Skipped while dictating — the mic would hear the speaker. */
export function autoReadReply(key: string | number, markdown: string | null | undefined, roomId: string | null): void {
  if (!markdown || sttActive || !ttsOffered() || !autoReadEnabled(roomId)) return;
  ttsErrorShown = false;
  ttsQueue.enqueue(key, splitSentences(ttsPlainText(markdown)));
}
// mic → getUserMedia → AudioContext(16k) + pcm-worklet → PCM16 frames.
// RMS silence detection cuts a segment (~700ms pause or 5s max) → WAV built
// client-side → POST /api/stt/transcribe → committed text appends into the
// composer as segments return. Tap the mic (or long trailing silence) to stop;
// Esc cancels and discards. On stop, the dictated span is tidied via
// /api/stt/cleanup (replaced with execCommand so Ctrl/Cmd+Z restores the raw
// transcript). Sending is ALWAYS an explicit act — no path here submits.
let sttConfig: any = null; // { enabled, cleanup, provider?, cleanupModelId?, canEdit? }
let sttActive = false;
let sttStopping = false;
let sttAudioCtx: any = null;
let sttStream: any = null;
let sttWorkletNode: any = null;
let sttSourceNode: any = null;
let sttBeforeText = ''; // composer content that predates this dictation
let sttCommitted = ''; // dictated text committed so far
let sttPending = 0; // segments in flight
let sttSegments: any[] = []; // Int16Array frames of the current segment
let sttSegmentMs = 0;
let sttSilenceMs = 0;
let sttSpeechInSegment = false;
let sttVoicedMs = 0; // time in the current segment above the speech floor
let sttNoSpeechMs = 0; // total silence since last speech — drives auto-stop
let sttInFlight: any[] = []; // promises of in-flight segment POSTs
let sttToastShown = false;
const STT_SAMPLE_RATE = 16000;
const STT_SILENCE_CUT_MS = 700; // pause that closes a segment
const STT_MAX_SEGMENT_MS = 5000; // hard cut so long speech still streams
const STT_AUTOSTOP_MS = 12000; // this much continuous silence ends dictation
let sttElapsedTimer: any = null;
let sttStartedAt = 0;

/** Recording chrome: mic ⇄ red pulsing stop square + elapsed chip (the
 *  standard voice-recorder idiom, so state is unmistakable at a glance). */
function sttSetRecordingChrome(on?: any) {
  const mic = $('#mic-btn');
  const chip = $('#stt-elapsed');
  const use = mic?.querySelector('use');
  if (use) use.setAttribute('href', on ? '#i-square' : '#i-mic');
  if (on) {
    sttStartedAt = Date.now();
    if (chip) {
      chip.textContent = '0:00';
      chip.hidden = false;
    }
    sttElapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - sttStartedAt) / 1000);
      const t = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      if (chip) chip.textContent = t;
      mic?.setAttribute('title', `Recording ${t} — tap to stop`);
    }, 1000);
  } else {
    if (sttElapsedTimer) clearInterval(sttElapsedTimer);
    sttElapsedTimer = null;
    if (chip) chip.hidden = true;
    mic?.setAttribute('title', 'Dictate');
  }
}
function sttAnnounce(text?: any) {
  const el = $('#stt-status');
  if (el) el.textContent = text;
}

/** Wrap accumulated PCM16 frames in a minimal 16 kHz mono WAV container. */
function sttBuildWav(frames?: any) {
  let samples = 0;
  for (const f of frames) samples += f.length;
  const buf = new ArrayBuffer(44 + samples * 2);
  const dv = new DataView(buf);
  const writeStr = (off?: any, s?: any) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + samples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true); // PCM chunk size
  dv.setUint16(20, 1, true); // PCM format
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, STT_SAMPLE_RATE, true);
  dv.setUint32(28, STT_SAMPLE_RATE * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  dv.setUint32(40, samples * 2, true);
  let off = 44;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++, off += 2) dv.setInt16(off, f[i], true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
function sttRenderInput() {
  const input = ($('#message-input')) as HTMLInputElement;
  if (!input) return;
  const sep = sttBeforeText && sttCommitted ? ' ' : '';
  input.value = sttBeforeText + sep + sttCommitted + (sttPending > 0 ? ' …' : '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Close the current segment and ship it for transcription (if it held speech). */
function sttCutSegment() {
  const frames = sttSegments;
  const worth = segmentWorthSending(sttVoicedMs, sttSegmentMs);
  sttSegments = [];
  sttSegmentMs = 0;
  sttSilenceMs = 0;
  sttSpeechInSegment = false;
  sttVoicedMs = 0;
  // A click or a breath: whisper would only invent text for it.
  if (!worth || frames.length === 0) return;
  const wav = sttBuildWav(frames);
  sttPending++;
  sttRenderInput();
  const p = authFetch('/api/stt/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
  })
    .then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText);
      const text = (body.text || '').trim();
      if (text) {
        sttCommitted = sttCommitted ? `${sttCommitted} ${text}` : text;
      }
    })
    .catch((err) => {
      if (!sttToastShown) {
        sttToastShown = true;
        showToast('Transcription failed: ' + err.message, { kind: 'error' });
      }
    })
    .finally(() => {
      sttPending--;
      sttRenderInput();
    });
  sttInFlight.push(p);
}

/** Per-frame handler: RMS gate → segment bookkeeping → cut on pause/length. */
function sttOnFrame(int16?: any) {
  if (!sttActive) return;
  const rms = frameRms(int16);
  const frameMs = (int16.length / STT_SAMPLE_RATE) * 1000;
  sttSegments.push(int16);
  sttSegmentMs += frameMs;
  if (rms >= STT_RMS_FLOOR) {
    sttSpeechInSegment = true;
    sttVoicedMs += frameMs;
    sttSilenceMs = 0;
    sttNoSpeechMs = 0;
  } else {
    sttSilenceMs += frameMs;
    sttNoSpeechMs += frameMs;
  }
  if ((sttSpeechInSegment && sttSilenceMs >= STT_SILENCE_CUT_MS) || sttSegmentMs >= STT_MAX_SEGMENT_MS) {
    sttCutSegment();
  }
  // Long total silence = the user walked away — stop as if the mic was tapped.
  // Stopping only inserts text; it NEVER sends.
  if (sttNoSpeechMs >= STT_AUTOSTOP_MS && !sttStopping) {
    stopDictation();
  }
}
async function startDictation() {
  if (sttActive) return;
  stopTts(); // barge-in: the user is talking now
  const input = ($('#message-input')) as HTMLInputElement;
  if (!input || (input as HTMLInputElement).disabled) return;
  try {
    sttStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showToast('Microphone access denied — allow the mic for this site in browser settings.', { kind: 'error' });
    return;
  }
  try {
    sttAudioCtx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
    await sttAudioCtx.audioWorklet.addModule('/pcm-worklet.js');
    sttSourceNode = sttAudioCtx.createMediaStreamSource(sttStream);
    sttWorkletNode = new AudioWorkletNode(sttAudioCtx, 'pcm-worklet');
    sttWorkletNode.port.onmessage = (e: MessageEvent) => sttOnFrame(new Int16Array(e.data));
    sttSourceNode.connect(sttWorkletNode);
  } catch (err) {
    showToast('Could not start audio capture: ' + (err as any)?.message, { kind: 'error' });
    sttTeardownAudio();
    return;
  }
  sttActive = true;
  sttStopping = false;
  sttToastShown = false;
  sttBeforeText = input.value.trim();
  sttCommitted = '';
  sttPending = 0;
  sttSegments = [];
  sttSegmentMs = 0;
  sttSilenceMs = 0;
  sttSpeechInSegment = false;
  sttVoicedMs = 0;
  sttNoSpeechMs = 0;
  sttInFlight = [];
  const mic = $('#mic-btn');
  mic?.classList.add('recording');
  mic?.setAttribute('aria-label', 'Stop dictation');
  mic?.setAttribute('aria-pressed', 'true');
  sttSetRecordingChrome(true);
  sttAnnounce('Listening…');
}
function sttTeardownAudio() {
  try {
    sttSourceNode?.disconnect();
    sttWorkletNode?.disconnect();
  } catch {
    /* already gone */
  }
  sttStream?.getTracks().forEach((t: any) => t.stop());
  sttAudioCtx?.close().catch(() => {});
  sttStream = null;
  sttAudioCtx = null;
  sttWorkletNode = null;
  sttSourceNode = null;
}
function sttResetMicButton() {
  const mic = $('#mic-btn');
  mic?.classList.remove('recording');
  mic?.setAttribute('aria-label', 'Start dictation');
  mic?.setAttribute('aria-pressed', 'false');
  sttSetRecordingChrome(false);
}

/** Stop capture, flush the tail segment, wait for transcripts, then tidy. */
async function stopDictation() {
  if (!sttActive || sttStopping) return;
  sttStopping = true;
  sttActive = false;
  sttCutSegment(); // flush whatever's buffered
  sttTeardownAudio();
  sttResetMicButton();
  sttAnnounce('Transcribing…');
  await Promise.allSettled(sttInFlight);
  sttRenderInput();
  // Nothing survived (silence, or only hallucinations the server dropped):
  // say so to screen readers only — the unchanged composer shows it already.
  const heard = sttCommitted.trim() !== '';
  await sttCleanupPass();
  sttStopping = false;
  sttAnnounce(heard || sttToastShown ? '' : 'Nothing heard');
}

/** Esc = cancel: discard everything dictated, restore the prior composer text. */
function cancelDictation() {
  if (!sttActive) return;
  sttActive = false;
  sttStopping = false;
  sttTeardownAudio();
  sttResetMicButton();
  sttCommitted = '';
  sttPending = 0;
  const input = ($('#message-input')) as HTMLInputElement;
  if (input) {
    input.value = sttBeforeText;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  sttAnnounce('Dictation cancelled');
}

/**
 * Tidy the dictated span via the server's cleanup model. The replacement goes
 * through execCommand('insertText') over a selection of just the dictated
 * text, so the native undo stack (Ctrl/Cmd+Z) restores the raw transcript.
 */
async function sttCleanupPass() {
  if (!sttConfig?.cleanup || !sttCommitted.trim()) return;
  const input = ($('#message-input')) as HTMLElement;
  if (!input) return;
  const raw = sttCommitted;
  const mic = $('#mic-btn');
  mic?.classList.add('tidying');
  try {
    const body = await apiJson('/api/stt/cleanup', { method: 'POST', body: { text: raw } });
    if (!body.cleaned || typeof body.text !== 'string') return;
    // The composer may have been edited while we waited — only swap if the
    // dictated span is still exactly where we left it.
    const sep = sttBeforeText && raw ? ' ' : '';
    const expected = sttBeforeText + sep + raw;
    if ((input as HTMLInputElement).value !== expected) return;
    const start = (sttBeforeText + sep).length;
    input.focus();
    (input as HTMLInputElement).setSelectionRange(start, (input as HTMLInputElement).value.length);
    const before = (input as HTMLInputElement).value;
    document.execCommand('insertText', false, body.text);
    if ((input as HTMLInputElement).value === before) {
      (input as HTMLInputElement).setRangeText(body.text, start, before.length, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    sttCommitted = body.text;
  } catch {
    /* raw transcript stays — cleanup is best-effort */
  } finally {
    mic?.classList.remove('tidying');
  }
}

/** Post-auth: reveal the mic when the server has an STT backend configured. */
async function initSttFeature() {
  try {
    sttConfig = await apiJson('/api/stt/config');
    $('#mic-btn')!.hidden = !sttConfig.enabled;
  } catch {
    /* feature stays hidden */
  }
}
// ── Accessors for state the Settings panels touch ──────────────────────────────
export function getTtsReadAloudEnabled() {
  return ttsReadAloudEnabled;
}
export function setTtsReadAloudEnabled(on?: any) {
  ttsReadAloudEnabled = on;
}
export function getSttConfig() {
  return sttConfig;
}
export function setSttConfig(cfg?: any) {
  sttConfig = cfg;
}
export function isDictationActive() {
  return sttActive;
}

export {
  loadTtsConfig, ttsPlainText, speak,
  startDictation, stopDictation, cancelDictation, initSttFeature,
};
