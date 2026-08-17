// ── Voice: text-to-speech playback + speech-to-text dictation ────────────────
// First FEATURE module out of legacy.js (the earlier three were leaves). Two
// halves that share nothing but their place in the composer UI:
//   TTS — "read aloud" on an agent message, server voices via /api/tts or the
//         browser's SpeechSynthesis as a fallback.
//   STT — mic capture → 16k WAV segments → /api/stt/transcribe → composer.
//
// Three pieces of state are read or written by the Settings panels, which are
// still in legacy.js. They are exposed as accessors, not bindings, for the same
// reason core/api.ts does it: an imported binding cannot be assigned. When the
// settings panels become modules, those call sites move with them.
import { ref } from 'vue';
import { $, lucide } from '../core/dom.js';
import { showToast } from '../core/toast.js';
import { authFetch } from '../core/api.js';

let ttsServerEnabled = false; // set by loadTtsConfig from /api/tts/config
let ttsReadAloudEnabled = false; // workspace-level (owner-set) — gates the speaker
let ttsCurrentAudio: HTMLAudioElement | null = null; // the Audio element currently playing (server mode)
/**
 * Which message is playing, and how far along.
 *
 * This was the button ELEMENT (ttsCurrentBtn) — identity comparisons all the way
 * through speak(), so a later click could supersede an in-flight fetch. The row
 * key does the same job while the button is rendered by TtsButton rather than
 * built by hand, which it has to be now that messages are Vue-owned.
 */
export const ttsActiveKey = ref<string | number | null>(null);
export const ttsPhase = ref<'loading' | 'playing' | null>(null);
async function loadTtsConfig() {
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
// True when we can speak at all — server TTS on, or the browser has Web Speech.
function ttsAvailable() {
  return ttsServerEnabled || (typeof window !== 'undefined' && 'speechSynthesis' in window);
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
export function stopTts() {
  if (ttsCurrentAudio) {
    ttsCurrentAudio.pause();
    if (ttsCurrentAudio.src) URL.revokeObjectURL(ttsCurrentAudio.src);
    ttsCurrentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  ttsActiveKey.value = null;
  ttsPhase.value = null;
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
  if (text) void speak(text, key);
}

async function speak(text: string, key: string | number) {
  ttsActiveKey.value = key;
  if (ttsServerEnabled) {
    ttsPhase.value = 'loading';
    try {
      const r = await authFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error(`tts ${r.status}`);
      const blob = await r.blob();
      if (ttsActiveKey.value !== key) return; // a later click superseded us mid-fetch
      const audio = new Audio(URL.createObjectURL(blob));
      ttsCurrentAudio = audio;
      audio.addEventListener('ended', () => {
        if (ttsActiveKey.value === key) stopTts();
      });
      audio.addEventListener('error', () => {
        if (ttsActiveKey.value === key) stopTts();
      });
      ttsPhase.value = 'playing';
      await audio.play();
      return;
    } catch (err) {
      console.error('Server TTS failed; falling back to Web Speech', err);
      // fall through to the Web Speech path below — unless a later click
      // superseded this one mid-fetch, in which case stale audio must not
      // start speaking over the newer playback.
      if (ttsActiveKey.value !== key) return;
    }
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.addEventListener('end', () => {
      if (ttsActiveKey.value === key) stopTts();
    });
    utter.addEventListener('error', () => {
      if (ttsActiveKey.value === key) stopTts();
    });
    ttsPhase.value = 'playing';
    window.speechSynthesis.speak(utter);
  } else {
    stopTts();
    showToast('Audio playback failed', { kind: 'error' });
  }
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
let sttNoSpeechMs = 0; // total silence since last speech — drives auto-stop
let sttInFlight: any[] = []; // promises of in-flight segment POSTs
let sttToastShown = false;
const STT_SAMPLE_RATE = 16000;
const STT_SILENCE_CUT_MS = 700; // pause that closes a segment
const STT_MAX_SEGMENT_MS = 5000; // hard cut so long speech still streams
const STT_RMS_FLOOR = 0.012; // below this a frame counts as silence
const STT_AUTOSTOP_MS = 12000; // this much continuous silence ends dictation
let sttElapsedTimer: any = null;
let sttStartedAt = 0;
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
function sttCutSegment() {
  const frames = sttSegments;
  const hadSpeech = sttSpeechInSegment;
  sttSegments = [];
  sttSegmentMs = 0;
  sttSilenceMs = 0;
  sttSpeechInSegment = false;
  if (!hadSpeech || frames.length === 0) return;
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
function sttOnFrame(int16?: any) {
  if (!sttActive) return;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] / 0x8000;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / int16.length);
  const frameMs = (int16.length / STT_SAMPLE_RATE) * 1000;
  sttSegments.push(int16);
  sttSegmentMs += frameMs;
  if (rms >= STT_RMS_FLOOR) {
    sttSpeechInSegment = true;
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
  // Stopping only inserts text; it NEVER sends (F3).
  if (sttNoSpeechMs >= STT_AUTOSTOP_MS && !sttStopping) {
    stopDictation();
  }
}
async function startDictation() {
  if (sttActive) return;
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
  await sttCleanupPass();
  sttStopping = false;
  sttAnnounce('');
}
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
async function sttCleanupPass() {
  if (!sttConfig?.cleanup || !sttCommitted.trim()) return;
  const input = ($('#message-input')) as HTMLElement;
  if (!input) return;
  const raw = sttCommitted;
  const mic = $('#mic-btn');
  mic?.classList.add('tidying');
  try {
    const r = await authFetch('/api/stt/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.cleaned || typeof body.text !== 'string') return;
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
async function initSttFeature() {
  try {
    const r = await authFetch('/api/stt/config');
    if (!r.ok) return;
    sttConfig = await r.json();
    $('#mic-btn')!.hidden = !sttConfig.enabled;
  } catch {
    /* feature stays hidden */
  }
}
// ── Accessors for state the Settings panels still touch ──────────────────────
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
