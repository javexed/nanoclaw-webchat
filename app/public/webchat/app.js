import { marked } from "/marked.min.js";
import DOMPurify from "/dompurify.min.js";
//#region src/core/dom.ts
/** querySelector, the shorthand the whole UI is written in. */
var $ = (sel) => document.querySelector(sel);
/** Inline Lucide icon referencing the SVG sprite in index.html. Returns an HTML
* string (safe — no user data); styling/color come from the .icon CSS class. */
function lucide$1(name, cls = "") {
	return `<svg class="icon${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
/** Same icon as a detached DOM node, for inserting NEXT TO user-controlled text
* without resorting to innerHTML (keeps the surrounding text XSS-safe). */
function lucideEl(name, cls = "") {
	const t = document.createElement("template");
	t.innerHTML = lucide$1(name, cls);
	return t.content.firstChild;
}
/** HTML-escape for the few places that still build markup as a string. */
function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
//#endregion
//#region src/core/api.ts
var authToken = sessionStorage.getItem("nanoclaw-token") || "";
function getAuthToken() {
	return authToken;
}
function setAuthToken(token) {
	authToken = token;
}
function getWsUrl() {
	return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}
function getWsProtocols() {
	return authToken ? [`bearer.${authToken}`] : [];
}
function authFetch(url, opts = {}) {
	const headers = { ...opts.headers };
	if (authToken && !headers["Authorization"] && !headers["authorization"]) headers["Authorization"] = `Bearer ${authToken}`;
	headers["X-Webchat-CSRF"] = "1";
	return fetch(url, {
		...opts,
		headers
	});
}
/** authFetch + JSON ceremony in one call. Sends a JSON body when `body` is
* given, parses the JSON response (tolerating empty/non-JSON), and throws
* Error(body.error || statusText) on !ok. Options: { method, body, headers }. */
async function apiJson(url, { method = "GET", body, headers } = {}) {
	const opts = {
		method,
		headers: { ...headers }
	};
	if (body !== void 0) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}
	const res = await authFetch(url, opts);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(data.error || res.statusText || `HTTP ${res.status}`);
		err.status = res.status;
		err.body = data;
		throw err;
	}
	return data;
}
//#endregion
//#region src/core/toast.ts
function showToast(message, { kind = "info", timeout } = {}) {
	const container = $("#toasts");
	if (!container) return null;
	const toast = document.createElement("div");
	toast.className = `toast toast-${kind}`;
	toast.setAttribute("role", kind === "error" ? "alert" : "status");
	toast.textContent = message;
	const remove = () => {
		if (!toast.parentNode) return;
		toast.classList.add("toast-out");
		setTimeout(() => toast.remove(), 180);
	};
	toast.addEventListener("click", remove);
	container.appendChild(toast);
	setTimeout(remove, timeout ?? (kind === "error" ? 7e3 : 4e3));
	return toast;
}
/** Error → toast, one shape everywhere (kind:'error' can't be forgotten). */
function toastError(err, fallback) {
	const message = err?.message;
	showToast(message || fallback || "Something went wrong", { kind: "error" });
}
//#endregion
//#region src/features/voice.js
var ttsServerEnabled = false;
var ttsReadAloudEnabled = false;
var ttsCurrentAudio = null;
var ttsCurrentBtn = null;
async function loadTtsConfig() {
	try {
		const r = await authFetch("/api/tts/config");
		if (r.ok) {
			const cfg = await r.json();
			ttsServerEnabled = cfg.enabled === true;
			ttsReadAloudEnabled = cfg.readAloud === true;
		}
	} catch {
		ttsServerEnabled = false;
	}
}
function ttsAvailable() {
	return ttsServerEnabled || typeof window !== "undefined" && "speechSynthesis" in window;
}
function ttsPlainText(md) {
	return String(md || "").replace(/```[\s\S]*?```/g, " (code block) ").replace(/`([^`]+)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^[>#\s]*/gm, "").replace(/[*_~]/g, "").replace(/\n{2,}/g, ". ").replace(/\s+/g, " ").trim();
}
function resetTtsButton(btn) {
	if (!btn) return;
	btn.classList.remove("tts-playing", "tts-loading");
	btn.innerHTML = lucide("volume-2");
	btn.setAttribute("aria-label", "Read aloud");
	btn.title = "Read aloud";
}
function markTtsPlaying(btn) {
	btn.classList.remove("tts-loading");
	btn.classList.add("tts-playing");
	btn.innerHTML = lucide("square");
	btn.setAttribute("aria-label", "Stop");
	btn.title = "Stop";
}
function stopTts() {
	if (ttsCurrentAudio) {
		ttsCurrentAudio.pause();
		if (ttsCurrentAudio.src) URL.revokeObjectURL(ttsCurrentAudio.src);
		ttsCurrentAudio = null;
	}
	if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
	resetTtsButton(ttsCurrentBtn);
	ttsCurrentBtn = null;
}
function buildTtsButton(getText) {
	if (!ttsReadAloudEnabled || !ttsAvailable()) return null;
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "tts-btn";
	resetTtsButton(btn);
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		if (ttsCurrentBtn === btn) {
			stopTts();
			return;
		}
		stopTts();
		const text = (getText() || "").trim();
		if (text) speak(text, btn);
	});
	return btn;
}
async function speak(text, btn) {
	ttsCurrentBtn = btn;
	if (ttsServerEnabled) {
		btn.classList.add("tts-loading");
		btn.setAttribute("aria-label", "Synthesizing…");
		try {
			const r = await authFetch("/api/tts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text })
			});
			if (!r.ok) throw new Error(`tts ${r.status}`);
			const blob = await r.blob();
			if (ttsCurrentBtn !== btn) return;
			const audio = new Audio(URL.createObjectURL(blob));
			ttsCurrentAudio = audio;
			audio.addEventListener("ended", () => {
				if (ttsCurrentBtn === btn) stopTts();
			});
			audio.addEventListener("error", () => {
				if (ttsCurrentBtn === btn) stopTts();
			});
			markTtsPlaying(btn);
			await audio.play();
			return;
		} catch (err) {
			console.error("Server TTS failed; falling back to Web Speech", err);
			if (ttsCurrentBtn !== btn) return;
		}
	}
	if (typeof window !== "undefined" && "speechSynthesis" in window) {
		const utter = new SpeechSynthesisUtterance(text);
		utter.addEventListener("end", () => {
			if (ttsCurrentBtn === btn) stopTts();
		});
		utter.addEventListener("error", () => {
			if (ttsCurrentBtn === btn) stopTts();
		});
		markTtsPlaying(btn);
		window.speechSynthesis.speak(utter);
	} else {
		stopTts();
		showToast("Audio playback failed", { kind: "error" });
	}
}
var sttConfig = null;
var sttActive = false;
var sttStopping = false;
var sttAudioCtx = null;
var sttStream = null;
var sttWorkletNode = null;
var sttSourceNode = null;
var sttBeforeText = "";
var sttCommitted = "";
var sttPending = 0;
var sttSegments = [];
var sttSegmentMs = 0;
var sttSilenceMs = 0;
var sttSpeechInSegment = false;
var sttNoSpeechMs = 0;
var sttInFlight = [];
var sttToastShown = false;
var STT_SAMPLE_RATE = 16e3;
var STT_SILENCE_CUT_MS = 700;
var STT_MAX_SEGMENT_MS = 5e3;
var STT_RMS_FLOOR = .012;
var STT_AUTOSTOP_MS = 12e3;
var sttElapsedTimer = null;
var sttStartedAt = 0;
function sttSetRecordingChrome(on) {
	const mic = $("#mic-btn");
	const chip = $("#stt-elapsed");
	const use = mic?.querySelector("use");
	if (use) use.setAttribute("href", on ? "#i-square" : "#i-mic");
	if (on) {
		sttStartedAt = Date.now();
		if (chip) {
			chip.textContent = "0:00";
			chip.hidden = false;
		}
		sttElapsedTimer = setInterval(() => {
			const sec = Math.floor((Date.now() - sttStartedAt) / 1e3);
			const t = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
			if (chip) chip.textContent = t;
			mic?.setAttribute("title", `Recording ${t} — tap to stop`);
		}, 1e3);
	} else {
		if (sttElapsedTimer) clearInterval(sttElapsedTimer);
		sttElapsedTimer = null;
		if (chip) chip.hidden = true;
		mic?.setAttribute("title", "Dictate");
	}
}
function sttAnnounce(text) {
	const el = $("#stt-status");
	if (el) el.textContent = text;
}
function sttBuildWav(frames) {
	let samples = 0;
	for (const f of frames) samples += f.length;
	const buf = /* @__PURE__ */ new ArrayBuffer(44 + samples * 2);
	const dv = new DataView(buf);
	const writeStr = (off, s) => {
		for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
	};
	writeStr(0, "RIFF");
	dv.setUint32(4, 36 + samples * 2, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, 1, true);
	dv.setUint32(24, STT_SAMPLE_RATE, true);
	dv.setUint32(28, STT_SAMPLE_RATE * 2, true);
	dv.setUint16(32, 2, true);
	dv.setUint16(34, 16, true);
	writeStr(36, "data");
	dv.setUint32(40, samples * 2, true);
	let off = 44;
	for (const f of frames) for (let i = 0; i < f.length; i++, off += 2) dv.setInt16(off, f[i], true);
	return new Blob([buf], { type: "audio/wav" });
}
function sttRenderInput() {
	const input = $("#message-input");
	if (!input) return;
	input.value = sttBeforeText + (sttBeforeText && sttCommitted ? " " : "") + sttCommitted + (sttPending > 0 ? " …" : "");
	input.dispatchEvent(new Event("input", { bubbles: true }));
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
	const p = authFetch("/api/stt/transcribe", {
		method: "POST",
		headers: { "Content-Type": "audio/wav" },
		body: wav
	}).then(async (r) => {
		const body = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(body.error || r.statusText);
		const text = (body.text || "").trim();
		if (text) sttCommitted = sttCommitted ? `${sttCommitted} ${text}` : text;
	}).catch((err) => {
		if (!sttToastShown) {
			sttToastShown = true;
			showToast("Transcription failed: " + err.message, { kind: "error" });
		}
	}).finally(() => {
		sttPending--;
		sttRenderInput();
	});
	sttInFlight.push(p);
}
function sttOnFrame(int16) {
	if (!sttActive) return;
	let sum = 0;
	for (let i = 0; i < int16.length; i++) {
		const s = int16[i] / 32768;
		sum += s * s;
	}
	const rms = Math.sqrt(sum / int16.length);
	const frameMs = int16.length / STT_SAMPLE_RATE * 1e3;
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
	if (sttSpeechInSegment && sttSilenceMs >= STT_SILENCE_CUT_MS || sttSegmentMs >= STT_MAX_SEGMENT_MS) sttCutSegment();
	if (sttNoSpeechMs >= STT_AUTOSTOP_MS && !sttStopping) stopDictation();
}
async function startDictation() {
	if (sttActive) return;
	const input = $("#message-input");
	if (!input || input.disabled) return;
	try {
		sttStream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch {
		showToast("Microphone access denied — allow the mic for this site in browser settings.", { kind: "error" });
		return;
	}
	try {
		sttAudioCtx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
		await sttAudioCtx.audioWorklet.addModule("/pcm-worklet.js");
		sttSourceNode = sttAudioCtx.createMediaStreamSource(sttStream);
		sttWorkletNode = new AudioWorkletNode(sttAudioCtx, "pcm-worklet");
		sttWorkletNode.port.onmessage = (e) => sttOnFrame(new Int16Array(e.data));
		sttSourceNode.connect(sttWorkletNode);
	} catch (err) {
		showToast("Could not start audio capture: " + err.message, { kind: "error" });
		sttTeardownAudio();
		return;
	}
	sttActive = true;
	sttStopping = false;
	sttToastShown = false;
	sttBeforeText = input.value.trim();
	sttCommitted = "";
	sttPending = 0;
	sttSegments = [];
	sttSegmentMs = 0;
	sttSilenceMs = 0;
	sttSpeechInSegment = false;
	sttNoSpeechMs = 0;
	sttInFlight = [];
	const mic = $("#mic-btn");
	mic?.classList.add("recording");
	mic?.setAttribute("aria-label", "Stop dictation");
	mic?.setAttribute("aria-pressed", "true");
	sttSetRecordingChrome(true);
	sttAnnounce("Listening…");
}
function sttTeardownAudio() {
	try {
		sttSourceNode?.disconnect();
		sttWorkletNode?.disconnect();
	} catch {}
	sttStream?.getTracks().forEach((t) => t.stop());
	sttAudioCtx?.close().catch(() => {});
	sttStream = null;
	sttAudioCtx = null;
	sttWorkletNode = null;
	sttSourceNode = null;
}
function sttResetMicButton() {
	const mic = $("#mic-btn");
	mic?.classList.remove("recording");
	mic?.setAttribute("aria-label", "Start dictation");
	mic?.setAttribute("aria-pressed", "false");
	sttSetRecordingChrome(false);
}
async function stopDictation() {
	if (!sttActive || sttStopping) return;
	sttStopping = true;
	sttActive = false;
	sttCutSegment();
	sttTeardownAudio();
	sttResetMicButton();
	sttAnnounce("Transcribing…");
	await Promise.allSettled(sttInFlight);
	sttRenderInput();
	await sttCleanupPass();
	sttStopping = false;
	sttAnnounce("");
}
function cancelDictation() {
	if (!sttActive) return;
	sttActive = false;
	sttStopping = false;
	sttTeardownAudio();
	sttResetMicButton();
	sttCommitted = "";
	sttPending = 0;
	const input = $("#message-input");
	if (input) {
		input.value = sttBeforeText;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	sttAnnounce("Dictation cancelled");
}
async function sttCleanupPass() {
	if (!sttConfig?.cleanup || !sttCommitted.trim()) return;
	const input = $("#message-input");
	if (!input) return;
	const raw = sttCommitted;
	const mic = $("#mic-btn");
	mic?.classList.add("tidying");
	try {
		const r = await authFetch("/api/stt/cleanup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: raw })
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok || !body.cleaned || typeof body.text !== "string") return;
		const sep = sttBeforeText && raw ? " " : "";
		const expected = sttBeforeText + sep + raw;
		if (input.value !== expected) return;
		const start = (sttBeforeText + sep).length;
		input.focus();
		input.setSelectionRange(start, input.value.length);
		const before = input.value;
		document.execCommand("insertText", false, body.text);
		if (input.value === before) {
			input.setRangeText(body.text, start, before.length, "end");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		sttCommitted = body.text;
	} catch {} finally {
		mic?.classList.remove("tidying");
	}
}
async function initSttFeature() {
	try {
		const r = await authFetch("/api/stt/config");
		if (!r.ok) return;
		sttConfig = await r.json();
		$("#mic-btn").hidden = !sttConfig.enabled;
	} catch {}
}
function getTtsReadAloudEnabled() {
	return ttsReadAloudEnabled;
}
function setTtsReadAloudEnabled(on) {
	ttsReadAloudEnabled = on;
}
function getSttConfig() {
	return sttConfig;
}
function setSttConfig(cfg) {
	sttConfig = cfg;
}
function isDictationActive() {
	return sttActive;
}
//#endregion
//#region src/legacy.js
marked.setOptions({
	breaks: true,
	gfm: true
});
function decorateCodeBlocks(container) {
	container.querySelectorAll("pre").forEach((pre) => {
		if (pre.classList.contains("has-code-toolbar")) return;
		pre.classList.add("has-code-toolbar");
		const code = pre.querySelector("code");
		const langClass = code && [...code.classList].find((c) => c.startsWith("language-"));
		const lang = langClass ? langClass.slice(9) : "";
		const toolbar = document.createElement("div");
		toolbar.className = "code-toolbar";
		if (lang) {
			const label = document.createElement("span");
			label.className = "code-lang";
			label.textContent = lang;
			toolbar.appendChild(label);
		}
		const wrapBtn = document.createElement("button");
		wrapBtn.type = "button";
		wrapBtn.className = "code-btn wrap-code-btn";
		wrapBtn.textContent = "Wrap";
		wrapBtn.setAttribute("aria-label", "Toggle line wrapping");
		toolbar.appendChild(wrapBtn);
		const copyBtn = document.createElement("button");
		copyBtn.type = "button";
		copyBtn.className = "code-btn copy-code-btn";
		copyBtn.textContent = "Copy";
		copyBtn.setAttribute("aria-label", "Copy code to clipboard");
		toolbar.appendChild(copyBtn);
		pre.insertBefore(toolbar, pre.firstChild);
	});
}
async function copyTextToClipboard(text) {
	if (navigator.clipboard && window.isSecureContext) try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	document.body.removeChild(ta);
	return ok;
}
/**
* Three outcomes, not two: 'ok' | 'unauthenticated' | 'unreachable'.
*
* The distinction is the whole point. The service worker caches the app shell
* and serves it cache-first, so the PWA boots fine with no network at all — but
* `/api/` deliberately bypasses the SW, so this probe goes straight to the
* network. On a cold start (app launched from the home screen, radio still
* waking, VPN/Tailscale not up yet, host mid-restart) it can fail while the user
* is perfectly authenticated. Treating that as "unauthenticated" is what shows
* the token screen to someone who never needed it — and why a hard refresh
* "fixes" it: the retry simply succeeds.
*
* So: only a real auth verdict (401/403) sends anyone to the login screen.
* Anything else retries briefly, then defers to the WebSocket reconnect logic
* and the connection banner, which already handle being offline gracefully.
*/
async function checkAuth() {
	if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "ok";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const headers = getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {};
			const res = await fetch("/api/auth/check", {
				headers,
				cache: "no-store"
			});
			if (res.ok) return "ok";
			if (res.status === 401 || res.status === 403) return "unauthenticated";
		} catch {}
		if (!navigator.onLine) break;
		await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
	}
	return "unreachable";
}
var learningMasterEnabled = true;
function applyLearningMaster() {
	const learnBtn = document.getElementById("learn-btn");
	if (learnBtn) learnBtn.hidden = !learningMasterEnabled;
	if (!learningMasterEnabled) hideLearnNudge();
}
async function loadLearningMaster() {
	try {
		const r = await authFetch("/api/learning/config");
		if (r.ok) learningMasterEnabled = (await r.json()).enabled !== false;
	} catch {}
	applyLearningMaster();
}
/**
* We entered the app without a verdict (see checkAuth). Once the network is
* genuinely back, settle it: a real 401/403 means show the login screen after
* all. Runs at most once, and only while still on the optimistic path.
*/
async function reprobeAuthWhenOnline() {
	if (!navigator.onLine) await new Promise((r) => window.addEventListener("online", r, { once: true }));
	if (await checkAuth() !== "unauthenticated") return;
	$("#login-screen").hidden = false;
	$("#app").hidden = true;
	applyLoginHint();
}
function enterAuthedApp() {
	$("#login-screen").hidden = true;
	$("#app").hidden = false;
	connect();
	cacheAuthHint();
	if (settings.notifications && typeof Notification !== "undefined" && Notification.permission === "granted") enableWebPush();
	maybeAutoOpenWizard();
	maybeSuggestBearerRetire();
	initSttFeature();
	loadLearningMaster();
	loadTtsConfig();
}
var bearerRetireWired = false;
async function maybeSuggestBearerRetire() {
	const banner = $("#bearer-retire-banner");
	if (!banner) return;
	if (localStorage.getItem("nanoclaw-bearer-retire-dismissed") === "1") return;
	let info = null;
	try {
		const r = await authFetch("/api/webchat/auth");
		if (r.ok) info = await r.json();
	} catch {
		info = null;
	}
	if (!info || !info.bearerActive || !info.canDisableBearer || info.sessionSource === "bearer") return;
	if (!bearerRetireWired) {
		bearerRetireWired = true;
		$("#bearer-retire-disable")?.addEventListener("click", () => retireBearerFromBanner());
		$("#bearer-retire-dismiss")?.addEventListener("click", () => {
			localStorage.setItem("nanoclaw-bearer-retire-dismissed", "1");
			banner.hidden = true;
		});
	}
	banner.hidden = false;
}
async function retireBearerFromBanner() {
	const banner = $("#bearer-retire-banner");
	const btn = $("#bearer-retire-disable");
	if (btn) btn.disabled = true;
	try {
		const r = await authFetch("/api/webchat/auth/bearer", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ active: false })
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok) {
			showToast("Bearer token disabled — access is via Tailscale/SSO", { kind: "success" });
			localStorage.setItem("nanoclaw-bearer-retire-dismissed", "1");
			if (banner) banner.hidden = true;
		} else showToast(data.error || "Could not disable the bearer token", {
			kind: "error",
			timeout: 8e3
		});
	} catch {
		showToast("Connection failed", { kind: "error" });
	} finally {
		if (btn) btn.disabled = false;
	}
}
async function initApp() {
	const verdict = await checkAuth();
	if (verdict === "ok" || verdict === "unreachable") {
		enterAuthedApp();
		if (verdict === "unreachable") reprobeAuthWhenOnline();
	} else {
		$("#login-screen").hidden = false;
		$("#app").hidden = true;
		applyLoginHint();
	}
}
var serverUsesTailscale = (() => {
	try {
		return localStorage.getItem("webchat-server-tailscale") === "1";
	} catch {
		return false;
	}
})();
function rememberServerAuthHint(methods) {
	if (!methods) return;
	serverUsesTailscale = !!methods.tailscale;
	try {
		localStorage.setItem("webchat-server-tailscale", serverUsesTailscale ? "1" : "0");
	} catch {}
}
var lastProbeAt = 0;
var lastDiagnosis = null;
async function probeInternet() {
	const hit = (url) => fetch(url, {
		mode: "no-cors",
		cache: "no-store",
		signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(4e3) : void 0
	});
	try {
		await Promise.any([hit("https://derp1.tailscale.com/generate_204"), hit("https://www.gstatic.com/generate_204")]);
		return true;
	} catch {
		return false;
	}
}
function setConnectionBanner(text, offerOpenTailscale) {
	const banner = $("#connection-banner");
	banner.replaceChildren(document.createTextNode(text));
	if (offerOpenTailscale && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "banner-action";
		btn.textContent = "Open Tailscale";
		btn.addEventListener("click", () => {
			location.href = "tailscale://";
		});
		banner.appendChild(btn);
	}
	banner.classList.add("visible");
}
async function diagnoseConnection() {
	if (!navigator.onLine) {
		setConnectionBanner("You’re offline. Reconnecting when the network returns…");
		return;
	}
	if (Date.now() - lastProbeAt < 1e4) {
		if (lastDiagnosis) setConnectionBanner(lastDiagnosis.text, lastDiagnosis.offer);
		return;
	}
	lastProbeAt = Date.now();
	const internetUp = await probeInternet();
	if (ws && ws.readyState === WebSocket.OPEN) return;
	lastDiagnosis = internetUp ? {
		text: serverUsesTailscale ? "Internet is up but the server is unreachable — check that Tailscale is connected on this device." : "Internet is up but the server is unreachable — it may be down.",
		offer: serverUsesTailscale
	} : {
		text: "No internet connection. Reconnecting…",
		offer: false
	};
	setConnectionBanner(lastDiagnosis.text, lastDiagnosis.offer);
}
async function cacheAuthHint() {
	try {
		const r = await fetch("/api/auth/info");
		if (r.ok) rememberServerAuthHint((await r.json()).methods);
	} catch {}
}
/**
* Fetch `/api/auth/info` and rewrite the login subtitle so the user knows
* what's expected (Tailscale on this device vs token entry vs server
* misconfig) instead of facing a generic token prompt.
*
* The common failure mode is the client device (this phone / laptop) not
* having Tailscale running — the server's almost always fine because the
* operator had to install Tailscale to set up this server in the first
* place. The copy reflects that.
*/
async function applyLoginHint() {
	let info;
	try {
		const r = await fetch("/api/auth/info");
		if (!r.ok) return;
		info = await r.json();
	} catch {
		return;
	}
	const subtitle = $(".login-subtitle");
	subtitle.hidden = false;
	const m = info.methods || {};
	rememberServerAuthHint(m);
	if (!m.bearer) $("#login-form").hidden = true;
	if (m.tailscale && info.tailscaleHealthy) subtitle.textContent = "Tailscale should sign you in automatically — make sure it’s running on this device, then refresh.";
	else if (m.tailscale && !info.tailscaleHealthy) subtitle.hidden = true;
	else if (m.proxy && !m.bearer) subtitle.innerHTML = "Couldn't sign you in — your reverse proxy didn't pass an identity through. Try refreshing, or ask whoever sent you the link.";
	else if (m.bearer) subtitle.textContent = "Enter the access token you were given below.";
	else {
		subtitle.textContent = "This server isn't ready to sign anyone in yet. Whoever installed it needs to finish setup.";
		$("#login-form").hidden = true;
	}
}
$("#login-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const token = $("#login-token").value.trim();
	if (!token) return;
	try {
		if ((await fetch("/api/auth/check", { headers: { Authorization: `Bearer ${token}` } })).ok) {
			setAuthToken(token);
			sessionStorage.setItem("nanoclaw-token", token);
			enterAuthedApp();
		} else {
			$("#login-error").textContent = "Invalid token";
			$("#login-error").hidden = false;
		}
	} catch {
		$("#login-error").textContent = "Connection failed";
		$("#login-error").hidden = false;
	}
});
var ROOM_COLORS = [
	"#4fc3f7",
	"#69f0ae",
	"#ffd54f",
	"#ff8a80",
	"#b388ff",
	"#80deea",
	"#ffab91",
	"#a5d6a7"
];
function roomColor(roomId) {
	let hash = 0;
	for (let i = 0; i < roomId.length; i++) hash = (hash << 5) - hash + roomId.charCodeAt(i) | 0;
	return ROOM_COLORS[Math.abs(hash) % ROOM_COLORS.length];
}
var DEFAULTS = {
	theme: "dark",
	font: "medium",
	sendKey: "enter",
	notifications: true
};
function loadSettings() {
	try {
		const raw = JSON.parse(localStorage.getItem("nanoclaw-settings") || "{}");
		delete raw.readAloud;
		delete raw.readAloudRooms;
		delete raw.readAloudDefault;
		return {
			...DEFAULTS,
			...raw
		};
	} catch {
		return { ...DEFAULTS };
	}
}
function saveSettings(settings) {
	localStorage.setItem("nanoclaw-settings", JSON.stringify(settings));
}
var settings = loadSettings();
function applySettings() {
	document.documentElement.setAttribute("data-theme", settings.theme);
	document.documentElement.setAttribute("data-font", settings.font);
	const meta = document.querySelector("meta[name=\"theme-color\"]");
	if (meta) {
		const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
		if (surface) meta.setAttribute("content", surface);
	}
}
var usageRangeDays = 7;
var usageWired = false;
async function renderUsageSettings() {
	const section = $("#settings-usage");
	if (!section) return;
	let data = null;
	try {
		const r = await authFetch("/api/webchat/usage?days=" + usageRangeDays);
		if (!r.ok) {
			section.hidden = true;
			return;
		}
		data = await r.json();
	} catch {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	if (!usageWired) {
		usageWired = true;
		document.querySelectorAll("#usage-range .setting-option").forEach((b) => {
			b.addEventListener("click", () => {
				usageRangeDays = Number(b.dataset.days) || 7;
				document.querySelectorAll("#usage-range .setting-option").forEach((x) => x.classList.toggle("active", x === b));
				renderUsageSettings();
			});
		});
	}
	const fmt = (n) => n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
	$("#usage-total").textContent = "~" + fmt(data.totals.tokens) + " tokens · " + data.totals.turns + " turns · " + data.totals.users + " user" + (data.totals.users === 1 ? "" : "s");
	const table = $("#usage-table");
	const tbody = $("#usage-tbody");
	const empty = $("#usage-empty");
	tbody.textContent = "";
	if (!data.perUser.length) {
		table.hidden = true;
		empty.hidden = false;
	} else {
		table.hidden = false;
		empty.hidden = true;
		for (const u of data.perUser) {
			const tr = document.createElement("tr");
			[
				String(u.user).split(":").pop(),
				"~" + fmt(u.inputTokens),
				"~" + fmt(u.outputTokens),
				"~" + fmt(u.totalTokens),
				String(u.turns)
			].forEach((c, i) => {
				const td = document.createElement("td");
				td.textContent = c;
				if (i > 0) td.className = "usage-num";
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		}
	}
	const spark = $("#usage-spark");
	spark.textContent = "";
	if (data.perDay.length > 1) {
		const max = Math.max.apply(null, data.perDay.map((d) => d.tokens).concat(1));
		for (const d of data.perDay) {
			const bar = document.createElement("span");
			bar.className = "usage-bar";
			bar.style.height = Math.max(4, Math.round(d.tokens / max * 36)) + "px";
			bar.title = d.day + ": ~" + fmt(d.tokens);
			spark.appendChild(bar);
		}
		spark.hidden = false;
	} else spark.hidden = true;
	const models = $("#usage-models");
	models.textContent = "";
	if (data.byModel.length) {
		for (const m of data.byModel) {
			const chip = document.createElement("span");
			chip.className = "usage-model-chip";
			chip.textContent = m.model + " · ~" + fmt(m.tokens);
			models.appendChild(chip);
		}
		models.hidden = false;
	} else models.hidden = true;
}
var mmWired = false;
function mmFmtGB(bytes) {
	return bytes == null ? "?" : (bytes / 1e9).toFixed(1) + "GB";
}
function mmBadge(text, kind) {
	const b = document.createElement("span");
	b.className = "mm-badge " + (kind || "");
	b.textContent = text;
	return b;
}
async function renderModelManage() {
	const section = $("#settings-models-manage");
	if (!section) return;
	let inv = null;
	try {
		const r = await authFetch("/api/models/manage");
		if (!r.ok) {
			section.hidden = true;
			return;
		}
		inv = await r.json();
	} catch {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	$("#mm-gpu-line").textContent = inv.gpu ? `GPU: ${(inv.gpu.totalMB / 1024).toFixed(0)}GB VRAM (${(inv.gpu.usedMB / 1024).toFixed(1)}GB in use) · agent prompt ~${(inv.agentPromptTokens.lean / 1e3).toFixed(1)}k tokens` : "No NVIDIA GPU detected — VRAM fit unknown";
	const list = $("#mm-list");
	list.textContent = "";
	for (const m of inv.models) {
		const card = document.createElement("div");
		card.className = "mm-card";
		const head = document.createElement("div");
		head.className = "mm-head";
		const name = document.createElement("span");
		name.className = "mm-name";
		name.textContent = m.tag;
		head.appendChild(name);
		if (m.isDefault) head.appendChild(mmBadge("DEFAULT", "ok"));
		if (!m.pulled) head.appendChild(mmBadge("not pulled", "warn"));
		if (m.loadedVramBytes != null) head.appendChild(mmBadge("loaded", "ok"));
		const spec = document.createElement("span");
		spec.className = "mm-spec";
		spec.textContent = [
			m.paramSize,
			m.quant,
			mmFmtGB(m.sizeBytes)
		].filter(Boolean).join(" · ");
		head.appendChild(spec);
		card.appendChild(head);
		const fitRow = document.createElement("div");
		fitRow.className = "mm-fit";
		const ctxTxt = `context ${Math.round(m.configuredCtx / 1024)}k${m.maxContext ? ` of ${Math.round(m.maxContext / 1024)}k max` : ""}`;
		fitRow.appendChild(mmBadge(m.fit.context === "fits" ? `✓ ${ctxTxt} — prompt fits` : `⚠ ${ctxTxt} — prompt truncates`, m.fit.context === "fits" ? "ok" : "warn"));
		if (m.loadedVramBytes != null) {
			const fits = m.loadedVramBytes >= (m.loadedTotalBytes ?? 0);
			fitRow.appendChild(mmBadge(fits ? `✓ VRAM ${mmFmtGB(m.loadedVramBytes)} (live)` : `⚠ spills to CPU (live)`, fits ? "ok" : "warn"));
		} else if (m.fit.vram !== "unknown") fitRow.appendChild(mmBadge(m.fit.vram === "fits" ? `✓ VRAM fits (~${mmFmtGB(m.fit.estFootprintBytes)} est.)` : `⚠ spills to CPU (~${mmFmtGB(m.fit.estFootprintBytes)} est.) — slow`, m.fit.vram === "fits" ? "ok" : "warn"));
		card.appendChild(fitRow);
		const actions = document.createElement("div");
		actions.className = "mm-actions";
		if (m.pulled && m.fit.context === "truncates") {
			const fix = document.createElement("button");
			fix.className = "btn btn-primary";
			fix.type = "button";
			fix.textContent = "Fix: create 16k variant";
			fix.title = "Creates a copy of this model with a 16k context window (num_ctx) and registers it — the agent prompt then fits without truncation.";
			fix.addEventListener("click", async () => {
				fix.disabled = true;
				fix.textContent = "Creating…";
				try {
					const r = await authFetch("/api/models/context-variant", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Webchat-CSRF": "1"
						},
						body: JSON.stringify({
							tag: m.tag,
							ctx: 16384
						})
					});
					const d = await r.json();
					if (!r.ok) throw new Error(d.error || r.statusText);
					showToast(`${d.tag} created and registered`, { kind: "success" });
				} catch (err) {
					showToast("Variant failed: " + err.message, { kind: "error" });
				}
				renderModelManage();
			});
			actions.appendChild(fix);
		}
		if (m.registryId && !m.isDefault) {
			const def = document.createElement("button");
			def.className = "btn btn-secondary";
			def.type = "button";
			def.textContent = "Set default";
			def.addEventListener("click", async () => {
				def.disabled = true;
				if ((await authFetch("/api/workspace-model", {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						"X-Webchat-CSRF": "1"
					},
					body: JSON.stringify({ modelId: m.registryId })
				})).ok) showToast(`${m.tag} is now the workspace default`, { kind: "success" });
				else showToast("Could not set default", { kind: "error" });
				renderModelManage();
			});
			actions.appendChild(def);
		}
		if (actions.children.length) card.appendChild(actions);
		list.appendChild(card);
	}
	if (!mmWired) {
		mmWired = true;
		$("#mm-pull-btn")?.addEventListener("click", async () => {
			const model = $("#mm-pull-input").value.trim();
			if (!model) return;
			const status = $("#mm-pull-status");
			status.hidden = false;
			status.textContent = "Starting pull…";
			try {
				const r = await authFetch("/api/ollama/pull", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Webchat-CSRF": "1"
					},
					body: JSON.stringify({
						host: "http://localhost:11434",
						model
					})
				});
				if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
				const poll = setInterval(async () => {
					const jobs = await (await authFetch("/api/ollama/pulls")).json().catch(() => []);
					const job = Array.isArray(jobs) ? jobs.find((j) => j.model.includes(model.toLowerCase().replace(/\s+/g, ""))) : null;
					if (!job) return;
					if (job.status === "pulling") {
						const pct = job.total ? Math.round(job.completed / job.total * 100) : 0;
						status.textContent = `${job.detail || "downloading…"} (${pct}%)`;
					} else {
						clearInterval(poll);
						status.textContent = job.status === "success" ? `${job.model} pulled.` : `Pull failed: ${job.error || "unknown"}`;
						renderModelManage();
					}
				}, 2500);
			} catch (err) {
				status.textContent = "Pull failed: " + err.message;
			}
		});
	}
}
function renderSettingsModal() {
	document.querySelectorAll("#theme-options .setting-option").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.value === settings.theme);
	});
	document.querySelectorAll("#font-options .setting-option").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.value === settings.font);
	});
	document.querySelectorAll("#send-options .setting-option").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.value === settings.sendKey);
	});
	$("#notif-toggle").checked = settings.notifications;
}
var credConfigWired = false;
async function renderCredentialsSettings() {
	const section = $("#settings-credentials");
	if (!section) return;
	let cfg;
	try {
		const r = await authFetch("/api/webchat/credentials-config");
		if (!r.ok) {
			section.hidden = true;
			return;
		}
		cfg = await r.json();
	} catch {
		section.hidden = true;
		return;
	}
	if (!cfg.canEdit) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	document.querySelectorAll("#cred-default-mode .setting-option").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.value === cfg.defaultMode);
	});
	const providerOn = {
		claude: !!(cfg.allowAnthropicKey && cfg.allowClaudeOauth),
		codex: !!(cfg.allowOpenaiKey && cfg.allowCodexOauth)
	};
	const providerAvailable = {
		claude: true,
		codex: !!cfg.codexAvailable
	};
	document.querySelectorAll("#cred-providers .setting-option").forEach((btn) => {
		const p = btn.dataset.provider;
		btn.classList.toggle("active", !!providerOn[p]);
		btn.classList.toggle("is-unavailable", !providerAvailable[p]);
	});
	const codexRow = $("#settings-codex-install");
	if (codexRow) codexRow.hidden = false;
	const codexInstallBtn = $("#codex-install-btn");
	const codexBadge = $("#codex-installed-badge");
	if (codexInstallBtn && !codexInstallActive) codexInstallBtn.hidden = !!cfg.codexAvailable;
	if (codexBadge) codexBadge.hidden = !cfg.codexAvailable;
	const opencodeRow = $("#settings-opencode-install");
	if (opencodeRow) opencodeRow.hidden = false;
	const opencodeInstallBtn = $("#opencode-install-btn");
	const opencodeBadge = $("#opencode-installed-badge");
	if (opencodeInstallBtn && !opencodeInstallActive) opencodeInstallBtn.hidden = !!cfg.opencodeAvailable;
	if (opencodeBadge) opencodeBadge.hidden = !cfg.opencodeAvailable;
	const piRow = $("#settings-pi-install");
	if (piRow) piRow.hidden = false;
	const piInstallBtn = $("#pi-install-btn");
	const piBadge = $("#pi-installed-badge");
	if (piInstallBtn && !opencodeInstallActive) piInstallBtn.hidden = !!cfg.piAvailable;
	if (piBadge) piBadge.hidden = !cfg.piAvailable;
	if (credConfigWired) return;
	credConfigWired = true;
	$("#codex-install-btn")?.addEventListener("click", () => runCodexInstall(CODEX_SETTINGS_ELS));
	$("#opencode-install-btn")?.addEventListener("click", () => runOpencodeInstall(OPENCODE_SETTINGS_ELS));
	$("#pi-install-btn")?.addEventListener("click", () => runOpencodeInstall(PI_SETTINGS_ELS));
	const putConfig = async (patch) => {
		const r = await authFetch("/api/webchat/credentials-config", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify(patch)
		});
		if (!r.ok) {
			showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			renderCredentialsSettings();
			return false;
		}
		return true;
	};
	document.querySelectorAll("#cred-default-mode .setting-option").forEach((btn) => {
		btn.addEventListener("click", async () => {
			if (await putConfig({ defaultMode: btn.dataset.value })) {
				document.querySelectorAll("#cred-default-mode .setting-option").forEach((b) => b.classList.toggle("active", b === btn));
				if (currentRoom) updateUserCredsBanner(currentRoom);
			}
		});
	});
	const PROVIDER_FLAGS = {
		claude: ["allowAnthropicKey", "allowClaudeOauth"],
		codex: ["allowOpenaiKey", "allowCodexOauth"]
	};
	const PROVIDER_UNAVAILABLE = {
		codex: "Codex isn’t installed yet — use “Install Codex…” above to add it.",
		claude: "Claude isn’t available in this workspace."
	};
	document.querySelectorAll("#cred-providers .setting-option").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const p = btn.dataset.provider;
			if (btn.classList.contains("is-unavailable")) {
				showToast(PROVIDER_UNAVAILABLE[p] || "This provider isn’t available yet.", {
					kind: "info",
					timeout: 9e3
				});
				return;
			}
			const [keyFlag, oauthFlag] = PROVIDER_FLAGS[p] || [];
			if (!keyFlag) return;
			const on = !btn.classList.contains("active");
			if (await putConfig({
				[keyFlag]: on,
				[oauthFlag]: on
			})) {
				btn.classList.toggle("active", on);
				if (currentRoom) updateUserCredsBanner(currentRoom);
			}
		});
	});
}
var wizardBtnWired = false;
async function renderSettingsWizardButton() {
	const wizardSection = $("#settings-wizard");
	if (!wizardSection) return;
	let ok = false;
	try {
		ok = (await authFetch("/api/workspace-credential")).ok;
	} catch {
		ok = false;
	}
	wizardSection.hidden = !ok;
	if (!ok || wizardBtnWired) return;
	wizardBtnWired = true;
	$("#wizard-open-btn")?.addEventListener("click", () => {
		closeSettings();
		openWizard();
	});
}
var selftestWired = false;
async function renderSelfTest() {
	const section = $("#settings-selftest");
	if (!section) return;
	let ok = false;
	try {
		ok = (await authFetch("/api/workspace-credential")).ok;
	} catch {
		ok = false;
	}
	section.hidden = !ok;
	if (!ok || selftestWired) return;
	selftestWired = true;
	const btn = $("#selftest-run-btn");
	const out = $("#selftest-results");
	btn?.addEventListener("click", async () => {
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = "Running…";
		out.hidden = false;
		out.textContent = "Running checks (this may spin a probe container)…";
		try {
			const res = await authFetch("/api/webchat/preflight");
			const data = await res.json();
			if (!res.ok) {
				out.textContent = data.error || res.statusText;
				return;
			}
			renderPreflightChecks(out, data.checks || []);
		} catch (err) {
			out.textContent = String(err.message || err);
		} finally {
			btn.disabled = false;
			btn.textContent = orig;
		}
	});
}
var PREFLIGHT_ICON = {
	ok: "✓",
	warn: "⚠",
	fail: "✕",
	info: "•"
};
function renderPreflightChecks(container, checks) {
	container.hidden = false;
	container.innerHTML = "";
	if (!checks.length) {
		container.textContent = "No checks ran.";
		return;
	}
	for (const c of checks) {
		const row = document.createElement("div");
		row.className = `preflight-check status-${c.status}`;
		const head = document.createElement("div");
		head.className = "preflight-check-head";
		head.textContent = `${PREFLIGHT_ICON[c.status] || "•"} ${c.label} — ${c.detail}`;
		row.appendChild(head);
		if (c.fix) {
			const pre = document.createElement("pre");
			pre.className = "preflight-fix";
			pre.textContent = c.fix;
			row.appendChild(pre);
			const copy = document.createElement("button");
			copy.type = "button";
			copy.className = "btn btn-ghost";
			copy.textContent = "Copy fix";
			copy.addEventListener("click", async () => {
				try {
					await navigator.clipboard.writeText(c.fix);
					copy.textContent = "Copied";
					setTimeout(() => copy.textContent = "Copy fix", 1500);
				} catch {
					showToast("Copy failed — select the text manually.", { kind: "error" });
				}
			});
			row.appendChild(copy);
		}
		container.appendChild(row);
	}
}
var accessBearerWired = false;
var bearerConfirmTimer = null;
var accessHttpsWired = false;
async function renderAccessSettings() {
	const section = $("#settings-access");
	if (!section) return;
	let info = null;
	try {
		const r = await authFetch("/api/webchat/auth");
		if (r.ok) info = await r.json();
	} catch {
		info = null;
	}
	section.hidden = !info;
	if (!info) return;
	const btn = $("#access-bearer-btn");
	if (!accessBearerWired) {
		accessBearerWired = true;
		btn?.addEventListener("click", () => toggleBearerToken(btn.dataset.want === "enable"));
	}
	clearTimeout(bearerConfirmTimer);
	btn.dataset.confirming = "";
	const badge = $("#access-bearer-badge");
	const setBadge = (text, title) => {
		badge.hidden = false;
		badge.textContent = text;
		badge.title = title;
	};
	if (!info.bearerConfigured) {
		btn.hidden = true;
		setBadge("Not set", "No bearer token is configured — access is controlled by your other auth method.");
	} else if (info.bearerActive && info.canDisableBearer) {
		btn.hidden = false;
		btn.dataset.want = "disable";
		btn.textContent = "Disable";
		setBadge("Active", "You also have Tailscale or SSO, so the shared bearer token is no longer needed.");
	} else if (info.bearerActive) {
		btn.hidden = true;
		setBadge("Required", "Required for access. Set up Tailscale or SSO to retire this shared token.");
	} else {
		btn.hidden = false;
		btn.dataset.want = "enable";
		btn.textContent = "Re-enable";
		setBadge("Disabled", "Access is via Tailscale or SSO. The token in .env is ignored until re-enabled.");
	}
	renderHttpsSettings();
}
async function renderHttpsSettings() {
	const row = $("#access-https-row");
	const hint = $("#access-https-hint");
	const btn = $("#access-https-btn");
	if (!row || !hint || !btn) return;
	if (!accessHttpsWired) {
		accessHttpsWired = true;
		btn.addEventListener("click", () => enableTailscaleHttps());
	}
	let state = null;
	try {
		const r = await authFetch("/api/webchat/tailscale-https");
		if (r.ok) state = await r.json();
	} catch {
		state = null;
	}
	if (!state || !state.available) {
		row.hidden = true;
		hint.hidden = true;
		return;
	}
	row.hidden = false;
	const badge = $("#access-https-badge");
	hint.hidden = true;
	if (state.active) {
		btn.hidden = true;
		badge.hidden = false;
		badge.title = `${state.url || "HTTPS via Tailscale"} — only reachable over your tailnet.`;
	} else {
		badge.hidden = true;
		btn.hidden = false;
		btn.disabled = false;
		btn.textContent = "Enable";
		btn.title = "Serve over Tailscale with a real certificate — enables PWA install, push, and voice.";
	}
}
async function enableTailscaleHttps() {
	const hint = $("#access-https-hint");
	const btn = $("#access-https-btn");
	btn.disabled = true;
	btn.textContent = "Enabling…";
	try {
		const r = await authFetch("/api/webchat/tailscale-https", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok && data.ok) showToast("HTTPS enabled over Tailscale", { kind: "success" });
		else {
			const parts = [data.error, data.hint].filter(Boolean).join(" ");
			showToast(data.error || "Could not enable HTTPS", {
				kind: "error",
				timeout: 9e3
			});
			if (parts) {
				hint.hidden = false;
				hint.innerHTML = data.hintUrl ? `${esc(parts)} <a href="${esc(data.hintUrl)}" target="_blank" rel="noopener">Open admin console</a>` : esc(parts);
			}
		}
	} catch {
		showToast("Connection failed", { kind: "error" });
	} finally {
		renderHttpsSettings();
	}
}
async function toggleBearerToken(wantActive) {
	const btn = $("#access-bearer-btn");
	const hint = $("#access-bearer-hint");
	if (!wantActive && btn.dataset.confirming !== "1") {
		btn.dataset.confirming = "1";
		const restore = btn.textContent;
		btn.textContent = "Click again to disable";
		bearerConfirmTimer = setTimeout(() => {
			btn.dataset.confirming = "";
			btn.textContent = restore;
		}, 4e3);
		return;
	}
	clearTimeout(bearerConfirmTimer);
	btn.dataset.confirming = "";
	btn.disabled = true;
	try {
		const r = await authFetch("/api/webchat/auth/bearer", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ active: wantActive })
		});
		const data = await r.json().catch(() => ({}));
		if (!r.ok) {
			showToast(data.error || "Could not change the bearer setting", {
				kind: "error",
				timeout: 8e3
			});
			if (data.error) {
				hint.hidden = false;
				hint.textContent = data.error;
			}
		} else showToast(wantActive ? "Bearer token re-enabled" : "Bearer token disabled — access is via Tailscale/SSO", { kind: "success" });
	} catch {
		showToast("Connection failed", { kind: "error" });
	} finally {
		btn.disabled = false;
		renderAccessSettings();
	}
}
/**
* Credential isolation — an install policy, shown only to someone who can change
* it. `credentialIsolation` is null when no choice has been made here, in which
* case .env decides and the row says so; the toggle still reflects what is
* actually in force (`credentialIsolationEffective`) so it never contradicts
* the agent panel's "Not private yet" note.
*/
function renderCredentialIsolation(feats) {
	const box = $("#settings-credential-isolation");
	if (!box) return;
	box.hidden = !feats.canEdit;
	if (!feats.canEdit) return;
	const toggle = $("#credential-isolation-toggle");
	toggle.checked = feats.credentialIsolationEffective === true;
	const envNote = $("#credential-isolation-env");
	const following = feats.credentialIsolation === null || feats.credentialIsolation === void 0;
	envNote.hidden = !following;
	if (following) envNote.textContent = "Following CREDENTIAL_ISOLATION in .env";
	if (toggle.dataset.wired) return;
	toggle.dataset.wired = "1";
	toggle.addEventListener("change", async () => {
		const want = toggle.checked;
		toggle.disabled = true;
		try {
			if (!(await authFetch("/api/webchat/features", {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					"X-Webchat-CSRF": "1"
				},
				body: JSON.stringify({ credentialIsolation: want })
			})).ok) throw new Error("save failed");
			envNote.hidden = true;
			showToast(want ? "Credential isolation on — applies as agents restart" : "Credential isolation off");
		} catch {
			toggle.checked = !want;
			showToast("Could not change credential isolation", { kind: "error" });
		} finally {
			toggle.disabled = false;
		}
	});
}
function applyMarketplaceNav() {
	const show = marketplaceEnabled && isAdminView;
	for (const id of [
		"#overflow-mcp",
		"#mtab-mcp-btn",
		"#mtab-skills-btn",
		"#overflow-skills"
	]) {
		const el = $(id);
		if (el) el.hidden = !show;
	}
}
var WIZARD_STEPS = 3;
var wizardStep = 0;
var wizardWired = false;
var wizardOllamaProbe = null;
var wizardEngine = "claude";
var wizardCodexAvailable = false;
var codexInstallActive = false;
var wizardCred = null;
var CODEX_WIZARD_ELS = {
	btn: "#wizard-codex-install",
	log: "#wizard-codex-install-log",
	doneMsg: "Codex loaded — connect your credentials below."
};
var CODEX_SETTINGS_ELS = {
	btn: "#codex-install-btn",
	log: "#codex-install-log",
	progress: "#codex-install-progress"
};
async function runCodexInstall(els = CODEX_WIZARD_ELS) {
	const btn = $(els.btn);
	const log = $(els.log);
	if (!btn || codexInstallActive) return;
	codexInstallActive = true;
	const progress = els.progress ? $(els.progress) : null;
	if (progress) progress.hidden = false;
	log.hidden = false;
	log.textContent = "Installing…";
	let done = wizardBusy(btn, "Installing…");
	const finish = () => {
		log.textContent = els.doneMsg || "Codex installed.";
		showToast("Codex installed", { kind: "success" });
	};
	try {
		const res = await authFetch("/api/codex/install", { method: "POST" });
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			log.textContent = "Install failed: " + (err.error || res.status);
			showToast(err.error || "Codex install failed", { kind: "error" });
			return;
		}
		let restarting = false;
		for (;;) {
			await new Promise((r) => setTimeout(r, 2500));
			let st;
			try {
				st = await (await authFetch("/api/codex/install")).json();
			} catch {
				restarting = true;
				break;
			}
			if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-14).join("\n");
			if (st.installed) {
				finish();
				return;
			}
			if (!st.running && st.exitCode === 0) {
				restarting = true;
				break;
			}
			if (!st.running && st.exitCode != null && st.exitCode !== 0) {
				log.textContent = "Install failed — see log:\n" + (st.lines || []).slice(-14).join("\n");
				showToast("Codex install failed — see log", { kind: "error" });
				return;
			}
		}
		if (restarting) {
			done();
			done = wizardBusy(btn, "Restarting…");
			log.textContent = "Restarting…";
			const deadline = Date.now() + 15e4;
			let sawResponsive = false;
			for (;;) {
				await new Promise((r) => setTimeout(r, 2500));
				let st = null;
				try {
					st = await (await authFetch("/api/codex/install")).json();
					sawResponsive = true;
				} catch {
					st = null;
				}
				if (st?.installed) {
					finish();
					return;
				}
				if (Date.now() > deadline) {
					log.textContent = sawResponsive ? "Codex didn’t load — restart the service, then reopen setup." : "Server didn’t come back — restart it, then reopen setup.";
					showToast("Codex built — restart the server to finish", { kind: "error" });
					return;
				}
			}
		}
	} catch (err) {
		log.textContent = "Install error: " + err.message;
		showToast("Codex install error", { kind: "error" });
	} finally {
		done();
		codexInstallActive = false;
		refreshWizardCredState();
		renderCredentialsSettings();
	}
}
var opencodeInstallActive = false;
var opencodeGateFromServer = false;
var opencodeGatePoll = null;
var OPENCODE_WIZARD_ELS = {
	btn: "#wizard-opencode-install",
	log: "#wizard-opencode-install-log",
	doneMsg: "OpenCode installed — your local agent can now use it (Agent → Harness)."
};
var OPENCODE_SETTINGS_ELS = {
	btn: "#opencode-install-btn",
	log: "#opencode-install-log",
	progress: "#opencode-install-progress"
};
var PI_SETTINGS_ELS = {
	btn: "#pi-install-btn",
	log: "#pi-install-log",
	progress: "#pi-install-progress",
	url: "/api/pi/install",
	name: "pi",
	doneMsg: "pi installed — switch an agent to it under Agent → Harness."
};
async function runOpencodeInstall(els = OPENCODE_WIZARD_ELS) {
	const url = els.url || "/api/opencode/install";
	const name = els.name || "OpenCode";
	const btn = $(els.btn);
	const log = $(els.log);
	if (!btn || opencodeInstallActive) return;
	opencodeInstallActive = true;
	refreshWizardNextGate();
	const progress = els.progress ? $(els.progress) : null;
	if (progress) progress.hidden = false;
	log.hidden = false;
	log.textContent = "Installing…";
	let done = wizardBusy(btn, "Installing…");
	const finish = () => {
		log.textContent = els.doneMsg || name + " installed.";
		showToast(name + " installed", { kind: "success" });
	};
	try {
		const res = await authFetch(url, { method: "POST" });
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (err.code === "already-installed") {
				finish();
				return;
			}
			log.textContent = "Install failed: " + (err.error || res.status);
			showToast(err.error || name + " install failed", { kind: "error" });
			return;
		}
		let restarting = false;
		for (;;) {
			await new Promise((r) => setTimeout(r, 2500));
			let st;
			try {
				st = await (await authFetch(url)).json();
			} catch {
				restarting = true;
				break;
			}
			if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-14).join("\n");
			if (st.installed) {
				finish();
				return;
			}
			if (!st.running && st.exitCode === 0) {
				restarting = true;
				break;
			}
			if (!st.running && st.exitCode != null && st.exitCode !== 0) {
				log.textContent = "Install failed — see log:\n" + (st.lines || []).slice(-14).join("\n");
				showToast(name + " install failed — see log", { kind: "error" });
				return;
			}
		}
		if (restarting) {
			done();
			done = wizardBusy(btn, "Restarting…");
			log.textContent = "Restarting…";
			const deadline = Date.now() + 15e4;
			let sawResponsive = false;
			for (;;) {
				await new Promise((r) => setTimeout(r, 2500));
				let st = null;
				try {
					st = await (await authFetch(url)).json();
					sawResponsive = true;
				} catch {
					st = null;
				}
				if (st?.installed) {
					finish();
					return;
				}
				if (Date.now() > deadline) {
					log.textContent = sawResponsive ? "OpenCode didn’t load — restart the service, then reopen setup." : "Server didn’t come back — restart it, then reopen setup.";
					showToast(name + " built — restart the server to finish", { kind: "error" });
					return;
				}
			}
		}
	} catch (err) {
		log.textContent = "Install error: " + err.message;
		showToast(name + " install error", { kind: "error" });
	} finally {
		done();
		opencodeInstallActive = false;
		refreshWizardNextGate();
		renderWizardOpencodeInstall();
		renderCredentialsSettings();
		fetchAgents();
	}
}
async function renderWizardOpencodeInstall() {
	const row = $("#wizard-opencode-install-row");
	const hint = $("#wizard-opencode-hint");
	if (!row) return;
	if (!!($("#wizard-ollama-connected")?.hidden ?? true)) {
		row.hidden = true;
		if (hint) hint.hidden = true;
		return;
	}
	let installed = false;
	let running = false;
	try {
		const st = await (await authFetch("/api/opencode/install")).json();
		installed = !!st.installed;
		running = !!st.running;
	} catch {}
	const badge = $("#wizard-opencode-installed-badge");
	const btn = $("#wizard-opencode-install");
	row.hidden = false;
	if (hint) hint.hidden = installed;
	if (badge) badge.hidden = !installed;
	if (btn && !opencodeInstallActive) btn.hidden = installed;
	opencodeGateFromServer = running;
	refreshWizardNextGate();
	if (running) {
		clearTimeout(opencodeGatePoll);
		opencodeGatePoll = setTimeout(renderWizardOpencodeInstall, 3e3);
	}
}
$("#wizard-opencode-install")?.addEventListener("click", () => runOpencodeInstall(OPENCODE_WIZARD_ELS));
function buildWizardDots() {
	const dots = $("#wizard-dots");
	if (!dots) return;
	dots.innerHTML = "";
	for (let i = 0; i < WIZARD_STEPS; i++) {
		const d = document.createElement("span");
		d.className = "wizard-dot";
		dots.appendChild(d);
	}
}
/**
* Reflect live credential state on the engine list: connected engines swap
* their connect controls for a prominent ✓ card (standard OAuth-connect UX —
* the action you completed disappears), and the radio chips update without a
* wizard reopen. Also greys Codex out when its provider isn't installed.
*/
async function refreshWizardCredState() {
	let s;
	try {
		const r = await authFetch("/api/workspace-credential");
		if (!r.ok) return;
		s = await r.json();
	} catch {
		return;
	}
	wizardCred = s;
	wizardCodexAvailable = !!s.codexAvailable;
	const credWord = (t) => t === "oauth_token" ? "subscription" : "API key";
	const claudeChip = $("#wizard-chip-claude");
	if (claudeChip) {
		claudeChip.hidden = false;
		claudeChip.textContent = s.connected ? "✓ connected" : "not connected";
		claudeChip.classList.toggle("ok", !!s.connected);
	}
	$("#wizard-claude-connect").hidden = !!s.connected;
	$("#wizard-claude-connected").hidden = !s.connected;
	if (s.connected) $("#wizard-claude-connected-text").textContent = s.external ? "Claude connected" : `Claude connected — ${credWord(s.credType)}`;
	$("#wizard-claude-disconnect").hidden = !!s.external;
	const codexChip = $("#wizard-chip-codex");
	if (codexChip) {
		codexChip.hidden = false;
		codexChip.textContent = s.codex?.connected ? "✓ connected" : wizardCodexAvailable ? "not connected" : "not installed";
		codexChip.classList.toggle("ok", !!s.codex?.connected);
	}
	const codexInstallRow = $("#wizard-codex-install-row");
	if (codexInstallRow && !codexInstallActive) codexInstallRow.hidden = wizardCodexAvailable;
	$("#wizard-codex-connect").hidden = !wizardCodexAvailable || !!s.codex?.connected;
	$("#wizard-codex-connected").hidden = !s.codex?.connected;
	if (s.codex?.connected) $("#wizard-codex-connected-text").textContent = s.codex.external ? "Codex connected" : `Codex connected — ${credWord(s.codex.credType)}`;
	const codexDisconnect = $("#wizard-codex-disconnect");
	if (codexDisconnect) codexDisconnect.hidden = !!s.codex?.external;
	const ollamaSet = s.defaultModelKind === "ollama" && !!s.defaultModelId;
	const ollamaModel = s.defaultModelModelId || s.defaultModelName;
	const ollamaChip = $("#wizard-chip-ollama");
	if (ollamaChip) {
		ollamaChip.hidden = false;
		ollamaChip.textContent = ollamaSet ? `✓ ${ollamaModel}` : "no model";
		ollamaChip.classList.toggle("ok", ollamaSet);
	}
	const ollamaCard = $("#wizard-ollama-connected");
	const ollamaSetup = $("#wizard-ollama-setup");
	if (ollamaCard && ollamaSetup) {
		ollamaCard.hidden = !ollamaSet;
		ollamaSetup.hidden = ollamaSet;
		if (ollamaSet) $("#wizard-ollama-connected-text").textContent = `${ollamaModel} · default`;
	}
	renderWizardOpencodeInstall();
}
/** Reveal the wizard's install-Ollama row when nothing answers locally (Linux
*  only), or prefill the endpoint when a local Ollama is already running. */
async function wizardCheckLocalOllama() {
	try {
		const r = await authFetch("/api/ollama/local");
		if (!r.ok) return;
		const st = await r.json();
		if (st.reachable) {
			const url = $("#wizard-ollama-url");
			if (url && !url.value) url.value = "http://localhost:11434";
			$("#wizard-ollama-install-row").hidden = true;
			$("#wizard-ollama-dl-row").hidden = false;
			wizardLoadRecommendation();
			wizardReattachPull();
		} else $("#wizard-ollama-install-row").hidden = !st.canInstall;
	} catch {}
}
async function wizardFollowPull(host, model) {
	const btn = $("#wizard-ollama-dl");
	const bar = $("#wizard-ollama-pull-bar");
	const done = wizardBusy(btn, "Downloading…");
	bar.hidden = false;
	try {
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			const { pulls } = await (await authFetch("/api/ollama/pulls")).json();
			const job = (pulls || []).find((j) => j.model === model && j.host === host);
			if (!job) continue;
			const pct = job.total > 0 ? Math.round(job.completed / job.total * 100) : 0;
			bar.querySelector("span").style.width = pct + "%";
			wizardSetStatus("#wizard-ollama-dl-status", `${job.detail || "downloading…"} (${pct}%)`, null);
			if (job.status === "success") {
				bar.hidden = true;
				wizardSetStatus("#wizard-ollama-dl-status", `${model} downloaded — setting it as the default…`, "ok");
				const probed = await wizardProbeOllama();
				if (probed && (probed.models || []).some((m) => String(m) === model)) {
					const radio = [...document.querySelectorAll("input[name=\"wizard-ollama-model\"]")].find((el) => el.value === model);
					if (radio) radio.checked = true;
					await wizardSelectOllamaModel(model);
					wizardSetStatus("#wizard-ollama-dl-status", `${model} downloaded and set as the workspace default.`, "ok");
				} else wizardSetStatus("#wizard-ollama-dl-status", `${model} downloaded — pick it above to set the default.`, "ok");
				return;
			}
			if (job.status === "error") {
				bar.hidden = true;
				return wizardSetStatus("#wizard-ollama-dl-status", job.error || "Pull failed.", "err");
			}
		}
	} finally {
		done();
	}
}
async function wizardProbeOllama() {
	const url = ($("#wizard-ollama-url")?.value || "").trim() || "http://localhost:11434";
	const done = wizardBusy($("#wizard-ollama-probe"), "Probing…");
	$("#wizard-ollama-status").hidden = true;
	try {
		const r = await authFetch("/api/models/probe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url })
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok) {
			wizardSetStatus("#wizard-ollama-status", body.error || `Probe failed (${r.status}).`, "err");
			return null;
		}
		if (!body.kind || !(body.models || []).length) {
			wizardSetStatus("#wizard-ollama-status", body.reason || "No models found at that endpoint.", "err");
			return null;
		}
		wizardOllamaProbe = body;
		const list = $("#wizard-ollama-list");
		list.innerHTML = "";
		body.models.forEach((m) => {
			const value = String(m);
			const li = document.createElement("li");
			const label = document.createElement("label");
			const radio = document.createElement("input");
			radio.type = "radio";
			radio.name = "wizard-ollama-model";
			radio.value = value;
			const span = document.createElement("span");
			span.textContent = value;
			label.appendChild(radio);
			label.appendChild(span);
			li.appendChild(label);
			list.appendChild(li);
		});
		$("#wizard-ollama-results").hidden = false;
		$("#wizard-ollama-dl-row").hidden = false;
		wizardLoadRecommendation();
		const ollamaStatusEl = $("#wizard-ollama-status");
		if (ollamaStatusEl) ollamaStatusEl.hidden = true;
		return body;
	} finally {
		done();
	}
}
async function wizardSelectOllamaModel(modelId) {
	if (!wizardOllamaProbe || !modelId) return;
	const endpoint = String(wizardOllamaProbe.endpoint || "").replace(/\/+$/, "");
	const host = (() => {
		try {
			return new URL(wizardOllamaProbe.endpoint).host;
		} catch {
			return wizardOllamaProbe.endpoint;
		}
	})();
	wizardSetStatus("#wizard-ollama-status", `Setting ${modelId} as the default…`, null);
	try {
		let id = null;
		try {
			const roster = await (await authFetch("/api/models")).json();
			id = (Array.isArray(roster) ? roster : []).find((m) => m.kind === "ollama" && String(m.endpoint || "").replace(/\/+$/, "") === endpoint && m.model_id === modelId)?.id ?? null;
		} catch {}
		if (!id) {
			const r = await authFetch("/api/models/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ models: [{
					name: `${host} · ${modelId}`,
					kind: wizardOllamaProbe.kind,
					endpoint: wizardOllamaProbe.endpoint,
					model_id: modelId
				}] })
			});
			const out = await r.json().catch(() => ({}));
			const created = out.created?.[0];
			if (!r.ok || !created) {
				wizardSetStatus("#wizard-ollama-status", out.error || out.failed?.[0]?.error || "Add failed.", "err");
				return;
			}
			id = created.id;
		}
		const dr = await authFetch("/api/workspace-model", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ modelId: id })
		});
		if (!dr.ok) {
			wizardSetStatus("#wizard-ollama-status", "Setting the default failed: " + ((await dr.json().catch(() => ({}))).error || dr.statusText), "err");
			return;
		}
		$("#wizard-ollama-status").hidden = true;
		await refreshWizardCredState();
	} catch {
		wizardSetStatus("#wizard-ollama-status", "Setting the default failed.", "err");
	}
}
async function wizardClearOllamaDefault() {
	if (wizardCred?.defaultModelKind !== "ollama" || !wizardCred?.defaultModelId) return;
	try {
		await authFetch("/api/workspace-model", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ modelId: null })
		});
		await refreshWizardCredState();
	} catch {}
}
var wizardRecLoaded = false;
async function wizardLoadRecommendation() {
	if (wizardRecLoaded) return;
	const hint = $("#wizard-ollama-rec");
	const input = $("#wizard-ollama-dl-model");
	try {
		const r = await authFetch("/api/ollama/recommend");
		if (!r.ok) return;
		const { recommendation: rec, remoteOllama } = await r.json();
		wizardRecLoaded = true;
		if (input && !input.value) input.value = rec.model.id;
		if (hint) {
			const remote = remoteOllama?.present === true;
			const fit = remote ? "remote Ollama" : rec.tight ? "tight fit" : rec.basis === "gpu" ? "GPU" : "good fit";
			hint.hidden = false;
			hint.textContent = `Recommended: ${rec.model.id} · ${fit}`;
			hint.title = remote ? `Runs on your remote Ollama (${remoteOllama.endpoint}). ${rec.detected}` : rec.detected;
			hint.classList.toggle("err", !remote && !!rec.tight);
		}
	} catch {
		if (input && !input.value) input.value = "qwen3:1.7b";
	}
}
async function wizardReattachPull() {
	try {
		const host = ($("#wizard-ollama-url")?.value || "").trim() || "http://localhost:11434";
		const { pulls } = await (await authFetch("/api/ollama/pulls")).json();
		const job = (pulls || []).find((j) => j.host === host && j.status === "pulling");
		if (!job) return;
		$("#wizard-ollama-dl-model").value = job.model;
		await wizardFollowPull(host, job.model);
	} catch {}
}
function syncWizardEngineBodies() {
	document.querySelectorAll(".wizard-engine-body").forEach((b) => {
		b.hidden = b.dataset.engine !== wizardEngine;
	});
}
function wizardEngineConnected() {
	const s = wizardCred || {};
	if (wizardEngine === "codex") return !!s.codex?.connected;
	if (wizardEngine === "ollama") return !!s.defaultModelId;
	return !!s.connected;
}
function showWizardStep(i) {
	wizardStep = Math.max(0, Math.min(2, i));
	document.querySelectorAll(".wizard-step").forEach((s) => {
		s.hidden = Number(s.dataset.step) !== wizardStep;
	});
	if (wizardStep === 0) syncWizardEngineBodies();
	if (wizardStep === 1) renderWizardAccess();
	if (wizardStep === 2) renderWizardFeatures();
	document.querySelectorAll("#wizard-dots .wizard-dot").forEach((d, idx) => {
		d.classList.toggle("active", idx === wizardStep);
		d.classList.toggle("done", idx < wizardStep);
	});
	$("#wizard-back").hidden = wizardStep === 0;
	const isLast = wizardStep === 2;
	$("#wizard-next").textContent = isLast ? "Finish" : "Next";
	refreshWizardNextGate();
}
function refreshWizardNextGate() {
	const btn = $("#wizard-next");
	if (!btn) return;
	if (opencodeInstallActive || opencodeGateFromServer) {
		btn.disabled = true;
		btn.dataset.gated = "1";
		btn.textContent = "Installing OpenCode…";
		btn.title = "Hang tight — finishing now would interrupt your first message when the harness restarts.";
	} else if (btn.dataset.gated) {
		delete btn.dataset.gated;
		btn.disabled = false;
		btn.title = "";
		btn.textContent = wizardStep === 2 ? "Finish" : "Next";
	}
}
async function openWizard() {
	wireWizard();
	buildWizardDots();
	showWizardStep(0);
	await refreshWizardCredState();
	$("#wizard-overlay").hidden = false;
}
function closeWizard() {
	$("#wizard-overlay").hidden = true;
}
async function finishWizard() {
	try {
		await authFetch("/api/webchat/onboarding", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ complete: true })
		});
	} catch {}
	wizardStopTsPoll();
	closeWizard();
}
/**
* Put an async wizard button into a busy state: disabled, label swapped, and a
* small inline spinner — the "doing something" signal lives ON the control the
* user just pressed. Returns a restore function for the finally block.
*/
function wizardBusy(btn, busyLabel) {
	const original = btn.textContent;
	btn.disabled = true;
	btn.textContent = "";
	const spin = document.createElement("span");
	spin.className = "btn-spinner";
	spin.setAttribute("aria-hidden", "true");
	btn.appendChild(spin);
	btn.appendChild(document.createTextNode(busyLabel));
	return () => {
		btn.disabled = false;
		btn.textContent = original;
	};
}
function wizardSetStatus(id, text, kind) {
	const el = $(id);
	if (!el) return;
	el.hidden = false;
	el.textContent = text;
	el.classList.toggle("ok", kind === "ok");
	el.classList.toggle("err", kind === "err");
}
async function wizardProbeHttps() {
	const row = $("#wizard-https-row");
	if (!row) return;
	let state = null;
	try {
		const r = await authFetch("/api/webchat/tailscale-https");
		if (r.ok) state = await r.json();
	} catch {
		state = null;
	}
	if (state && state.available && !state.active) {
		row.hidden = false;
		wizardSetStatus("#wizard-https-status", "", null);
		$("#wizard-https-status").hidden = true;
	} else if (state && state.active) {
		row.hidden = false;
		$("#wizard-https-btn").hidden = true;
		wizardSetStatus("#wizard-https-status", "HTTPS is already on.", "ok");
	} else row.hidden = true;
}
async function wizardEnableHttps() {
	const btn = $("#wizard-https-btn");
	btn.disabled = true;
	const restore = btn.textContent;
	btn.textContent = "Enabling…";
	try {
		const r = await authFetch("/api/webchat/tailscale-https", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok && data.ok) {
			btn.hidden = true;
			wizardSetStatus("#wizard-https-status", data.url ? `HTTPS on — reach this at ${data.url}` : "HTTPS enabled.", "ok");
			showToast("HTTPS enabled over Tailscale", { kind: "success" });
		} else {
			const msg = [data.error, data.hint].filter(Boolean).join(" ") || "Could not enable HTTPS";
			wizardSetStatus("#wizard-https-status", msg, "err");
			if (data.hintUrl) {
				const el = $("#wizard-https-status");
				el.innerHTML = `${esc(msg)} <a href="${esc(data.hintUrl)}" target="_blank" rel="noopener">Open admin console</a>`;
			}
			showToast(data.error || "Could not enable HTTPS", {
				kind: "error",
				timeout: 9e3
			});
		}
	} catch {
		wizardSetStatus("#wizard-https-status", "Connection failed.", "err");
	} finally {
		btn.disabled = false;
		if (!btn.hidden) btn.textContent = restore;
	}
}
function syncWizardAccessBodies() {
	const sel = document.querySelector("input[name=\"wizard-access\"]:checked")?.value || "bearer";
	document.querySelectorAll(".wizard-engine-body[data-access]").forEach((b) => {
		b.hidden = b.dataset.access !== sel;
	});
	if (sel === "tailscale") wizardProbeHttps();
	wizardStartTsPollIfNeeded();
}
var wizardTtsWired = false;
var WIZARD_TTS_ELS = {
	btn: "#wizard-tts-install",
	log: "#wizard-tts-log",
	progress: "#wizard-tts-progress"
};
var wizardSttWired = false;
var wizardSttBackend = "local";
var WIZARD_STT_ELS = {
	btn: "#wizard-stt-install",
	log: "#wizard-stt-log",
	progress: "#wizard-stt-log"
};
async function renderWizardDictation() {
	const section = $("#wizard-stt-section");
	if (!section) return;
	let st = null;
	try {
		const r = await authFetch("/api/webchat/stt/install");
		if (r.ok) st = await r.json();
	} catch {
		st = null;
	}
	if (!st) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	const enable = $("#wizard-stt-enable");
	if (enable) enable.checked = !!st.enabled;
	if (!wizardSttWired) {
		wizardSttWired = true;
		enable?.addEventListener("change", async () => {
			const on = enable.checked;
			if (!(await authFetch("/api/stt/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: on })
			})).ok) {
				enable.checked = !on;
				showToast("Could not update voice dictation", { kind: "error" });
				return;
			}
			renderWizardDictation();
		});
		document.querySelectorAll("#wizard-stt-backend input[type=\"radio\"]").forEach((b) => {
			b.addEventListener("change", () => {
				if (!b.checked) return;
				wizardSttBackend = b.value;
				renderWizardDictation();
			});
		});
		$("#wizard-stt-install")?.addEventListener("click", () => runSttInstall({ provider: "local" }, WIZARD_STT_ELS, renderWizardDictation));
		$("#wizard-stt-connect")?.addEventListener("click", () => {
			const key = ($("#wizard-stt-key")?.value || "").trim();
			if (!key) {
				showToast("Enter the ElevenLabs API key first", { kind: "error" });
				return;
			}
			runSttInstall({
				provider: "elevenlabs",
				apiKey: key
			}, WIZARD_STT_ELS, renderWizardDictation);
			$("#wizard-stt-key").value = "";
		});
	}
	const group = $("#wizard-stt-group");
	if (group) group.hidden = !st.enabled;
	if (!st.enabled) return;
	const installed = !!st.installed;
	const backend = installed ? st.provider || wizardSttBackend : wizardSttBackend;
	document.querySelectorAll("#wizard-stt-backend input[type=\"radio\"]").forEach((b) => {
		b.checked = b.value === backend;
	});
	const local = backend === "local";
	const badge = $("#wizard-stt-installed");
	if (badge) badge.hidden = !installed;
	const badgeText = $("#wizard-stt-installed-text");
	if (badgeText) badgeText.textContent = local ? "Whisper installed" : "ElevenLabs connected";
	const installRow = $("#wizard-stt-install-row");
	if (installRow) installRow.hidden = installed || !local || !st.installerPresent;
	const keyRow = $("#wizard-stt-key-row");
	if (keyRow) keyRow.hidden = installed || local;
	if (st.running) pollSttInstall(WIZARD_STT_ELS, renderWizardDictation);
}
async function renderWizardFeatures() {
	renderWizardDictation();
	const mkt = $("#wizard-marketplace");
	if (mkt) mkt.checked = marketplaceEnabled === true;
	const ttsDefault = $("#wizard-tts-default");
	if (ttsDefault) ttsDefault.checked = getTtsReadAloudEnabled();
	if (!wizardTtsWired) {
		wizardTtsWired = true;
		ttsDefault?.addEventListener("change", async () => {
			const on = ttsDefault.checked;
			try {
				if (!(await authFetch("/api/tts/config", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ readAloud: on })
				})).ok) throw new Error("save failed");
				setTtsReadAloudEnabled(on);
				if (!on) stopTts();
				renderWizardFeatures();
			} catch {
				ttsDefault.checked = !on;
				showToast("Failed to save Read aloud", { kind: "error" });
			}
		});
		$("#wizard-tts-install")?.addEventListener("click", () => runTtsInstall(WIZARD_TTS_ELS));
		$("#wizard-autolearn")?.addEventListener("change", async () => {
			const on = $("#wizard-autolearn").checked;
			try {
				if (!(await authFetch("/api/learning/config", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: on })
				})).ok) throw new Error("save failed");
				learningMasterEnabled = on;
				applyLearningMaster();
			} catch {
				$("#wizard-autolearn").checked = !on;
				showToast("Failed to save auto-learn", { kind: "error" });
			}
		});
	}
	const alBox = $("#wizard-autolearn");
	if (alBox) alBox.checked = learningMasterEnabled;
	const row = $("#wizard-tts-install-row");
	const badge = $("#wizard-tts-installed");
	const progress = $("#wizard-tts-progress");
	const btn = $("#wizard-tts-install");
	const ttsOn = !!ttsDefault?.checked;
	let st = null;
	try {
		const res = await authFetch("/api/webchat/tts/install");
		if (res.ok) st = await res.json();
	} catch {
		st = null;
	}
	if (!st || !ttsOn) {
		if (row) row.hidden = true;
		if (badge) badge.hidden = true;
		if (progress) progress.hidden = !(st && st.running);
		if (st && st.running) pollTtsInstall(WIZARD_TTS_ELS);
		return;
	}
	if (st.installed) {
		if (row) row.hidden = true;
		if (badge) badge.hidden = false;
		if (progress) progress.hidden = !st.running;
		if (btn) btn.textContent = "Install Kokoro…";
		if (st.running) pollTtsInstall(WIZARD_TTS_ELS);
		return;
	}
	if (badge) badge.hidden = true;
	if (row) row.hidden = !st.installerPresent;
	if (st.running) pollTtsInstall(WIZARD_TTS_ELS);
	else if (btn) {
		btn.disabled = false;
		btn.textContent = "Install Kokoro…";
	}
}
var wizardAuthInfo = null;
async function wizardAccessReady() {
	const sel = document.querySelector("input[name=\"wizard-access\"]:checked")?.value || "bearer";
	if (sel === "bearer" || sel === "localhost") return true;
	let info = wizardAuthInfo;
	try {
		const r = await authFetch("/api/webchat/auth");
		if (r.ok) {
			info = await r.json();
			wizardAuthInfo = info;
		}
	} catch {}
	if (sel === "tailscale") return !!(info && info.tailscale && info.tailscale.healthy);
	if (sel === "sso") return !!(info && info.proxy);
	return true;
}
var tailscaleInstallActive = false;
var cloudflaredInstallActive = false;
async function runTailscaleInstall() {
	const btn = $("#wizard-ts-install-btn");
	const log = $("#wizard-ts-install-log");
	if (log) {
		log.hidden = false;
		log.textContent = "Starting…";
	}
	if (btn) {
		btn.disabled = true;
		btn.textContent = "Installing…";
	}
	try {
		const res = await authFetch("/api/webchat/tailscale/install", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = err.error || "Install failed to start.";
			showToast(err.error || "Tailscale install failed", {
				kind: "error",
				timeout: 9e3
			});
			if (btn) {
				btn.disabled = false;
				btn.textContent = "Install Tailscale…";
			}
			return;
		}
		pollTailscaleInstall();
	} catch (err) {
		if (log) log.textContent = "Install failed: " + err.message;
		if (btn) {
			btn.disabled = false;
			btn.textContent = "Install Tailscale…";
		}
	}
}
async function pollTailscaleInstall() {
	if (tailscaleInstallActive) return;
	tailscaleInstallActive = true;
	const btn = $("#wizard-ts-install-btn");
	const log = $("#wizard-ts-install-log");
	if (log) log.hidden = false;
	if (btn) btn.disabled = true;
	try {
		for (;;) {
			const st = await (await authFetch("/api/webchat/tailscale/install")).json();
			if (log) {
				log.textContent = (st.lines || []).slice(-14).join("\n") || "Starting…";
				log.scrollTop = log.scrollHeight;
			}
			if (!st.running) {
				if (st.exitCode === 0) showToast("Tailscale is up — first tailnet sign-in becomes owner", { kind: "success" });
				else showToast("Tailscale install/sign-in didn’t finish — see the log", {
					kind: "error",
					timeout: 9e3
				});
				break;
			}
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast("Tailscale install error: " + err.message, { kind: "error" });
	} finally {
		tailscaleInstallActive = false;
		if (btn) {
			btn.disabled = false;
			btn.textContent = "Install Tailscale…";
		}
		renderWizardAccess();
	}
}
async function runCloudflaredBinaryInstall() {
	const btn = $("#wizard-cf-install-btn");
	const log = $("#wizard-cf-install-log");
	if (log) {
		log.hidden = false;
		log.textContent = "Starting…";
	}
	const done = btn ? wizardBusy(btn, "Installing…") : null;
	try {
		const res = await authFetch("/api/webchat/cloudflared/install", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = err.error || "Install failed to start.";
			showToast(err.error || "cloudflared install failed", {
				kind: "error",
				timeout: 9e3
			});
			done?.();
			return;
		}
		done?.();
		pollCloudflared({
			btn: "#wizard-cf-install-btn",
			success: "cloudflared installed — paste your tunnel token"
		});
	} catch (err) {
		if (log) log.textContent = "Install failed: " + err.message;
		done?.();
	}
}
async function runCloudflaredConnect() {
	const btn = $("#wizard-cf-connect-btn");
	const log = $("#wizard-cf-install-log");
	const tokenEl = $("#wizard-cf-token");
	const token = (tokenEl?.value || "").trim();
	if (!token) {
		showToast("Paste the tunnel token first", { kind: "error" });
		return;
	}
	if (log) {
		log.hidden = false;
		log.textContent = "Starting…";
	}
	const done = btn ? wizardBusy(btn, "Connecting…") : null;
	try {
		const res = await authFetch("/api/webchat/cloudflared/connect", {
			method: "POST",
			headers: {
				"X-Webchat-CSRF": "1",
				"Content-Type": "application/json"
			},
			body: JSON.stringify({ token })
		});
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = err.error || "Connect failed to start.";
			showToast(err.error || "Cloudflare Tunnel connect failed", {
				kind: "error",
				timeout: 9e3
			});
			done?.();
			return;
		}
		if (tokenEl) tokenEl.value = "";
		done?.();
		pollCloudflared({
			btn: "#wizard-cf-connect-btn",
			success: "Cloudflare Tunnel connected"
		});
	} catch (err) {
		if (log) log.textContent = "Connect failed: " + err.message;
		done?.();
	}
}
async function pollCloudflared({ btn: btnSel, success }) {
	if (cloudflaredInstallActive) return;
	cloudflaredInstallActive = true;
	const btn = btnSel ? $(btnSel) : null;
	const log = $("#wizard-cf-install-log");
	if (log) log.hidden = false;
	const done = btn ? wizardBusy(btn, "Working…") : null;
	try {
		for (;;) {
			const st = await (await authFetch("/api/webchat/cloudflared")).json();
			if (log) {
				log.textContent = (st.lines || []).slice(-14).join("\n") || "Starting…";
				log.scrollTop = log.scrollHeight;
			}
			if (!st.running) {
				if (st.exitCode === 0) showToast(success, { kind: "success" });
				else showToast("cloudflared step didn’t finish — see the log", {
					kind: "error",
					timeout: 9e3
				});
				break;
			}
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast("cloudflared error: " + err.message, { kind: "error" });
	} finally {
		cloudflaredInstallActive = false;
		done?.();
		renderWizardAccess();
	}
}
var wizardAccessDefaulted = false;
var wizardBearerPendingRestart = false;
var wizardTsPoll = null;
function wizardStopTsPoll() {
	if (wizardTsPoll) {
		clearInterval(wizardTsPoll);
		wizardTsPoll = null;
	}
}
function wizardStartTsPollIfNeeded() {
	const sel = document.querySelector("input[name=\"wizard-access\"]:checked")?.value;
	const healthy = !!(wizardAuthInfo && wizardAuthInfo.tailscale && wizardAuthInfo.tailscale.healthy);
	if (sel !== "tailscale" || healthy) {
		wizardStopTsPoll();
		return;
	}
	if (wizardTsPoll) return;
	wizardTsPoll = setInterval(async () => {
		try {
			const r = await authFetch("/api/webchat/auth");
			if (!r.ok) return;
			const info = await r.json();
			if (info && info.tailscale && info.tailscale.healthy) {
				wizardStopTsPoll();
				renderWizardAccess();
			}
		} catch {}
	}, 4e3);
}
async function renderWizardAccess() {
	const stateEl = $("#wizard-access-state");
	let info = null;
	try {
		const r = await authFetch("/api/webchat/auth");
		if (r.ok) info = await r.json();
	} catch {
		info = null;
	}
	wizardAuthInfo = info;
	const tsHealthy = !!(info && info.tailscale && info.tailscale.healthy);
	const tsAuthActive = !!(info && info.tailscale && info.tailscale.enabled && info.tailscale.healthy);
	const proxyOn = !!(info && info.proxy);
	const bearerOn = !!(info && info.bearerActive);
	const localhostOnly = !!(info && info.loopback) && !bearerOn && !tsAuthActive && !proxyOn;
	const chip = (id, text, ok) => {
		const el = $(id);
		if (!el) return;
		el.hidden = !info;
		el.textContent = text;
		el.classList.toggle("ok", ok);
	};
	chip("#wizard-access-localhost-chip", localhostOnly ? "active" : "off", localhostOnly);
	chip("#wizard-access-bearer-chip", bearerOn ? "active" : "off", bearerOn);
	chip("#wizard-access-ts-chip", tsHealthy ? "✓ up" : "not detected", tsHealthy);
	chip("#wizard-access-sso-chip", proxyOn ? "✓ active" : "not configured", proxyOn);
	if (!wizardAccessDefaulted && info) {
		wizardAccessDefaulted = true;
		if (localhostOnly) {
			const r = document.querySelector("input[name=\"wizard-access\"][value=\"localhost\"]");
			if (r) r.checked = true;
		}
	}
	const tsReady = $("#wizard-ts-ready");
	if (tsReady) tsReady.hidden = !tsHealthy;
	const tsHelper = $("#wizard-ts-helper");
	const tsRow = $("#wizard-ts-install-row");
	const tsManual = $("#wizard-ts-manual");
	if (tsHealthy) {
		if (tsHelper) tsHelper.hidden = true;
		if (tsRow) tsRow.hidden = true;
		if (tsManual) tsManual.hidden = true;
	} else {
		let ts = null;
		try {
			const r = await authFetch("/api/webchat/tailscale/install");
			if (r.ok) ts = await r.json();
		} catch {
			ts = null;
		}
		const canInstall = !!(ts && ts.canInstall);
		const tunPresent = !!(ts && ts.tunPresent);
		const isRoot = !!(ts && ts.isRoot);
		if (tsRow) tsRow.hidden = !canInstall;
		if (tsManual) tsManual.hidden = !(!canInstall && tunPresent && !isRoot);
		if (tsHelper) tsHelper.hidden = !(!canInstall && !tunPresent);
		if (canInstall && ts.running) pollTailscaleInstall();
	}
	let cf = null;
	try {
		const r = await authFetch("/api/webchat/cloudflared");
		if (r.ok) cf = await r.json();
	} catch {
		cf = null;
	}
	const cfService = !!(cf && cf.serviceInstalled);
	const cfBinary = !!(cf && cf.installed);
	const cfCanInstall = !!(cf && cf.canInstall);
	chip("#wizard-access-cf-chip", cfService ? "✓ running" : cfBinary ? "installed" : "not set up", cfService);
	const cfReady = $("#wizard-cf-ready");
	if (cfReady) cfReady.hidden = !cfService;
	const cfHelper = $("#wizard-cf-helper");
	if (cfHelper) cfHelper.hidden = cfService || cfCanInstall;
	const cfInstallRow = $("#wizard-cf-install-row");
	if (cfInstallRow) cfInstallRow.hidden = cfService || !cfCanInstall || cfBinary;
	const cfConnect = $("#wizard-cf-connect");
	if (cfConnect) cfConnect.hidden = cfService || !cfCanInstall || !cfBinary;
	if (cfCanInstall && cf.running) pollCloudflared({
		btn: null,
		success: "cloudflared step complete"
	});
	const retireRow = $("#wizard-retire-row");
	if (retireRow) retireRow.hidden = !(info && info.canDisableBearer);
	const bearerUnset = !!(info && !info.bearerConfigured);
	const bearerGenRow = $("#wizard-bearer-gen-row");
	if (bearerGenRow && !wizardBearerPendingRestart) bearerGenRow.hidden = !bearerUnset;
	if (stateEl) {
		if (!info) stateEl.textContent = "Access settings are available to the owner.";
		else {
			const methods = [];
			if (tsAuthActive) methods.push("Tailscale identity");
			if (proxyOn) methods.push("reverse-proxy SSO");
			if (bearerOn) methods.push("a bearer token");
			stateEl.textContent = methods.length ? `Secured by ${methods.join(" + ")}.` : "Loopback-only — no network auth configured.";
		}
	}
	syncWizardAccessBodies();
}
async function wizardRetireBearer() {
	const done = wizardBusy($("#wizard-retire-btn"), "Retiring…");
	try {
		const r = await authFetch("/api/webchat/auth/bearer", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ active: false })
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok) {
			showToast("Bearer token retired — access is via Tailscale/SSO", { kind: "success" });
			await renderWizardAccess();
		} else wizardSetStatus("#wizard-retire-status", data.error || "Could not retire the token", "err");
	} catch {
		wizardSetStatus("#wizard-retire-status", "Connection failed.", "err");
	} finally {
		done();
	}
}
async function wizardGenerateBearer() {
	const done = wizardBusy($("#wizard-bearer-gen"), "Generating…");
	try {
		const r = await authFetch("/api/webchat/auth/bearer/generate", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		const data = await r.json().catch(() => ({}));
		if (!r.ok || !data.token) {
			showToast(data.error || "Could not generate a token", {
				kind: "error",
				timeout: 8e3
			});
			return;
		}
		setAuthToken(data.token);
		sessionStorage.setItem("nanoclaw-token", data.token);
		const field = $("#wizard-bearer-token");
		if (field) field.value = data.token;
		if ($("#wizard-bearer-result")) $("#wizard-bearer-result").hidden = false;
		if ($("#wizard-bearer-gen-row")) $("#wizard-bearer-gen-row").hidden = true;
		wizardBearerPendingRestart = true;
	} catch {
		showToast("Connection failed.", { kind: "error" });
	} finally {
		done();
	}
}
async function wizardCopyBearerToken() {
	const field = $("#wizard-bearer-token");
	const value = field?.value || "";
	if (!value) return;
	try {
		await navigator.clipboard.writeText(value);
		showToast("Token copied", { kind: "success" });
	} catch {
		field?.select();
		try {
			document.execCommand("copy");
			showToast("Token copied", { kind: "success" });
		} catch {
			showToast("Copy failed — select the token and copy manually", { kind: "error" });
		}
	}
}
async function wizardCopyText(selector, okMsg) {
	const el = $(selector);
	const text = (el && "value" in el ? el.value : el?.textContent || "").trim();
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		showToast(okMsg || "Copied", { kind: "success" });
	} catch {
		el?.select?.();
		showToast("Copy failed — select and copy manually", { kind: "error" });
	}
}
async function wizardTriggerRestart() {
	const overlay = $("#restart-overlay");
	const titleEl = $("#restart-title");
	const statusEl = $("#restart-status");
	const reloadBtn = $("#restart-reload-btn");
	const setStatus = (t) => {
		if (statusEl) statusEl.textContent = t;
	};
	if (overlay) overlay.hidden = false;
	reloadBtn?.addEventListener("click", () => location.reload(), { once: true });
	const readUptime = async () => {
		try {
			const r = await fetch("/health", { cache: "no-store" });
			if (!r.ok) return null;
			const b = await r.json();
			return typeof b.uptime === "number" ? b.uptime : null;
		} catch {
			return null;
		}
	};
	const baseUptime = await readUptime() ?? Infinity;
	try {
		await authFetch("/api/webchat/restart", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
	} catch {}
	const started = Date.now();
	const DEADLINE_MS = 9e4;
	while (Date.now() - started < DEADLINE_MS) {
		await new Promise((r) => setTimeout(r, 1500));
		const up = await readUptime();
		if (up !== null && up < baseUptime) {
			setStatus("Back online — reloading…");
			await new Promise((r) => setTimeout(r, 700));
			location.reload();
			return;
		}
		setStatus("Restarting the server…");
	}
	if (titleEl) titleEl.textContent = "Still restarting…";
	setStatus("This is taking longer than usual. Reload once you can reach the server.");
	if (reloadBtn) reloadBtn.hidden = false;
}
function wireWizard() {
	if (wizardWired) return;
	wizardWired = true;
	$("#wizard-next")?.addEventListener("click", async () => {
		if (!!document.querySelector(`.wizard-step[data-step="${wizardStep}"] input[name="wizard-access"]`) && !await wizardAccessReady()) {
			const sel = document.querySelector("input[name=\"wizard-access\"]:checked")?.value;
			showToast(sel === "tailscale" ? "Connect Tailscale first — sign in over your tailnet (install it above if needed), then continue." : "Configure the reverse proxy first — set WEBCHAT_TRUSTED_PROXY_IPS and restart, then continue.", {
				kind: "info",
				timeout: 8e3
			});
			return;
		}
		if (wizardStep === 2) {
			wizardCreateAndFinish();
			return;
		}
		if (wizardStep === 0 && !wizardEngineConnected()) {
			showToast(`Finish this engine first — ${wizardEngine === "ollama" ? "set a default Ollama model" : wizardEngine === "codex" && !wizardCodexAvailable ? "install then connect Codex" : `connect ${wizardEngine === "codex" ? "Codex" : "Claude"}`} above.`, {
				kind: "info",
				timeout: 6e3
			});
			return;
		}
		showWizardStep(wizardStep + 1);
	});
	$("#wizard-back")?.addEventListener("click", () => showWizardStep(wizardStep - 1));
	$("#wizard-skip")?.addEventListener("click", () => {
		if (wizardStep === 2) finishWizard();
		else showWizardStep(wizardStep + 1);
	});
	$("#wizard-close")?.addEventListener("click", () => finishWizard());
	document.querySelectorAll("input[name=\"wizard-access\"]").forEach((radio) => {
		radio.addEventListener("change", () => syncWizardAccessBodies());
	});
	$("#wizard-https-btn")?.addEventListener("click", () => wizardEnableHttps());
	$("#wizard-ts-install-btn")?.addEventListener("click", () => runTailscaleInstall());
	$("#wizard-cf-install-btn")?.addEventListener("click", () => runCloudflaredBinaryInstall());
	$("#wizard-cf-connect-btn")?.addEventListener("click", () => runCloudflaredConnect());
	$("#wizard-retire-btn")?.addEventListener("click", () => wizardRetireBearer());
	$("#wizard-bearer-gen")?.addEventListener("click", () => wizardGenerateBearer());
	$("#wizard-bearer-copy")?.addEventListener("click", () => wizardCopyBearerToken());
	$("#wizard-ts-manual-copy")?.addEventListener("click", () => wizardCopyText("#wizard-ts-manual-cmd", "Copied"));
	document.querySelectorAll("input[name=\"wizard-engine\"]").forEach((radio) => {
		radio.addEventListener("change", () => {
			wizardEngine = radio.value;
			syncWizardEngineBodies();
			if (wizardEngine === "ollama") wizardCheckLocalOllama();
			else wizardClearOllamaDefault();
		});
	});
	$("#wizard-claude-oauth")?.addEventListener("click", () => openOauthMintModal("workspace"));
	$("#wizard-codex-install")?.addEventListener("click", () => runCodexInstall());
	$("#wizard-codex-oauth")?.addEventListener("click", () => openOauthMintModal("workspace-codex"));
	$("#wizard-codex-save")?.addEventListener("click", async () => {
		const key = ($("#wizard-codex-key")?.value || "").trim();
		if (!/^sk-/.test(key)) return wizardSetStatus("#wizard-codex-status", "Expected an OpenAI API key (sk-…).", "err");
		const done = wizardBusy($("#wizard-codex-save"), "Saving…");
		try {
			const r = await authFetch("/api/workspace-credential", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					provider: "codex",
					type: "api_key",
					apiKey: key
				})
			});
			const out = await r.json().catch(() => ({}));
			if (!r.ok) return wizardSetStatus("#wizard-codex-status", out.error || "Save failed.", "err");
			$("#wizard-codex-key").value = "";
			await refreshWizardCredState();
		} finally {
			done();
		}
	});
	$("#wizard-claude-save")?.addEventListener("click", async () => {
		const key = ($("#wizard-claude-key")?.value || "").trim();
		if (!/^sk-ant-/.test(key)) return wizardSetStatus("#wizard-claude-status", "Expected an Anthropic API key (sk-ant-…) or setup token (sk-ant-oat…).", "err");
		const isOauth = /^sk-ant-oat/.test(key);
		const done = wizardBusy($("#wizard-claude-save"), "Saving…");
		try {
			const r = await authFetch("/api/workspace-credential", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(isOauth ? {
					type: "oauth_token",
					token: key
				} : {
					type: "api_key",
					apiKey: key
				})
			});
			const out = await r.json().catch(() => ({}));
			if (!r.ok) return wizardSetStatus("#wizard-claude-status", out.error || "Save failed.", "err");
			$("#wizard-claude-key").value = "";
			await refreshWizardCredState();
		} finally {
			done();
		}
	});
	$("#wizard-claude-disconnect")?.addEventListener("click", async () => {
		const r = await authFetch("/api/workspace-credential", { method: "DELETE" });
		if (!r.ok) {
			showToast("Failed to disconnect: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return;
		}
		await refreshWizardCredState();
	});
	$("#wizard-codex-disconnect")?.addEventListener("click", async () => {
		const r = await authFetch("/api/workspace-credential?provider=codex", { method: "DELETE" });
		if (!r.ok) {
			showToast("Failed to disconnect: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return;
		}
		await refreshWizardCredState();
	});
	$("#wizard-ollama-probe")?.addEventListener("click", () => void wizardProbeOllama());
	$("#wizard-ollama-list")?.addEventListener("change", (e) => {
		const t = e.target;
		if (t && t.name === "wizard-ollama-model" && t.value) wizardSelectOllamaModel(t.value);
	});
	$("#wizard-ollama-change")?.addEventListener("click", () => {
		$("#wizard-ollama-connected").hidden = true;
		$("#wizard-ollama-setup").hidden = false;
	});
	$("#wizard-ollama-install")?.addEventListener("click", async () => {
		const done = wizardBusy($("#wizard-ollama-install"), "Installing…");
		const log = $("#wizard-ollama-install-log");
		log.hidden = false;
		log.textContent = "Starting…";
		try {
			const r = await authFetch("/api/ollama/install", { method: "POST" });
			if (!r.ok) {
				const err = await r.json().catch(() => ({}));
				if (err.error !== "already-running") {
					log.textContent = err.error || "Install failed to start.";
					return;
				}
				log.textContent = "Resuming the install already in progress…";
			}
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, 2e3));
				const st = await (await authFetch("/api/ollama/local")).json();
				log.textContent = (st.lines || []).join("\n") || "Working…";
				log.scrollTop = log.scrollHeight;
				if (!st.running) {
					if (st.exitCode === 0 && st.reachable) {
						$("#wizard-ollama-install-row").hidden = true;
						$("#wizard-ollama-url").value = "http://localhost:11434";
						wizardSetStatus("#wizard-ollama-status", "Ollama installed and running — download a model below.", "ok");
						$("#wizard-ollama-dl-row").hidden = false;
						wizardLoadRecommendation();
					} else wizardSetStatus("#wizard-ollama-status", "Install failed — see the log above.", "err");
					return;
				}
			}
		} finally {
			done();
		}
	});
	$("#wizard-ollama-dl")?.addEventListener("click", async () => {
		const model = ($("#wizard-ollama-dl-model")?.value || "").trim() || "qwen3:1.7b";
		const host = ($("#wizard-ollama-url")?.value || "").trim() || "http://localhost:11434";
		const r = await authFetch("/api/ollama/pull", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				host,
				model
			})
		});
		if (!r.ok) return wizardSetStatus("#wizard-ollama-dl-status", (await r.json().catch(() => ({}))).error || "Pull failed to start.", "err");
		await wizardFollowPull(host, model);
	});
}
async function wizardCreateAndFinish() {
	const roomName = ($("#wizard-room-name")?.value || "").trim() || "General";
	const agentName = ($("#wizard-agent-name")?.value || "").trim() || "Assistant";
	if (wizardEngine !== "ollama") await wizardClearOllamaDefault();
	const mktEnabled = $("#wizard-marketplace")?.checked !== false;
	try {
		await authFetch("/api/webchat/features", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ marketplaceEnabled: mktEnabled })
		});
		marketplaceEnabled = mktEnabled;
		applyMarketplaceNav();
	} catch {}
	try {
		await authFetch("/api/webchat/tailscale-owner", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ armed: document.querySelector("input[name=\"wizard-access\"]:checked")?.value === "tailscale" })
		});
	} catch {}
	const done = wizardBusy($("#wizard-next"), "Creating…");
	try {
		const agentRef = {
			kind: "new",
			name: agentName
		};
		if (wizardEngine === "codex") agentRef.provider = "codex";
		const r = await authFetch("/api/rooms", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: roomName,
				agents: [agentRef]
			})
		});
		const out = await r.json().catch(() => ({}));
		if (!r.ok) {
			if (r.status === 409) {
				wizardSetStatus("#wizard-room-status", "Already set up — finishing…", "ok");
				await finishWizard();
				if (wizardBearerPendingRestart) await wizardTriggerRestart();
				return;
			}
			return wizardSetStatus("#wizard-room-status", out.error || "Create failed.", "err");
		}
		wizardSetStatus("#wizard-room-status", "Created. Finishing…", "ok");
		await finishWizard();
		if (wizardBearerPendingRestart) await wizardTriggerRestart();
		if (typeof fetchAgents === "function") fetchAgents().catch(() => {});
	} finally {
		done();
	}
}
async function maybeAutoOpenWizard() {
	try {
		const r = await authFetch("/api/webchat/onboarding");
		if (!r.ok) return;
		const s = await r.json();
		if (s.canEdit && !s.complete) openWizard();
	} catch {}
}
async function saveHandle() {
	const input = $("#handle-input");
	const status = $("#handle-status");
	if (!input || !status) return;
	const next = input.value.trim().toLowerCase().replace(/^@/, "");
	const showStatus = (text, ok) => {
		status.hidden = false;
		status.textContent = text;
		status.classList.toggle("ok", !!ok);
		status.classList.toggle("err", !ok);
	};
	if (!/^[a-z0-9-]{1,32}$/.test(next)) {
		showStatus("Use 1–32 letters, numbers, or hyphens.", false);
		return;
	}
	if (next === myHandle) {
		showStatus("That’s already your handle.", true);
		return;
	}
	try {
		const res = await authFetch("/api/me/handle", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ handle: next })
		});
		if (res.ok) {
			myHandle = (((await res.json()).handle || next) + "").toLowerCase();
			input.value = myHandle;
			renderHandleChip();
			showStatus("Saved.", true);
		} else if (res.status === 409) showStatus("That handle is taken.", false);
		else if (res.status === 400) showStatus("Use 1–32 letters, numbers, or hyphens.", false);
		else showStatus("Couldn’t save — try again.", false);
	} catch {
		showStatus("Couldn’t save — try again.", false);
	}
}
function renderHandleChip() {
	const chip = $("#handle-chip");
	if (!chip) return;
	const label = myHandle ? `@${myHandle}` : "+ set @handle";
	chip.textContent = userCredsConnected ? `🔑 ${label}` : label;
	chip.classList.toggle("is-unset", !myHandle);
	chip.classList.toggle("has-cred", userCredsConnected);
	chip.title = userCredsConnected ? "Billing your own account — click to manage" : "Edit your handle";
	chip.setAttribute("aria-label", userCredsConnected ? "Billing your own account — manage credentials" : "Edit your handle");
}
function openHandlePopover() {
	const pop = $("#handle-popover");
	const input = $("#handle-input");
	const status = $("#handle-status");
	if (!pop) return;
	if (input) input.value = myHandle || "";
	if (status) {
		status.hidden = true;
		status.textContent = "";
		status.classList.remove("ok", "err");
	}
	updateHandleCreds();
	pop.hidden = false;
	$("#handle-chip")?.setAttribute("aria-expanded", "true");
	if (input) input.focus();
}
function closeHandlePopover() {
	const pop = $("#handle-popover");
	if (!pop || pop.hidden) return;
	pop.hidden = true;
	$("#handle-chip")?.setAttribute("aria-expanded", "false");
}
$("#handle-chip")?.addEventListener("click", (e) => {
	e.stopPropagation();
	const pop = $("#handle-popover");
	if (pop && pop.hidden) openHandlePopover();
	else closeHandlePopover();
});
$("#handle-popover-close")?.addEventListener("click", closeHandlePopover);
document.addEventListener("click", (e) => {
	const pop = $("#handle-popover");
	if (!pop || pop.hidden) return;
	if (pop.contains(e.target) || e.target === $("#handle-chip")) return;
	closeHandlePopover();
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closeHandlePopover();
});
applySettings();
function openSettings() {
	renderSettingsModal();
	renderSettingsWizardButton();
	renderSelfTest();
	renderCredentialsSettings();
	renderRoutingSetupSettings();
	renderTtsSetupSettings();
	renderSttSetupSettings();
	renderAutoLearnSetting();
	renderPrejudgeSettings();
	renderSkillSourcesSettings();
	renderMcpSources();
	renderToolSecrets();
	renderMyCredentials();
	renderAccessSettings();
	renderUsageSettings();
	renderModelManage();
	$("#settings-overlay").hidden = false;
	const focusable = $("#settings-overlay .modal").querySelectorAll("button, input, select, [tabindex]:not([tabindex=\"-1\"])");
	if (focusable.length) focusable[0].focus();
}
function closeSettings() {
	$("#settings-overlay").hidden = true;
}
document.addEventListener("click", (e) => {
	const btn = e.target.closest(".feature-info-btn");
	if (!btn) return;
	const info = document.getElementById(btn.getAttribute("aria-controls"));
	if (!info) return;
	const open = info.hidden;
	info.hidden = !open;
	btn.setAttribute("aria-expanded", String(open));
});
var ttsInstallWired = false;
var ttsInstallActive = false;
var TTS_SETTINGS_ELS = {
	btn: "#tts-install-btn",
	log: "#tts-install-log",
	progress: "#tts-install-progress"
};
async function pollTtsInstall(els = TTS_SETTINGS_ELS) {
	if (ttsInstallActive) return;
	ttsInstallActive = true;
	const btn = $(els.btn);
	const log = $(els.log);
	const progress = $(els.progress);
	if (progress) progress.hidden = false;
	if (btn) btn.disabled = true;
	try {
		while (true) {
			const st = await (await authFetch("/api/webchat/tts/install")).json();
			if (log) {
				log.textContent = (st.lines || []).slice(-12).join("\n") || "Starting…";
				log.scrollTop = log.scrollHeight;
			}
			if (!st.running) {
				if (st.exitCode === 0) {
					showToast("Read aloud installed — Kokoro voices are live", { kind: "success" });
					await loadTtsConfig();
				} else showToast("Read aloud install failed — see log", { kind: "error" });
				break;
			}
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast("Read aloud install error: " + err.message, { kind: "error" });
	} finally {
		ttsInstallActive = false;
		renderTtsSetupSettings();
		renderWizardFeatures();
	}
}
async function runTtsInstall(els = TTS_SETTINGS_ELS) {
	const btn = $(els.btn);
	const log = $(els.log);
	const progress = $(els.progress);
	if (progress) progress.hidden = false;
	const done = btn ? wizardBusy(btn, "Installing…") : null;
	if (log) log.textContent = "Starting…";
	try {
		const res = await authFetch("/api/webchat/tts/install", { method: "POST" });
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = "Install failed: " + (err.error || res.status);
			showToast("Read aloud install failed", { kind: "error" });
			done?.();
			return;
		}
		pollTtsInstall(els);
	} catch (err) {
		if (log) log.textContent = "Install failed: " + err.message;
		done?.();
	}
}
async function renderTtsSetupSettings() {
	const section = $("#settings-tts");
	if (!section) return;
	const btn = $("#tts-install-btn");
	const badge = $("#tts-installed-badge");
	const progress = $("#tts-install-progress");
	if (!ttsInstallWired) {
		ttsInstallWired = true;
		btn.addEventListener("click", () => runTtsInstall());
		$("#tts-voice-select")?.addEventListener("change", async () => {
			const voice = $("#tts-voice-select").value;
			const r = await authFetch("/api/tts/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ voice })
			});
			if (!r.ok) {
				showToast("Failed to save voice: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
				renderTtsSetupSettings();
				return;
			}
			showToast("Voice saved", { kind: "success" });
			try {
				const sample = await authFetch("/api/tts", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						text: "This is how I sound.",
						voice
					})
				});
				if (sample.ok) {
					const blob = await sample.blob();
					new Audio(URL.createObjectURL(blob)).play();
				}
			} catch {}
		});
	}
	let st = null;
	try {
		const res = await authFetch("/api/webchat/tts/install");
		if (res.ok) st = await res.json();
	} catch {
		st = null;
	}
	if (!st) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	await loadTtsConfig();
	document.querySelectorAll("#tts-default-mode .setting-option").forEach((b) => {
		b.classList.toggle("active", b.dataset.value === (getTtsReadAloudEnabled() ? "on" : "off"));
	});
	const desc = $("#tts-setup-desc");
	if (st.installed) {
		btn.hidden = true;
		badge.hidden = false;
		if (desc) desc.hidden = true;
		progress.hidden = !st.running;
		if (st.running) pollTtsInstall();
		try {
			const [voicesRes, cfgRes] = await Promise.all([authFetch("/api/tts/voices"), authFetch("/api/tts/config")]);
			if (voicesRes.ok) {
				const { voices } = await voicesRes.json();
				const cfg = cfgRes.ok ? await cfgRes.json() : {};
				const select = $("#tts-voice-select");
				if (select && Array.isArray(voices) && voices.length) {
					select.innerHTML = "";
					for (const v of voices) {
						const opt = document.createElement("option");
						opt.value = v;
						opt.textContent = v;
						select.appendChild(opt);
					}
					if (cfg.voice) select.value = cfg.voice;
					if (cfg.model) {
						const label = $("#tts-voice-label");
						if (label) label.textContent = `Voice (${cfg.model.charAt(0).toUpperCase()}${cfg.model.slice(1)})`;
					}
					$("#tts-voice-group").hidden = false;
				}
			}
		} catch {}
		return;
	}
	badge.hidden = true;
	$("#tts-voice-group").hidden = true;
	btn.hidden = !st.installerPresent;
	if (desc) {
		desc.hidden = false;
		if (st.installerPresent) desc.textContent = "Using each device’s built-in voices.";
		else desc.textContent = "Server voices need the add-webchat-tts skill, which isn’t in this install — re-run install-webchat.sh to add it. Device voices still work.";
	}
	if (st.running) pollTtsInstall();
	else {
		btn.disabled = false;
		btn.textContent = "Install local voices";
		btn.title = "Run a local Kokoro voice model (~330MB, no cloud, no key). Without it the control uses your device voices.";
	}
}
/** Recording chrome: mic ⇄ red pulsing stop square + elapsed chip (the
*  standard voice-recorder idiom, so state is unmistakable at a glance). */
/** Wrap accumulated PCM16 frames in a minimal 16 kHz mono WAV container. */
/** Close the current segment and ship it for transcription (if it held speech). */
/** Per-frame handler: RMS gate → segment bookkeeping → cut on pause/length. */
/** Stop capture, flush the tail segment, wait for transcripts, then tidy. */
/** Esc = cancel: discard everything dictated, restore the prior composer text. */
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && isDictationActive()) {
		e.preventDefault();
		cancelDictation();
	}
});
/**
* Tidy the dictated span via the server's cleanup model. The replacement goes
* through execCommand('insertText') over a selection of just the dictated
* text, so the native undo stack (Ctrl/Cmd+Z) restores the raw transcript.
*/
$("#mic-btn")?.addEventListener("click", () => {
	if (isDictationActive()) stopDictation();
	else startDictation();
});
/** Post-auth: reveal the mic when the server has an STT backend configured. */
var sttInstallWired = false;
var sttInstallActive = false;
var sttChosenBackend = "local";
var sttLastState = null;
var STT_SETTINGS_ELS = {
	btn: "#stt-install-btn",
	log: "#stt-install-log",
	progress: "#stt-install-progress"
};
async function pollSttInstall(els = STT_SETTINGS_ELS, onDone) {
	if (sttInstallActive) return;
	sttInstallActive = true;
	const btn = $(els.btn);
	const log = $(els.log);
	const progress = $(els.progress);
	if (progress) progress.hidden = false;
	if (btn) btn.disabled = true;
	try {
		while (true) {
			const st = await (await authFetch("/api/webchat/stt/install")).json();
			if (log) {
				log.textContent = (st.lines || []).slice(-12).join("\n") || "Starting…";
				log.scrollTop = log.scrollHeight;
			}
			if (!st.running) {
				if (st.exitCode === 0) {
					showToast("Voice dictation installed — the mic is live", { kind: "success" });
					await initSttFeature();
				} else showToast("Voice dictation install failed — see log", { kind: "error" });
				break;
			}
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast("Voice dictation install error: " + err.message, { kind: "error" });
	} finally {
		sttInstallActive = false;
		renderSttSetupSettings();
		if (onDone) onDone();
	}
}
async function runSttInstall(payload, els = STT_SETTINGS_ELS, onDone) {
	const btn = $(els.btn);
	const log = $(els.log);
	const progress = $(els.progress);
	if (progress) progress.hidden = false;
	const done = btn ? wizardBusy(btn, "Installing…") : null;
	if (log) log.textContent = "Starting…";
	try {
		const res = await authFetch("/api/webchat/stt/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		});
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = "Install failed: " + (err.error || res.status);
			showToast("Voice dictation install failed", { kind: "error" });
			done?.();
			return;
		}
		pollSttInstall(els, onDone);
	} catch (err) {
		if (log) log.textContent = "Install failed: " + err.message;
		done?.();
	}
}
function sttPopulateModelSelect(st) {
	const select = $("#stt-model-select");
	if (!select || !Array.isArray(st.models)) return;
	if (select.options.length === 0) for (const m of st.models) {
		const opt = document.createElement("option");
		opt.value = m;
		opt.textContent = m === st.suggestedModel ? `${m} (suggested)` : m;
		select.appendChild(opt);
	}
	select.value = st.model || st.suggestedModel || st.models[0];
}
/** Show/hide the pre-install pickers for the chosen backend. */
function sttRenderBackendChoice(st) {
	document.querySelectorAll("#stt-backend-mode .setting-option").forEach((b) => b.classList.toggle("active", b.dataset.value === sttChosenBackend));
	const local = sttChosenBackend === "local";
	$("#stt-model-group").hidden = !local || !st.installerPresent;
	$("#stt-install-btn").hidden = !local || !st.installerPresent;
	$("#stt-key-group").hidden = local;
	if (local) sttPopulateModelSelect(st);
}
/** Populate the cleanup select from the roster (owner path of /api/stt/config). */
async function renderSttCleanupSelect(cfg) {
	const group = $("#stt-cleanup-group");
	const select = $("#stt-cleanup-select");
	if (!group || !select) return;
	group.hidden = false;
	try {
		const models = await (await authFetch("/api/models")).json();
		select.innerHTML = "<option value=\"\">None — raw transcript</option>";
		for (const m of models) {
			if (m.kind !== "ollama" && m.kind !== "openai-compatible" || !m.endpoint) continue;
			const opt = document.createElement("option");
			opt.value = m.id;
			opt.textContent = `${m.name} (${m.model_id})`;
			select.appendChild(opt);
		}
		select.value = cfg.cleanupModelId || "";
	} catch {}
}
async function renderSttSetupSettings() {
	const section = $("#settings-stt");
	if (!section) return;
	let st = null;
	try {
		const res = await authFetch("/api/webchat/stt/install");
		if (res.ok) st = await res.json();
	} catch {
		st = null;
	}
	if (!st) {
		section.hidden = true;
		return;
	}
	sttLastState = st;
	section.hidden = false;
	const btn = $("#stt-install-btn");
	const badge = $("#stt-installed-badge");
	const progress = $("#stt-install-progress");
	const desc = $("#stt-setup-desc");
	if (!sttInstallWired) {
		sttInstallWired = true;
		document.querySelectorAll("#stt-backend-mode .setting-option").forEach((b) => {
			b.addEventListener("click", () => {
				sttChosenBackend = b.dataset.value;
				renderSttSetupSettings();
			});
		});
		btn?.addEventListener("click", () => {
			runSttInstall({
				provider: "local",
				model: $("#stt-model-select")?.value || void 0
			});
		});
		document.querySelectorAll("#stt-enabled-mode .setting-option").forEach((b) => {
			b.addEventListener("click", async () => {
				const on = b.dataset.value === "on";
				const r = await authFetch("/api/stt/config", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: on })
				});
				if (!r.ok) {
					showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
					return;
				}
				document.querySelectorAll("#stt-enabled-mode .setting-option").forEach((x) => x.classList.toggle("active", x === b));
				const mic = $("#mic-btn");
				if (mic) mic.hidden = !on;
				if (!on && isDictationActive()) cancelDictation();
				showToast(on ? "Voice dictation on for everyone" : "Voice dictation off for everyone");
			});
		});
		$("#stt-model-select")?.addEventListener("change", () => {
			if (!sttLastState?.installed || sttLastState.provider !== "local") return;
			const model = $("#stt-model-select").value;
			if (!model || model === sttLastState.model) return;
			showToast(`Switching to ${model}…`, { kind: "info" });
			runSttInstall({
				provider: "local",
				model
			});
		});
		$("#stt-connect-btn")?.addEventListener("click", () => {
			const key = ($("#stt-api-key")?.value || "").trim();
			if (!key) {
				showToast("Enter the ElevenLabs API key first", { kind: "error" });
				return;
			}
			runSttInstall({
				provider: "elevenlabs",
				apiKey: key
			});
			$("#stt-api-key").value = "";
		});
		$("#stt-prompt-edit")?.addEventListener("click", () => {
			const editor = $("#stt-prompt-editor");
			const open = editor.hidden;
			editor.hidden = !open;
			$("#stt-prompt-edit").setAttribute("aria-expanded", String(open));
			if (open) $("#stt-prompt-text").focus();
		});
		$("#stt-prompt-save")?.addEventListener("click", async () => {
			const value = $("#stt-prompt-text").value.trim();
			const r = await authFetch("/api/stt/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cleanupPrompt: value || null })
			});
			const body = await r.json().catch(() => ({}));
			if (!r.ok) {
				showToast("Failed to save: " + (body.error || r.statusText), { kind: "error" });
				return;
			}
			$("#stt-prompt-editor").hidden = true;
			$("#stt-prompt-edit").setAttribute("aria-expanded", "false");
			showToast(body.cleanupPrompt ? "Cleanup prompt saved" : "Cleanup prompt reset to default", { kind: "success" });
			renderSttSetupSettings();
		});
		$("#stt-prompt-reset")?.addEventListener("click", async () => {
			if (!(await authFetch("/api/stt/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cleanupPrompt: null })
			})).ok) {
				showToast("Failed to reset", { kind: "error" });
				return;
			}
			$("#stt-prompt-editor").hidden = true;
			$("#stt-prompt-edit").setAttribute("aria-expanded", "false");
			showToast("Cleanup prompt reset to default", { kind: "success" });
			renderSttSetupSettings();
		});
		$("#stt-cleanup-select")?.addEventListener("change", async () => {
			const value = $("#stt-cleanup-select").value || null;
			const r = await authFetch("/api/stt/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cleanupModelId: value })
			});
			if (!r.ok) {
				showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
				renderSttSetupSettings();
				return;
			}
			setSttConfig({
				...getSttConfig(),
				cleanup: value !== null,
				cleanupModelId: value
			});
			showToast(value ? "Cleanup model saved" : "Cleanup turned off", { kind: "success" });
		});
	}
	if (st.installed) {
		badge.hidden = false;
		btn.hidden = true;
		$("#stt-backend-group").hidden = true;
		$("#stt-key-group").hidden = true;
		$("#stt-enabled-group").hidden = false;
		document.querySelectorAll("#stt-enabled-mode .setting-option").forEach((b) => {
			b.classList.toggle("active", b.dataset.value === (st.enabled ? "on" : "off"));
		});
		const localModel = st.provider === "local" && st.installerPresent;
		$("#stt-model-group").hidden = !localModel;
		if (localModel) {
			sttPopulateModelSelect(st);
			const label = $("#stt-model-label");
			if (label) label.textContent = "Model (Whisper)";
		}
		if (desc) desc.hidden = true;
		progress.hidden = !st.running;
		if (st.running) pollSttInstall();
		try {
			const cfg = await (await authFetch("/api/stt/config")).json();
			if (cfg.canEdit) {
				await renderSttCleanupSelect(cfg);
				$("#stt-prompt-row").hidden = false;
				$("#stt-prompt-text").value = cfg.cleanupPrompt || cfg.defaultCleanupPrompt || "";
				$("#stt-prompt-reset").hidden = !cfg.cleanupPrompt;
			}
		} catch {}
		return;
	}
	badge.hidden = true;
	$("#stt-enabled-group").hidden = true;
	$("#stt-cleanup-group").hidden = true;
	$("#stt-prompt-row").hidden = true;
	$("#stt-prompt-editor").hidden = true;
	$("#stt-backend-group").hidden = false;
	if (desc) {
		desc.hidden = st.installerPresent || sttChosenBackend !== "local";
		if (!st.installerPresent) desc.textContent = "The local backend needs the add-webchat-dictation skill, which isn’t in this install — re-run install-webchat.sh to add it, or use ElevenLabs.";
	}
	sttRenderBackendChoice(st);
	if (st.running) pollSttInstall();
	else if (btn) {
		btn.disabled = false;
		btn.textContent = "Install";
		btn.title = "Run whisper.cpp locally with the selected model — no cloud, no key. Model download sized to this machine.";
	}
}
var autoLearnWired = false;
async function renderAutoLearnSetting() {
	const section = document.getElementById("settings-autolearn");
	if (!section) return;
	let cfg = null;
	try {
		const r = await authFetch("/api/learning/config");
		if (r.ok) cfg = await r.json();
	} catch {
		cfg = null;
	}
	if (!cfg || !cfg.canEdit) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	learningMasterEnabled = cfg.enabled !== false;
	document.querySelectorAll("#autolearn-mode .setting-option").forEach((b) => {
		b.classList.toggle("active", b.dataset.value === (learningMasterEnabled ? "on" : "off"));
	});
	const clfGroup = document.getElementById("autolearn-classifier-group");
	const clfSelect = document.getElementById("autolearn-classifier-select");
	if (clfGroup) clfGroup.hidden = !learningMasterEnabled;
	if (learningMasterEnabled && clfSelect && clfSelect.options.length <= 1) try {
		const models = await (await authFetch("/api/models")).json();
		clfSelect.innerHTML = "<option value=\"\">None — busy-turn heuristic</option>";
		for (const m of models) {
			if (m.kind !== "ollama" && m.kind !== "openai-compatible" || !m.endpoint) continue;
			const opt = document.createElement("option");
			opt.value = m.id;
			opt.textContent = `${m.name} (${m.model_id})`;
			clfSelect.appendChild(opt);
		}
	} catch {}
	if (clfSelect) clfSelect.value = cfg.classifierModelId || "";
	if (autoLearnWired) return;
	autoLearnWired = true;
	document.querySelectorAll("#autolearn-mode .setting-option").forEach((b) => {
		b.addEventListener("click", async () => {
			const on = b.dataset.value === "on";
			const r = await authFetch("/api/learning/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: on })
			});
			if (!r.ok) {
				showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
				return;
			}
			learningMasterEnabled = on;
			document.querySelectorAll("#autolearn-mode .setting-option").forEach((x) => x.classList.toggle("active", x === b));
			applyLearningMaster();
			if (clfGroup) clfGroup.hidden = !on;
			showToast(on ? "Auto-learn on — takes effect as each agent restarts" : "Auto-learn off for the whole workspace — takes effect as each agent restarts");
		});
	});
	clfSelect?.addEventListener("change", async () => {
		const value = clfSelect.value || null;
		const r = await authFetch("/api/learning/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ classifierModelId: value })
		});
		if (!r.ok) {
			showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			renderAutoLearnSetting();
			return;
		}
		showToast(value ? "Classifier set — decides skill-worthy turns (applies as agents restart)" : "Classifier off — back to the busy-turn heuristic", { kind: "success" });
	});
}
async function renderPrejudgeSettings() {
	const section = $("#settings-prejudge");
	if (!section) return;
	section.hidden = !isOwnerView;
	if (!isOwnerView) return;
	let cfg = null;
	try {
		const r = await authFetch("/api/approvals/prejudge");
		if (r.ok) cfg = await r.json();
	} catch {}
	if (!cfg) {
		section.hidden = true;
		return;
	}
	const sel = $("#prejudge-model-select");
	sel.innerHTML = "";
	const off = document.createElement("option");
	off.value = "";
	off.textContent = "Off";
	sel.appendChild(off);
	try {
		const models = await (await authFetch("/api/models")).json();
		for (const m of models) {
			if (!(m.kind === "anthropic" || (m.kind === "ollama" || m.kind === "openai-compatible") && m.endpoint)) continue;
			const opt = document.createElement("option");
			opt.value = m.id;
			opt.textContent = `${m.name} (${m.model_id})`;
			sel.appendChild(opt);
		}
	} catch {}
	sel.value = cfg.modelId || "";
	if (sel.value !== (cfg.modelId || "")) sel.value = "";
	renderPrejudgeActions(cfg);
	sel.onchange = async () => {
		try {
			const out = await apiJson("/api/approvals/prejudge", {
				method: "PUT",
				body: { modelId: sel.value || null }
			});
			showToast(sel.value ? "Approval pre-judge on" : "Approval pre-judge off", { kind: "success" });
			renderPrejudgeActions(out);
		} catch (err) {
			showToast("Could not save: " + (err?.message || err), { kind: "error" });
			renderPrejudgeSettings();
		}
	};
}
function renderPrejudgeActions(cfg) {
	const group = $("#prejudge-actions-group");
	const list = $("#prejudge-actions-list");
	if (!group || !list) return;
	group.hidden = !cfg.modelId;
	if (!cfg.modelId) return;
	list.innerHTML = "";
	const never = new Set(cfg.neverList?.actions || []);
	const opted = new Set(cfg.actions || []);
	const actions = [.../* @__PURE__ */ new Set([
		...cfg.knownActions || [],
		...never,
		...opted
	])].sort();
	for (const action of actions) {
		const label = document.createElement("label");
		label.className = "setting-toggle";
		const name = document.createElement("span");
		name.textContent = action;
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.dataset.action = action;
		cb.checked = opted.has(action);
		if (never.has(action)) {
			cb.checked = false;
			cb.disabled = true;
			label.classList.add("prejudge-never");
			label.title = "Always needs a human";
		} else cb.addEventListener("change", async () => {
			const next = [...list.querySelectorAll("input:not(:disabled):checked")].map((el) => el.dataset.action);
			try {
				await apiJson("/api/approvals/prejudge", {
					method: "PUT",
					body: { actions: next }
				});
				showToast("Approval pre-judge saved", { kind: "success" });
			} catch (err) {
				cb.checked = !cb.checked;
				showToast("Could not save: " + (err?.message || err), { kind: "error" });
			}
		});
		label.append(name, cb);
		list.appendChild(label);
	}
}
var routingInstallWired = false;
var routingInstallActive = false;
var ROUTING_ELS_SETTINGS = {
	log: "#routing-install-log",
	bar: "#routing-pull-bar",
	label: "#routing-pull-label"
};
function renderRoutingInstallProgress(st, els = ROUTING_ELS_SETTINGS) {
	const log = $(els.log);
	const bar = $(els.bar);
	const label = $(els.label);
	log.textContent = (st.lines || []).slice(-12).join("\n") || "Starting…";
	log.scrollTop = log.scrollHeight;
	const pull = st.pull;
	if (pull) {
		bar.hidden = false;
		label.hidden = false;
		const pct = pull.total > 0 ? Math.min(100, Math.round(100 * pull.completed / pull.total)) : 0;
		bar.querySelector("span").style.width = pct + "%";
		if (pull.status === "pulling") label.textContent = "Classifier model: " + (pull.detail || "downloading…") + " (" + pct + "%)";
		else if (pull.status === "success") label.textContent = "Classifier model ready.";
		else label.textContent = "Classifier model pull failed: " + (pull.error || "");
	} else {
		bar.hidden = true;
		label.hidden = true;
	}
}
async function pollRoutingInstall() {
	if (routingInstallActive) return;
	routingInstallActive = true;
	const btn = $("#routing-install-btn");
	$("#routing-install-progress").hidden = false;
	btn.disabled = true;
	let chainHandled = false;
	try {
		while (true) {
			const st = await (await authFetch("/api/router/install")).json();
			renderRoutingInstallProgress(st);
			if (!st.running && !chainHandled) {
				chainHandled = true;
				if (st.exitCode === 0) {
					try {
						await authFetch("/api/router/routes", {
							method: "PUT",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ live: { enabled: true } })
						});
					} catch {}
					await fetchModels();
					showToast("Auto routing installed and live — assign the “auto” model to an agent.", { kind: "success" });
					await probeRoutingAvailability();
				} else {
					showToast("Auto routing setup failed — see log", { kind: "error" });
					break;
				}
			}
			const pullDone = !st.pull || st.pull.status !== "pulling";
			if (!st.running && pullDone) break;
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast("Auto routing setup error: " + err.message, { kind: "error" });
	} finally {
		routingInstallActive = false;
		renderRoutingSetupSettings();
	}
}
async function installLitellmPhase(log) {
	log.textContent = "Installing the LiteLLM router…";
	let res;
	try {
		res = await authFetch("/api/router/litellm-install", { method: "POST" });
	} catch (err) {
		log.textContent = "LiteLLM install failed: " + err.message;
		showToast("LiteLLM install failed", { kind: "error" });
		return false;
	}
	if (!res.ok && res.status !== 202) {
		log.textContent = "LiteLLM install failed: " + ((await res.json().catch(() => ({}))).error || res.status);
		showToast("LiteLLM install failed", { kind: "error" });
		return false;
	}
	while (true) {
		const st = await (await authFetch("/api/router/litellm-install")).json();
		if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-12).join("\n");
		if (!st.running) {
			if (st.exitCode === 0) {
				showToast("LiteLLM router installed", { kind: "success" });
				return true;
			}
			showToast("LiteLLM install failed — see log", { kind: "error" });
			return false;
		}
		await new Promise((r) => setTimeout(r, 2e3));
	}
}
async function runRoutingInstall() {
	const btn = $("#routing-install-btn");
	const log = $("#routing-install-log");
	$("#routing-install-progress").hidden = false;
	btn.disabled = true;
	btn.textContent = "Installing…";
	log.textContent = "Starting…";
	try {
		if (!(await (await authFetch("/api/router/install")).json().catch(() => ({}))).litellmReady) {
			if (!await installLitellmPhase(log)) {
				btn.disabled = false;
				btn.textContent = "Install";
				return;
			}
		}
		const res = await authFetch("/api/router/install", { method: "POST" });
		if (!res.ok) {
			log.textContent = "Install failed: " + ((await res.json().catch(() => ({}))).error || res.status);
			showToast("Auto routing setup failed", { kind: "error" });
			btn.disabled = false;
			btn.textContent = "Install";
			return;
		}
		pollRoutingInstall();
	} catch (err) {
		log.textContent = "Install failed: " + err.message;
		showToast("Auto routing setup failed", { kind: "error" });
		btn.disabled = false;
		btn.textContent = "Install";
	}
}
async function renderRoutingSetupSettings() {
	const section = $("#settings-routing");
	let st;
	try {
		const res = await authFetch("/api/router/install");
		if (!res.ok) {
			section.hidden = true;
			return;
		}
		st = await res.json();
	} catch {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	const btn = $("#routing-install-btn");
	const desc = $("#routing-setup-desc");
	const badge = $("#routing-installed-badge");
	const progress = $("#routing-install-progress");
	if (!routingInstallWired) {
		routingInstallWired = true;
		btn.addEventListener("click", runRoutingInstall);
	}
	const pulling = Boolean(st.pull && st.pull.status === "pulling");
	const busy = st.running || pulling;
	if (st.installed) {
		btn.hidden = true;
		desc.hidden = true;
		badge.hidden = false;
		if (busy) {
			progress.hidden = false;
			renderRoutingInstallProgress(st);
			pollRoutingInstall();
		} else progress.hidden = true;
		return;
	}
	badge.hidden = true;
	btn.hidden = false;
	btn.textContent = busy ? "Installing…" : "Install";
	btn.disabled = busy;
	desc.hidden = true;
	if (busy) {
		progress.hidden = false;
		renderRoutingInstallProgress(st);
		pollRoutingInstall();
	} else progress.hidden = true;
}
function closeOverflowMenu() {
	const menu = $("#overflow-menu");
	if (!menu) return;
	menu.hidden = true;
	$("#overflow-btn")?.setAttribute("aria-expanded", "false");
}
$("#overflow-btn")?.addEventListener("click", (e) => {
	e.stopPropagation();
	const menu = $("#overflow-menu");
	const open = menu.hidden;
	menu.hidden = !open;
	$("#overflow-btn").setAttribute("aria-expanded", String(open));
	if (open) probeRoutingAvailability();
});
$("#overflow-menu")?.addEventListener("click", (e) => {
	const item = e.target.closest(".overflow-item");
	if (!item) return;
	closeOverflowMenu();
	const action = item.dataset.action;
	if (action === "agents") openManage("agents");
	else if (action === "models") openManage("models");
	else if (action === "mcp") openManage("mcp");
	else if (action === "skills") openManage("skills");
	else if (action === "routing") openManage("routing");
	else if (action === "journey") toggleJourney();
	else if (action === "topology") toggleTopology();
	else if (action === "wiring") toggleMatrix();
	else if (action === "dashboard") toggleDashboard();
	else if (action === "permissions") togglePermissions();
	else if (action === "settings") openSettings();
	else if (action === "help") toggleHelp();
});
document.addEventListener("click", (e) => {
	const menu = $("#overflow-menu");
	if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== $("#overflow-btn")) closeOverflowMenu();
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closeOverflowMenu();
});
$("#settings-close").addEventListener("click", closeSettings);
$("#settings-overlay").addEventListener("click", (e) => {
	if (e.target === $("#settings-overlay")) closeSettings();
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !$("#settings-overlay").hidden) closeSettings();
});
var lightboxOpen = false;
var lightboxImages = [];
var lightboxIndex = 0;
var prevBodyOverflow = "";
var lightboxCloseTimer = null;
var lightboxXf = {
	scale: 1,
	x: 0,
	y: 0
};
var lightboxGesture = {
	startScale: 1,
	startDist: 0,
	startX: 0,
	startY: 0,
	startTouchX: 0,
	startTouchY: 0,
	mode: null
};
function applyLightboxTransform() {
	const img = $("#lightbox-img");
	img.style.transform = `translate(${lightboxXf.x}px, ${lightboxXf.y}px) scale(${lightboxXf.scale})`;
}
function resetLightboxTransform() {
	lightboxXf.scale = 1;
	lightboxXf.x = 0;
	lightboxXf.y = 0;
	applyLightboxTransform();
}
function snapshotRoomImages() {
	const imgs = document.querySelectorAll("#messages .file-image-preview");
	return Array.from(imgs).map((el) => ({
		url: el.src,
		alt: el.alt || ""
	}));
}
function setLightboxImage(idx) {
	if (idx < 0 || idx >= lightboxImages.length) return;
	lightboxIndex = idx;
	const { url, alt } = lightboxImages[idx];
	const img = $("#lightbox-img");
	const spinner = $("#lightbox-spinner");
	resetLightboxTransform();
	spinner.hidden = false;
	img.style.visibility = "hidden";
	img.onload = img.onerror = () => {
		spinner.hidden = true;
		img.style.visibility = "";
	};
	img.src = url;
	img.alt = alt;
	const dl = $("#lightbox-download");
	dl.href = url;
	try {
		const tail = new URL(url, location.href).pathname.split("/").pop();
		if (tail) dl.setAttribute("download", tail);
	} catch {
		dl.setAttribute("download", "");
	}
	$("#lightbox-prev").hidden = idx <= 0;
	$("#lightbox-next").hidden = idx >= lightboxImages.length - 1;
}
function openLightbox(url, alt) {
	if (lightboxCloseTimer) {
		clearTimeout(lightboxCloseTimer);
		lightboxCloseTimer = null;
	}
	lightboxImages = snapshotRoomImages();
	let idx = lightboxImages.findIndex((it) => it.url === url);
	if (idx === -1) {
		lightboxImages = [{
			url,
			alt: alt || ""
		}];
		idx = 0;
	}
	const overlay = $("#lightbox");
	overlay.classList.remove("closing");
	overlay.hidden = false;
	lightboxOpen = true;
	prevBodyOverflow = document.body.style.overflow;
	document.body.style.overflow = "hidden";
	setLightboxImage(idx);
	history.pushState({ lightbox: true }, "");
	requestAnimationFrame(() => $("#lightbox-close").focus());
}
function closeLightbox(fromPopstate = false) {
	if (!lightboxOpen) return;
	const overlay = $("#lightbox");
	lightboxOpen = false;
	overlay.classList.add("closing");
	document.body.style.overflow = prevBodyOverflow;
	lightboxCloseTimer = setTimeout(() => {
		lightboxCloseTimer = null;
		overlay.hidden = true;
		overlay.classList.remove("closing");
		$("#lightbox-img").src = "";
		$("#lightbox-img").style.transform = "";
		$("#lightbox-img").style.visibility = "";
	}, 150);
	if (!fromPopstate && history.state && history.state.lightbox) history.back();
}
function navigateLightbox(delta) {
	const next = lightboxIndex + delta;
	if (next < 0 || next >= lightboxImages.length) return;
	setLightboxImage(next);
}
$("#lightbox-close").addEventListener("click", () => closeLightbox());
$("#lightbox-prev").addEventListener("click", (e) => {
	e.stopPropagation();
	navigateLightbox(-1);
});
$("#lightbox-next").addEventListener("click", (e) => {
	e.stopPropagation();
	navigateLightbox(1);
});
$("#lightbox-download").addEventListener("click", (e) => e.stopPropagation());
$("#lightbox").addEventListener("click", (e) => {
	if (e.target === $("#lightbox")) closeLightbox();
});
document.addEventListener("keydown", (e) => {
	if (!lightboxOpen) return;
	if (e.key === "Escape") closeLightbox();
	else if (e.key === "ArrowLeft") navigateLightbox(-1);
	else if (e.key === "ArrowRight") navigateLightbox(1);
});
var viewStack = [];
function openView(name, teardown) {
	viewStack.push({
		name,
		teardown
	});
	history.pushState({ viewDepth: viewStack.length }, "");
}
function closeView(name) {
	const idx = viewStack.map((v) => v.name).lastIndexOf(name);
	if (idx === -1) return;
	history.go(-(viewStack.length - idx));
}
window.addEventListener("popstate", (e) => {
	if (lightboxOpen) {
		closeLightbox(true);
		return;
	}
	const targetDepth = e.state && e.state.viewDepth || 0;
	while (viewStack.length > targetDepth) {
		const top = viewStack.pop();
		try {
			top.teardown();
		} catch (err) {
			console.error("view teardown failed", err);
		}
	}
});
function blockingOverlayOpen() {
	if (document.querySelector(".modal-overlay:not([hidden])")) return true;
	return [
		"model-picker",
		"lightbox",
		"members-overlay",
		"handle-popover",
		"overflow-menu",
		"search-results",
		"learn-menu"
	].some((id) => {
		const el = document.getElementById(id);
		return el && !el.hidden;
	});
}
function closeTopDetailAside() {
	const layers = [
		["members-panel", () => {
			$("#members-panel").hidden = true;
		}],
		["route-detail", closeRouteDetail],
		["model-detail", closeModelDetail],
		["agent-detail", closeAgentDetail],
		["mcp-detail", closeMcpDetail]
	];
	for (const [id, close] of layers) {
		const el = document.getElementById(id);
		if (el && !el.hidden) {
			close();
			return true;
		}
	}
	return false;
}
document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape" || viewStack.length === 0) return;
	if (blockingOverlayOpen()) return;
	const t = e.target;
	if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
	e.preventDefault();
	e.stopPropagation();
	if (closeTopDetailAside()) return;
	closeView(viewStack[viewStack.length - 1].name);
}, true);
function getTouchDist(touches) {
	const dx = touches[0].clientX - touches[1].clientX;
	const dy = touches[0].clientY - touches[1].clientY;
	return Math.hypot(dx, dy);
}
var lightboxImg = $("#lightbox-img");
lightboxImg.addEventListener("touchstart", (e) => {
	if (e.touches.length === 2) {
		e.preventDefault();
		lightboxGesture.mode = "pinch";
		lightboxGesture.startScale = lightboxXf.scale;
		lightboxGesture.startDist = getTouchDist(e.touches);
		lightboxGesture.startX = lightboxXf.x;
		lightboxGesture.startY = lightboxXf.y;
		lightboxImg.classList.add("dragging");
	} else if (e.touches.length === 1 && lightboxXf.scale > 1) {
		e.preventDefault();
		lightboxGesture.mode = "pan";
		lightboxGesture.startTouchX = e.touches[0].clientX;
		lightboxGesture.startTouchY = e.touches[0].clientY;
		lightboxGesture.startX = lightboxXf.x;
		lightboxGesture.startY = lightboxXf.y;
		lightboxImg.classList.add("dragging");
	}
}, { passive: false });
lightboxImg.addEventListener("touchmove", (e) => {
	if (lightboxGesture.mode === "pinch" && e.touches.length === 2) {
		e.preventDefault();
		const ratio = getTouchDist(e.touches) / lightboxGesture.startDist;
		lightboxXf.scale = Math.max(.5, Math.min(4, lightboxGesture.startScale * ratio));
		applyLightboxTransform();
	} else if (lightboxGesture.mode === "pan" && e.touches.length === 1) {
		e.preventDefault();
		lightboxXf.x = lightboxGesture.startX + (e.touches[0].clientX - lightboxGesture.startTouchX);
		lightboxXf.y = lightboxGesture.startY + (e.touches[0].clientY - lightboxGesture.startTouchY);
		applyLightboxTransform();
	}
}, { passive: false });
lightboxImg.addEventListener("touchend", () => {
	lightboxGesture.mode = null;
	lightboxImg.classList.remove("dragging");
	if (lightboxXf.scale < 1.05) resetLightboxTransform();
});
document.querySelectorAll("#theme-options .setting-option").forEach((btn) => {
	btn.addEventListener("click", () => {
		settings.theme = btn.dataset.value;
		saveSettings(settings);
		applySettings();
		renderSettingsModal();
	});
});
document.querySelectorAll("#font-options .setting-option").forEach((btn) => {
	btn.addEventListener("click", () => {
		settings.font = btn.dataset.value;
		saveSettings(settings);
		applySettings();
		renderSettingsModal();
	});
});
document.querySelectorAll("#send-options .setting-option").forEach((btn) => {
	btn.addEventListener("click", () => {
		settings.sendKey = btn.dataset.value;
		saveSettings(settings);
		renderSettingsModal();
	});
});
document.querySelectorAll("#tts-default-mode .setting-option").forEach((btn) => {
	btn.addEventListener("click", async () => {
		const on = btn.dataset.value === "on";
		const r = await authFetch("/api/tts/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ readAloud: on })
		});
		if (!r.ok) {
			showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return;
		}
		setTtsReadAloudEnabled(on);
		document.querySelectorAll("#tts-default-mode .setting-option").forEach((b) => b.classList.toggle("active", b === btn));
		if (!on) stopTts();
		showToast(on ? "Read aloud on for everyone — hover an agent reply for the speaker" : "Read aloud off for everyone");
	});
});
$("#notif-toggle").addEventListener("change", async () => {
	if ($("#notif-toggle").checked) {
		if (Notification.permission !== "granted") {
			if (await Notification.requestPermission() !== "granted") {
				$("#notif-toggle").checked = false;
				settings.notifications = false;
				saveSettings(settings);
				showToast("Notifications need browser permission to turn on", { kind: "info" });
				return;
			}
		}
		await enableWebPush({ interactive: true });
	} else await disableWebPush();
	settings.notifications = $("#notif-toggle").checked;
	saveSettings(settings);
});
$("#handle-save")?.addEventListener("click", saveHandle);
$("#handle-input")?.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		saveHandle();
	}
});
function urlBase64ToUint8Array(base64String) {
	const base64 = (base64String + "=".repeat((4 - base64String.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const buf = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
	return buf;
}
async function enableWebPush({ interactive = false } = {}) {
	const fail = (msg, err) => {
		console.warn("[push]", msg, err ?? "");
		if (interactive) showToast(msg, { kind: "error" });
	};
	try {
		if (!("serviceWorker" in navigator)) return fail("Notifications aren’t supported in this browser");
		if (!("PushManager" in window)) {
			console.warn("[push] PushManager unavailable");
			if (interactive) showToast("To enable notifications on iOS, add this app to your home screen and open it from there", {
				kind: "info",
				timeout: 6e3
			});
			return;
		}
		console.log("[push] fetching VAPID key");
		const keyRes = await authFetch("/api/push/vapid-public");
		if (!keyRes.ok) return fail("Couldn’t enable notifications — the server has no push key");
		const { key } = await keyRes.json();
		if (!key) return fail("Couldn’t enable notifications — the server has no push key");
		const reg = await navigator.serviceWorker.ready;
		let sub = await reg.pushManager.getSubscription();
		if (!sub) {
			console.log("[push] subscribing");
			sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(key)
			});
		} else console.log("[push] reusing existing subscription");
		if (!(await authFetch("/api/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(sub.toJSON())
		})).ok) return fail("Couldn’t save your notification subscription");
		console.log("[push] subscribed", sub.endpoint.slice(-24));
		if (interactive) showToast("Notifications enabled", { kind: "success" });
	} catch (err) {
		fail("Couldn’t enable notifications", err);
	}
}
async function disableWebPush() {
	try {
		if (!("serviceWorker" in navigator)) return;
		const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
		if (sub) {
			await authFetch("/api/push/unsubscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint: sub.endpoint })
			});
			await sub.unsubscribe();
			console.log("[push] unsubscribed");
		}
	} catch (err) {
		console.error("[push] unsubscribe failed:", err);
	}
}
var ws;
var currentRoom = null;
var myIdentity = "";
var myHandle = "";
var pendingMessages = /* @__PURE__ */ new Map();
var typingUsers = /* @__PURE__ */ new Map();
var unreadRooms = /* @__PURE__ */ new Set();
var mentionedRooms = /* @__PURE__ */ new Set();
var roomMentionPeople = [];
var showArchived = sessionStorage.getItem("webchat:showArchived") === "1";
var showHidden = sessionStorage.getItem("webchat:showHidden") === "1";
var roomSortAz = sessionStorage.getItem("webchat:roomSortAz") === "1";
var agentSortAz = sessionStorage.getItem("webchat:agentSortAz") === "1";
var modelSortAz = sessionStorage.getItem("webchat:modelSortAz") === "1";
var usersSortAz = sessionStorage.getItem("webchat:usersSortAz") === "1";
var manageTab = "agents";
var agentName = "";
var lastSeenMessageId = sessionStorage.getItem("lastSeenMessageId") || null;
var reconnectDelay = 1e3;
function setLastSeenMessageId(id) {
	lastSeenMessageId = id;
	if (id) sessionStorage.setItem("lastSeenMessageId", id);
}
async function fetchMyHandle() {
	try {
		const r = await authFetch("/api/me/handle");
		if (r.ok) myHandle = ((await r.json()).handle || "").toLowerCase();
	} catch {}
	renderHandleChip();
}
function messageMentionsMe(text) {
	if (!myHandle || typeof text !== "string") return false;
	return new RegExp("(?:^|[^a-z0-9_-])@" + myHandle + "(?![a-z0-9-])", "i").test(text);
}
function connect() {
	if (ws) {
		ws._intentionalClose = true;
		try {
			ws.close();
		} catch {}
	}
	const sock = new WebSocket(getWsUrl(), getWsProtocols());
	ws = sock;
	sock.onopen = () => {
		$("#connection-banner").classList.remove("visible");
		reconnectDelay = 1e3;
		lastProbeAt = 0;
		lastDiagnosis = null;
		sock.send(JSON.stringify({ type: "auth" }));
	};
	sock.onmessage = (evt) => {
		const msg = JSON.parse(evt.data);
		switch (msg.type) {
			case "system":
				if (msg.message && !myIdentity) {
					const m = msg.message.match(/^(?:Connected as|Welcome,)\s+(.+)$/);
					if (m) myIdentity = m[1].trim();
				}
				appendSystem(msg.message);
				return;
			case "rooms":
				if (!lastRoomsList.length && msg.rooms.length) refreshDraftBadge();
				lastRoomsList = msg.rooms;
				msg.rooms.forEach((r) => {
					if (r.unread && r.id !== currentRoom) unreadRooms.add(r.id);
					if (r.mention && r.id !== currentRoom) mentionedRooms.add(r.id);
					else if (!r.mention) mentionedRooms.delete(r.id);
					else unreadRooms.delete(r.id);
				});
				renderRooms(msg.rooms);
				if (allAgents.length === 0) authFetch("/api/agents").then((r) => r.json()).then((b) => {
					allAgents = b;
				}).catch(() => {});
				fetchApprovals();
				fetchMyHandle();
				probeIsOwner();
				refreshWiredAgentsForCurrentRoom();
				fetchMentionablePeople();
				if (currentRoom) {
					ws.send(JSON.stringify({
						type: "join",
						room_id: currentRoom
					}));
					if (lastSeenMessageId) authFetch(`/api/rooms/${currentRoom}/messages?after_id=${lastSeenMessageId}`).then((r) => r.json()).then((missed) => {
						if (missed.length > 0) {
							const wasNearBottom = isNearBottom();
							missed.forEach((m) => appendMessage(m));
							setLastSeenMessageId(missed[missed.length - 1].id);
							if (wasNearBottom) scrollToBottom();
							else updateScrollButton();
						}
					}).catch(() => {});
				} else {
					const saved = localStorage.getItem("lastRoom");
					if (saved) {
						const room = msg.rooms.find((r) => r.id === saved);
						if (room) {
							const savedThread = localStorage.getItem("lastThread:" + saved);
							joinRoom(room.id, room.name, void 0, savedThread && savedThread !== "main" ? savedThread : void 0);
						}
					}
				}
				break;
			case "history": {
				$("#messages").innerHTML = "";
				msg.messages.forEach((m) => appendMessage(m));
				oldestMessageId = msg.messages.length ? msg.messages[0].id : null;
				noMoreOlder = msg.messages.length < 50;
				loadingOlder = false;
				if (msg.messages.length === 0) $("#messages").innerHTML = "<div class=\"empty-state\">No messages yet. Start the conversation!</div>";
				endTranscriptSwitch();
				if (msg.messages.length > 0) setLastSeenMessageId(msg.messages[msg.messages.length - 1].id);
				const sendAfter = pendingSendAfterJoin;
				pendingSendAfterJoin = null;
				if (sendAfter) triggerLearn(sendAfter);
				const jumpTo = pendingJumpMessageId;
				pendingJumpMessageId = null;
				if (jumpTo) jumpToMessage(jumpTo);
				else {
					scrollToBottom(true);
					requestAnimationFrame(() => scrollToBottom(true));
					setTimeout(() => scrollToBottom(true), 100);
					setTimeout(() => scrollToBottom(true), 300);
				}
				break;
			}
			case "members":
				if (msg.room_id === currentRoom) {
					renderMembers(msg.members);
					fetchMentionablePeople();
				}
				break;
			case "message": {
				if (msg.room_id && msg.created_at) {
					roomActivity.set(msg.room_id, Math.max(roomActivity.get(msg.room_id) || 0, msg.created_at));
					if (lastRoomsList.length) renderRooms(lastRoomsList);
				}
				const msgThread = msg.thread_id || "main";
				if ((msg.room_id || currentRoom) === currentRoom && msgThread !== currentThread) {
					if (msg.sender !== myIdentity) {
						threadUnread.add(msgThread);
						if (!threadCreating && !threadRenaming) renderThreadList();
					}
					break;
				}
				const wasNearBottom = isNearBottom();
				if (settings.notifications && document.hidden && msg.sender !== myIdentity && msg.message_type !== "a2a" && msg.sender_type !== "a2a") try {
					const mentioned = messageMentionsMe(msg.content);
					new Notification(mentioned ? `${msg.sender} mentioned you` : `${msg.sender}`, {
						body: msg.content.slice(0, 100),
						tag: msg.id || "nanoclaw-msg",
						requireInteraction: mentioned
					});
				} catch {}
				let appendedEl = null;
				if (msg.sender === myIdentity && msg.client_id && pendingMessages.has(msg.client_id)) {
					const el = pendingMessages.get(msg.client_id);
					const status = el.querySelector(".status");
					if (status) status.textContent = "✓✓";
					if (status) status.classList.add("delivered");
					pendingMessages.delete(msg.client_id);
					if (msg.id) {
						el.dataset.messageId = msg.id;
						addDeleteButton(el, msg.id);
					}
				} else appendedEl = appendMessage(msg);
				if (msg.id && msg.room_id === currentRoom) {
					setLastSeenMessageId(msg.id);
					if (!document.hidden && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
						type: "read",
						room_id: currentRoom,
						thread_id: currentThread
					}));
				}
				if (wasNearBottom || forceScrollCount > 0 && !userScrolledAway) {
					scrollToBottom();
					requestAnimationFrame(() => {
						if (!userScrolledAway) scrollToBottom();
					});
					setTimeout(() => {
						if (!userScrolledAway) scrollToBottom();
					}, 200);
					if (appendedEl) appendedEl.querySelectorAll("img").forEach((img) => {
						if (img.complete) return;
						img.addEventListener("load", scheduleFollowScroll, { once: true });
					});
					if (forceScrollCount > 0) forceScrollCount--;
				} else incrementMissedMessages();
				break;
			}
			case "typing":
				handleTypingEvent(msg);
				break;
			case "status":
				handleStatusEvent(msg);
				break;
			case "unread":
				if (msg.room_id && msg.room_id !== currentRoom) {
					unreadRooms.add(msg.room_id);
					updateUnreadDots();
				}
				break;
			case "mention":
				if (msg.room_id && msg.room_id !== currentRoom) {
					mentionedRooms.add(msg.room_id);
					unreadRooms.add(msg.room_id);
					updateUnreadDots();
				}
				break;
			case "read_cleared": {
				const cleared = (msg.room_id && unreadRooms.delete(msg.room_id)) | 0;
				const clearedMention = (msg.room_id && mentionedRooms.delete(msg.room_id)) | 0;
				if (cleared || clearedMention) updateUnreadDots();
				break;
			}
			case "delete_message":
				if (msg.message_id) {
					const el = document.querySelector(`[data-message-id="${CSS.escape(msg.message_id)}"]`);
					if (el) {
						el.classList.add("deleting");
						setTimeout(() => el.remove(), 350);
					}
				}
				break;
			case "approval":
				handleApprovalEvent(msg);
				break;
			case "approval_resolved":
				handleApprovalResolvedEvent(msg);
				break;
			case "skill_draft_review":
				handleSkillDraftReview(msg);
				break;
			case "error": console.error("WS error:", msg.error);
		}
	};
	sock.onclose = () => {
		if (sock._intentionalClose) return;
		if (ws !== sock) return;
		setConnectionBanner("Connection lost. Reconnecting…");
		diagnoseConnection();
		myIdentity = "";
		setTimeout(connect, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, 3e4);
	};
}
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState !== "visible") return;
	if (ws && ws.readyState !== WebSocket.OPEN) connect();
	else {
		fetchApprovals();
		if (currentRoom) ws.send(JSON.stringify({
			type: "read",
			room_id: currentRoom,
			thread_id: currentThread
		}));
	}
});
window.addEventListener("online", () => {
	if (ws && ws.readyState !== WebSocket.OPEN) {
		reconnectDelay = 1e3;
		connect();
	}
});
window.addEventListener("offline", () => {
	if (ws && ws.readyState !== WebSocket.OPEN) diagnoseConnection();
});
setInterval(() => {
	if (document.visibilityState === "visible") fetchApprovals();
}, 1e4);
var roomActivity = /* @__PURE__ */ new Map();
function activityOf(room) {
	return Math.max(room.last_activity || room.created_at || 0, roomActivity.get(room.id) || 0);
}
var ROOM_DIVIDER = Symbol("room-divider");
var renderRoomsRetryTimer = null;
function renderRooms(rooms) {
	const list = $("#room-list");
	if (list.querySelector(".room-menu")) {
		clearTimeout(renderRoomsRetryTimer);
		renderRoomsRetryTimer = setTimeout(() => renderRooms(rooms), 400);
		return;
	}
	const prevScrollTop = list.scrollTop;
	if (!list.dataset.dropWired) {
		list.dataset.dropWired = "1";
		list.addEventListener("dragover", (e) => {
			if (!list.classList.contains("room-list-dragging")) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		});
		list.addEventListener("drop", async (e) => {
			if (!list.classList.contains("room-list-dragging")) return;
			e.preventDefault();
			const id = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
			list.classList.remove("room-list-dragging");
			if (id) await toggleRoomPin(id, true);
		});
	}
	list.innerHTML = "";
	const byActivity = (a, b) => activityOf(b) - activityOf(a);
	const byName = (a, b) => String(a.id).localeCompare(String(b.id));
	const roomCmp = roomSortAz ? byName : byActivity;
	const visibleRooms = showHidden ? [...rooms] : rooms.filter((r) => !r.hidden);
	const active = visibleRooms.filter((r) => !r.archived);
	const archived = visibleRooms.filter((r) => r.archived).sort(roomCmp);
	const pinned = active.filter((r) => r.pinned).sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0) || byActivity(a, b));
	const unpinned = active.filter((r) => !r.pinned).sort(roomCmp);
	const toggleBtn = $("#archived-toggle");
	if (archived.length === 0) toggleBtn.hidden = true;
	else {
		toggleBtn.hidden = false;
		toggleBtn.textContent = showArchived ? `Hide ${archived.length} archived` : `Show ${archived.length} archived`;
	}
	const hiddenCount = rooms.filter((r) => r.hidden).length;
	const hiddenBtn = $("#hidden-toggle");
	if (hiddenCount === 0) hiddenBtn.hidden = true;
	else {
		hiddenBtn.hidden = false;
		hiddenBtn.textContent = showHidden ? `Hide ${hiddenCount} hidden` : `Show ${hiddenCount} hidden`;
	}
	const showDivider = pinned.length > 0 && unpinned.length > 0;
	const toRender = [
		...pinned,
		...showDivider ? [ROOM_DIVIDER] : [],
		...unpinned,
		...showArchived ? archived : []
	];
	for (let i = 0; i < toRender.length; i++) {
		const room = toRender[i];
		if (room === ROOM_DIVIDER) {
			const sep = document.createElement("li");
			sep.className = "room-divider";
			sep.setAttribute("role", "separator");
			list.appendChild(sep);
			continue;
		}
		const li = document.createElement("li");
		const color = roomColor(room.id);
		li.dataset.roomId = room.id;
		li.style.borderLeftColor = color;
		if (room.archived) li.classList.add("archived");
		const text = document.createElement("span");
		text.className = "room-row-name";
		text.textContent = `#${room.id}`;
		li.appendChild(text);
		if (mentionedRooms.has(room.id)) {
			const badge = document.createElement("span");
			badge.className = "mention-dot";
			badge.textContent = "@";
			badge.title = "You were mentioned here";
			li.appendChild(badge);
		} else if (unreadRooms.has(room.id)) {
			const dot = document.createElement("span");
			dot.className = "unread-dot";
			dot.style.background = color;
			li.appendChild(dot);
		}
		if (room.pinned) {
			const pin = document.createElement("span");
			pin.className = "room-pin-indicator";
			pin.innerHTML = lucide$1("pin");
			pin.setAttribute("aria-label", "Pinned");
			li.appendChild(pin);
		}
		if (!room.archived) {
			li.draggable = true;
			li.addEventListener("dragstart", (e) => {
				if (e.dataTransfer) {
					e.dataTransfer.setData("text/plain", room.id);
					e.dataTransfer.effectAllowed = "move";
				}
				if (room.pinned) {
					draggedPinId = room.id;
					list.classList.add("room-list-reordering");
				} else {
					draggedPinId = null;
					list.classList.add("room-list-dragging");
				}
			});
			li.addEventListener("dragend", () => {
				draggedPinId = null;
				list.classList.remove("room-list-dragging", "room-list-reordering");
				list.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
			});
		}
		if (room.pinned) {
			const clearMarkers = () => li.classList.remove("drop-before", "drop-after");
			li.addEventListener("dragover", (e) => {
				if (!draggedPinId || draggedPinId === room.id) return;
				e.preventDefault();
				e.stopPropagation();
				const rect = li.getBoundingClientRect();
				const after = e.clientY > rect.top + rect.height / 2;
				li.classList.toggle("drop-after", after);
				li.classList.toggle("drop-before", !after);
			});
			li.addEventListener("dragleave", clearMarkers);
			li.addEventListener("drop", async (e) => {
				if (!draggedPinId || draggedPinId === room.id) return;
				e.preventDefault();
				e.stopPropagation();
				const rect = li.getBoundingClientRect();
				const after = e.clientY > rect.top + rect.height / 2;
				const moved = draggedPinId;
				draggedPinId = null;
				clearMarkers();
				list.classList.remove("room-list-reordering");
				await reorderPinnedRoom(moved, room.id, after);
			});
		}
		const kebab = document.createElement("button");
		kebab.className = "room-kebab";
		kebab.type = "button";
		kebab.innerHTML = lucide$1("ellipsis");
		kebab.setAttribute("aria-label", "Room actions");
		kebab.addEventListener("click", (e) => {
			e.stopPropagation();
			list.querySelectorAll(".room-menu").forEach((m) => m.remove());
			const menu = document.createElement("div");
			menu.className = "room-menu";
			const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
			if (room.pinned || coarsePointer) {
				const pinBtn = document.createElement("button");
				pinBtn.type = "button";
				pinBtn.textContent = room.pinned ? "Unpin" : "Pin";
				pinBtn.addEventListener("click", async (ev) => {
					ev.stopPropagation();
					menu.remove();
					await toggleRoomPin(room.id, !room.pinned);
				});
				menu.appendChild(pinBtn);
			}
			if (room.pinned && pinned.length > 1) {
				const pinIdx = pinned.findIndex((r) => r.id === room.id);
				if (pinIdx > 0) {
					const upBtn = document.createElement("button");
					upBtn.type = "button";
					upBtn.textContent = "Move up";
					upBtn.addEventListener("click", async (ev) => {
						ev.stopPropagation();
						menu.remove();
						await movePinnedRoom(room.id, -1);
					});
					menu.appendChild(upBtn);
				}
				if (pinIdx < pinned.length - 1) {
					const downBtn = document.createElement("button");
					downBtn.type = "button";
					downBtn.textContent = "Move down";
					downBtn.addEventListener("click", async (ev) => {
						ev.stopPropagation();
						menu.remove();
						await movePinnedRoom(room.id, 1);
					});
					menu.appendChild(downBtn);
				}
			}
			const hideBtn = document.createElement("button");
			hideBtn.type = "button";
			hideBtn.textContent = room.hidden ? "Unhide" : "Hide";
			hideBtn.addEventListener("click", async (ev) => {
				ev.stopPropagation();
				menu.remove();
				await toggleRoomHide(room.id, !room.hidden);
			});
			menu.appendChild(hideBtn);
			if (room.canArchive) {
				const archiveBtn = document.createElement("button");
				archiveBtn.type = "button";
				archiveBtn.textContent = room.archived ? "Unarchive" : "Archive";
				archiveBtn.addEventListener("click", async (ev) => {
					ev.stopPropagation();
					menu.remove();
					await toggleRoomArchive(room.id, !room.archived);
				});
				menu.appendChild(archiveBtn);
			}
			li.appendChild(menu);
			const close = () => {
				menu.remove();
				document.removeEventListener("click", close);
			};
			setTimeout(() => document.addEventListener("click", close), 0);
		});
		const actions = document.createElement("span");
		actions.className = "room-actions";
		actions.appendChild(kebab);
		if (room.id !== currentRoom) {
			if (threadAddRoom === room.id) appendRoomThreadInput(li, room);
			else {
				const add = document.createElement("button");
				add.className = "thread-add-inline";
				add.type = "button";
				add.textContent = "+";
				add.title = "New thread";
				add.setAttribute("aria-label", `New thread in #${room.id}`);
				add.addEventListener("click", (e) => {
					e.stopPropagation();
					threadAddRoom = room.id;
					threadCreating = false;
					renderRooms(lastRoomsList);
				});
				actions.appendChild(add);
			}
		}
		li.appendChild(actions);
		const threadCount = room.thread_count || 0;
		if (threadCount > 0) {
			const open = expandedRooms.has(room.id);
			const chev = document.createElement("button");
			chev.className = "room-thread-toggle";
			chev.type = "button";
			chev.textContent = open ? "▾" : "▸";
			const lbl = `${threadCount} thread${threadCount === 1 ? "" : "s"}`;
			chev.title = lbl;
			chev.setAttribute("aria-label", `${open ? "Collapse" : "Show"} ${lbl}`);
			chev.setAttribute("aria-expanded", open ? "true" : "false");
			chev.addEventListener("click", (e) => {
				e.stopPropagation();
				toggleRoomThreads(room.id);
			});
			li.insertBefore(chev, li.firstChild);
		}
		if (room.id === currentRoom) li.classList.add("active");
		li.setAttribute("role", "button");
		li.setAttribute("tabindex", "0");
		li.addEventListener("click", () => joinRoom(room.id, room.name));
		li.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				joinRoom(room.id, room.name);
			}
		});
		list.appendChild(li);
		if (room.id === currentRoom) {
			if (expandedRooms.has(room.id)) {
				const threadHost = document.createElement("div");
				threadHost.className = "thread-list";
				li.appendChild(threadHost);
			}
		} else if (expandedRooms.has(room.id)) {
			const threadHost = document.createElement("div");
			threadHost.className = "thread-list";
			li.appendChild(threadHost);
			renderRoomThreads(li, room.id);
		}
	}
	if (currentRoom && expandedRooms.has(currentRoom)) renderThreadList();
	list.scrollTop = prevScrollTop;
}
var lastRoomsList = [];
function updateUnreadDots() {
	if (lastRoomsList.length) renderRooms(lastRoomsList);
}
async function toggleRoomArchive(roomId, archive) {
	const target = lastRoomsList.find((r) => r.id === roomId);
	if (target) target.archived = archive;
	renderRooms(lastRoomsList);
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${archive ? "archive" : "unarchive"}`, {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("toggleRoomArchive failed:", err);
		if (target) target.archived = !archive;
		renderRooms(lastRoomsList);
	}
}
var draggedPinId = null;
async function reorderPinnedRoom(movedId, targetId, after) {
	const order = lastRoomsList.filter((r) => r.pinned && !r.archived).sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0)).map((r) => r.id);
	const from = order.indexOf(movedId);
	if (from === -1) return;
	order.splice(from, 1);
	let to = order.indexOf(targetId);
	if (to === -1) return;
	if (after) to += 1;
	order.splice(to, 0, movedId);
	order.forEach((id, i) => {
		const r = lastRoomsList.find((x) => x.id === id);
		if (r) r.pin_position = i;
	});
	renderRooms(lastRoomsList);
	try {
		const res = await authFetch("/api/rooms/pins/order", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ order })
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("reorderPinnedRoom failed:", err);
	}
}
async function movePinnedRoom(roomId, dir) {
	const order = lastRoomsList.filter((r) => r.pinned && !r.archived).sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0)).map((r) => r.id);
	const i = order.indexOf(roomId);
	const j = i + dir;
	if (i === -1 || j < 0 || j >= order.length) return;
	[order[i], order[j]] = [order[j], order[i]];
	order.forEach((id, k) => {
		const r = lastRoomsList.find((x) => x.id === id);
		if (r) r.pin_position = k;
	});
	renderRooms(lastRoomsList);
	try {
		const res = await authFetch("/api/rooms/pins/order", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ order })
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("movePinnedRoom failed:", err);
	}
}
async function toggleRoomPin(roomId, pin) {
	const target = lastRoomsList.find((r) => r.id === roomId);
	if (target) target.pinned = pin;
	renderRooms(lastRoomsList);
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${pin ? "pin" : "unpin"}`, {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("toggleRoomPin failed:", err);
		if (target) target.pinned = !pin;
		renderRooms(lastRoomsList);
	}
}
async function toggleRoomHide(roomId, hide) {
	const target = lastRoomsList.find((r) => r.id === roomId);
	if (target) target.hidden = hide;
	renderRooms(lastRoomsList);
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${hide ? "hide" : "unhide"}`, {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("toggleRoomHide failed:", err);
		if (target) target.hidden = !hide;
		renderRooms(lastRoomsList);
	}
}
var currentThread = "main";
var threadCreating = false;
var threadAddRoom = null;
var threadRenaming = null;
var threadUnread = /* @__PURE__ */ new Set();
var expandedRooms = /* @__PURE__ */ new Set();
var threadCache = /* @__PURE__ */ new Map();
function roomThreads() {
	return threadCache.get(currentRoom) || [];
}
function toggleRoomThreads(roomId) {
	if (expandedRooms.has(roomId)) {
		expandedRooms.delete(roomId);
		renderRooms(lastRoomsList);
		return;
	}
	expandedRooms.add(roomId);
	if (!threadCache.has(roomId)) loadRoomThreads(roomId).then(() => {
		if (expandedRooms.has(roomId)) renderRooms(lastRoomsList);
	});
	renderRooms(lastRoomsList);
}
async function loadRoomThreads(roomId) {
	try {
		const r = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/threads`);
		threadCache.set(roomId, r.ok ? await r.json() ?? [] : []);
	} catch {
		threadCache.set(roomId, []);
	}
}
function renderRoomThreads(li, roomId) {
	const host = li.querySelector(".thread-list");
	if (!host) return;
	host.innerHTML = "";
	const threads = threadCache.get(roomId);
	if (!Array.isArray(threads)) {
		host.innerHTML = "<div class=\"thread-loading\">Loading…</div>";
		return;
	}
	const room = lastRoomsList.find((r) => r.id === roomId);
	for (const t of threads.filter((t) => t.kind !== "main")) {
		const row = document.createElement("div");
		row.className = "thread-row";
		row.dataset.threadId = t.thread_id;
		row.style.setProperty("--thread-color", roomColor(t.thread_id));
		row.setAttribute("role", "button");
		row.tabIndex = 0;
		row.setAttribute("aria-label", `Open thread ${t.title}`);
		const glyph = document.createElement("span");
		glyph.className = "thread-glyph";
		glyph.textContent = "#";
		glyph.setAttribute("aria-hidden", "true");
		row.appendChild(glyph);
		const label = document.createElement("span");
		label.className = "thread-label";
		label.textContent = t.title;
		row.appendChild(label);
		const enter = () => joinRoom(roomId, room ? room.name : roomId, void 0, t.thread_id);
		row.addEventListener("click", (e) => {
			e.stopPropagation();
			enter();
		});
		row.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				e.stopPropagation();
				enter();
			}
		});
		host.appendChild(row);
	}
}
async function loadThreadList(roomId) {
	try {
		const r = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/threads`);
		if (roomId !== currentRoom) return;
		if (!r.ok) {
			threadCache.set(roomId, []);
			renderThreadList();
			if (r.status !== 404) showToast("Could not load threads", { kind: "error" });
			return;
		}
		const threads = await r.json();
		const list = Array.isArray(threads) ? threads : [];
		threadCache.set(roomId, list);
		for (const t of list) if (t.unread && t.thread_id !== currentThread) threadUnread.add(t.thread_id);
		renderThreadList();
		updateThreadSyncControls();
	} catch {
		if (roomId !== currentRoom) return;
		threadCache.set(roomId, []);
		renderThreadList();
		showToast("Could not load threads", { kind: "error" });
	}
}
function threadGlyph(kind) {
	return kind === "agent" ? "@" : "#";
}
function renderThreadList() {
	const li = document.querySelector(`#room-list li[data-room-id="${cssEscape(currentRoom)}"]`);
	li?.querySelector(".thread-add-inline")?.remove();
	const host = li?.querySelector(".thread-list");
	if (!host) return;
	host.innerHTML = "";
	const nonMain = roomThreads().filter((t) => t.kind !== "main");
	for (const t of nonMain) {
		if (t.thread_id === threadRenaming) {
			host.appendChild(buildThreadRenameRow(t));
			continue;
		}
		const row = document.createElement("div");
		row.className = "thread-row" + (t.thread_id === currentThread ? " active" : "");
		row.dataset.threadId = t.thread_id;
		row.setAttribute("role", "button");
		row.tabIndex = 0;
		row.setAttribute("aria-label", `Open thread ${t.title}`);
		if (t.thread_id === currentThread) row.setAttribute("aria-current", "true");
		row.style.setProperty("--thread-color", roomColor(t.thread_id));
		const glyph = document.createElement("span");
		glyph.className = "thread-glyph";
		glyph.textContent = threadGlyph(t.kind);
		glyph.setAttribute("aria-hidden", "true");
		row.appendChild(glyph);
		const label = document.createElement("span");
		label.className = "thread-label";
		label.textContent = t.title;
		row.appendChild(label);
		if (t.thread_id !== currentThread && threadUnread.has(t.thread_id)) {
			const dot = document.createElement("span");
			dot.className = "thread-unread";
			row.appendChild(dot);
		}
		if (t.kind !== "main") {
			const menu = document.createElement("button");
			menu.className = "thread-kebab";
			menu.type = "button";
			menu.innerHTML = lucide$1("ellipsis");
			menu.setAttribute("aria-label", "Thread actions");
			menu.addEventListener("click", (e) => {
				e.stopPropagation();
				openThreadMenu(t, menu);
			});
			row.appendChild(menu);
		}
		row.addEventListener("click", (e) => {
			e.stopPropagation();
			openThread(t.thread_id);
		});
		row.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				e.stopPropagation();
				openThread(t.thread_id);
			}
		});
		host.appendChild(row);
	}
	if (threadCreating) host.appendChild(makeThreadNameInput({
		ariaLabel: "New thread name",
		onCancel: () => {
			threadCreating = false;
			renderThreadList();
		},
		onSubmit: (title) => {
			threadCreating = false;
			createThread(title);
		}
	}));
	else if (nonMain.length === 0) {
		const add = document.createElement("button");
		add.className = "thread-add-inline";
		add.type = "button";
		add.textContent = "+";
		add.title = "New thread";
		add.setAttribute("aria-label", "New thread");
		add.addEventListener("click", (e) => {
			e.stopPropagation();
			threadCreating = true;
			renderThreadList();
		});
		(li.querySelector(".room-actions") || li).appendChild(add);
	} else {
		const add = document.createElement("button");
		add.className = "thread-add-inline";
		add.type = "button";
		add.textContent = "+";
		add.title = "New thread";
		add.setAttribute("aria-label", "New thread");
		add.addEventListener("click", (e) => {
			e.stopPropagation();
			threadCreating = true;
			renderThreadList();
		});
		const lastRow = host.lastElementChild;
		if (lastRow) lastRow.appendChild(add);
		else li.appendChild(add);
	}
}
function openThread(threadId) {
	if (!currentRoom || threadId === currentThread) return;
	hideOtherFullViews();
	$("#chat").hidden = false;
	$("#app").classList.add("in-room");
	$("#app").classList.remove("in-dashboard");
	currentThread = threadId;
	localStorage.setItem("lastThread:" + currentRoom, threadId);
	threadUnread.delete(threadId);
	beginTranscriptSwitch();
	ws.send(JSON.stringify({
		type: "join",
		room_id: currentRoom,
		thread_id: threadId
	}));
	renderThreadList();
	updateThreadSyncControls();
}
function updateThreadSyncControls() {
	const inThread = !!(currentRoom && currentThread && currentThread !== "main");
	const sw = $("#thread-switch");
	if (sw) {
		sw.hidden = !currentRoom;
		const topicCount = roomThreads().filter((t) => t.kind !== "main").length;
		sw.textContent = topicCount > 0 ? `#${topicCount}` : "#";
		sw.classList.toggle("has-threads", topicCount > 0);
		sw.title = topicCount > 0 ? `${topicCount} thread${topicCount === 1 ? "" : "s"}` : "Threads";
	}
	const sync = $("#thread-sync");
	if (sync) sync.hidden = !inThread;
	const crumb = $("#thread-crumb");
	if (crumb) {
		crumb.hidden = !inThread;
		if (inThread) {
			const thread = roomThreads().find((t) => t.thread_id === currentThread);
			const nameEl = $("#thread-crumb-name");
			if (nameEl) {
				nameEl.textContent = thread ? thread.title : currentThread;
				nameEl.style.setProperty("--thread-color", roomColor(currentThread));
			}
		}
	}
}
async function createThread(title, roomId = currentRoom) {
	try {
		const thread = await apiJson(`/api/rooms/${encodeURIComponent(roomId)}/threads`, {
			method: "POST",
			body: { title }
		});
		if (roomId === currentRoom) {
			await loadThreadList(roomId);
			openThread(thread.thread_id);
		} else {
			const room = lastRoomsList.find((x) => x.id === roomId);
			joinRoom(roomId, room ? room.name : roomId, void 0, thread.thread_id);
		}
	} catch (err) {
		showToast("Could not create thread: " + (err.message || err), { kind: "error" });
		if (roomId === currentRoom) renderThreadList();
	}
}
function makeThreadNameInput({ value = "", placeholder = "Thread name…", ariaLabel, selectAll = false, blurSubmits = false, onSubmit, onCancel }) {
	const input = document.createElement("input");
	input.type = "text";
	input.className = "thread-add-input";
	input.maxLength = 80;
	if (value) input.value = value;
	else input.placeholder = placeholder;
	if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
	let settled = false;
	const cancel = () => {
		if (settled) return;
		settled = true;
		onCancel?.();
	};
	const submit = () => {
		if (settled) return;
		const title = input.value.trim();
		if (!title || title === value) return cancel();
		settled = true;
		onSubmit(title);
	};
	input.addEventListener("click", (e) => e.stopPropagation());
	input.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.key === "Enter") {
			e.preventDefault();
			submit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancel();
		}
	});
	input.addEventListener("blur", blurSubmits ? submit : cancel);
	setTimeout(() => {
		input.focus();
		if (selectAll) input.select();
	}, 0);
	return input;
}
function appendRoomThreadInput(li, room) {
	const host = document.createElement("div");
	host.className = "thread-list";
	host.appendChild(makeThreadNameInput({
		ariaLabel: `New thread in #${room.id}`,
		onCancel: () => {
			threadAddRoom = null;
			renderRooms(lastRoomsList);
		},
		onSubmit: (title) => {
			threadAddRoom = null;
			createThread(title, room.id);
		}
	}));
	li.appendChild(host);
}
function openThreadMenu(thread, anchor) {
	closeThreadMenus();
	const menu = document.createElement("div");
	menu.className = "thread-menu";
	const rename = document.createElement("button");
	rename.textContent = "Rename";
	rename.addEventListener("click", () => {
		closeThreadMenus();
		startThreadRename(thread);
	});
	menu.appendChild(rename);
	if (isOwnerView) {
		const del = document.createElement("button");
		del.className = "danger";
		del.textContent = "Delete";
		del.addEventListener("click", () => {
			closeThreadMenus();
			deleteThreadConfirm(thread, anchor.closest(".thread-row"));
		});
		menu.appendChild(del);
	}
	anchor.parentElement.appendChild(menu);
	setTimeout(() => document.addEventListener("click", closeThreadMenus, { once: true }), 0);
}
function closeThreadMenus() {
	document.querySelectorAll(".thread-menu").forEach((m) => m.remove());
}
function closeThreadSwitcher() {
	document.querySelectorAll(".thread-switcher").forEach((m) => m.remove());
}
function openThreadSwitcher() {
	closeThreadSwitcher();
	if (!currentRoom) return;
	const btn = $("#thread-switch");
	if (!btn) return;
	const pop = document.createElement("div");
	pop.className = "thread-switcher";
	pop.setAttribute("role", "menu");
	const addRow = (label, threadId, tinted) => {
		const b = document.createElement("button");
		b.className = "thread-switcher-item" + (threadId === currentThread ? " active" : "");
		b.type = "button";
		b.setAttribute("role", "menuitem");
		if (tinted) {
			const dot = document.createElement("span");
			dot.className = "thread-switcher-dot";
			dot.style.background = roomColor(threadId);
			b.appendChild(dot);
		}
		const name = document.createElement("span");
		name.className = "thread-switcher-label";
		name.textContent = label;
		b.appendChild(name);
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			closeThreadSwitcher();
			openThread(threadId);
		});
		pop.appendChild(b);
	};
	addRow("Main chat", "main", false);
	for (const t of roomThreads().filter((t) => t.kind !== "main")) addRow(t.title, t.thread_id, true);
	const add = document.createElement("button");
	add.className = "thread-switcher-item thread-switcher-new";
	add.type = "button";
	add.textContent = "+ New thread";
	add.addEventListener("click", (e) => {
		e.stopPropagation();
		switcherCreate(pop, add);
	});
	pop.appendChild(add);
	btn.parentElement.appendChild(pop);
	setTimeout(() => document.addEventListener("click", closeThreadSwitcher, { once: true }), 0);
}
function switcherCreate(pop, addBtn) {
	addBtn.replaceWith(makeThreadNameInput({
		ariaLabel: "New thread name",
		blurSubmits: true,
		onCancel: closeThreadSwitcher,
		onSubmit: (title) => {
			closeThreadSwitcher();
			createThread(title);
		}
	}));
}
function startThreadRename(thread) {
	threadRenaming = thread.thread_id;
	threadCreating = false;
	renderThreadList();
}
function buildThreadRenameRow(t) {
	const row = document.createElement("div");
	row.className = "thread-row";
	row.dataset.threadId = t.thread_id;
	row.style.setProperty("--thread-color", roomColor(t.thread_id));
	row.appendChild(makeThreadNameInput({
		value: t.title,
		ariaLabel: "Rename thread",
		selectAll: true,
		onCancel: () => {
			threadRenaming = null;
			renderThreadList();
		},
		onSubmit: (title) => {
			threadRenaming = null;
			submitThreadRename(t.thread_id, title);
		}
	}));
	return row;
}
async function submitThreadRename(threadId, title) {
	try {
		await apiJson(`/api/rooms/${encodeURIComponent(currentRoom)}/threads/${encodeURIComponent(threadId)}`, {
			method: "PATCH",
			body: { title }
		});
		await loadThreadList(currentRoom);
	} catch (err) {
		showToast("Rename failed: " + (err.message || err), { kind: "error" });
	}
}
async function deleteThreadConfirm(thread, rowEl) {
	const commit = async () => {
		try {
			await apiJson(`/api/rooms/${encodeURIComponent(currentRoom)}/threads/${encodeURIComponent(thread.thread_id)}`, { method: "DELETE" });
			if (currentThread === thread.thread_id) openThread("main");
			await loadThreadList(currentRoom);
			showToast("Thread deleted", { kind: "success" });
		} catch (err) {
			showToast("Delete failed: " + (err.message || err), { kind: "error" });
			await loadThreadList(currentRoom);
		}
	};
	const row = rowEl || document.querySelector(`.thread-row[data-thread-id="${cssEscape(thread.thread_id)}"]`);
	if (!row) {
		if (await showConfirmModal({
			title: `Delete "${thread.title}"?`,
			body: "",
			confirmLabel: "Delete",
			destructive: true
		})) await commit();
		return;
	}
	row.classList.add("deleting");
	armUndo(row, `Removing ${thread.title}…`, UNDO_SECONDS, () => {
		row.classList.remove("deleting");
		commit();
	});
	const undoBtn = row.querySelector(".undo-timer .btn");
	if (undoBtn) undoBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		row.classList.remove("deleting");
	});
}
function cssEscape(s) {
	if (window.CSS && CSS.escape) return CSS.escape(String(s));
	return String(s).replace(/["\\\]]/g, "\\$&");
}
var pendingJumpMessageId = null;
var pendingSendAfterJoin = null;
var roomSwitchDimTimer = null;
function beginTranscriptSwitch() {
	const el = $("#messages");
	el.classList.add("room-switching");
	clearTimeout(roomSwitchDimTimer);
	roomSwitchDimTimer = setTimeout(() => el.classList.remove("room-switching"), 2e3);
}
function endTranscriptSwitch() {
	clearTimeout(roomSwitchDimTimer);
	$("#messages").classList.remove("room-switching");
}
function joinRoom(roomId, roomName, jumpMessageId, initialThread) {
	pendingJumpMessageId = jumpMessageId || null;
	pendingSendAfterJoin = null;
	closeAgentDetail();
	closeRoomDetail();
	closeModelDetail();
	closeMcpDetail();
	hideOtherFullViews();
	$("#chat").hidden = false;
	endAllAgentTurns();
	const prevRoom = currentRoom;
	currentRoom = roomId;
	if (prevRoom && prevRoom !== roomId) expandedRooms.delete(prevRoom);
	expandedRooms.add(roomId);
	threadAddRoom = null;
	unreadRooms.delete(roomId);
	mentionedRooms.delete(roomId);
	refreshRoomAutoLearn(roomId);
	updateUnreadDots();
	updateUserCredsBanner(roomId);
	const roomAgent = allAgents.find((b) => b.room_id === roomId);
	if (roomAgent) agentName = roomAgent.name;
	$("#app").classList.add("in-room");
	$("#app").classList.remove("in-dashboard");
	for (const t of typingUsers.values()) clearTimeout(t.timeout);
	typingUsers.clear();
	renderTypingIndicator();
	$("#members-panel").hidden = true;
	$("#members-overlay").classList.remove("visible");
	renderMembers([]);
	beginTranscriptSwitch();
	currentThread = initialThread || "main";
	localStorage.setItem("lastThread:" + roomId, currentThread);
	threadUnread.clear();
	threadCache.delete(roomId);
	updateThreadSyncControls();
	ws.send(JSON.stringify({
		type: "join",
		room_id: roomId,
		thread_id: currentThread
	}));
	loadThreadList(roomId);
	localStorage.setItem("lastRoom", roomId);
	$("#room-name").textContent = `#${roomId}`;
	$("#message-input").disabled = false;
	const learnBtn = $("#learn-btn");
	if (learnBtn) {
		learnBtn.disabled = false;
		learnBtn.hidden = !learningMasterEnabled;
	}
	hideLearnNudge();
	learnTurnToolCount = 0;
	$("#message-form button[type=submit]").disabled = false;
	showRoomSettingsToggle(true);
	if (lastRoomsList.length) renderRooms(lastRoomsList);
	refreshWiredAgentsForCurrentRoom();
	fetchMentionablePeople();
}
var searchDebounce = null;
function clearRoomSearch() {
	const list = $("#search-results");
	if (list) {
		list.hidden = true;
		list.innerHTML = "";
	}
	const roomList = $("#room-list");
	if (roomList) roomList.hidden = false;
	const sortBtn = $("#room-sort-az");
	if (sortBtn) sortBtn.hidden = false;
	const close = $("#room-search-close");
	if (close) close.hidden = true;
}
function renderSearchResults(results) {
	const list = $("#search-results");
	if (!list) return;
	if (!results || results.length === 0) list.innerHTML = "<li class=\"search-empty\">No matches</li>";
	else list.innerHTML = results.map((r) => {
		const snip = esc(r.snippet || "").replace(/«/g, "<mark>").replace(/»/g, "</mark>");
		return `<li class="search-result" data-room-id="${esc(r.roomId)}" data-room-name="${esc(r.roomName)}" data-message-id="${esc(r.id)}">
            <div class="search-result-head">
              <span class="search-result-room">#${esc(r.roomName)}</span>
              <span class="search-result-time">${esc(relativeTime(r.createdAt))}</span>
            </div>
            <div class="search-result-snip"><span class="search-result-sender">${esc(r.sender)}:</span> ${snip}</div>
          </li>`;
	}).join("");
	list.hidden = false;
	const roomList = $("#room-list");
	if (roomList) roomList.hidden = true;
	const sortBtn = $("#room-sort-az");
	if (sortBtn) sortBtn.hidden = true;
}
$("#room-search")?.addEventListener("input", (e) => {
	const q = e.target.value.trim();
	const closeBtn = $("#room-search-close");
	if (closeBtn) closeBtn.hidden = !q;
	clearTimeout(searchDebounce);
	if (!q) {
		clearRoomSearch();
		return;
	}
	searchDebounce = setTimeout(async () => {
		try {
			const r = await authFetch(`/api/search?q=${encodeURIComponent(q)}`);
			if (!r.ok) return renderSearchResults([]);
			renderSearchResults((await r.json()).results || []);
		} catch {
			renderSearchResults([]);
		}
	}, 250);
});
$("#room-search-close")?.addEventListener("click", () => {
	const input = $("#room-search");
	if (input) input.value = "";
	clearRoomSearch();
	if (input) input.blur();
});
$("#search-results")?.addEventListener("click", (e) => {
	const li = e.target.closest(".search-result");
	if (!li) return;
	const { roomId, roomName, messageId } = li.dataset;
	$("#search-results .search-result.active")?.classList.remove("active");
	li.classList.add("active");
	joinRoom(roomId, roomName, messageId);
});
document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	const list = $("#search-results");
	if (!list || list.hidden) return;
	const input = $("#room-search");
	if (input) input.value = "";
	clearRoomSearch();
});
function createDeleteButton(messageId) {
	const delBtn = document.createElement("button");
	delBtn.className = "msg-delete";
	delBtn.textContent = "🗑";
	delBtn.title = "Delete message";
	let confirmTimer = null;
	delBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		if (delBtn.classList.contains("confirm")) {
			clearTimeout(confirmTimer);
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
				type: "delete_message",
				message_id: messageId
			}));
		} else {
			delBtn.classList.add("confirm");
			delBtn.textContent = "delete?";
			confirmTimer = setTimeout(() => {
				delBtn.classList.remove("confirm");
				delBtn.textContent = "🗑";
			}, 3e3);
		}
	});
	return delBtn;
}
function addDeleteButton(msgEl, messageId) {
	if (msgEl.querySelector(".msg-delete")) return;
	const bubble = msgEl.querySelector(".bubble");
	if (!bubble) return;
	let bodyRow = msgEl.querySelector(".msg-body");
	if (!bodyRow) {
		bodyRow = document.createElement("div");
		bodyRow.className = "msg-body";
		bubble.parentNode.insertBefore(bodyRow, bubble);
		bodyRow.appendChild(bubble);
	}
	bodyRow.insertBefore(createDeleteButton(messageId), bubble);
}
function agentColor(name) {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = h * 31 + name.charCodeAt(i) >>> 0;
	return `hsl(${h % 360}, 60%, 55%)`;
}
function formatTime(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	const time = d.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit"
	});
	const now = /* @__PURE__ */ new Date();
	if (d.toDateString() === now.toDateString()) return time;
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
	const dateOpts = d.getFullYear() === now.getFullYear() ? {
		month: "short",
		day: "numeric"
	} : {
		month: "short",
		day: "numeric",
		year: "numeric"
	};
	return `${d.toLocaleDateString([], dateOpts)}, ${time}`;
}
function appendSkillDraftCard(msg, beforeNode) {
	refreshDraftBadge();
	let d = {};
	try {
		d = JSON.parse(msg.content) || {};
	} catch {
		d = {};
	}
	const wrap = document.createElement("div");
	wrap.className = "msg skill-draft-msg";
	wrap.dataset.draftId = d.draftId || msg.id;
	const resolved = d.status === "kept" || d.status === "discarded";
	const title = d.kind === "patch" ? `Proposed change to ${d.targetSkill || d.skillName}` : `Proposed skill: ${d.skillName}`;
	if (resolved) {
		const note = document.createElement("div");
		note.className = "approval-inroom-note resolved";
		note.textContent = d.status === "kept" ? `✅ ${title} — kept` : `🗑 ${title} — discarded`;
		wrap.appendChild(note);
	} else {
		const card = document.createElement("div");
		card.className = "skill-draft-card";
		const head = document.createElement("div");
		head.className = "skill-head";
		const name = document.createElement("span");
		name.className = "skill-name";
		name.textContent = title;
		head.appendChild(name);
		if (d.agentName) {
			const badge = originBadgeEl({
				label: `learned · ${d.agentName}`,
				official: false
			});
			head.appendChild(badge);
		}
		const desc = document.createElement("div");
		desc.className = "skill-desc";
		desc.textContent = d.description || "";
		const actions = document.createElement("div");
		actions.className = "skill-draft-actions";
		const view = document.createElement("button");
		view.type = "button";
		view.className = "btn btn-ghost";
		view.textContent = "View";
		view.addEventListener("click", () => openSkillDraft(d.draftId));
		const keep = document.createElement("button");
		keep.type = "button";
		keep.className = "btn btn-primary";
		keep.textContent = "Keep";
		keep.title = `Wire to ${d.agentName}`;
		keep.dataset.draftId = d.draftId;
		if (reviewingDrafts.has(d.draftId)) markDraftReviewing(keep, true);
		keep.addEventListener("click", () => armUndo(actions, `Keeping ${d.skillName}…`, UNDO_SECONDS, (restore) => {
			restore();
			return keepSkillDraft({
				id: d.draftId,
				agentGroupId: d.agentGroupId,
				agentName: d.agentName
			}, keep);
		}));
		const drop = document.createElement("button");
		drop.type = "button";
		drop.className = "skill-delete";
		drop.textContent = "Discard";
		drop.addEventListener("click", () => armUndo(actions, `Discarding ${d.skillName}…`, UNDO_SECONDS, () => discardSkillDraft(d.draftId)));
		actions.append(view, keep, drop);
		card.append(head, desc, actions);
		wrap.appendChild(card);
	}
	const existing = $(`#messages .skill-draft-msg[data-draft-id="${wrap.dataset.draftId}"]`);
	if (existing) {
		existing.replaceWith(wrap);
		return;
	}
	const tb = $("#messages .thinking-bubble");
	if (beforeNode) $("#messages").insertBefore(wrap, beforeNode);
	else if (tb) $("#messages").insertBefore(wrap, tb);
	else $("#messages").appendChild(wrap);
}
function appendApprovalCard(msg, beforeNode) {
	let data = {};
	try {
		data = JSON.parse(msg.content) || {};
	} catch {
		data = {};
	}
	const wrap = document.createElement("div");
	wrap.className = "msg approval-msg";
	wrap.dataset.questionId = data.questionId || msg.id;
	const resolved = msg.message_type === "approval_resolved" || !!data.resolvedBy;
	const eligible = Array.isArray(data.approvers) && data.approvers.includes(myIdentity);
	if (resolved) {
		const who = data.resolvedBy ? " by " + String(data.resolvedBy).split(":").pop().split("@")[0] : "";
		const note = document.createElement("div");
		note.className = "approval-inroom-note resolved";
		note.textContent = `🔒 ${data.title || "Approval"} — resolved${who}`;
		wrap.appendChild(note);
	} else if (eligible) wrap.appendChild(renderApprovalCard({
		questionId: data.questionId,
		title: data.title,
		payload: data.question,
		options: data.options
	}, {}));
	else {
		const note = document.createElement("div");
		note.className = "approval-inroom-note";
		note.textContent = `🔒 ${data.title || "Approval requested"} — awaiting an admin`;
		wrap.appendChild(note);
	}
	const tb = $("#messages .thinking-bubble");
	if (beforeNode) $("#messages").insertBefore(wrap, beforeNode);
	else if (tb) $("#messages").insertBefore(wrap, tb);
	else $("#messages").appendChild(wrap);
}
function appendMessage(msg, statusText, beforeNode) {
	if (msg.type === "system") {
		appendSystem(msg.message);
		return;
	}
	if (msg.message_type === "approval" || msg.message_type === "approval_resolved") {
		appendApprovalCard(msg, beforeNode);
		return;
	}
	if (msg.message_type === "skill_draft") {
		appendSkillDraftCard(msg, beforeNode);
		return;
	}
	if (msg.message_type === "context-divider") {
		const rule = document.createElement("div");
		rule.className = "context-divider";
		const label = document.createElement("span");
		label.textContent = msg.content || "Synced context";
		rule.appendChild(label);
		const tb = $("#messages .thinking-bubble");
		if (beforeNode) $("#messages").insertBefore(rule, beforeNode);
		else if (tb) $("#messages").insertBefore(rule, tb);
		else $("#messages").appendChild(rule);
		return rule;
	}
	const div = document.createElement("div");
	const isMine = msg.sender === myIdentity;
	const isA2a = msg.message_type === "a2a" || msg.sender_type === "a2a";
	const isAgent = !isA2a && msg.sender_type === "agent";
	let a2aTo = null;
	let a2aText = msg.content;
	if (isA2a) try {
		const parsed = JSON.parse(msg.content);
		a2aTo = parsed.to ?? null;
		a2aText = typeof parsed.text === "string" ? parsed.text : msg.content;
	} catch {}
	let thoughtsForThisMsg = null;
	if (isAgent) {
		let senderBubble = bubbleFor(msg.sender);
		if (!senderBubble) {
			const all = document.querySelectorAll("#messages .thinking-bubble");
			if (all.length === 1) senderBubble = all[0];
		}
		if (senderBubble) {
			const log = senderBubble._turn && senderBubble._turn.reasoningLog;
			if (log && log.length > 0) thoughtsForThisMsg = log.slice();
			endAgentTurn(senderBubble.dataset.agent);
		}
	}
	div.className = isA2a ? "msg a2a" : isMine ? "msg mine" : isAgent ? "msg agent" : "msg other";
	if (!isMine && messageMentionsMe(isA2a ? a2aText : msg.content)) div.classList.add("mentions-me");
	if (msg.id) div.dataset.messageId = msg.id;
	if (isA2a) div.style.setProperty("--a2a-accent", agentColor(msg.sender));
	const sender = document.createElement("div");
	sender.className = "sender";
	if (isA2a) {
		sender.classList.add("a2a-label");
		const fromSpan = document.createElement("span");
		fromSpan.className = "a2a-agent";
		fromSpan.textContent = msg.sender;
		fromSpan.style.color = agentColor(msg.sender);
		sender.appendChild(fromSpan);
		if (a2aTo) {
			const arrow = document.createElement("span");
			arrow.className = "a2a-arrow";
			arrow.textContent = "→";
			sender.appendChild(arrow);
			const toSpan = document.createElement("span");
			toSpan.className = "a2a-agent";
			toSpan.textContent = a2aTo;
			toSpan.style.color = agentColor(a2aTo);
			sender.appendChild(toSpan);
		}
	} else if (isAgent) {
		sender.textContent = "";
		sender.appendChild(lucideEl("bot"));
		sender.append(" " + msg.sender);
	} else sender.textContent = isMine ? "You" : msg.sender;
	div.appendChild(sender);
	const bubble = document.createElement("div");
	bubble.className = "bubble";
	if (msg.message_type === "file" && msg.file_meta) {
		bubble.appendChild(renderFileBubble(msg.file_meta));
		if (msg.content && msg.content !== msg.file_meta.filename) {
			const caption = document.createElement("div");
			caption.className = "file-caption";
			caption.textContent = msg.content;
			bubble.appendChild(caption);
		}
	} else if (isMine) try {
		bubble.innerHTML = DOMPurify.sanitize(marked.parse(msg.content));
		decorateCodeBlocks(bubble);
		decorateMentions(bubble);
	} catch (err) {
		console.error("Message render failed; falling back to plain text", err);
		bubble.textContent = msg.content;
	}
	else try {
		bubble.innerHTML = DOMPurify.sanitize(marked.parse(a2aText));
		decorateCodeBlocks(bubble);
		decorateMentions(bubble);
	} catch (err) {
		console.error("Message render failed; falling back to plain text", err);
		bubble.textContent = a2aText;
	}
	if (isMine) {
		const bodyRow = document.createElement("div");
		bodyRow.className = "msg-body";
		if (msg.id) bodyRow.appendChild(createDeleteButton(msg.id));
		bodyRow.appendChild(bubble);
		div.appendChild(bodyRow);
	} else div.appendChild(bubble);
	if (thoughtsForThisMsg && thoughtsForThisMsg.length > 0) div.appendChild(buildThoughtsDisclosure(thoughtsForThisMsg));
	if (isAgent && msg.content) {
		const ttsBtn = buildTtsButton(() => ttsPlainText(msg.content));
		if (ttsBtn) bubble.appendChild(ttsBtn);
	}
	const timeStr = formatTime(msg.created_at);
	if (timeStr) {
		const time = document.createElement("div");
		time.className = "timestamp";
		time.textContent = timeStr;
		if (msg.created_at) time.title = new Date(msg.created_at).toLocaleString();
		div.appendChild(time);
	}
	if (isMine && statusText) {
		const status = document.createElement("div");
		status.className = "status" + (statusText === "✓✓" ? " delivered" : "");
		status.textContent = statusText;
		div.appendChild(status);
	}
	const thinkingBubble = $("#messages .thinking-bubble");
	if (beforeNode) $("#messages").insertBefore(div, beforeNode);
	else if (thinkingBubble) $("#messages").insertBefore(div, thinkingBubble);
	else $("#messages").appendChild(div);
	if (isA2a) applyA2aClamp(bubble, div);
	return div;
}
function appendSystem(text) {
	const div = document.createElement("div");
	div.className = "msg system";
	div.textContent = text;
	const thinkingBubble = $("#messages .thinking-bubble");
	if (thinkingBubble) $("#messages").insertBefore(div, thinkingBubble);
	else $("#messages").appendChild(div);
	return div;
}
function buildThoughtsDisclosure(lines) {
	const details = document.createElement("details");
	details.className = "thoughts";
	const summary = document.createElement("summary");
	summary.appendChild(lucideEl("sparkles"));
	summary.append(` Thoughts (${lines.length})`);
	const last = lines[lines.length - 1] || "";
	if (last) {
		const preview = document.createElement("span");
		preview.className = "thoughts-preview";
		preview.textContent = " — " + (last.length > 90 ? `${last.slice(0, 89)}…` : last);
		summary.appendChild(preview);
	}
	details.appendChild(summary);
	const body = document.createElement("div");
	body.className = "thoughts-body";
	for (const line of lines) {
		const row = document.createElement("div");
		row.className = "thoughts-line";
		row.textContent = line;
		body.appendChild(row);
	}
	details.appendChild(body);
	return details;
}
function applyA2aClamp(bubble, container) {
	bubble.classList.add("a2a-clamp", "collapsed");
	if (bubble.scrollHeight <= bubble.clientHeight + 4) {
		bubble.classList.remove("a2a-clamp", "collapsed");
		return;
	}
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "a2a-more";
	toggle.textContent = "Show more";
	toggle.addEventListener("click", () => {
		const collapsed = bubble.classList.toggle("collapsed");
		toggle.textContent = collapsed ? "Show more" : "Show less";
	});
	container.appendChild(toggle);
}
var oldestMessageId = null;
var loadingOlder = false;
var noMoreOlder = false;
var suppressScrollRestore = false;
async function loadOlderMessages() {
	if (loadingOlder || noMoreOlder || !currentRoom || !oldestMessageId) return;
	loadingOlder = true;
	const el = $("#messages");
	const prevElHeight = el.scrollHeight;
	const prevElTop = el.scrollTop;
	const prevDocHeight = document.documentElement.scrollHeight;
	const prevWinY = window.scrollY;
	try {
		const r = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/messages?before_id=${encodeURIComponent(oldestMessageId)}`);
		if (!r.ok) return;
		const older = await r.json();
		if (!Array.isArray(older) || older.length === 0) {
			noMoreOlder = true;
			return;
		}
		const fresh = older.filter((m) => !m.id || !el.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`));
		if (fresh.length === 0) {
			noMoreOlder = true;
			return;
		}
		const anchor = el.firstChild;
		fresh.forEach((m) => appendMessage(m, void 0, anchor));
		oldestMessageId = older[0].id;
		if (older.length < 50) noMoreOlder = true;
		if (!suppressScrollRestore) requestAnimationFrame(() => {
			el.scrollTop = prevElTop + (el.scrollHeight - prevElHeight);
			window.scrollTo(0, prevWinY + (document.documentElement.scrollHeight - prevDocHeight));
		});
	} catch {} finally {
		loadingOlder = false;
	}
}
async function jumpToMessage(messageId) {
	if (!messageId) return;
	const find = () => $("#messages").querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
	let el = find();
	if (!el) {
		suppressScrollRestore = true;
		try {
			let guard = 0;
			while (!el && !noMoreOlder && guard < 40) {
				const before = oldestMessageId;
				await loadOlderMessages();
				el = find();
				if (oldestMessageId === before) break;
				guard++;
			}
		} finally {
			suppressScrollRestore = false;
		}
	}
	if (!el) {
		showToast("Couldn’t find that message — it may be too old to load.", { kind: "info" });
		return;
	}
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	el.scrollIntoView({ block: "center" });
	el.classList.add("jump-highlight");
	setTimeout(() => el.classList.remove("jump-highlight"), 2500);
}
/**
* Transient corner notification. `kind` is 'info' (default), 'success', or
* 'error'. Errors linger longer and must be dismissed-or-time-out; all toasts
* are click-to-dismiss. Returns the element so callers can remove it early.
*/
var userCredsProvider = "claude";
var userCredsState = null;
var userCredsConnected = false;
function userCredsWords(provider) {
	return provider === "codex" ? {
		name: "Codex",
		subWord: "ChatGPT subscription",
		keyWord: "OpenAI key",
		keyPlaceholder: "sk-…"
	} : {
		name: "Claude",
		subWord: "Claude subscription",
		keyWord: "Anthropic key",
		keyPlaceholder: "sk-ant-…"
	};
}
async function updateUserCredsBanner(roomId) {
	const banner = $("#user-creds-banner");
	if (!banner || !roomId) return;
	const hideAll = () => {
		banner.hidden = true;
		userCredsState = null;
		userCredsConnected = false;
		updateHandleCreds();
		renderHandleChip();
	};
	try {
		const r = await authFetch(`/api/user-credentials/credential?roomId=${encodeURIComponent(roomId)}`);
		if (!r.ok) {
			hideAll();
			return;
		}
		const { connected, mode, oauthAllowed, apiKeyAllowed = true, provider = "claude" } = await r.json();
		userCredsProvider = provider;
		const { name, subWord, keyWord, keyPlaceholder } = userCredsWords(provider);
		const apiOffered = mode !== "disabled" && apiKeyAllowed;
		const oauthOffered = mode !== "disabled" && oauthAllowed;
		if (!apiOffered && !oauthOffered) {
			hideAll();
			return;
		}
		userCredsState = {
			offered: true,
			connected,
			provider,
			oauthAllowed: oauthOffered,
			apiOffered,
			subWord,
			keyWord
		};
		userCredsConnected = connected;
		updateHandleCreds();
		renderHandleChip();
		if (connected) {
			banner.hidden = true;
			return;
		}
		const connectBtn = $("#user-creds-connect-btn");
		const oauthBtn = $("#user-creds-oauth-btn");
		const input = $("#user-creds-key-input");
		banner.hidden = false;
		input.hidden = true;
		input.value = "";
		input.placeholder = keyPlaceholder;
		if (oauthBtn) {
			oauthBtn.hidden = !oauthOffered;
			oauthBtn.textContent = `Connect to ${name}`;
		}
		connectBtn.hidden = !apiOffered;
		if (connectBtn) connectBtn.textContent = "API key";
	} catch {
		hideAll();
	}
}
function updateHandleCreds() {
	const wrap = $("#handle-creds");
	if (!wrap) return;
	if (!userCredsState || !userCredsState.offered) {
		wrap.hidden = true;
		return;
	}
	wrap.hidden = false;
	const statusEl = $("#handle-creds-status");
	const actionBtn = $("#handle-creds-action");
	const { name } = userCredsWords(userCredsState.provider);
	if (statusEl) {
		statusEl.textContent = `${name} — ${userCredsState.connected ? "connected" : "not connected"}`;
		statusEl.classList.toggle("is-connected", userCredsState.connected);
	}
	if (actionBtn) actionBtn.textContent = userCredsState.connected ? "Disconnect" : "Connect";
}
$("#handle-creds-action")?.addEventListener("click", async () => {
	if (!userCredsState) return;
	closeHandlePopover();
	if (userCredsState.connected) {
		if (await showConfirmModal({
			title: `Disconnect ${userCredsWords(userCredsState.provider).name}?`,
			confirmLabel: "Disconnect",
			destructive: true
		})) await disconnectUserCreds();
	} else if (userCredsState.oauthAllowed) $("#user-creds-oauth-btn")?.click();
	else {
		const banner = $("#user-creds-banner");
		if (banner) {
			banner.hidden = false;
			banner.scrollIntoView({
				behavior: "smooth",
				block: "nearest"
			});
			banner.classList.add("user-creds-banner-flash");
			setTimeout(() => banner.classList.remove("user-creds-banner-flash"), 1200);
		}
		$("#user-creds-connect-btn")?.click();
	}
});
$("#user-creds-connect-btn")?.addEventListener("click", async (e) => {
	const input = $("#user-creds-key-input");
	if (input.hidden) {
		input.hidden = false;
		input.focus();
		return;
	}
	const apiKey = input.value.trim();
	if (!apiKey) return;
	const btn = e.currentTarget;
	btn.disabled = true;
	try {
		const r = await authFetch("/api/user-credentials/credential", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({
				roomId: currentRoom,
				apiKey
			})
		});
		if (r.ok) {
			showToast(`Connected your ${userCredsWords(userCredsProvider).keyWord}.`, { kind: "success" });
			await updateUserCredsBanner(currentRoom);
		} else showToast("Failed to connect key: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
	} catch (err) {
		showToast("Failed to connect key: " + (err?.message || "network error"), { kind: "error" });
	} finally {
		btn.disabled = false;
	}
});
$("#user-creds-key-input")?.addEventListener("keydown", (e) => {
	if (e.key === "Enter") $("#user-creds-connect-btn").click();
});
async function disconnectUserCreds() {
	const r = await authFetch("/api/user-credentials/credential", {
		method: "DELETE",
		headers: {
			"Content-Type": "application/json",
			"X-Webchat-CSRF": "1"
		},
		body: JSON.stringify({ roomId: currentRoom })
	});
	if (r.ok) {
		showToast("Disconnected your account.", { kind: "success" });
		await updateUserCredsBanner(currentRoom);
	} else showToast("Failed to disconnect: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
}
var userCredsOauthSessionId = null;
var userCredsOauthReturnFocus = null;
function userCredsOauthStatus(msg, kind) {
	const el = $("#user-creds-oauth-status");
	if (!el) return;
	if (!msg) {
		el.hidden = true;
		return;
	}
	el.hidden = false;
	el.textContent = msg;
	el.className = "user-creds-oauth-status" + (kind ? " " + kind : "");
}
var userCredsOauthTarget = "member";
async function openOauthMintModal(target) {
	userCredsOauthTarget = target;
	const modal = $("#user-creds-oauth-modal");
	if (!modal) return;
	const isWorkspace = target.startsWith("workspace");
	const isCodex = target === "workspace-codex" || !isWorkspace && userCredsProvider === "codex";
	const title = $("#user-creds-oauth-title");
	if (title) title.textContent = isWorkspace ? `Connect ${isCodex ? "ChatGPT" : "Claude"} (workspace default)` : `Connect to ${userCredsWords(userCredsProvider).name}`;
	$("#user-creds-oauth-step2").hidden = true;
	$("#user-creds-oauth-submit").hidden = true;
	$("#user-creds-oauth-spinner").hidden = false;
	const code = $("#user-creds-oauth-code");
	if (code) code.value = "";
	const codexCode = $("#user-creds-oauth-codex-code");
	userCredsOauthReturnFocus = document.activeElement;
	modal.hidden = false;
	$("#user-creds-oauth-close")?.focus();
	userCredsOauthStatus("Preparing sign-in…", "");
	try {
		const r = await authFetch(isWorkspace ? isCodex ? "/api/workspace-credential/codex/start" : "/api/workspace-credential/oauth/start" : isCodex ? "/api/user-credentials/codex/start" : "/api/user-credentials/oauth/start", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify(isWorkspace ? {} : { roomId: currentRoom })
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || r.statusText);
		userCredsOauthSessionId = data.sessionId;
		const link = $("#user-creds-oauth-link");
		if (link) {
			link.href = data.url;
			link.textContent = isWorkspace ? `Open ${isCodex ? "ChatGPT" : "Claude"} sign-in ↗` : `Open ${userCredsWords(userCredsProvider).name} sign-in ↗`;
		}
		if (code) code.hidden = isCodex;
		const codeLabel = $("#user-creds-oauth-code-label");
		if (codeLabel) codeLabel.hidden = isCodex;
		if (codexCode) {
			codexCode.hidden = !isCodex;
			codexCode.textContent = "";
			if (isCodex && data.userCode) {
				codexCode.append("Pairing code: ");
				const codeEl = document.createElement("code");
				codeEl.textContent = data.userCode;
				const copyBtn = document.createElement("button");
				copyBtn.type = "button";
				copyBtn.className = "codex-code-copy";
				copyBtn.title = "Copy";
				copyBtn.setAttribute("aria-label", "Copy pairing code");
				copyBtn.innerHTML = "<svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-copy\"></use></svg>";
				copyBtn.addEventListener("click", async () => {
					const use = copyBtn.querySelector("use");
					if (await copyTextToClipboard(data.userCode)) {
						copyBtn.classList.add("copied");
						use?.setAttribute("href", "#i-check");
						setTimeout(() => {
							copyBtn.classList.remove("copied");
							use?.setAttribute("href", "#i-copy");
						}, 1500);
					}
				});
				codexCode.append(codeEl, copyBtn);
			} else if (isCodex) codexCode.textContent = "Open the link, then approve the sign-in.";
		}
		const submit = $("#user-creds-oauth-submit");
		if (submit) submit.textContent = isCodex ? "I’ve approved — connect" : "Connect";
		$("#user-creds-oauth-spinner").hidden = true;
		$("#user-creds-oauth-step2").hidden = false;
		$("#user-creds-oauth-submit").hidden = false;
		userCredsOauthStatus(isCodex ? "Open the link, enter the code, and approve — then click connect." : "", "");
		$("#user-creds-oauth-link").focus();
	} catch (err) {
		$("#user-creds-oauth-spinner").hidden = true;
		userCredsOauthStatus(err.message || "Could not start sign-in.", "error");
	}
}
$("#user-creds-oauth-btn")?.addEventListener("click", () => openOauthMintModal("member"));
function closeUserCredsOauthModal() {
	if (userCredsOauthSessionId) {
		authFetch(userCredsOauthTarget === "workspace-codex" ? "/api/workspace-credential/codex/cancel" : userCredsOauthTarget === "workspace" ? "/api/workspace-credential/oauth/cancel" : userCredsProvider === "codex" ? "/api/user-credentials/codex/cancel" : "/api/user-credentials/oauth/cancel", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ sessionId: userCredsOauthSessionId })
		}).catch(() => {});
		userCredsOauthSessionId = null;
	}
	const modal = $("#user-creds-oauth-modal");
	if (modal) modal.hidden = true;
	if (userCredsOauthReturnFocus && typeof userCredsOauthReturnFocus.focus === "function") userCredsOauthReturnFocus.focus();
	userCredsOauthReturnFocus = null;
}
$("#user-creds-oauth-cancel")?.addEventListener("click", closeUserCredsOauthModal);
$("#user-creds-oauth-close")?.addEventListener("click", closeUserCredsOauthModal);
$("#user-creds-oauth-modal")?.addEventListener("click", (e) => {
	if (e.target === $("#user-creds-oauth-modal")) closeUserCredsOauthModal();
});
document.addEventListener("keydown", (e) => {
	const modal = $("#user-creds-oauth-modal");
	if (!modal || modal.hidden) return;
	if (e.key === "Escape") {
		e.preventDefault();
		closeUserCredsOauthModal();
		return;
	}
	if (e.key !== "Tab") return;
	const focusable = Array.from(modal.querySelectorAll("button:not([hidden]), a[href], input:not([hidden])")).filter((el) => el.offsetParent !== null && !el.disabled);
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (e.shiftKey && document.activeElement === first) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && document.activeElement === last) {
		e.preventDefault();
		first.focus();
	}
});
$("#user-creds-oauth-code")?.addEventListener("paste", () => {
	setTimeout(() => {
		const submit = $("#user-creds-oauth-submit");
		if (submit && !submit.hidden && ($("#user-creds-oauth-code")?.value || "").trim()) submit.click();
	}, 0);
});
$("#user-creds-oauth-submit")?.addEventListener("click", async () => {
	const isWorkspace = userCredsOauthTarget.startsWith("workspace");
	const isCodex = userCredsOauthTarget === "workspace-codex" || !isWorkspace && userCredsProvider === "codex";
	const code = ($("#user-creds-oauth-code")?.value || "").trim();
	if (!userCredsOauthSessionId) return;
	if (!isCodex && !code) return;
	const btn = $("#user-creds-oauth-submit");
	btn.disabled = true;
	$("#user-creds-oauth-step2").hidden = true;
	$("#user-creds-oauth-spinner").hidden = false;
	const { subWord } = userCredsWords(userCredsProvider);
	userCredsOauthStatus("Connecting…", "");
	try {
		const r = await authFetch(isWorkspace ? isCodex ? "/api/workspace-credential/codex/finish" : "/api/workspace-credential/oauth/code" : isCodex ? "/api/user-credentials/codex/finish" : "/api/user-credentials/oauth/code", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify(isWorkspace ? isCodex ? { sessionId: userCredsOauthSessionId } : {
				sessionId: userCredsOauthSessionId,
				code
			} : isCodex ? {
				roomId: currentRoom,
				sessionId: userCredsOauthSessionId
			} : {
				roomId: currentRoom,
				sessionId: userCredsOauthSessionId,
				code
			})
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || r.statusText);
		userCredsOauthSessionId = null;
		if (isWorkspace) {
			showToast(`Workspace default ${isCodex ? "ChatGPT" : "Claude"} subscription connected.`, { kind: "success" });
			$("#user-creds-oauth-modal").hidden = true;
			refreshWizardCredState();
		} else {
			showToast(`Connected your ${subWord}.`, { kind: "success" });
			$("#user-creds-oauth-modal").hidden = true;
			await updateUserCredsBanner(currentRoom);
		}
	} catch (err) {
		$("#user-creds-oauth-spinner").hidden = true;
		$("#user-creds-oauth-step2").hidden = false;
		userCredsOauthStatus(err.message || "Could not connect.", "error");
	} finally {
		btn.disabled = false;
	}
});
/**
* Promise-based confirmation modal. Resolves true on confirm, false on
* cancel / backdrop / Escape. `body` may be a string or an HTMLElement (use an
* element when the message contains user-supplied text, so it stays escaped).
* `destructive` styles the confirm button as a delete action and focuses
* Cancel by default.
*/
function showConfirmModal({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, extraActions = [], beforeConfirm = null }) {
	return new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.className = "modal-overlay confirm-overlay";
		const modal = document.createElement("div");
		modal.className = "modal confirm-modal" + (body ? "" : " confirm-modal--titleonly");
		const header = document.createElement("div");
		header.className = "modal-header";
		const titleSpan = document.createElement("span");
		titleSpan.textContent = title || "Confirm";
		header.appendChild(titleSpan);
		let bodyEl = null;
		if (body) {
			bodyEl = document.createElement("div");
			bodyEl.className = "modal-body";
			const message = document.createElement("div");
			message.className = "confirm-message";
			if (body instanceof HTMLElement) message.appendChild(body);
			else message.textContent = body;
			bodyEl.appendChild(message);
		}
		const footer = document.createElement("div");
		footer.className = "confirm-actions";
		const cancelBtn = document.createElement("button");
		cancelBtn.type = "button";
		cancelBtn.className = "btn-cancel";
		cancelBtn.textContent = cancelLabel;
		const confirmBtn = document.createElement("button");
		confirmBtn.type = "button";
		confirmBtn.className = destructive ? "btn btn-danger" : "btn btn-primary";
		confirmBtn.textContent = confirmLabel;
		const extraBtns = extraActions.map((a) => {
			const b = document.createElement("button");
			b.type = "button";
			b.className = a.className || "btn btn-secondary";
			b.textContent = a.label;
			b.addEventListener("click", () => close(a.value));
			return b;
		});
		footer.append(cancelBtn, ...extraBtns, confirmBtn);
		modal.append(header, ...bodyEl ? [bodyEl] : [], footer);
		overlay.appendChild(modal);
		document.body.appendChild(overlay);
		let settled = false;
		const close = (result) => {
			if (settled) return;
			settled = true;
			document.removeEventListener("keydown", onKey);
			overlay.remove();
			resolve(result);
		};
		const confirm = () => {
			if (beforeConfirm && beforeConfirm() === false) return;
			close(true);
		};
		const onKey = (e) => {
			if (e.key === "Escape") close(false);
			else if (e.key === "Enter") confirm();
		};
		cancelBtn.addEventListener("click", () => close(false));
		confirmBtn.addEventListener("click", confirm);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close(false);
		});
		document.addEventListener("keydown", onKey);
		(destructive ? cancelBtn : confirmBtn).focus();
	});
}
/** Single-line text prompt in the app's modal chrome — replaces native prompt()
* (unstylable, ESC-inconsistent, blocked in some PWA contexts). Returns the
* trimmed value, or null on cancel/empty.
* `validate(trimmedValue)` (optional): return an error string to keep the modal
* open with that message inline (DESIGN §5 — field validation is inline text),
* or null/undefined to accept. */
async function showInputModal({ title, placeholder = "", value = "", confirmLabel = "Create", validate = null }) {
	const wrap = document.createElement("div");
	const input = document.createElement("input");
	input.type = "text";
	input.className = "confirm-input";
	input.placeholder = placeholder;
	input.value = value;
	input.autocomplete = "off";
	wrap.appendChild(input);
	let beforeConfirm = null;
	if (validate) {
		const err = document.createElement("div");
		err.className = "confirm-input-error";
		err.hidden = true;
		wrap.appendChild(err);
		input.addEventListener("input", () => {
			err.hidden = true;
			input.classList.remove("invalid");
		});
		beforeConfirm = () => {
			const msg = validate(input.value.trim());
			if (!msg) return true;
			err.textContent = msg;
			err.hidden = false;
			input.classList.add("invalid");
			input.focus();
			return false;
		};
	}
	const done = showConfirmModal({
		title,
		body: wrap,
		confirmLabel,
		beforeConfirm
	});
	input.focus();
	return await done ? input.value.trim() || null : null;
}
function renderFileBubble(meta) {
	const wrap = document.createElement("div");
	wrap.className = "file-bubble";
	const isImage = meta.mime?.startsWith("image/");
	if (isImage) {
		const img = document.createElement("img");
		img.src = meta.url;
		img.alt = meta.filename;
		img.className = "file-image-preview";
		img.loading = "lazy";
		img.addEventListener("click", () => openLightbox(meta.url, meta.filename));
		wrap.appendChild(img);
	}
	const info = document.createElement("div");
	info.className = "file-info";
	const icon = isImage ? lucide$1("image") : meta.mime?.includes("pdf") ? lucide$1("file-text") : lucide$1("paperclip");
	const sizeStr = meta.size < 1024 ? `${meta.size} B` : meta.size < 1048576 ? `${(meta.size / 1024).toFixed(1)} KB` : `${(meta.size / 1048576).toFixed(1)} MB`;
	info.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${esc(meta.filename)}</span><span class="file-size">${sizeStr}</span>`;
	const dl = document.createElement("a");
	dl.href = meta.url;
	dl.download = meta.filename;
	dl.className = "file-download";
	dl.innerHTML = lucide$1("download");
	dl.title = "Download";
	info.appendChild(dl);
	wrap.appendChild(info);
	return wrap;
}
function formatFileSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}
var pendingFiles = [];
var pendingFileSeq = 0;
var pendingThumbUrls = /* @__PURE__ */ new Map();
function stageFile(file) {
	if (!currentRoom) return;
	const id = ++pendingFileSeq;
	pendingFiles.push({
		id,
		file
	});
	renderFilePreview();
	const input = $("#message-input");
	input.focus();
	input.placeholder = pendingFiles.length === 1 ? `Add a message about ${file.name}…` : `Add a message about ${pendingFiles.length} files…`;
}
function stageFiles(fileList) {
	for (const f of fileList) stageFile(f);
}
function removeStagedFile(id) {
	const url = pendingThumbUrls.get(id);
	if (url) {
		URL.revokeObjectURL(url);
		pendingThumbUrls.delete(id);
	}
	pendingFiles = pendingFiles.filter((p) => p.id !== id);
	if (pendingFiles.length === 0) clearStagedFiles();
	else {
		renderFilePreview();
		$("#message-input").placeholder = pendingFiles.length === 1 ? `Add a message about ${pendingFiles[0].file.name}…` : `Add a message about ${pendingFiles.length} files…`;
	}
}
function clearStagedFiles() {
	for (const url of pendingThumbUrls.values()) URL.revokeObjectURL(url);
	pendingThumbUrls.clear();
	pendingFiles = [];
	const preview = $("#file-preview");
	if (preview) {
		preview.hidden = true;
		preview.innerHTML = "";
	}
	$("#message-input").placeholder = "Message…";
}
function renderFilePreview() {
	const preview = $("#file-preview");
	if (!preview) return;
	if (pendingFiles.length === 0) {
		preview.hidden = true;
		preview.innerHTML = "";
		return;
	}
	preview.hidden = false;
	let html = "";
	for (const { id, file } of pendingFiles) {
		const isImage = file.type.startsWith("image/");
		html += `<div class="file-preview-content" data-id="${id}">`;
		if (isImage) {
			let url = pendingThumbUrls.get(id);
			if (!url) {
				url = URL.createObjectURL(file);
				pendingThumbUrls.set(id, url);
			}
			html += `<img src="${url}" class="file-preview-thumb" alt="">`;
		} else html += `<span class="file-preview-icon">${lucide$1("paperclip")}</span>`;
		html += `<span class="file-preview-name">${esc(file.name)}</span>`;
		html += `<span class="file-preview-size">${formatFileSize(file.size)}</span>`;
		html += `<button class="file-preview-remove" data-remove-id="${id}">${lucide$1("x")}</button>`;
		html += "</div>";
	}
	preview.innerHTML = html;
	preview.querySelectorAll("[data-remove-id]").forEach((btn) => {
		btn.addEventListener("click", () => {
			removeStagedFile(Number(btn.dataset.removeId));
		});
	});
}
var CHUNK_THRESHOLD = 524288;
var CHUNK_SIZE = 524288;
async function uploadFile(file, caption) {
	if (!currentRoom) return;
	if (file.size > CHUNK_THRESHOLD) return uploadFileChunked(file, caption);
	const form = new FormData();
	form.append("file", file);
	if (caption) form.append("caption", caption);
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/upload?thread_id=${encodeURIComponent(currentThread)}`, {
			method: "POST",
			body: form
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			console.error("Upload failed:", err.error || res.statusText);
			appendSystem("Upload failed: " + (err.error || res.statusText));
		}
	} catch (err) {
		console.error("Upload error:", err);
		appendSystem("Upload failed: " + err.message);
	}
}
function arrayBufferToBase64(buf) {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}
function uuidv4() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
	bytes[6] = bytes[6] & 15 | 64;
	bytes[8] = bytes[8] & 63 | 128;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function uploadFileChunked(file, caption) {
	const uploadId = uuidv4();
	const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
	const statusMsg = appendSystem(`Uploading ${file.name} (0/${totalChunks})…`);
	for (let i = 0; i < totalChunks; i++) {
		const start = i * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE, file.size);
		const b64 = arrayBufferToBase64(await file.slice(start, end).arrayBuffer());
		const body = {
			uploadId,
			chunkIndex: i,
			totalChunks,
			filename: file.name,
			mime: file.type || "application/octet-stream",
			data: b64
		};
		if (i === totalChunks - 1 && caption) body.caption = caption;
		try {
			const res = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/upload/chunk?thread_id=${encodeURIComponent(currentThread)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				if (statusMsg) statusMsg.textContent = `Upload failed: ${err.error || res.statusText}`;
				return;
			}
		} catch (err) {
			if (statusMsg) statusMsg.textContent = `Upload failed: ${err.message}`;
			return;
		}
		if (statusMsg) statusMsg.textContent = `Uploading ${file.name} (${i + 1}/${totalChunks})…`;
	}
	if (statusMsg) statusMsg.remove();
}
function scrollToBottom(instant) {
	const el = $("#messages");
	el.scrollTo({
		top: el.scrollHeight,
		behavior: instant ? "instant" : "smooth"
	});
	window.scrollTo({
		top: document.body.scrollHeight,
		behavior: instant ? "instant" : "smooth"
	});
}
function isNearBottom() {
	const el = $("#messages");
	const elNear = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	const winNear = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;
	return elNear && winNear;
}
var pendingFollowScroll = false;
function scheduleFollowScroll() {
	if (pendingFollowScroll) return;
	pendingFollowScroll = true;
	requestAnimationFrame(() => {
		pendingFollowScroll = false;
		if (!userScrolledAway) scrollToBottom();
	});
}
var missedMsgCount = 0;
var forceScrollCount = 0;
var userScrolledAway = false;
function updateScrollButton() {
	if (isNearBottom()) {
		$("#scroll-bottom").hidden = true;
		missedMsgCount = 0;
		$("#unread-badge").textContent = "";
	} else {
		$("#scroll-bottom").hidden = false;
		$("#unread-badge").textContent = missedMsgCount > 0 ? String(missedMsgCount) : "";
	}
}
function incrementMissedMessages() {
	if (!isNearBottom()) {
		missedMsgCount++;
		updateScrollButton();
	}
}
$("#messages").addEventListener("click", async (e) => {
	const btn = e.target.closest(".code-btn");
	if (!btn) return;
	const pre = btn.closest("pre");
	if (!pre) return;
	if (btn.classList.contains("copy-code-btn")) {
		const code = pre.querySelector("code");
		const ok = await copyTextToClipboard((code ? code.textContent : pre.textContent) || "");
		btn.classList.add(ok ? "copied" : "error");
		btn.textContent = ok ? "Copied ✓" : "Failed";
		setTimeout(() => {
			btn.classList.remove("copied", "error");
			btn.textContent = "Copy";
		}, 1500);
	} else if (btn.classList.contains("wrap-code-btn")) {
		const wrapping = pre.classList.toggle("wrap");
		btn.textContent = wrapping ? "Unwrap" : "Wrap";
		btn.classList.toggle("active", wrapping);
	}
});
var lastUserScrollAt = 0;
var touchMovedThisGesture = false;
var momentumUntil = 0;
var markUserScroll = () => {
	lastUserScrollAt = Date.now();
};
window.addEventListener("wheel", markUserScroll, { passive: true });
window.addEventListener("touchstart", () => {
	touchMovedThisGesture = false;
}, { passive: true });
window.addEventListener("touchmove", () => {
	touchMovedThisGesture = true;
	markUserScroll();
}, { passive: true });
window.addEventListener("touchend", () => {
	if (touchMovedThisGesture) momentumUntil = Date.now() + 1e3;
	touchMovedThisGesture = false;
}, { passive: true });
window.addEventListener("keydown", (e) => {
	const t = e.target;
	if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
	if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "PageUp" || e.key === "PageDown" || e.key === "Home" || e.key === "End" || e.key === " ") markUserScroll();
});
function handleScroll() {
	updateScrollButton();
	const el = $("#messages");
	const elScrolls = el.scrollHeight - el.clientHeight > 4;
	const winScrolls = document.documentElement.scrollHeight - window.innerHeight > 4;
	if (elScrolls && el.scrollTop < 80 || winScrolls && window.scrollY < 80) loadOlderMessages();
	const now = Date.now();
	const userDriven = now - lastUserScrollAt < 300 || now < momentumUntil;
	if (!isNearBottom()) {
		if (userDriven) {
			userScrolledAway = true;
			forceScrollCount = 0;
		}
	} else userScrolledAway = false;
}
$("#messages").addEventListener("scroll", handleScroll);
window.addEventListener("scroll", handleScroll);
$("#scroll-bottom").addEventListener("click", () => {
	missedMsgCount = 0;
	userScrolledAway = false;
	lastUserScrollAt = 0;
	momentumUntil = 0;
	$("#unread-badge").textContent = "";
	scrollToBottom();
});
var clientMsgSeq = 0;
function sendCurrentMessage() {
	const input = $("#message-input");
	const text = input.value.trimEnd();
	if (!currentRoom) return;
	if (pendingFiles.length > 0) {
		const files = pendingFiles.map((p) => p.file);
		const caption = text;
		clearStagedFiles();
		input.value = "";
		input.style.height = "auto";
		(async () => {
			for (let i = 0; i < files.length; i++) await uploadFile(files[i], i === 0 ? caption : "");
		})();
		return;
	}
	if (!text) return;
	const bulk = BULK_COMMANDS[text.toLowerCase()];
	if (bulk) {
		input.value = "";
		input.style.height = "auto";
		$("#slash-menu").hidden = true;
		setTimeout(() => broadcastSessionCommand(bulk), 0);
		return;
	}
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		showToast("Not connected — try again in a moment.", { kind: "error" });
		return;
	}
	const clientId = `local-${++clientMsgSeq}-${Date.now()}`;
	ws.send(JSON.stringify({
		type: "message",
		content: text,
		client_id: clientId,
		thread_id: currentThread
	}));
	const el = appendMessage({
		sender: myIdentity,
		sender_type: "user",
		content: text
	}, "✓");
	pendingMessages.set(clientId, el);
	userScrolledAway = false;
	forceScrollCount = 3;
	lastUserScrollAt = 0;
	momentumUntil = 0;
	scrollToBottom();
	input.value = "";
	input.style.height = "auto";
}
async function broadcastSessionCommand(command) {
	if (!currentRoom) return;
	const verb = command === "/clear" ? "Reset" : "Compact";
	if (!await showConfirmModal({
		title: `${verb} all sessions`,
		body: `${verb} every active session of this room's agent(s) — including background agent-to-agent sessions${command === "/clear" ? ". Each drops its context and starts fresh on the next turn." : "."}`,
		confirmLabel: verb,
		destructive: command === "/clear"
	})) return;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/sessions/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command })
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		showToast(`${verb} queued for ${body.count} session(s)`, { kind: "success" });
	} catch (err) {
		showToast(`${verb} all failed: ${err.message}`, { kind: "error" });
	}
}
$("#message-form").addEventListener("submit", (e) => {
	e.preventDefault();
	sendCurrentMessage();
});
$("#message-input").addEventListener("keydown", (e) => {
	if (slashKeydown(e)) return;
	if (mentionMatches.length > 0 && (e.key === "Enter" || e.key === "Tab")) return;
	if (e.key !== "Enter") return;
	if (settings.sendKey === "enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
		e.preventDefault();
		sendCurrentMessage();
	}
	if (settings.sendKey === "shift-enter" && e.shiftKey) {
		e.preventDefault();
		sendCurrentMessage();
	}
	if (settings.sendKey === "ctrl-enter" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		sendCurrentMessage();
	}
});
var SLASH_COMMANDS = [
	{
		cmd: "/clear",
		desc: "Reset this session — drop context, start fresh"
	},
	{
		cmd: "/clear all",
		desc: "Reset ALL of this agent's sessions (incl. background a2a)"
	},
	{
		cmd: "/compact",
		desc: "Compact the context now"
	},
	{
		cmd: "/compact all",
		desc: "Compact ALL of this agent's sessions"
	},
	{
		cmd: "/context",
		desc: "Show context-window usage"
	},
	{
		cmd: "/cost",
		desc: "Show token cost so far"
	},
	{
		cmd: "/files",
		desc: "List files in the workspace"
	},
	{
		cmd: "/learn",
		desc: "Distill a reusable skill from this session"
	}
];
var BULK_COMMANDS = {
	"/clear all": "/clear",
	"/compact all": "/compact"
};
var slashMatches = [];
var slashActive = 0;
function updateSlashMenu() {
	const menu = $("#slash-menu");
	if (!isAdminView) {
		slashMatches = [];
		menu.hidden = true;
		return;
	}
	const v = $("#message-input").value;
	slashMatches = /^\/[a-z-]*( [a-z-]*)?$/i.exec(v) ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase())) : [];
	if (slashMatches.length === 0) {
		menu.hidden = true;
		return;
	}
	if (slashActive >= slashMatches.length) slashActive = 0;
	menu.innerHTML = "";
	slashMatches.forEach((c, i) => {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "slash-item" + (i === slashActive ? " active" : "");
		item.setAttribute("role", "option");
		item.innerHTML = `<span class="slash-cmd">${esc(c.cmd)}</span><span class="slash-desc">${esc(c.desc)}</span>`;
		item.addEventListener("mousedown", (e) => {
			e.preventDefault();
			pickSlash(i);
		});
		menu.appendChild(item);
	});
	menu.hidden = false;
}
function pickSlash(i) {
	const c = slashMatches[i];
	if (!c) return;
	const input = $("#message-input");
	slashMatches = [];
	$("#slash-menu").hidden = true;
	const bulk = BULK_COMMANDS[c.cmd];
	if (bulk) {
		input.value = "";
		input.style.height = "auto";
		setTimeout(() => broadcastSessionCommand(bulk), 0);
		return;
	}
	input.value = c.cmd + " ";
	input.focus();
}
function slashKeydown(e) {
	if (slashMatches.length === 0) return false;
	if (e.key === "ArrowDown") {
		slashActive = (slashActive + 1) % slashMatches.length;
		updateSlashMenu();
		e.preventDefault();
		return true;
	}
	if (e.key === "ArrowUp") {
		slashActive = (slashActive - 1 + slashMatches.length) % slashMatches.length;
		updateSlashMenu();
		e.preventDefault();
		return true;
	}
	if (e.key === "Enter" || e.key === "Tab") {
		pickSlash(slashActive);
		e.preventDefault();
		return true;
	}
	if (e.key === "Escape") {
		slashMatches = [];
		$("#slash-menu").hidden = true;
		e.preventDefault();
		return true;
	}
	return false;
}
var wiredAgentsForCurrentRoom = [];
async function refreshWiredAgentsForCurrentRoom() {
	const roomId = currentRoom;
	if (!roomId) {
		wiredAgentsForCurrentRoom = [];
		return;
	}
	try {
		const next = await (await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`)).json();
		if (currentRoom === roomId) wiredAgentsForCurrentRoom = next;
	} catch {}
}
async function fetchMentionablePeople() {
	const roomId = currentRoom;
	if (!roomId) {
		roomMentionPeople = [];
		return;
	}
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/mentionable`);
		if (!res.ok) return;
		const people = await res.json();
		if (currentRoom === roomId) roomMentionPeople = people.map((p) => ({
			folder: p.handle,
			name: p.name,
			isUser: true
		}));
	} catch {}
}
var mentionPopover = null;
var mentionStart = -1;
var mentionMatches = [];
var mentionSelectedIndex = 0;
function ensureMentionPopover() {
	if (mentionPopover) return mentionPopover;
	const el = document.createElement("div");
	el.id = "mention-popover";
	el.className = "mention-popover";
	el.hidden = true;
	$("#message-form").appendChild(el);
	mentionPopover = el;
	return el;
}
function dismissMentionPopover() {
	mentionStart = -1;
	mentionMatches = [];
	if (mentionPopover) mentionPopover.hidden = true;
}
function renderMentionPopover(input) {
	const el = ensureMentionPopover();
	if (mentionMatches.length === 0) {
		el.hidden = true;
		return;
	}
	el.innerHTML = "";
	mentionMatches.forEach((agent, i) => {
		const item = document.createElement("div");
		item.className = "mention-popover-item" + (i === mentionSelectedIndex ? " active" : "");
		const slug = document.createElement("span");
		slug.className = "mention-popover-slug";
		slug.textContent = `@${agent.folder}`;
		item.appendChild(slug);
		if (agent.name && agent.name !== agent.folder) {
			const name = document.createElement("span");
			name.className = "mention-popover-name";
			name.textContent = ` — ${agent.name}`;
			item.appendChild(name);
		}
		if (agent.isUser) {
			const badge = document.createElement("span");
			badge.className = "mention-popover-person";
			badge.textContent = "person";
			item.appendChild(badge);
		} else if (agent.is_prime) {
			const badge = document.createElement("span");
			badge.className = "mention-popover-prime";
			badge.textContent = "default";
			item.appendChild(badge);
		}
		const pick = (e) => {
			e.preventDefault();
			mentionSelectedIndex = i;
			acceptMention(input);
		};
		item.addEventListener("mousedown", pick);
		item.addEventListener("touchstart", pick, { passive: false });
		el.appendChild(item);
	});
	el.hidden = false;
}
function tryActivateMention(input) {
	const seen = /* @__PURE__ */ new Set();
	const mentionPool = [];
	for (const a of [...wiredAgentsForCurrentRoom, ...roomMentionPeople]) {
		const key = (a.folder || "").toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		mentionPool.push(a);
	}
	if (mentionPool.length === 0) {
		dismissMentionPopover();
		return;
	}
	const value = input.value;
	const cursor = input.selectionStart ?? value.length;
	let i = cursor - 1;
	while (i >= 0) {
		const c = value[i];
		if (c === "@") {
			if (i !== 0 && !/\s/.test(value[i - 1])) {
				dismissMentionPopover();
				return;
			}
			break;
		}
		if (!/[a-zA-Z0-9-]/.test(c)) {
			dismissMentionPopover();
			return;
		}
		i--;
	}
	if (i < 0) {
		dismissMentionPopover();
		return;
	}
	mentionStart = i;
	const token = value.slice(i + 1, cursor).toLowerCase();
	mentionMatches = mentionPool.filter((a) => a.folder.toLowerCase().startsWith(token)).slice(0, 8);
	mentionSelectedIndex = 0;
	if (mentionMatches.length === 0) {
		dismissMentionPopover();
		return;
	}
	renderMentionPopover(input);
}
function acceptMention(input) {
	if (mentionStart < 0 || mentionMatches.length === 0) return;
	const agent = mentionMatches[mentionSelectedIndex];
	if (!agent) return;
	const before = input.value.slice(0, mentionStart);
	const after = input.value.slice(input.selectionStart ?? input.value.length);
	const inserted = `@${agent.folder} `;
	input.value = before + inserted + after;
	const newCursor = before.length + inserted.length;
	input.setSelectionRange(newCursor, newCursor);
	dismissMentionPopover();
	input.dispatchEvent(new Event("input"));
}
(() => {
	const input = $("#message-input");
	input.addEventListener("input", () => tryActivateMention(input));
	input.addEventListener("blur", () => {
		setTimeout(dismissMentionPopover, 120);
	});
	input.addEventListener("keydown", (e) => {
		if (mentionMatches.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionMatches.length;
			renderMentionPopover(input);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionMatches.length) % mentionMatches.length;
			renderMentionPopover(input);
		} else if (e.key === "Tab" || e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			acceptMention(input);
		} else if (e.key === "Escape") {
			e.preventDefault();
			dismissMentionPopover();
		}
	}, true);
})();
/**
* Walk a rendered bubble's text nodes and wrap `@<slug>` tokens in a styled
* span. Cosmetic only — even if the token doesn't match a wired agent, the
* styling tells the user "this looks like a mention." Server-side matching
* is what actually decides routing.
*/
function mentionAgentColor(handle) {
	const a = (wiredAgentsForCurrentRoom || []).find((x) => (x.folder || "").toLowerCase() === handle);
	return a && a.name ? agentColor(a.name) : null;
}
function decorateMentions(bubble) {
	const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, { acceptNode(node) {
		let p = node.parentNode;
		while (p && p !== bubble) {
			const tag = p.nodeName;
			if (tag === "CODE" || tag === "PRE") return NodeFilter.FILTER_REJECT;
			p = p.parentNode;
		}
		return NodeFilter.FILTER_ACCEPT;
	} });
	const nodes = [];
	let n;
	while (n = walker.nextNode()) nodes.push(n);
	const re = /(^|\s)@([a-z0-9-]+)\b/gi;
	for (const node of nodes) {
		const txt = node.nodeValue;
		if (!/@[a-z0-9-]/i.test(txt)) continue;
		re.lastIndex = 0;
		let last = 0;
		let m;
		const frag = document.createDocumentFragment();
		let touched = false;
		while ((m = re.exec(txt)) !== null) {
			const fullStart = m.index + m[1].length;
			if (fullStart > last) frag.appendChild(document.createTextNode(txt.slice(last, fullStart)));
			const span = document.createElement("span");
			span.className = "mention";
			const handle = m[2].toLowerCase();
			if (myHandle && handle === myHandle) span.classList.add("mention-me");
			else {
				const color = mentionAgentColor(handle);
				if (color) span.style.background = color;
			}
			span.textContent = `@${m[2]}`;
			frag.appendChild(span);
			last = fullStart + 1 + m[2].length;
			touched = true;
		}
		if (!touched) continue;
		if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
		node.parentNode.replaceChild(frag, node);
	}
}
var currentMembers = [];
var membersFilter = "";
function renderMembers(members) {
	currentMembers = members;
	const toggle = $("#members-toggle");
	toggle.textContent = members.length;
	toggle.hidden = !currentRoom;
	paintMembersList();
}
function paintMembersList() {
	const list = $("#members-list");
	list.innerHTML = "";
	let sorted = [...currentMembers].sort((a, b) => {
		if (a.identity_type !== b.identity_type) return a.identity_type === "agent" ? -1 : 1;
		return a.identity.localeCompare(b.identity);
	});
	if (membersFilter) sorted = sorted.filter((m) => `${m.identity} ${m.handle || ""}`.toLowerCase().includes(membersFilter));
	if (sorted.length === 0) {
		list.innerHTML = "<li class=\"member-empty\">No members match.</li>";
		return;
	}
	for (const m of sorted) {
		const li = document.createElement("li");
		const dot = document.createElement("span");
		dot.className = `member-dot ${m.identity_type}`;
		li.appendChild(dot);
		const name = document.createElement("span");
		name.className = "member-name";
		name.textContent = m.identity === myIdentity ? `${m.identity} (you)` : m.identity;
		li.appendChild(name);
		if (m.identity_type === "agent") {
			const tag = document.createElement("span");
			tag.className = "member-tag";
			tag.textContent = "AGENT";
			li.appendChild(tag);
		} else if (m.handle) {
			const handle = document.createElement("span");
			handle.className = "member-handle";
			handle.textContent = `@${m.handle}`;
			li.appendChild(handle);
		}
		list.appendChild(li);
	}
}
function toggleMembersPanel() {
	const panel = $("#members-panel");
	const overlay = $("#members-overlay");
	const visible = panel.hidden;
	panel.hidden = !visible;
	if (visible) overlay.classList.add("visible");
	else overlay.classList.remove("visible");
}
$("#members-toggle").addEventListener("click", toggleMembersPanel);
$("#members-close").addEventListener("click", toggleMembersPanel);
$("#members-search")?.addEventListener("input", (e) => {
	membersFilter = e.target.value.trim().toLowerCase();
	paintMembersList();
});
$("#members-overlay").addEventListener("click", toggleMembersPanel);
var detailRouterOpen = false;
var afterDetailClose = null;
function closeAllDetailDrawers() {
	$("#agent-detail").hidden = true;
	$("#room-detail").hidden = true;
	$("#model-detail").hidden = true;
	$("#mcp-detail").hidden = true;
}
/**
* The one loading primitive (DESIGN.md §5): a list that's fetching shows an inline
* ring as its FIRST ROW — never a blank pane, never a toast. Toasts are outcomes;
* a spinner is the wait.
*/
function loadingRow(label) {
	return `<li class="skills-empty"><span class="btn-spinner" aria-hidden="true"></span>${label}</li>`;
}
function openFullView(fn) {
	if (detailRouterOpen) {
		afterDetailClose = fn;
		closeAllDetailDrawers();
		return;
	}
	fn();
}
(function() {
	const overlay = $("#detail-overlay");
	if (!overlay) return;
	const panels = [
		"#agent-detail",
		"#room-detail",
		"#model-detail",
		"#mcp-detail"
	].map((s) => $(s)).filter(Boolean);
	const app = $("#app");
	const sync = () => {
		const allHidden = panels.every((p) => p.hidden);
		overlay.hidden = allHidden;
		if (app) app.classList.toggle("detail-open", !allHidden);
		if (!allHidden && !detailRouterOpen) {
			detailRouterOpen = true;
			openView("detail", () => {
				detailRouterOpen = false;
				closeAllDetailDrawers();
				const next = afterDetailClose;
				afterDetailClose = null;
				if (next) queueMicrotask(next);
			});
		} else if (allHidden && detailRouterOpen) {
			detailRouterOpen = false;
			closeView("detail");
		}
	};
	const obs = new MutationObserver(sync);
	for (const p of panels) obs.observe(p, {
		attributes: true,
		attributeFilter: ["hidden"]
	});
	sync();
	overlay.addEventListener("click", () => {
		if (!$("#agent-detail").hidden) closeAgentDetail();
		if (!$("#room-detail").hidden) closeRoomDetail();
		if (!$("#model-detail").hidden) closeModelDetail();
		if (!$("#mcp-detail").hidden) closeMcpDetail();
	});
})();
var manageActive = false;
function openManage(tab = "agents") {
	openFullView(() => {
		hideOtherFullViews("manage");
		$("#chat").hidden = false;
		$("#app").classList.remove("in-dashboard");
		manageActive = true;
		$("#manage").hidden = false;
		$("#overflow-btn")?.classList.add("active");
		switchManageTab(tab);
		if (!viewStack.some((v) => v.name === "manage")) openView("manage", teardownManage);
		probeRoutingAvailability();
	});
}
function teardownManage() {
	manageActive = false;
	$("#manage").hidden = true;
	$("#overflow-btn")?.classList.remove("active");
}
function switchManageTab(tab) {
	manageTab = tab;
	document.querySelectorAll(".manage-tab").forEach((t) => {
		const on = t.dataset.mtab === tab;
		t.classList.toggle("active", on);
		t.setAttribute("aria-selected", String(on));
	});
	$("#mtab-agents").hidden = tab !== "agents";
	$("#mtab-models").hidden = tab !== "models";
	$("#mtab-mcp").hidden = tab !== "mcp";
	$("#mtab-skills").hidden = tab !== "skills";
	$("#mtab-routing").hidden = tab !== "routing";
	if (typeof syncManageSortIcon === "function") syncManageSortIcon();
	if (tab === "agents") fetchAgents();
	else if (tab === "models") fetchModels();
	else if (tab === "mcp") fetchMcpServers();
	else if (tab === "skills") renderSkillsRegistry();
	else if (tab === "routing") {
		if (!routingAvailable) return switchManageTab("agents");
		loadRoutingTab();
	}
}
$("#manage-back")?.addEventListener("click", () => closeView("manage"));
document.querySelectorAll(".manage-tab").forEach((t) => {
	t.addEventListener("click", () => switchManageTab(t.dataset.mtab));
});
async function refreshDraftBadge(known) {
	let n = known;
	if (typeof n !== "number") try {
		const res = await authFetch("/api/skill-drafts");
		n = res.ok ? ((await res.json()).drafts || []).length : 0;
	} catch {
		n = 0;
	}
	const dot = $("#learn-drafts-dot");
	const pill = $("#learn-drafts-count");
	if (dot) dot.hidden = n === 0;
	if (pill) {
		pill.hidden = n === 0;
		pill.textContent = n > 0 ? String(n) : "";
	}
}
async function renderSkillDrafts() {
	const wrap = $("#skill-drafts");
	const list = $("#skill-drafts-list");
	if (!wrap || !list) return;
	let drafts = [];
	try {
		const res = await authFetch("/api/skill-drafts");
		if (res.ok) drafts = (await res.json()).drafts || [];
	} catch {}
	wrap.hidden = drafts.length === 0;
	refreshDraftBadge(drafts.length);
	list.innerHTML = "";
	for (const d of drafts) {
		const li = document.createElement("li");
		li.className = "skill-row";
		li.dataset.draftId = d.id;
		const info = document.createElement("div");
		info.className = "skill-info";
		info.style.cursor = "pointer";
		const head = document.createElement("div");
		head.className = "skill-head";
		const name = document.createElement("span");
		name.className = "skill-name";
		name.textContent = d.kind === "patch" ? `${d.targetSkill || d.skillName} (change)` : d.skillName;
		const badge = document.createElement("span");
		badge.className = "skill-badge skill-badge-origin";
		badge.style.setProperty("--badge-hue", "48");
		badge.textContent = `learned · ${d.agentName}`;
		head.append(name, badge);
		const desc = document.createElement("span");
		desc.className = "skill-desc";
		desc.textContent = d.description || "";
		if (d.roomId) {
			const src = document.createElement("a");
			src.href = "#";
			src.className = "skill-draft-source";
			src.textContent = "from this conversation →";
			src.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const room = lastRoomsList.find((r) => r.id === d.roomId);
				joinRoom(d.roomId, room ? room.name : d.roomId);
			});
			desc.append(" ", src);
		}
		info.append(head, desc);
		info.addEventListener("click", () => openSkillDraft(d.id));
		li.appendChild(info);
		const keep = document.createElement("button");
		keep.type = "button";
		keep.className = "btn btn-secondary skill-catalog-add";
		keep.textContent = "Keep";
		keep.title = `Wire to ${d.agentName}`;
		keep.dataset.draftId = d.id;
		if (reviewingDrafts.has(d.id)) markDraftReviewing(keep, true);
		const actions = document.createElement("span");
		actions.className = "skill-draft-actions";
		keep.addEventListener("click", () => armUndo(actions, `Keeping ${d.skillName}…`, UNDO_SECONDS, (restore) => {
			restore();
			return keepSkillDraft(d, keep);
		}));
		const drop = document.createElement("button");
		drop.type = "button";
		drop.className = "skill-delete";
		drop.textContent = "Discard";
		drop.addEventListener("click", () => armUndo(actions, `Discarding ${d.skillName}…`, UNDO_SECONDS, () => discardSkillDraft(d.id)));
		actions.append(keep, drop);
		li.append(actions);
		list.appendChild(li);
	}
}
/**
* Minimal LCS line diff. A revision is only reviewable if you can see what
* CHANGED — showing the whole new file and asking someone to spot the edit is not
* review, it's proofreading. Skills are small, so O(m×n) is fine and beats pulling
* in a diff dependency.
*/
function lineDiff(oldText, newText) {
	const a = String(oldText).split("\n");
	const b = String(newText).split("\n");
	const m = a.length;
	const n = b.length;
	const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
	for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) if (a[i] === b[j]) {
		out.push("  " + a[i]);
		i++;
		j++;
	} else if (dp[i + 1][j] >= dp[i][j + 1]) out.push("- " + a[i++]);
	else out.push("+ " + b[j++]);
	while (i < m) out.push("- " + a[i++]);
	while (j < n) out.push("+ " + b[j++]);
	return out.join("\n");
}
var skillEditorDraft = null;
function openSkillEditorModal({ name, body, editable, badgeText, onSave, actions = [] }) {
	const overlay = document.createElement("div");
	overlay.className = "modal-overlay";
	const modal = document.createElement("div");
	modal.className = "modal skill-edit-modal";
	modal.setAttribute("role", "dialog");
	modal.setAttribute("aria-modal", "true");
	modal.setAttribute("aria-labelledby", "skill-edit-modal-title");
	const header = document.createElement("div");
	header.className = "modal-header";
	const title = document.createElement("span");
	title.id = "skill-edit-modal-title";
	title.textContent = name;
	header.appendChild(title);
	if (badgeText) {
		const badge = document.createElement("span");
		badge.className = "skill-badge skill-badge-user";
		badge.textContent = badgeText;
		header.appendChild(badge);
	}
	const bodyEl = document.createElement("div");
	bodyEl.className = "modal-body";
	const ta = document.createElement("textarea");
	ta.className = "skill-edit-textarea";
	ta.value = body;
	ta.readOnly = !editable;
	ta.spellcheck = false;
	bodyEl.appendChild(ta);
	const footer = document.createElement("div");
	footer.className = "confirm-actions";
	const actionBtns = actions.map((a) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "btn btn-ghost";
		b.textContent = a.label;
		b.addEventListener("click", () => {
			close();
			a.onClick();
		});
		footer.appendChild(b);
		return b;
	});
	const closeBtn = document.createElement("button");
	closeBtn.type = "button";
	closeBtn.className = "btn-cancel";
	closeBtn.textContent = editable ? "Cancel" : "Close";
	footer.appendChild(closeBtn);
	let saveBtn = null;
	if (editable) {
		saveBtn = document.createElement("button");
		saveBtn.type = "button";
		saveBtn.className = "btn btn-primary";
		saveBtn.textContent = "Save";
		footer.appendChild(saveBtn);
	}
	modal.append(header, bodyEl, footer);
	overlay.appendChild(modal);
	document.body.appendChild(overlay);
	const onKey = (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			return;
		}
		if (e.key === "Tab") {
			const focusables = [
				ta,
				...actionBtns,
				closeBtn,
				saveBtn
			].filter(Boolean);
			const i = focusables.indexOf(document.activeElement);
			if (e.shiftKey && i <= 0) {
				e.preventDefault();
				focusables[focusables.length - 1].focus();
			} else if (!e.shiftKey && (i === -1 || i === focusables.length - 1)) {
				e.preventDefault();
				focusables[0].focus();
			}
		}
	};
	const close = () => {
		overlay.remove();
		document.removeEventListener("keydown", onKey);
	};
	document.addEventListener("keydown", onKey);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) close();
	});
	closeBtn.addEventListener("click", close);
	if (saveBtn) saveBtn.addEventListener("click", async () => {
		saveBtn.disabled = true;
		const prev = saveBtn.textContent;
		saveBtn.textContent = "Saving…";
		try {
			await onSave(ta.value);
			close();
		} catch (err) {
			showToast("Save failed: " + (err?.message || err), { kind: "error" });
			saveBtn.disabled = false;
			saveBtn.textContent = prev;
		}
	});
	setTimeout(() => ta.focus(), 0);
}
async function openScopedSkillEditor(agentId, name) {
	let data = null;
	try {
		data = await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}/content`);
	} catch (err) {
		return showToast("Couldn’t load skill: " + (err?.message || err), { kind: "error" });
	}
	openSkillEditorModal({
		name: data.name,
		body: data.body,
		editable: !!data.editable,
		badgeText: data.editable ? "learned · editable (this agent)" : "read-only",
		actions: [{
			label: "History",
			onClick: () => openJourney({
				agentGroupId: agentId,
				skill: name
			})
		}],
		onSave: async (content) => {
			showToast(`Saved ${(await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}/content`, {
				method: "PUT",
				body: { content }
			})).name} — applies on this agent's next spawn`, { kind: "success" });
			if (selectedAgentId) renderAgentSkills(selectedAgentId);
		}
	});
}
async function openPoolSkillFromAgent(name) {
	let data = null;
	try {
		data = await apiJson(`/api/skills/${encodeURIComponent(name)}`);
	} catch (err) {
		return showToast("Couldn’t load skill: " + (err?.message || err), { kind: "error" });
	}
	const editable = data.source === "user";
	openSkillEditorModal({
		name: data.name,
		body: data.content,
		editable,
		badgeText: editable ? "imported · editable" : "built-in · read-only",
		onSave: async (content) => {
			showToast(`Saved ${(await apiJson(`/api/skills/${encodeURIComponent(name)}`, {
				method: "PUT",
				body: { content }
			})).name} — applies on each agent's next spawn`, { kind: "success" });
		}
	});
}
async function openSkillDraft(id) {
	try {
		const d = await apiJson(`/api/skill-drafts/${encodeURIComponent(id)}`);
		const isPatch = d.kind === "patch" && d.targetSkill;
		skillEditorDraft = {
			id: d.id,
			name: isPatch ? d.targetSkill : d.skillName,
			isPatch,
			body: d.body,
			currentBody: d.currentBody || "",
			mode: isPatch && d.currentBody ? "diff" : "edit"
		};
		const draft = skillEditorDraft;
		if ($("#manage").hidden || $("#mtab-skills").hidden) {
			openManage("skills");
			setTimeout(() => {
				skillEditorDraft = draft;
				renderDraftEditor();
			}, 200);
		} else renderDraftEditor();
	} catch (err) {
		showToast("Could not open draft: " + (err?.message || err), { kind: "error" });
	}
}
/**
* Undo window: swaps an actions row for a sliding countdown + Undo. The action
* commits when the bar empties; Undo restores the row untouched. The timer only
* ever starts from a human CLICK — automation (auto-keep) stays instant — and a
* tab closed mid-countdown commits nothing: the draft simply stays pending,
* which is the safe default.
*/
/** Paint the editor from skillEditorDraft (diff-review or edit mode). */
function renderDraftEditor() {
	const d = skillEditorDraft;
	if (!d) return;
	const content = $("#skill-editor-content");
	$("#skill-editor-name").value = d.name;
	$("#skill-editor-name").readOnly = true;
	const badge = $("#skill-editor-badge");
	if (badge) {
		badge.hidden = false;
		badge.className = "skill-badge";
		badge.textContent = d.isPatch ? `proposed revision of ${d.name}` : "proposed skill";
	}
	const modeBtn = $("#skill-editor-mode");
	if (d.mode === "diff") {
		content.value = lineDiff(d.currentBody, d.body);
		content.readOnly = true;
		$("#skill-editor-save").hidden = true;
		if (modeBtn) {
			modeBtn.hidden = false;
			modeBtn.textContent = "Edit";
		}
	} else {
		content.value = d.body;
		content.readOnly = false;
		$("#skill-editor-save").hidden = false;
		if (modeBtn) {
			modeBtn.hidden = !(d.isPatch && d.currentBody);
			modeBtn.textContent = "View diff";
		}
	}
	showSkillEditor(true);
}
$("#skill-editor-mode")?.addEventListener("click", () => {
	const d = skillEditorDraft;
	if (!d) return;
	if (d.mode === "edit") {
		d.body = $("#skill-editor-content").value;
		d.mode = "diff";
	} else d.mode = "edit";
	renderDraftEditor();
});
function armUndo(actionsEl, label, seconds, onCommit) {
	const original = [...actionsEl.childNodes];
	const { width } = actionsEl.getBoundingClientRect();
	if (width) actionsEl.style.width = `${width}px`;
	const restore = () => {
		actionsEl.style.width = "";
		actionsEl.textContent = "";
		for (const n of original) actionsEl.appendChild(n);
	};
	actionsEl.textContent = "";
	const wrap = document.createElement("span");
	wrap.className = "undo-timer";
	const text = document.createElement("span");
	text.className = "undo-timer-label";
	text.textContent = label;
	const bar = document.createElement("span");
	bar.className = "undo-timer-bar";
	const fill = document.createElement("span");
	bar.appendChild(fill);
	const undo = document.createElement("button");
	undo.type = "button";
	undo.className = "btn btn-ghost";
	undo.textContent = "Undo";
	wrap.append(text, bar, undo);
	actionsEl.appendChild(wrap);
	requestAnimationFrame(() => requestAnimationFrame(() => {
		fill.style.transitionDuration = `${seconds}s`;
		fill.style.width = "0%";
	}));
	const t = setTimeout(() => onCommit(restore), seconds * 1e3);
	undo.addEventListener("click", () => {
		clearTimeout(t);
		restore();
	});
}
var UNDO_SECONDS = 10;
var reviewingDrafts = /* @__PURE__ */ new Set();
/** The Keep button currently rendered for a draft (null after navigation). */
function draftKeepButton(draftId) {
	return document.querySelector(`button[data-draft-id="${CSS.escape(draftId)}"]`);
}
/** Reflect a draft's in-flight review on its Keep button, if one is rendered. */
function markDraftReviewing(btn, reviewing) {
	if (!btn) return;
	btn.disabled = reviewing;
	btn.textContent = reviewing ? "Reviewing…" : "Keep";
}
async function showOverlapChoice(d, overlaps) {
	const el = document.createElement("div");
	for (const o of overlaps) {
		const row = document.createElement("div");
		row.className = "import-warning";
		row.textContent = `⚠ ${o.name} (${o.source === "pending-draft" ? "pending draft" : o.source}) — ${o.reason}`;
		el.appendChild(row);
	}
	const updatable = overlaps.filter((o) => o.source !== "pending-draft");
	let confirmLabel;
	let confirmDecision;
	const extras = [];
	if (updatable.length === 1) {
		confirmLabel = `Update ${updatable[0].name}`;
		confirmDecision = {
			action: "update",
			target: updatable[0].name
		};
		extras.push({
			label: "Keep as new",
			value: { action: "keep-new" },
			className: "btn btn-secondary"
		});
	} else {
		confirmLabel = "Keep as new";
		confirmDecision = { action: "keep-new" };
		for (const o of updatable.slice(0, 3)) extras.push({
			label: `Update ${o.name}`,
			value: {
				action: "update",
				target: o.name
			},
			className: "btn btn-secondary"
		});
	}
	extras.push({
		label: "Discard draft",
		value: { action: "discard" },
		className: "btn btn-danger"
	});
	const choice = await showConfirmModal({
		title: `Overlaps with ${overlaps.length === 1 ? overlaps[0].name : overlaps.length + " existing skills"}`,
		body: el,
		confirmLabel,
		extraActions: extras
	});
	const decision = choice === true ? confirmDecision : choice || { action: "cancel" };
	if (decision.action === "update") return keepSkillDraft(d, draftKeepButton(d.id), false, decision.target);
	if (decision.action === "keep-new") return keepSkillDraft(d, draftKeepButton(d.id), true);
	if (decision.action === "discard") {
		await discardSkillDraft(d.id);
		showToast(`Discarded ${d.skillName || "draft"}`, { kind: "success" });
	}
}
function handleSkillDraftReview(msg) {
	reviewingDrafts.delete(msg.draftId);
	const d = {
		id: msg.draftId,
		skillName: msg.skillName,
		agentGroupId: msg.agentGroupId,
		agentName: msg.agentName
	};
	if (msg.outcome === "kept") {
		showToast(msg.updated ? `Updated ${msg.name || d.skillName} — wired to ${d.agentName}` : `Kept ${msg.name || d.skillName} — wired to ${d.agentName}`, { kind: "success" });
		refreshDraftBadge();
		renderSkillsRegistry();
		return;
	}
	markDraftReviewing(draftKeepButton(msg.draftId), false);
	if (msg.outcome === "overlaps" && Array.isArray(msg.overlaps) && msg.overlaps.length) {
		showOverlapChoice(d, msg.overlaps);
		return;
	}
	toastError(new Error(msg.error || "Review failed"), "Keep failed");
}
async function keepSkillDraft(d, btn, force, updateTarget) {
	if (btn) {
		btn.disabled = true;
		btn.textContent = updateTarget ? "Updating…" : "Keeping…";
	}
	try {
		const qs = updateTarget ? `?updateTarget=${encodeURIComponent(updateTarget)}` : force ? "?force=1" : "";
		const res = await authFetch(`/api/skill-drafts/${encodeURIComponent(d.id)}/keep${qs}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentGroupId: d.agentGroupId })
		});
		const body = await res.json().catch(() => ({}));
		if (res.status === 202 && body.queued) {
			reviewingDrafts.add(d.id);
			markDraftReviewing(btn, true);
			return;
		}
		if (!res.ok) throw new Error(body.error || res.statusText);
		showToast(body.updated ? `Updated ${body.name} — wired to ${d.agentName}` : `Kept ${body.name} — wired to ${d.agentName}`, { kind: "success" });
		refreshDraftBadge();
		renderSkillsRegistry();
	} catch (err) {
		toastError(err, "Keep failed");
		markDraftReviewing(btn, false);
	}
}
async function discardSkillDraft(id) {
	try {
		await apiJson(`/api/skill-drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
		refreshDraftBadge();
		renderSkillDrafts();
	} catch (err) {
		showToast("Discard failed: " + (err?.message || err), { kind: "error" });
	}
}
async function renderSkillDuplicates() {
	const wrap = $("#skill-duplicates");
	const list = $("#skill-duplicates-list");
	if (!wrap || !list) return;
	let dups = [];
	try {
		const res = await authFetch("/api/skills/duplicates");
		if (res.ok) dups = (await res.json()).duplicates || [];
	} catch {}
	wrap.hidden = dups.length === 0;
	list.innerHTML = "";
	for (const d of dups) {
		const li = document.createElement("li");
		li.className = "skill-row";
		const info = document.createElement("div");
		info.className = "skill-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		const name = document.createElement("span");
		name.className = "skill-name";
		name.textContent = d.name;
		const badge = document.createElement("span");
		badge.className = "skill-badge skill-badge-origin";
		badge.style.setProperty("--badge-hue", "48");
		badge.textContent = `learned · ${d.agents.length} agents`;
		head.append(name, badge);
		const desc = document.createElement("span");
		desc.className = "skill-desc";
		desc.textContent = d.agents.join(", ");
		info.append(head, desc);
		li.appendChild(info);
		const promote = document.createElement("button");
		promote.type = "button";
		promote.className = "btn btn-secondary skill-catalog-add";
		promote.textContent = "Promote";
		promote.addEventListener("click", async () => {
			if (!await showConfirmModal({
				title: `Promote ${d.name} to the shared pool?`,
				body: `The newest copy serves every agent; each agent's own copy moves to its archive.`,
				confirmLabel: "Promote"
			})) return;
			promote.disabled = true;
			try {
				await apiJson("/api/skills/promote", {
					method: "POST",
					body: { name: d.name }
				});
				showToast(`${d.name} promoted — shared with all agents`, { kind: "success" });
				renderSkillsRegistry();
			} catch (err) {
				showToast("Promote failed: " + (err?.message || err), { kind: "error" });
				promote.disabled = false;
			}
		});
		li.appendChild(promote);
		list.appendChild(li);
	}
}
function skillsSectionOpen(key) {
	const v = localStorage.getItem("skillsSectionOpen:" + key);
	return v === null ? key === "pool" : v === "1";
}
function setSkillsSectionOpen(key, open) {
	localStorage.setItem("skillsSectionOpen:" + key, open ? "1" : "0");
}
function skillsFilterQuery() {
	return ($("#skills-filter")?.value || "").trim().toLowerCase();
}
function applySkillsSections() {
	const list = $("#skills-list");
	if (!list) return;
	const q = skillsFilterQuery();
	let anyMatch = false;
	for (const head of list.querySelectorAll("li[data-section-head]")) {
		const key = head.dataset.sectionHead;
		const rows = list.querySelectorAll(`li.skill-row[data-section="${CSS.escape(key)}"]`);
		let shown = 0;
		for (const row of rows) {
			const visible = q ? (row.dataset.search || "").includes(q) : skillsSectionOpen(key);
			row.hidden = !visible;
			if (visible) shown++;
		}
		const open = q ? shown > 0 : skillsSectionOpen(key);
		head.hidden = q ? shown === 0 : false;
		head.classList.toggle("open", open);
		head.setAttribute("aria-expanded", open ? "true" : "false");
		if (q && shown > 0) anyMatch = true;
	}
	const none = $("#skills-no-match");
	if (none) none.hidden = !q || anyMatch;
}
function buildSkillsSectionHead(key, label, roomName, count) {
	const li = document.createElement("li");
	li.className = "skills-section-head";
	li.dataset.sectionHead = key;
	const chev = document.createElement("span");
	chev.className = "skills-section-chevron";
	chev.textContent = "›";
	const name = document.createElement("span");
	name.className = "skills-section-label";
	name.textContent = label;
	li.append(chev, name);
	if (roomName) {
		const pill = document.createElement("span");
		pill.className = "skill-badge skill-badge-scope";
		pill.textContent = roomName;
		li.appendChild(pill);
	}
	const n = document.createElement("span");
	n.className = "skills-section-count";
	n.textContent = String(count);
	li.appendChild(n);
	li.setAttribute("role", "button");
	li.setAttribute("tabindex", "0");
	const toggle = () => {
		if (skillsFilterQuery()) return;
		setSkillsSectionOpen(key, !skillsSectionOpen(key));
		applySkillsSections();
	};
	li.addEventListener("click", toggle);
	li.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggle();
		}
	});
	return li;
}
async function renderSkillsRegistry() {
	const list = $("#skills-list");
	if (!list) return;
	showSkillEditor(false);
	renderSkillDrafts();
	renderSkillDuplicates();
	const learnLink = $("#skills-learn-link");
	if (learnLink) learnLink.hidden = !learningMasterEnabled;
	list.innerHTML = "<li class=\"skills-empty\">Loading…</li>";
	let skills = [];
	try {
		const res = await authFetch("/api/skills");
		if (res.ok) skills = (await res.json()).skills || [];
	} catch (err) {
		console.error("Failed to load skills:", err);
	}
	list.innerHTML = "";
	const filterEl = $("#skills-filter");
	if (!skills.length) {
		if (filterEl) filterEl.hidden = true;
		list.innerHTML = "<li class=\"skills-empty\">No skills yet — import one above.</li>";
		return;
	}
	if (filterEl) filterEl.hidden = false;
	const pool = [];
	const byAgent = /* @__PURE__ */ new Map();
	for (const s of skills) if (s.source === "scoped") {
		let g = byAgent.get(s.agentGroupId);
		if (!g) byAgent.set(s.agentGroupId, g = {
			name: s.agentName || "",
			rooms: s.rooms || [],
			skills: []
		});
		g.skills.push(s);
	} else pool.push(s);
	const sections = [];
	if (pool.length) sections.push({
		key: "pool",
		label: "Workspace",
		roomName: null,
		skills: pool
	});
	for (const [gid, g] of [...byAgent].sort((a, b) => a[1].name.localeCompare(b[1].name))) sections.push({
		key: gid,
		label: g.name,
		roomName: g.rooms.length === 1 ? g.rooms[0].name : null,
		skills: g.skills
	});
	for (const section of sections) {
		list.appendChild(buildSkillsSectionHead(section.key, section.label, section.roomName, section.skills.length));
		for (const s of section.skills) appendSkillRow(list, section.key, s);
	}
	const none = document.createElement("li");
	none.id = "skills-no-match";
	none.className = "skills-empty";
	none.textContent = "No matching skills";
	none.hidden = true;
	list.appendChild(none);
	applySkillsSections();
	markSkillUpdates(list);
}
function appendSkillRow(list, sectionKey, s) {
	const li = document.createElement("li");
	li.className = "skill-row";
	const info = document.createElement("div");
	info.className = "skill-info";
	const head = document.createElement("div");
	head.className = "skill-head";
	const name = document.createElement("span");
	name.className = "skill-name";
	name.textContent = s.name;
	let badge;
	if (s.source === "scoped") {
		badge = document.createElement("span");
		badge.className = "skill-badge skill-badge-scope";
		badge.textContent = s.rooms && s.rooms.length === 1 ? s.rooms[0].name : s.agentName;
	} else if (s.source === "shipped") {
		badge = document.createElement("span");
		badge.className = "skill-badge";
		badge.textContent = "built-in";
	} else if (s.origin && s.origin.label) badge = originBadgeEl(s.origin);
	else {
		badge = document.createElement("span");
		badge.className = "skill-badge skill-badge-user";
		badge.textContent = "imported";
	}
	head.append(name, badge);
	if (s.source === "scoped" && s.origin && s.origin.label) head.appendChild(originBadgeEl(s.origin));
	const desc = document.createElement("span");
	desc.className = "skill-desc";
	desc.textContent = s.description || "";
	info.append(head, desc);
	const open = () => s.source === "scoped" ? openScopedSkillEditor(s.agentGroupId, s.name) : openSkillEditor(s.name);
	info.style.cursor = "pointer";
	info.setAttribute("role", "button");
	info.setAttribute("tabindex", "0");
	info.addEventListener("click", open);
	info.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			open();
		}
	});
	li.appendChild(info);
	if (s.source === "user") {
		li.dataset.skill = s.name;
		const del = document.createElement("button");
		del.type = "button";
		del.className = "skill-delete";
		del.textContent = "Remove";
		del.addEventListener("click", () => deleteSkill(s.name));
		li.appendChild(del);
	} else if (s.source === "scoped") {
		const hist = document.createElement("button");
		hist.type = "button";
		hist.className = "btn btn-ghost skill-history-btn";
		hist.textContent = "History";
		hist.addEventListener("click", () => openJourney({
			agentGroupId: s.agentGroupId,
			agentName: s.agentName,
			skill: s.name
		}));
		li.appendChild(hist);
		const del = document.createElement("button");
		del.type = "button";
		del.className = "skill-delete";
		del.textContent = "Remove";
		del.addEventListener("click", () => removeAgentScopedSkill(s.agentGroupId, s.name, del, renderSkillsRegistry));
		li.appendChild(del);
	}
	li.dataset.section = sectionKey;
	li.dataset.search = (s.name + " " + (s.description || "")).toLowerCase();
	list.appendChild(li);
}
async function markSkillUpdates(list) {
	let updates = [];
	try {
		const res = await authFetch("/api/skills/updates");
		if (res.ok) updates = (await res.json()).updates || [];
	} catch {}
	for (const u of updates) {
		if (!u.hasUpdate) continue;
		const li = list.querySelector(`li[data-skill="${CSS.escape(u.name)}"]`);
		if (!li || li.querySelector(".skill-update-btn")) continue;
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn btn-secondary skill-update-btn";
		btn.textContent = "Update";
		btn.title = "The source repo has newer commits — re-import from it";
		btn.addEventListener("click", async () => {
			if (!await showConfirmModal({
				title: `Update ${u.name}?`,
				body: "Re-imports from its source at the latest commit. The current version is kept in history.",
				confirmLabel: "Update"
			})) return;
			btn.disabled = true;
			btn.textContent = "Updating…";
			try {
				const body = await apiJson(`/api/skills/${encodeURIComponent(u.name)}/update`, { method: "POST" });
				showToast(`Updated ${u.name}`, { kind: "success" });
				for (const w of body.warnings || []) showToast(`⚠ ${w}`, { kind: "error" });
				renderSkillsRegistry();
			} catch (err) {
				showToast("Update failed: " + (err?.message || err), { kind: "error" });
				btn.disabled = false;
				btn.textContent = "Update";
			}
		});
		li.insertBefore(btn, li.querySelector(".skill-delete"));
	}
}
var SKILL_TEMPLATE = `---
name: my-skill
description: One line saying what this skill is for and when to use it.
---

# My Skill

Instructions the agent follows when this skill applies.
`;
function showSkillsView(view) {
	$("#skills-browse").hidden = view !== "browse";
	$("#skills-add").hidden = view !== "add";
	$("#skills-editor").hidden = view !== "editor";
}
function resetSkillEditorState() {
	skillEditorDraft = null;
	const m = $("#skill-editor-mode");
	if (m) m.hidden = true;
}
var skillEditorClosing = false;
function showSkillEditor(show) {
	if (show) {
		skillEditorClosing = false;
		showSkillsView("editor");
		if (!viewStack.some((v) => v.name === "skill-editor")) openView("skill-editor", () => {
			skillEditorClosing = false;
			resetSkillEditorState();
			showSkillsView("browse");
		});
		return;
	}
	if (viewStack.some((v) => v.name === "skill-editor")) {
		if (!skillEditorClosing) {
			skillEditorClosing = true;
			closeView("skill-editor");
		}
		return;
	}
	resetSkillEditorState();
	showSkillsView("browse");
}
function skillsLoadingRow(label) {
	return loadingRow(label);
}
function labelHue(str) {
	const BAND_LO = 60;
	const usable = 230;
	let h = 0;
	for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) % usable;
	return h < BAND_LO ? h : h + 130;
}
function originBadgeEl(origin) {
	const safeUrlEl = /^https?:\/\//i.test(origin.url || "") ? origin.url : null;
	const el = document.createElement(safeUrlEl ? "a" : "span");
	el.className = "skill-badge skill-badge-origin" + (origin.official ? " skill-badge-official" : "");
	el.textContent = origin.label;
	if (!origin.official) el.style.setProperty("--badge-hue", String(labelHue(origin.label)));
	if (safeUrlEl) {
		el.href = safeUrlEl;
		el.target = "_blank";
		el.rel = "noopener noreferrer";
		el.title = `${origin.label} — open source ↗`;
		el.addEventListener("click", (e) => e.stopPropagation());
	}
	return el;
}
var skillTrust = "official";
var poolSearchTimer = null;
var poolSeq = 0;
async function openSkillsAdd() {
	showSkillsView("add");
	$("#skill-discover-search").value = "";
	await setSkillTrust("official");
}
async function setSkillTrust(mode) {
	skillTrust = mode;
	const official = mode === "official";
	$("#skills-trust-official").classList.toggle("active", official);
	$("#skills-trust-official").setAttribute("aria-selected", String(official));
	$("#skills-trust-community").classList.toggle("active", !official);
	$("#skills-trust-community").setAttribute("aria-selected", String(!official));
	const search = $("#skill-discover-search");
	search.hidden = official;
	if (official) search.value = "";
	$("#skills-catalog-warn").hidden = official;
	await renderSkillPool();
}
async function renderSkillPool() {
	const tier = skillTrust;
	const community = tier === "community";
	const q = community ? $("#skill-discover-search").value.trim() : "";
	const list = $("#skills-catalog-list");
	const seq = ++poolSeq;
	list.innerHTML = skillsLoadingRow(q ? "Searching…" : "Loading skills…");
	let data = null;
	try {
		const res = await authFetch(`/api/skills/catalog?tier=${tier}&q=${encodeURIComponent(q)}`);
		if (res.ok) data = await res.json();
	} catch {}
	if (seq !== poolSeq) return;
	if (!data) {
		list.innerHTML = "<li class=\"skills-empty\">Couldn’t load skills — import by URL below.</li>";
		return;
	}
	const skills = data.skills || [];
	list.innerHTML = "";
	if (!skills.length) {
		list.innerHTML = `<li class="skills-empty">${q ? "No matches." : "Nothing here yet."}</li>`;
		return;
	}
	for (const s of skills) {
		const li = document.createElement("li");
		li.className = "skill-row";
		const info = document.createElement("div");
		info.className = "skill-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		const name = document.createElement("span");
		name.className = "skill-name";
		name.textContent = s.name;
		head.append(name, originBadgeEl(s.origin));
		const desc = document.createElement("span");
		desc.className = "skill-desc";
		desc.textContent = s.description || "";
		info.append(head, desc);
		li.appendChild(info);
		if (community && s.review) {
			const review = document.createElement("a");
			review.className = "skill-review";
			review.href = s.review;
			review.target = "_blank";
			review.rel = "noopener noreferrer";
			review.textContent = "Review ↗";
			li.appendChild(review);
		}
		if (s.installed) {
			const got = document.createElement("span");
			got.className = "skill-badge skill-badge-user";
			got.textContent = "added";
			li.appendChild(got);
		} else {
			const add = document.createElement("button");
			add.type = "button";
			add.className = "btn btn-secondary skill-catalog-add";
			add.textContent = "Add";
			add.addEventListener("click", () => openWireToAgentsPicker({
				...s.ref,
				origin: s.origin
			}, s.name, { community }));
			li.appendChild(add);
		}
		list.appendChild(li);
	}
}
var wireSkillState = null;
async function openWireToAgentsPicker(importBody, displayName, opts = {}) {
	if (!await inspectAndConfirmImport(importBody, displayName, !!opts.community)) return;
	if (!allAgents.length) await fetchAgents();
	wireSkillState = {
		importBody,
		name: null,
		wired: /* @__PURE__ */ new Set()
	};
	openAttachPicker({
		title: `Wire ${displayName} to agents`,
		searchPlaceholder: "Search agents…",
		emptyText: "No agents yet.",
		addNewLabel: "Wire to all agents",
		items: () => allAgents,
		searchText: (a) => a.name,
		name: (a) => a.name,
		isAttached: (a) => wireSkillState.wired.has(a.id),
		onToggle: async (a, add) => {
			if (add) {
				const body = await apiJson(`/api/agents/${encodeURIComponent(a.id)}/skills/import`, {
					method: "POST",
					body: importBody
				});
				wireSkillState.name = body.name;
				wireSkillState.wired.add(a.id);
				showToast(`Wired ${body.name} to ${a.name}`, { kind: "success" });
			} else {
				await apiJson(`/api/agents/${encodeURIComponent(a.id)}/skills/scoped/${encodeURIComponent(wireSkillState.name)}`, { method: "DELETE" });
				wireSkillState.wired.delete(a.id);
				showToast(`Unwired from ${a.name}`, { kind: "success" });
			}
		},
		onAddNew: async () => {
			closeAttachPicker();
			try {
				showToast(`Added ${(await apiJson("/api/skills/import", {
					method: "POST",
					body: importBody
				})).name} to all agents`, { kind: "success" });
			} catch (err) {
				showToast("Import failed: " + (err?.message || err), { kind: "error" });
			}
		}
	});
}
async function inspectAndConfirmImport(importBody, displayName, community) {
	let insp = null;
	try {
		const res = await authFetch("/api/skills/inspect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...importBody,
				official: !community
			})
		});
		if (res.ok) insp = await res.json();
	} catch {}
	if (!insp) return showConfirmModal({
		title: `Import ${displayName}?`,
		body: community ? "This is a community skill — its instructions and scripts will run in your agents. Review it first." : void 0,
		confirmLabel: "Import",
		destructive: !!community
	});
	const el = document.createElement("div");
	const line = (text, cls) => {
		const d = document.createElement("div");
		if (cls) d.className = cls;
		d.textContent = text;
		el.appendChild(d);
	};
	const kb = Math.max(1, Math.round(insp.totalBytes / 1024));
	line(`${insp.files} file${insp.files === 1 ? "" : "s"} · ${kb} KB · SKILL.md ≈ ${insp.skillMdTokens.toLocaleString()} tokens of agent context`);
	line(insp.scripts.length ? `Scripts: ${insp.scripts.slice(0, 5).join(", ")}${insp.scripts.length > 5 ? ` +${insp.scripts.length - 5} more` : ""}` : "No scripts — instructions only");
	if (insp.externalHosts.length) line(`Links out to: ${insp.externalHosts.slice(0, 6).join(", ")}`);
	for (const w of insp.warnings) line(`⚠ ${w}`, "import-warning");
	if (community) line("Community skill — unvetted. Its instructions and any scripts run in your agents.", "import-note");
	return showConfirmModal({
		title: `Import ${displayName}?`,
		body: el,
		confirmLabel: "Import",
		destructive: !!community || insp.warnings.length > 0
	});
}
async function openSkillEditor(name) {
	skillEditorDraft = null;
	const modeBtn = $("#skill-editor-mode");
	if (modeBtn) modeBtn.hidden = true;
	const nameInput = $("#skill-editor-name");
	const content = $("#skill-editor-content");
	const badge = $("#skill-editor-badge");
	const save = $("#skill-editor-save");
	if (name) {
		let data = null;
		try {
			const res = await authFetch(`/api/skills/${encodeURIComponent(name)}`);
			if (res.ok) data = await res.json();
		} catch {}
		if (!data) return showToast("Couldn’t load skill", { kind: "error" });
		nameInput.value = data.name;
		nameInput.readOnly = true;
		content.value = data.content;
		const editable = data.source === "user";
		content.readOnly = !editable;
		save.hidden = !editable;
		badge.hidden = false;
		badge.className = "skill-badge skill-badge-" + data.source;
		badge.textContent = editable ? "imported — editable" : "built-in — read-only";
	} else {
		nameInput.value = "";
		nameInput.readOnly = false;
		content.value = SKILL_TEMPLATE;
		content.readOnly = false;
		save.hidden = false;
		badge.hidden = true;
	}
	showSkillEditor(true);
	(name ? content : nameInput).focus();
}
async function saveSkillEditor() {
	if (skillEditorDraft) {
		const d = skillEditorDraft;
		const body = d.mode === "edit" ? $("#skill-editor-content").value : d.body;
		const save = $("#skill-editor-save");
		save.disabled = true;
		try {
			await apiJson(`/api/skill-drafts/${encodeURIComponent(d.id)}`, {
				method: "PUT",
				body: { body }
			});
			d.body = body;
			showToast("Draft updated — Keep applies this version", { kind: "success" });
			renderSkillDrafts();
			renderRoomSkills();
		} catch (err) {
			showToast("Save failed: " + (err?.message || err), { kind: "error" });
		} finally {
			save.disabled = false;
		}
		return;
	}
	const name = $("#skill-editor-name").value.trim();
	const content = $("#skill-editor-content").value;
	if (!name) return showToast("Give the skill a name", { kind: "error" });
	const save = $("#skill-editor-save");
	save.disabled = true;
	try {
		showToast(`Saved ${(await apiJson(`/api/skills/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: { content }
		})).name} — applies on each agent's next spawn`, { kind: "success" });
		showSkillEditor(false);
		await renderSkillsRegistry();
	} catch (err) {
		showToast("Save failed: " + (err?.message || err), { kind: "error" });
	} finally {
		save.disabled = false;
	}
}
$("#skill-add-btn")?.addEventListener("click", openSkillsAdd);
$("#skill-discover-search")?.addEventListener("input", () => {
	clearTimeout(poolSearchTimer);
	poolSearchTimer = setTimeout(() => renderSkillPool(), 400);
});
$("#skills-add-back")?.addEventListener("click", () => renderSkillsRegistry());
var skillsFilterTimer = 0;
$("#skills-filter")?.addEventListener("input", () => {
	clearTimeout(skillsFilterTimer);
	skillsFilterTimer = setTimeout(applySkillsSections, 100);
});
$("#skills-trust-official")?.addEventListener("click", () => setSkillTrust("official"));
$("#skills-trust-community")?.addEventListener("click", () => setSkillTrust("community"));
async function pickLearnTarget() {
	let agents = [];
	try {
		agents = await apiJson("/api/agents");
	} catch (err) {
		toastError(err, "Could not load agents");
		return null;
	}
	if (!Array.isArray(agents) || agents.length === 0) {
		showToast("No agents you administer", { kind: "error" });
		return null;
	}
	const roomsByAgent = /* @__PURE__ */ new Map();
	await Promise.all(agents.map(async (a) => {
		try {
			const r = await authFetch(`/api/agents/${encodeURIComponent(a.id)}/rooms`);
			roomsByAgent.set(a.id, r.ok ? await r.json() : []);
		} catch {
			roomsByAgent.set(a.id, []);
		}
	}));
	const firstWithRoom = agents.find((a) => (roomsByAgent.get(a.id) || []).length > 0);
	if (!firstWithRoom) {
		showToast("No agent has a room — wire one to a room first", { kind: "error" });
		return null;
	}
	const body = document.createElement("div");
	body.className = "learn-target-picker";
	const agentSel = document.createElement("select");
	agentSel.className = "confirm-input";
	agentSel.setAttribute("aria-label", "Agent");
	for (const a of agents) {
		const opt = new Option(a.name, a.id);
		if ((roomsByAgent.get(a.id) || []).length === 0) {
			opt.disabled = true;
			opt.title = "No room";
		}
		agentSel.appendChild(opt);
	}
	agentSel.value = firstWithRoom.id;
	const roomSel = document.createElement("select");
	roomSel.className = "confirm-input";
	roomSel.setAttribute("aria-label", "Room");
	const syncRooms = () => {
		const rooms = roomsByAgent.get(agentSel.value) || [];
		roomSel.innerHTML = "";
		for (const r of rooms) roomSel.appendChild(new Option(r.name, r.id));
		roomSel.hidden = rooms.length <= 1;
	};
	agentSel.addEventListener("change", syncRooms);
	syncRooms();
	body.append(agentSel, roomSel);
	if (!await showConfirmModal({
		title: "Learn with which agent?",
		body,
		confirmLabel: "Learn"
	})) return null;
	const rooms = roomsByAgent.get(agentSel.value) || [];
	return (rooms.length > 1 ? rooms.find((r) => r.id === roomSel.value) : rooms[0]) || null;
}
$("#skills-learn-link")?.addEventListener("click", async () => {
	const v = await promptLearnSource({
		title: "Learn from a link",
		placeholder: "https://…",
		check: isLearnUrlToken,
		invalid: "Start with a full link (http:// or https://)"
	});
	if (!v) return;
	const room = await pickLearnTarget();
	if (!room) return;
	closeView("manage");
	joinRoom(room.id, room.name);
	pendingSendAfterJoin = "/learn " + v;
});
async function renderSkillSourcesSettings() {
	const section = $("#settings-skill-sources");
	if (!section) return;
	section.hidden = !isOwnerView;
	if (!isOwnerView) return;
	const list = $("#skill-sources-list");
	list.innerHTML = "";
	let sources = [];
	let builtins = [];
	try {
		const res = await authFetch("/api/skills/sources");
		if (res.ok) {
			const b = await res.json();
			sources = b.sources || [];
			builtins = b.builtins || [];
		}
	} catch {}
	const sourceRow = (origin, meta) => {
		const li = document.createElement("li");
		li.className = "skill-source-row";
		const info = document.createElement("div");
		info.className = "skill-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		head.appendChild(originBadgeEl(origin));
		const m = document.createElement("span");
		m.className = "skill-desc";
		m.textContent = meta;
		info.append(head, m);
		li.appendChild(info);
		return li;
	};
	for (const s of sources) {
		const origin = s.official ? {
			label: s.label.replace(/\s*\((?:official|community)\)\s*$/i, ""),
			url: `https://github.com/${s.owner}/${s.repo}`,
			official: true
		} : {
			label: `${s.owner}/${s.repo}`,
			url: `https://github.com/${s.owner}/${s.repo}`,
			official: false
		};
		const li = sourceRow(origin, s.dir ? `${s.dir} · ${s.branch}` : `whole repo · ${s.branch}`);
		const edit = document.createElement("button");
		edit.type = "button";
		edit.className = "btn btn-ghost";
		edit.textContent = "Edit";
		edit.addEventListener("click", () => {
			$("#skill-source-url").value = `https://github.com/${s.owner}/${s.repo}/tree/${s.branch}/${s.dir}`;
			const save = $("#skill-source-save");
			save.textContent = "Save";
			save.dataset.editId = s.id;
		});
		const del = document.createElement("button");
		del.type = "button";
		del.className = "skill-delete";
		del.textContent = "Remove";
		del.addEventListener("click", async () => {
			if (!await showConfirmModal({
				title: `Remove ${origin.label}?`,
				body: "The collection disappears from the Skills catalog. Already-imported skills are unaffected.",
				confirmLabel: "Remove",
				destructive: true
			})) return;
			try {
				await apiJson(`/api/skills/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" });
				renderSkillSourcesSettings();
			} catch (err) {
				showToast("Remove failed: " + (err?.message || err), { kind: "error" });
			}
		});
		li.append(edit, del);
		list.appendChild(li);
	}
	for (const bi of builtins) {
		const li = sourceRow({
			label: bi.label,
			url: bi.url,
			official: false
		}, bi.disabled ? "Built-in marketplace — removed from the pool" : "Built-in marketplace — pooled into Community");
		if (bi.disabled) li.classList.add("source-disabled");
		const tag = document.createElement("span");
		tag.className = "skill-badge";
		tag.textContent = "built-in";
		li.appendChild(tag);
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = bi.disabled ? "btn btn-ghost" : "skill-delete";
		toggle.textContent = bi.disabled ? "Add" : "Remove";
		toggle.addEventListener("click", () => toggleBuiltinSource(bi.id, bi.disabled));
		li.appendChild(toggle);
		list.appendChild(li);
	}
}
async function toggleBuiltinSource(id, wasDisabled) {
	try {
		const res = await authFetch(`/api/skills/sources/${encodeURIComponent(id)}`, {
			method: wasDisabled ? "PUT" : "DELETE",
			...wasDisabled ? {
				headers: { "Content-Type": "application/json" },
				body: "{}"
			} : {}
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
		showToast(wasDisabled ? "Marketplace added back to the pool" : "Marketplace removed from the pool", { kind: "success" });
		renderSkillSourcesSettings();
	} catch (err) {
		showToast("Failed: " + (err?.message || err), { kind: "error" });
	}
}
$("#skill-source-save")?.addEventListener("click", async () => {
	const save = $("#skill-source-save");
	const url = $("#skill-source-url").value.trim();
	if (!url) return showToast("Paste a GitHub repo or folder URL", { kind: "error" });
	const folder = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/);
	const root = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
	const derivedId = (folder ? `${folder[1]}-${folder[2]}-${folder[4]}` : root ? `${root[1]}-${root[2]}` : "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
	const id = save.dataset.editId || derivedId;
	if (!id) return showToast("Expected a GitHub repo or folder URL", { kind: "error" });
	save.disabled = true;
	try {
		showToast(`Added ${(await apiJson(`/api/skills/sources/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: { url }
		})).source?.label || "collection"}`, { kind: "success" });
		$("#skill-source-url").value = "";
		save.textContent = "Add";
		delete save.dataset.editId;
		renderSkillSourcesSettings();
	} catch (err) {
		showToast("Save failed: " + (err?.message || err), { kind: "error" });
	} finally {
		save.disabled = false;
	}
});
$("#skill-new-btn")?.addEventListener("click", () => openSkillEditor(null));
$("#skill-editor-cancel")?.addEventListener("click", () => showSkillEditor(false));
$("#skill-editor-save")?.addEventListener("click", saveSkillEditor);
function importSkill() {
	const input = $("#skill-import-url");
	const url = (input.value || "").trim();
	if (!url) return;
	const label = url.replace(/^https?:\/\/github\.com\//, "").replace(/\/tree\/.*$/, "");
	input.value = "";
	openWireToAgentsPicker({ url }, label || "skill", { community: true });
}
async function deleteSkill(name) {
	if (!await showConfirmModal({
		title: `Delete ${name}?`,
		body: "Removes this imported skill. Agents that use it lose it on their next spawn.",
		confirmLabel: "Delete",
		destructive: true
	})) return;
	try {
		await apiJson(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
		showToast(`Deleted ${name}`, { kind: "success" });
		await renderSkillsRegistry();
	} catch (err) {
		showToast("Delete failed: " + (err?.message || err), { kind: "error" });
	}
}
$("#skill-import-btn")?.addEventListener("click", importSkill);
$("#skill-import-url")?.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		importSkill();
	}
});
var pendingApprovals = [];
function setApprovalsBanner(count) {
	const banner = $("#approvals-banner");
	if (!banner) return;
	const countEl = $("#approvals-count");
	const textEl = banner.querySelector(".approvals-banner-text");
	if (count <= 0) {
		banner.hidden = true;
		banner.classList.remove("expanded");
		$("#approval-list").hidden = true;
		$("#approvals-banner-toggle").setAttribute("aria-expanded", "false");
		return;
	}
	banner.hidden = false;
	countEl.textContent = String(count);
	const noun = count === 1 ? "approval" : "approvals";
	textEl.innerHTML = "";
	textEl.appendChild(countEl);
	textEl.appendChild(document.createTextNode(` ${noun} pending`));
}
function renderApprovalCard(a, options) {
	const opts = options || {};
	const card = document.createElement(opts.toast ? "div" : "li");
	card.className = opts.toast ? "approval-toast" : "approval-card";
	card.dataset.questionId = a.questionId;
	const title = document.createElement("div");
	title.className = "approval-title";
	title.textContent = a.title || a.action || "Approval requested";
	card.appendChild(title);
	if (a.payload && !opts.toast) {
		const pre = document.createElement("pre");
		pre.className = "approval-payload";
		pre.textContent = typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload, null, 2);
		card.appendChild(pre);
	}
	const actions = document.createElement("div");
	actions.className = "approval-actions";
	(Array.isArray(a.options) && a.options.length ? a.options : [{
		label: "Approve",
		value: "approve"
	}, {
		label: "Reject",
		value: "reject"
	}]).forEach((opt) => {
		const btn = document.createElement("button");
		btn.textContent = opt.label || opt.value;
		btn.className = opt.value === "approve" ? "approve" : opt.value === "reject" ? "reject" : "";
		btn.addEventListener("click", () => respondToApproval(a.questionId, opt.value, card));
		actions.appendChild(btn);
	});
	card.appendChild(actions);
	return card;
}
function renderApprovalsList() {
	const list = $("#approval-list");
	if (list) {
		list.innerHTML = "";
		pendingApprovals.forEach((a) => list.appendChild(renderApprovalCard(a)));
	}
	setApprovalsBanner(pendingApprovals.length);
}
var approvalsBannerToggle = $("#approvals-banner-toggle");
if (approvalsBannerToggle) approvalsBannerToggle.addEventListener("click", () => {
	const banner = $("#approvals-banner");
	const list = $("#approval-list");
	const expanded = banner.classList.toggle("expanded");
	list.hidden = !expanded;
	approvalsBannerToggle.setAttribute("aria-expanded", String(expanded));
});
async function fetchApprovals() {
	try {
		const r = await authFetch("/api/approvals/pending");
		if (!r.ok) return;
		pendingApprovals = await r.json();
		renderApprovalsList();
	} catch (err) {
		console.error("fetchApprovals failed:", err);
	}
}
function showApprovalToast(a) {
	const container = $("#approval-toasts");
	if (!container) return;
	const toast = renderApprovalCard(a, { toast: true });
	container.appendChild(toast);
	setTimeout(() => {
		if (toast.parentNode) toast.remove();
	}, 3e4);
}
function handleApprovalResolvedEvent(msg) {
	const approvalId = msg.approvalId;
	if (!approvalId) return;
	pendingApprovals = pendingApprovals.filter((a) => a.questionId !== approvalId);
	renderApprovalsList();
	document.querySelectorAll(`.approval-toast[data-question-id="${approvalId}"]`).forEach((el) => el.remove());
	document.querySelectorAll(`.approval-msg[data-question-id="${approvalId}"]`).forEach((el) => {
		const who = msg.resolvedBy ? " by " + String(msg.resolvedBy).split(":").pop().split("@")[0] : "";
		el.innerHTML = "";
		const note = document.createElement("div");
		note.className = "approval-inroom-note resolved";
		note.textContent = `🔒 Approval — resolved${who}`;
		el.appendChild(note);
	});
}
function handleApprovalEvent(msg) {
	showApprovalToast(msg);
	fetchApprovals();
	if (settings.notifications && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") try {
		new Notification(msg.title || "Approval requested", { body: msg.question || "" });
	} catch {}
}
async function respondToApproval(questionId, value, cardEl) {
	if (!cardEl) cardEl = document.querySelector(`[data-question-id="${questionId}"]`);
	if (cardEl) cardEl.querySelectorAll("button").forEach((b) => b.disabled = true);
	try {
		const r = await authFetch(`/api/approvals/${encodeURIComponent(questionId)}/respond`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ value })
		});
		if (!r.ok) {
			const body = await r.json().catch(() => ({}));
			console.error("Approval respond failed:", r.status, body);
			if (cardEl) {
				cardEl.querySelectorAll("button").forEach((b) => b.disabled = false);
				let errEl = cardEl.querySelector(".approval-error");
				if (!errEl) {
					errEl = document.createElement("div");
					errEl.className = "approval-error";
					cardEl.appendChild(errEl);
				}
				errEl.textContent = `Couldn't respond (${r.status}): ${body.error || r.statusText}`;
			}
			return;
		}
		pendingApprovals = pendingApprovals.filter((a) => a.questionId !== questionId);
		renderApprovalsList();
		document.querySelectorAll(`.approval-toast[data-question-id="${questionId}"]`).forEach((el) => el.remove());
	} catch (err) {
		console.error("Approval respond errored:", err);
		if (cardEl) cardEl.querySelectorAll("button").forEach((b) => b.disabled = false);
	}
}
$("#mobile-back").addEventListener("click", () => {
	$("#app").classList.remove("in-room");
});
var dashboardActive = false;
function hideOtherFullViews(keep) {
	if (keep !== "manage" && manageActive) {
		manageActive = false;
		$("#manage").hidden = true;
		$("#overflow-btn")?.classList.remove("active");
	}
	if (keep !== "dashboard" && dashboardActive) {
		dashboardActive = false;
		$("#dashboard").hidden = true;
		$("#dash-btn")?.classList.remove("active");
	}
	if (keep !== "permissions" && permsActive) {
		permsActive = false;
		$("#permissions").hidden = true;
	}
	if (keep !== "topology" && topologyActive) {
		topologyActive = false;
		$("#topology").hidden = true;
	}
	if (keep !== "journey" && journeyActive) {
		journeyActive = false;
		$("#journey").hidden = true;
	}
	if (keep !== "matrix" && matrixActive) {
		matrixActive = false;
		$("#matrix").hidden = true;
	}
	if (keep !== "help" && helpActive) {
		helpActive = false;
		$("#help").hidden = true;
	}
}
function openDashboard() {
	openFullView(() => {
		hideOtherFullViews("dashboard");
		dashboardActive = true;
		$("#chat").hidden = true;
		$("#dashboard").hidden = false;
		$("#dash-btn")?.classList.add("active");
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		refreshDashboard();
		openView("dashboard", teardownDashboard);
	});
}
function teardownDashboard() {
	dashboardActive = false;
	$("#chat").hidden = false;
	$("#dashboard").hidden = true;
	$("#dash-btn")?.classList.remove("active");
	$("#app").classList.remove("in-dashboard");
}
function toggleDashboard() {
	if (dashboardActive) closeView("dashboard");
	else openDashboard();
}
$("#dash-btn")?.addEventListener("click", toggleDashboard);
$("#dash-back").addEventListener("click", toggleDashboard);
$("#dash-refresh").addEventListener("click", refreshDashboard);
var topologyActive = false;
function openTopology() {
	openFullView(() => {
		hideOtherFullViews("topology");
		topologyActive = true;
		$("#chat").hidden = true;
		$("#topology").hidden = false;
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		refreshTopology();
		openView("topology", teardownTopology);
	});
}
function teardownTopology() {
	topologyActive = false;
	$("#chat").hidden = false;
	$("#topology").hidden = true;
	$("#app").classList.remove("in-dashboard");
}
function toggleTopology() {
	if (topologyActive) closeView("topology");
	else openTopology();
}
$("#topology-back")?.addEventListener("click", toggleTopology);
$("#topology-refresh")?.addEventListener("click", refreshTopology);
var journeyActive = false;
var journeyFilter = {
	agent: "",
	kind: "",
	skill: ""
};
var journeyAgents = /* @__PURE__ */ new Map();
function setJourneyPreset(preset) {
	journeyFilter.agent = preset?.agentGroupId || "";
	journeyFilter.kind = "";
	journeyFilter.skill = preset?.skill || "";
	if (journeyFilter.agent && !journeyAgents.has(journeyFilter.agent)) {
		const known = typeof allAgents !== "undefined" && allAgents.find?.((a) => a.id === journeyFilter.agent);
		journeyAgents.set(journeyFilter.agent, preset?.agentName || known && known.name || journeyFilter.agent);
	}
	renderJourneyFilterControls();
}
function openJourney(preset) {
	if (journeyActive) {
		setJourneyPreset(preset);
		applyJourneyFilters();
		return;
	}
	openFullView(() => {
		hideOtherFullViews("journey");
		journeyActive = true;
		$("#chat").hidden = true;
		$("#journey").hidden = false;
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		journeyAgents.clear();
		setJourneyPreset(preset);
		refreshJourney(true);
		openView("journey", teardownJourney);
	});
}
function teardownJourney() {
	journeyActive = false;
	$("#chat").hidden = false;
	$("#journey").hidden = true;
	$("#app").classList.remove("in-dashboard");
}
function toggleJourney() {
	if (journeyActive) closeView("journey");
	else openJourney();
}
$("#journey-back")?.addEventListener("click", toggleJourney);
$("#journey-refresh")?.addEventListener("click", () => void refreshJourney(true));
$("#journey-more")?.addEventListener("click", () => void refreshJourney(false));
var journeyCursor = null;
var journeyLastDay = "";
async function refreshJourney(reset) {
	const list = $("#journey-list");
	if (!list) return;
	if (reset) {
		journeyCursor = null;
		journeyLastDay = "";
		list.textContent = "Loading…";
	}
	const more = $("#journey-more");
	try {
		const data = await apiJson(`/api/learning/timeline?limit=100${!reset && journeyCursor ? `&before=${journeyCursor}` : ""}`);
		const events = data.events || [];
		if (reset) list.innerHTML = "";
		renderJourneyEvents(list, events);
		journeyCursor = data.nextBefore || null;
		if (more) more.hidden = !journeyCursor;
		if (reset && !events.length) list.innerHTML = "<div class=\"journey-empty\">Nothing learned yet.</div>";
		renderJourneyFilterControls();
		applyJourneyFilters();
	} catch (err) {
		if (reset) list.textContent = "Could not load the timeline.";
		else toastError(err, "Could not load more");
	}
}
var JOURNEY_VERBS = {
	proposed: "Proposed",
	kept: "Kept",
	discarded: "Discarded",
	revised: "Revised",
	archived: "Archived"
};
function journeyMeta(ev) {
	const bits = [];
	if (ev.kind === "kept" && ev.by === "auto-keep") bits.push("kept automatically");
	else if (ev.kind === "discarded" && ev.by === "expired") bits.push("expired unreviewed");
	else if (ev.kind === "discarded" && ev.by === "superseded") bits.push("replaced by a newer draft");
	else if (ev.kind === "archived") bits.push("unused, moved to the archive");
	if (ev.roomName) bits.push(ev.roomName);
	return bits.join(" · ");
}
function renderJourneyEvents(list, events) {
	const now = /* @__PURE__ */ new Date();
	for (const ev of events) {
		const d = new Date(ev.ts);
		const day = d.toDateString();
		if (day !== journeyLastDay) {
			journeyLastDay = day;
			const h = document.createElement("div");
			h.className = "journey-day";
			h.textContent = day === now.toDateString() ? "Today" : d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? {
				month: "long",
				day: "numeric"
			} : {
				year: "numeric",
				month: "long",
				day: "numeric"
			});
			list.appendChild(h);
		}
		const row = document.createElement("div");
		row.className = "journey-row";
		row.dataset.kind = ev.kind;
		row.dataset.agent = ev.agentGroupId || "";
		row.dataset.skill = ev.skillName || "";
		if (ev.agentGroupId && !journeyAgents.has(ev.agentGroupId)) journeyAgents.set(ev.agentGroupId, ev.agentName || ev.agentGroupId);
		const verb = document.createElement("span");
		verb.className = `journey-verb journey-verb-${ev.kind}`;
		verb.textContent = JOURNEY_VERBS[ev.kind] || ev.kind;
		const name = document.createElement("span");
		name.className = "journey-skill";
		name.textContent = ev.skillName;
		const pill = document.createElement("span");
		pill.className = "skill-badge skill-badge-scope";
		pill.textContent = ev.agentName;
		const meta = document.createElement("span");
		meta.className = "journey-meta";
		meta.textContent = journeyMeta(ev);
		const time = document.createElement("span");
		time.className = "journey-time";
		time.textContent = d.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit"
		});
		if (ev.description) row.title = ev.description;
		row.append(verb, name, pill, meta, time);
		if ((ev.kind === "kept" || ev.kind === "revised") && ev.skillExists) {
			row.classList.add("journey-linked");
			row.setAttribute("role", "button");
			row.setAttribute("tabindex", "0");
			const open = () => openScopedSkillEditor(ev.agentGroupId, ev.skillName);
			row.addEventListener("click", open);
			row.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			});
		}
		if (ev.canRevert) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "btn btn-secondary";
			btn.textContent = "Revert";
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				if (!await showConfirmModal({
					title: `Revert ${ev.skillName}?`,
					body: "Restores the previous version. The current version is kept in history.",
					confirmLabel: "Revert",
					destructive: true
				})) return;
				btn.disabled = true;
				try {
					await apiJson(`/api/agents/${encodeURIComponent(ev.agentGroupId)}/skills/scoped/${encodeURIComponent(ev.skillName)}/revert`, { method: "POST" });
					showToast(`Reverted ${ev.skillName}`, { kind: "success" });
					refreshJourney(true);
				} catch (err) {
					toastError(err, "Revert failed");
					btn.disabled = false;
				}
			});
			row.appendChild(btn);
		}
		list.appendChild(row);
	}
}
function renderJourneyFilterControls() {
	const sel = $("#journey-agent-filter");
	if (sel) {
		sel.innerHTML = "";
		sel.appendChild(new Option("All agents", ""));
		for (const [id, name] of [...journeyAgents].sort((a, b) => a[1].localeCompare(b[1]))) sel.appendChild(new Option(name, id));
		sel.value = journeyFilter.agent;
		if (sel.value !== journeyFilter.agent) journeyFilter.agent = "";
	}
	for (const b of document.querySelectorAll("#journey-kind-filter .setting-option")) {
		const active = (b.dataset.kind || "") === journeyFilter.kind;
		b.classList.toggle("active", active);
		b.setAttribute("aria-pressed", String(active));
	}
	const chip = $("#journey-skill-chip");
	if (chip) {
		chip.hidden = !journeyFilter.skill;
		if (journeyFilter.skill) chip.textContent = `skill: ${journeyFilter.skill} ✕`;
	}
}
function applyJourneyFilters() {
	const list = $("#journey-list");
	if (!list) return;
	let curDay = null;
	let dayShown = 0;
	let shown = 0;
	let total = 0;
	const flushDay = () => {
		if (curDay) curDay.hidden = dayShown === 0;
	};
	for (const el of list.children) if (el.classList.contains("journey-day")) {
		flushDay();
		curDay = el;
		dayShown = 0;
	} else if (el.classList.contains("journey-row")) {
		total++;
		const show = (!journeyFilter.agent || el.dataset.agent === journeyFilter.agent) && (!journeyFilter.kind || el.dataset.kind === journeyFilter.kind) && (!journeyFilter.skill || el.dataset.skill === journeyFilter.skill);
		el.hidden = !show;
		if (show) {
			dayShown++;
			shown++;
		}
	}
	flushDay();
	const none = $("#journey-no-match");
	if (none) none.hidden = !(total > 0 && shown === 0);
}
$("#journey-agent-filter")?.addEventListener("change", (e) => {
	journeyFilter.agent = e.target.value;
	applyJourneyFilters();
});
$("#journey-kind-filter")?.addEventListener("click", (e) => {
	const btn = e.target.closest(".setting-option");
	if (!btn) return;
	journeyFilter.kind = btn.dataset.kind || "";
	renderJourneyFilterControls();
	applyJourneyFilters();
});
$("#journey-skill-chip")?.addEventListener("click", () => {
	journeyFilter.skill = "";
	renderJourneyFilterControls();
	applyJourneyFilters();
});
async function refreshTopology() {
	const canvas = $("#topology-canvas");
	if (!canvas) return;
	canvas.textContent = "Loading…";
	try {
		const r = await authFetch("/api/topology");
		if (!r.ok) {
			canvas.textContent = "Could not load topology.";
			return;
		}
		renderTopology(await r.json());
	} catch {
		canvas.textContent = "Could not load topology.";
	}
}
var SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
	const el = document.createElementNS(SVG_NS, tag);
	for (const k in attrs) el.setAttribute(k, attrs[k]);
	return el;
}
function renderTopology(data) {
	const canvas = $("#topology-canvas");
	if (!canvas) return;
	topoData = data;
	topoFocus = null;
	updateTopoFocusPill();
	canvas.textContent = "";
	const rooms = data.rooms || [];
	const agents = data.agents || [];
	const models = data.models || [];
	const edges = data.edges || [];
	const mcpServers = data.mcpServers || [];
	const mcpEdges = data.mcpEdges || [];
	const skills = data.skills || [];
	const skillEdges = data.skillEdges || [];
	if (rooms.length === 0) {
		canvas.textContent = "No rooms yet.";
		return;
	}
	const push = (m, k, v) => {
		if (!m.has(k)) m.set(k, []);
		m.get(k).push(v);
	};
	const agentRooms = /* @__PURE__ */ new Map();
	const roomAgents = /* @__PURE__ */ new Map();
	const modelAgents = /* @__PURE__ */ new Map();
	for (const e of edges) {
		push(agentRooms, e.agent, e.room);
		push(roomAgents, e.room, e.agent);
	}
	for (const a of agents) if (a.modelId) push(modelAgents, a.modelId, a.id);
	const mcpAgents = /* @__PURE__ */ new Map();
	const agentMcps = /* @__PURE__ */ new Map();
	for (const e of mcpEdges) {
		push(mcpAgents, e.mcp, e.agent);
		push(agentMcps, e.agent, e.mcp);
	}
	const skillAgents = /* @__PURE__ */ new Map();
	for (const e of skillEdges) push(skillAgents, e.skill, e.agent);
	const indexMap = (arr) => new Map(arr.map((x, i) => [x.id, i]));
	const bary = (neighbors, posMap) => !neighbors || neighbors.length === 0 ? Number.POSITIVE_INFINITY : neighbors.reduce((s, n) => s + (posMap.get(n) ?? 0), 0) / neighbors.length;
	const reorder = (items, neighborsOf, posMap) => {
		const ranked = items.map((it, i) => ({
			id: it.id,
			b: bary(neighborsOf(it.id), posMap),
			i
		}));
		ranked.sort((x, y) => x.b - y.b || x.i - y.i);
		return new Map(ranked.map((r, i) => [r.id, i]));
	};
	let roomY = indexMap(rooms);
	let agentY = reorder(agents, (id) => agentRooms.get(id), roomY);
	let modelY = reorder(models, (id) => modelAgents.get(id), agentY);
	roomY = reorder(rooms, (id) => roomAgents.get(id), agentY);
	agentY = reorder(agents, (id) => agentRooms.get(id), roomY);
	modelY = reorder(models, (id) => modelAgents.get(id), agentY);
	const mcpY = reorder(mcpServers, (id) => mcpAgents.get(id), agentY);
	const skillY = reorder(skills, (id) => skillAgents.get(id), agentY);
	const ROW = 46;
	const PAD = 28;
	const COLW = 240;
	const cols = {
		room: PAD,
		agent: 268,
		model: 508,
		mcp: 748,
		skill: 988
	};
	const rowsCount = Math.max(rooms.length, agents.length, models.length, mcpServers.length, skills.length, 1);
	const svg = svgEl("svg", {
		viewBox: `0 0 ${(skills.length ? cols.skill : mcpServers.length ? cols.mcp : cols.model) + COLW} ${76 + rowsCount * ROW}`,
		class: "topology-svg",
		preserveAspectRatio: "xMidYMin meet"
	});
	const NODE_X = 6;
	const LABEL_W = 84;
	const yPx = (yMap, id) => 48 + (yMap.get(id) ?? 0) * ROW + ROW / 2;
	for (const [label, x] of [
		["Rooms", cols.room],
		["Agents", cols.agent],
		["Models", cols.model],
		...mcpServers.length ? [["MCP servers", cols.mcp]] : [],
		...skills.length ? [["Skills", cols.skill]] : []
	]) {
		const h = svgEl("text", {
			x,
			y: PAD,
			class: "topo-col-head"
		});
		h.textContent = label;
		svg.appendChild(h);
	}
	const edgeLine = (x1, y1, x2, y2, stroke) => {
		const ln = svgEl("line", {
			x1,
			y1,
			x2,
			y2,
			class: "topo-edge"
		});
		if (stroke) ln.style.stroke = stroke;
		return svg.appendChild(ln);
	};
	for (const e of edges) {
		const ln = edgeLine(cols.room + LABEL_W, yPx(roomY, e.room), cols.agent - NODE_X, yPx(agentY, e.agent), roomColor(e.room));
		ln.setAttribute("data-room", e.room);
		ln.setAttribute("data-agent", e.agent);
	}
	for (const a of agents) if (a.modelId) {
		const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, a.id), cols.model - NODE_X, yPx(modelY, a.modelId));
		ln.setAttribute("data-agent", a.id);
		ln.setAttribute("data-model", a.modelId);
	}
	for (const e of mcpEdges) {
		const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, e.agent), cols.mcp - NODE_X, yPx(mcpY, e.mcp));
		ln.classList.add("topo-edge-mcp");
		ln.setAttribute("data-agent", e.agent);
		ln.setAttribute("data-mcp", e.mcp);
	}
	for (const e of skillEdges) {
		const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, e.agent), cols.skill - NODE_X, yPx(skillY, e.skill));
		ln.classList.add("topo-edge-skill");
		ln.setAttribute("data-agent", e.agent);
		ln.setAttribute("data-skill", e.skill);
	}
	const drawNode = (x, yMap, item, kind, degree, stroke) => {
		const y = yPx(yMap, item.id);
		const g = svgEl("g", { class: `topo-node topo-${kind}${degree === 0 ? " topo-orphan" : ""}` });
		g.style.cursor = "pointer";
		g.setAttribute("role", "button");
		g.setAttribute("tabindex", "0");
		g.setAttribute("aria-label", `Open ${kind} settings: ${item.name}`);
		g.setAttribute("data-kind", kind);
		g.setAttribute("data-node-id", item.id);
		const activate = () => {
			setTopoFocus(kind, item.id, item.name);
			openTopologyItem(kind, item.id);
		};
		g.addEventListener("click", activate);
		g.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				activate();
			}
		});
		const c = svgEl("circle", {
			cx: x,
			cy: y,
			r: NODE_X
		});
		if (stroke && degree > 0) c.style.stroke = stroke;
		g.appendChild(c);
		const t = svgEl("text", {
			x: x + 11,
			y: y + 4,
			class: "topo-label"
		});
		t.textContent = degree > 0 ? `${item.name} · ${degree}` : item.name;
		g.appendChild(t);
		svg.appendChild(g);
	};
	for (const r of rooms) drawNode(cols.room, roomY, r, "room", (roomAgents.get(r.id) || []).length, roomColor(r.id));
	for (const a of agents) drawNode(cols.agent, agentY, a, "agent", (agentRooms.get(a.id) || []).length);
	for (const m of models) drawNode(cols.model, modelY, m, "model", (modelAgents.get(m.id) || []).length);
	for (const srv of mcpServers) drawNode(cols.mcp, mcpY, srv, "mcp", (mcpAgents.get(srv.id) || []).length);
	for (const sk of skills) drawNode(cols.skill, skillY, sk, "skill", (skillAgents.get(sk.id) || []).length);
	svg.addEventListener("click", (ev) => {
		if (ev.target === svg) clearTopoFocus();
	});
	canvas.appendChild(svg);
}
var topoData = null;
var topoFocus = null;
function computeTopoFocus(data, kind, id) {
	const agents = data?.agents || [];
	const edges = data?.edges || [];
	const mcpEdges = data?.mcpEdges || [];
	const skillEdges = data?.skillEdges || [];
	const rooms = /* @__PURE__ */ new Set();
	const ags = /* @__PURE__ */ new Set();
	const models = /* @__PURE__ */ new Set();
	const mcps = /* @__PURE__ */ new Set();
	const skls = /* @__PURE__ */ new Set();
	const agentModel = new Map(agents.map((a) => [a.id, a.modelId]));
	const roomsOfAgent = /* @__PURE__ */ new Map();
	const agentsOfRoom = /* @__PURE__ */ new Map();
	const agentsOfModel = /* @__PURE__ */ new Map();
	const agentsOfMcp = /* @__PURE__ */ new Map();
	const mcpsOfAgent = /* @__PURE__ */ new Map();
	const agentsOfSkill = /* @__PURE__ */ new Map();
	const skillsOfAgent = /* @__PURE__ */ new Map();
	const push = (m, k, v) => {
		if (k == null) return;
		if (!m.has(k)) m.set(k, []);
		m.get(k).push(v);
	};
	for (const e of edges) {
		push(roomsOfAgent, e.agent, e.room);
		push(agentsOfRoom, e.room, e.agent);
	}
	for (const a of agents) if (a.modelId) push(agentsOfModel, a.modelId, a.id);
	for (const e of mcpEdges) {
		push(agentsOfMcp, e.mcp, e.agent);
		push(mcpsOfAgent, e.agent, e.mcp);
	}
	for (const e of skillEdges) {
		push(agentsOfSkill, e.skill, e.agent);
		push(skillsOfAgent, e.agent, e.skill);
	}
	if (kind === "model") {
		models.add(id);
		for (const a of agentsOfModel.get(id) || []) {
			ags.add(a);
			for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
		}
	} else if (kind === "agent") {
		ags.add(id);
		if (agentModel.get(id)) models.add(agentModel.get(id));
		for (const r of roomsOfAgent.get(id) || []) rooms.add(r);
	} else if (kind === "room") {
		rooms.add(id);
		for (const a of agentsOfRoom.get(id) || []) {
			ags.add(a);
			if (agentModel.get(a)) models.add(agentModel.get(a));
		}
	} else if (kind === "mcp") {
		mcps.add(id);
		for (const a of agentsOfMcp.get(id) || []) {
			ags.add(a);
			if (agentModel.get(a)) models.add(agentModel.get(a));
			for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
		}
	} else if (kind === "skill") {
		skls.add(id);
		for (const a of agentsOfSkill.get(id) || []) {
			ags.add(a);
			if (agentModel.get(a)) models.add(agentModel.get(a));
			for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
		}
	}
	for (const a of ags) {
		for (const m of mcpsOfAgent.get(a) || []) mcps.add(m);
		for (const k of skillsOfAgent.get(a) || []) skls.add(k);
	}
	return {
		rooms,
		agents: ags,
		models,
		mcps,
		skills: skls
	};
}
function applyTopoFocus() {
	const svg = $("#topology-canvas")?.querySelector("svg");
	if (!svg) return;
	if (!topoFocus) {
		svg.querySelectorAll(".topo-dimmed").forEach((el) => el.classList.remove("topo-dimmed"));
		return;
	}
	const hl = computeTopoFocus(topoData, topoFocus.kind, topoFocus.id);
	const setFor = (k) => k === "room" ? hl.rooms : k === "agent" ? hl.agents : k === "mcp" ? hl.mcps : k === "skill" ? hl.skills : hl.models;
	svg.querySelectorAll(".topo-node").forEach((g) => {
		const on = setFor(g.getAttribute("data-kind")).has(g.getAttribute("data-node-id"));
		g.classList.toggle("topo-dimmed", !on);
	});
	svg.querySelectorAll(".topo-edge").forEach((ln) => {
		const on = ln.hasAttribute("data-skill") ? hl.agents.has(ln.getAttribute("data-agent")) && hl.skills.has(ln.getAttribute("data-skill")) : ln.hasAttribute("data-mcp") ? hl.agents.has(ln.getAttribute("data-agent")) && hl.mcps.has(ln.getAttribute("data-mcp")) : ln.hasAttribute("data-model") ? hl.agents.has(ln.getAttribute("data-agent")) && hl.models.has(ln.getAttribute("data-model")) : hl.rooms.has(ln.getAttribute("data-room")) && hl.agents.has(ln.getAttribute("data-agent"));
		ln.classList.toggle("topo-dimmed", !on);
	});
}
function setTopoFocus(kind, id, name) {
	topoFocus = {
		kind,
		id,
		name
	};
	applyTopoFocus();
	updateTopoFocusPill();
}
function clearTopoFocus() {
	topoFocus = null;
	applyTopoFocus();
	updateTopoFocusPill();
}
function updateTopoFocusPill() {
	const pill = $("#topo-focus-pill");
	if (!pill) return;
	if (topoFocus) {
		pill.textContent = `Focused: ${topoFocus.name} ✕`;
		pill.hidden = false;
	} else pill.hidden = true;
}
$("#topo-focus-pill")?.addEventListener("click", clearTopoFocus);
async function openTopologyItem(kind, id) {
	try {
		if (kind === "room") await openRoomDetail(id);
		else if (kind === "agent") {
			if (!allAgents.length) await fetchAgents();
			await openAgentDetail(id);
		} else if (kind === "model") {
			if (!allModels.length) await fetchModels();
			await openModelDetail(id);
		} else if (kind === "mcp") await openMcpDetail(id);
	} catch (err) {
		showToast("Couldn’t open settings: " + (err?.message || err), { kind: "error" });
	}
}
var matrixActive = false;
var matrixWired = /* @__PURE__ */ new Set();
function openMatrix() {
	openFullView(() => {
		hideOtherFullViews("matrix");
		matrixActive = true;
		$("#chat").hidden = true;
		$("#matrix").hidden = false;
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		refreshMatrix();
		openView("matrix", teardownMatrix);
	});
}
function teardownMatrix() {
	matrixActive = false;
	$("#chat").hidden = false;
	$("#matrix").hidden = true;
	$("#app").classList.remove("in-dashboard");
}
function toggleMatrix() {
	if (matrixActive) closeView("matrix");
	else openMatrix();
}
$("#matrix-back")?.addEventListener("click", toggleMatrix);
$("#matrix-refresh")?.addEventListener("click", refreshMatrix);
var helpActive = false;
function openHelp() {
	closeAgentDetail();
	closeRoomDetail();
	closeModelDetail();
	closeMcpDetail();
	hideOtherFullViews("help");
	helpActive = true;
	$("#chat").hidden = true;
	$("#help").hidden = false;
	$("#app").classList.add("in-dashboard");
	$("#app").classList.remove("in-room");
	openView("help", teardownHelp);
}
function teardownHelp() {
	helpActive = false;
	$("#chat").hidden = false;
	$("#help").hidden = true;
	$("#app").classList.remove("in-dashboard");
}
function toggleHelp() {
	if (helpActive) closeView("help");
	else openHelp();
}
$("#help-back")?.addEventListener("click", toggleHelp);
async function refreshMatrix() {
	const canvas = $("#matrix-canvas");
	if (!canvas) return;
	canvas.textContent = "Loading…";
	try {
		const r = await authFetch("/api/topology");
		if (!r.ok) {
			canvas.textContent = "Could not load wiring.";
			return;
		}
		renderMatrix(await r.json());
	} catch {
		canvas.textContent = "Could not load wiring.";
	}
}
function renderMatrix(data) {
	const canvas = $("#matrix-canvas");
	if (!canvas) return;
	canvas.textContent = "";
	const rooms = data.rooms || [];
	const agents = data.agents || [];
	if (rooms.length === 0 || agents.length === 0) {
		canvas.textContent = "Nothing to wire yet — create a room and an agent first.";
		return;
	}
	matrixWired = new Set((data.edges || []).map((e) => `${e.room}|${e.agent}`));
	const table = document.createElement("table");
	table.className = "matrix-table";
	const thead = document.createElement("thead");
	const hr = document.createElement("tr");
	const corner = document.createElement("th");
	corner.className = "matrix-corner";
	corner.textContent = "Room \\ Agent";
	hr.appendChild(corner);
	for (const a of agents) {
		const th = document.createElement("th");
		th.className = "matrix-agent-head";
		const name = document.createElement("div");
		name.className = "matrix-agent-name";
		name.textContent = a.name;
		th.appendChild(name);
		const chip = document.createElement("div");
		chip.className = "matrix-model-chip" + (a.modelName ? "" : " none");
		chip.textContent = a.modelName || "no model";
		th.appendChild(chip);
		hr.appendChild(th);
	}
	thead.appendChild(hr);
	table.appendChild(thead);
	const tbody = document.createElement("tbody");
	for (const room of rooms) {
		const tr = document.createElement("tr");
		const rh = document.createElement("th");
		rh.className = "matrix-room-head";
		rh.textContent = room.name;
		tr.appendChild(rh);
		for (const a of agents) {
			const td = document.createElement("td");
			td.className = "matrix-cell" + (matrixWired.has(`${room.id}|${a.id}`) ? " on" : "");
			td.dataset.room = room.id;
			td.dataset.agent = a.id;
			td.title = `${room.name} ↔ ${a.name}`;
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	canvas.appendChild(table);
}
$("#matrix-canvas")?.addEventListener("click", async (e) => {
	const cell = e.target.closest(".matrix-cell");
	if (!cell || cell.classList.contains("pending")) return;
	const roomId = cell.dataset.room;
	const agentId = cell.dataset.agent;
	const wantWired = !cell.classList.contains("on");
	cell.classList.add("pending");
	cell.classList.toggle("on", wantWired);
	try {
		const r = wantWired ? await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				kind: "existing",
				id: agentId
			})
		}) : await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
		if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
		matrixWired[wantWired ? "add" : "delete"](`${roomId}|${agentId}`);
	} catch (err) {
		cell.classList.toggle("on", !wantWired);
		showToast("Could not update wiring: " + (err.message || err), { kind: "error" });
	} finally {
		cell.classList.remove("pending");
	}
});
var permsActive = false;
var permsAgents = [];
var permsUsers = [];
var permsSelectedUserId = null;
var myUserId = null;
var isOwnerView = false;
var isAdminView = false;
var marketplaceEnabled = false;
function openPermissions() {
	openFullView(() => {
		hideOtherFullViews("permissions");
		permsActive = true;
		$("#chat").hidden = true;
		$("#permissions").hidden = false;
		$("#overflow-btn")?.classList.add("active");
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		permsShowList();
		refreshPermissions();
		openView("permissions", teardownPermissions);
	});
}
function teardownPermissions() {
	permsActive = false;
	$("#chat").hidden = false;
	$("#permissions").hidden = true;
	$("#overflow-btn")?.classList.remove("active");
	$("#app").classList.remove("in-dashboard");
}
function togglePermissions() {
	if (permsActive) closeView("permissions");
	else openPermissions();
}
async function probeIsOwner() {
	try {
		const [check, users] = await Promise.all([authFetch("/api/auth/check"), authFetch("/api/users")]);
		if (check.ok) {
			const body = await check.json();
			if (body && typeof body.userId === "string") myUserId = body.userId;
		}
		if (users.ok) {
			$("#overflow-permissions").hidden = false;
			$("#overflow-journey")?.removeAttribute("hidden");
			isAdminView = true;
			try {
				const fr = await authFetch("/api/webchat/features");
				const feats = fr.ok ? await fr.json() : {};
				marketplaceEnabled = feats.marketplaceEnabled === true;
				renderCredentialIsolation(feats);
			} catch {
				marketplaceEnabled = false;
			}
			if (marketplaceEnabled) {
				$("#overflow-mcp")?.removeAttribute("hidden");
				$("#mtab-mcp-btn")?.removeAttribute("hidden");
				$("#mtab-skills-btn")?.removeAttribute("hidden");
				$("#overflow-skills")?.removeAttribute("hidden");
			}
			const list = await users.json().catch(() => []);
			const me = Array.isArray(list) ? list.find((u) => u.id === myUserId) : null;
			isOwnerView = !!(me && userIsOwner(me));
			return true;
		}
	} catch {}
	isOwnerView = false;
	isAdminView = false;
	return false;
}
async function refreshPermissions() {
	try {
		const [usersRes, agentsRes] = await Promise.all([authFetch("/api/users"), authFetch("/api/agents")]);
		if (!usersRes.ok) {
			$("#perms-user-list").innerHTML = "<li class=\"perms-empty\">Failed to load users.</li>";
			return;
		}
		permsUsers = await usersRes.json();
		permsAgents = agentsRes.ok ? await agentsRes.json() : [];
		populatePermsAgentDropdowns();
		renderPermsUserList();
		if (permsSelectedUserId && permsUsers.find((u) => u.id === permsSelectedUserId)) renderPermsDetail(permsSelectedUserId);
		else if (permsSelectedUserId) {
			permsSelectedUserId = null;
			permsShowList();
		}
	} catch (err) {
		console.error("refreshPermissions failed:", err);
	}
}
function populatePermsAgentDropdowns() {
	const el = $("#perms-create-group");
	if (!el) return;
	el.innerHTML = "<option value=\"\">— global —</option>";
	permsAgents.forEach((a) => {
		const opt = document.createElement("option");
		opt.value = a.id;
		opt.textContent = a.name || a.id;
		el.appendChild(opt);
	});
}
function userDisplayName(u) {
	if (u.display_name && u.display_name.trim()) return u.display_name.trim();
	const lastColon = u.id.lastIndexOf(":");
	return lastColon >= 0 ? u.id.slice(lastColon + 1) : u.id;
}
function userIsOwner(u) {
	return !!u.roles.find((r) => r.kind === "owner" && r.agent_group_id === null);
}
function userIsGlobalAdmin(u) {
	return !!u.roles.find((r) => r.kind === "admin" && r.agent_group_id === null);
}
function userScopedAdminCount(u) {
	return u.roles.filter((r) => r.kind === "admin" && r.agent_group_id).length;
}
function userMemberCount(u) {
	return u.memberships.length;
}
function userRoleSummary(u) {
	const parts = [];
	if (userIsOwner(u)) parts.push("owner");
	if (userIsGlobalAdmin(u)) parts.push("global admin");
	const sa = userScopedAdminCount(u);
	if (sa) parts.push(`admin · ${sa} group${sa > 1 ? "s" : ""}`);
	const m = userMemberCount(u);
	if (m) parts.push(`member · ${m} group${m > 1 ? "s" : ""}`);
	return parts.join(" · ") || "no roles";
}
var permsUserFilter = "";
function renderPermsUserList() {
	const list = $("#perms-user-list");
	list.innerHTML = "";
	if (permsUsers.length === 0) {
		list.innerHTML = "<li class=\"perms-empty\" style=\"padding:16px;\">No users yet — anyone who authenticates will appear here.</li>";
		return;
	}
	const byName = (a, b) => userDisplayName(a).localeCompare(userDisplayName(b));
	const sorted = usersSortAz ? [...permsUsers].sort(byName) : [...permsUsers].sort((a, b) => {
		const tier = (u) => u.id === myUserId ? 0 : userIsOwner(u) ? 1 : userIsGlobalAdmin(u) || userScopedAdminCount(u) ? 2 : 3;
		const ta = tier(a);
		const tb = tier(b);
		return ta !== tb ? ta - tb : byName(a, b);
	});
	const rows = permsUserFilter ? sorted.filter((u) => `${userDisplayName(u)} ${u.id}`.toLowerCase().includes(permsUserFilter)) : sorted;
	if (rows.length === 0) {
		list.innerHTML = "<li class=\"perms-empty\" style=\"padding:16px;\">No users match.</li>";
		return;
	}
	rows.forEach((u) => {
		const li = document.createElement("li");
		li.tabIndex = 0;
		if (u.id === permsSelectedUserId) li.classList.add("active");
		const nameRow = document.createElement("div");
		nameRow.className = "perms-user-name";
		const nameText = document.createElement("span");
		nameText.className = "perms-name-text";
		nameText.textContent = userDisplayName(u);
		nameRow.appendChild(nameText);
		if (u.id === myUserId) {
			const youTag = document.createElement("span");
			youTag.className = "perms-you-tag";
			youTag.textContent = "YOU";
			nameRow.appendChild(youTag);
		}
		li.appendChild(nameRow);
		const idLine = document.createElement("div");
		idLine.className = "perms-user-id-sub";
		idLine.textContent = u.id;
		li.appendChild(idLine);
		const summary = document.createElement("div");
		summary.className = "perms-user-summary";
		summary.textContent = userRoleSummary(u);
		li.appendChild(summary);
		li.addEventListener("click", () => permsSelectUser(u.id));
		li.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				permsSelectUser(u.id);
			}
		});
		list.appendChild(li);
	});
}
$("#perms-user-search")?.addEventListener("input", (e) => {
	permsUserFilter = e.target.value.trim().toLowerCase();
	renderPermsUserList();
});
function permsSelectUser(userId) {
	permsSelectedUserId = userId;
	renderPermsDetail(userId);
	$("#perms-user-list").querySelectorAll("li").forEach((li) => li.classList.remove("active"));
	renderPermsUserList();
	permsShowDetail();
}
function findRole(u, kind, agentGroupId) {
	return u.roles.find((r) => r.kind === kind && r.agent_group_id === agentGroupId);
}
function findMembership(u, agentGroupId) {
	return u.memberships.find((m) => m.agent_group_id === agentGroupId);
}
function auditTooltip(audit) {
	if (!audit) return "";
	const who = audit.granted_by || audit.added_by || "system";
	const whenIso = audit.granted_at || audit.added_at || "";
	const when = whenIso ? new Date(whenIso).toLocaleString() : "";
	return `Granted by ${who}${when ? " on " + when : ""}`;
}
function renderPermsDetail(userId) {
	const u = permsUsers.find((x) => x.id === userId);
	if (!u) return;
	$("#perms-detail-name").textContent = userDisplayName(u);
	$("#perms-detail-id").textContent = u.id;
	const globalEl = $("#perms-global-toggles");
	globalEl.innerHTML = "";
	globalEl.appendChild(buildToggleRow(u, "Owner", "👑 ", findRole(u, "owner", null), () => togglePerm(u.id, "owner", null, !findRole(u, "owner", null))));
	globalEl.appendChild(buildToggleRow(u, "Global admin", "", findRole(u, "admin", null), () => togglePerm(u.id, "admin", null, !findRole(u, "admin", null))));
	const matrix = $("#perms-matrix");
	matrix.innerHTML = "";
	if (permsAgents.length === 0) {
		const empty = document.createElement("div");
		empty.className = "perms-matrix-empty";
		empty.textContent = "No agent groups yet.";
		matrix.appendChild(empty);
	} else permsAgents.forEach((a) => {
		const adminRole = findRole(u, "admin", a.id);
		const member = findMembership(u, a.id);
		const row = document.createElement("div");
		row.className = "perms-matrix-row";
		const name = document.createElement("span");
		name.className = "perms-group-name";
		name.textContent = a.name || a.id;
		name.title = a.id;
		row.appendChild(name);
		const adminBtn = document.createElement("button");
		adminBtn.type = "button";
		adminBtn.className = `perms-cell${adminRole ? " on" : ""}`;
		adminBtn.textContent = adminRole ? "✓" : "·";
		if (adminRole) adminBtn.title = auditTooltip(adminRole);
		adminBtn.setAttribute("aria-label", `${adminRole ? "Revoke" : "Grant"} admin · ${a.name || a.id}`);
		adminBtn.addEventListener("click", () => togglePerm(u.id, "admin", a.id, !adminRole, adminBtn));
		row.appendChild(adminBtn);
		const memberBtn = document.createElement("button");
		memberBtn.type = "button";
		memberBtn.className = `perms-cell member-style${member ? " on" : ""}`;
		memberBtn.textContent = member ? "✓" : "·";
		if (member) memberBtn.title = auditTooltip(member);
		memberBtn.setAttribute("aria-label", `${member ? "Revoke" : "Grant"} member · ${a.name || a.id}`);
		memberBtn.addEventListener("click", () => togglePerm(u.id, "member", a.id, !member, memberBtn));
		row.appendChild(memberBtn);
		matrix.appendChild(row);
	});
	const deleteZone = $("#perms-delete-zone");
	const deleteBtn = $("#perms-delete-btn");
	const isSelf = u.id === myUserId;
	const hasRolesOrMemberships = u.roles.length > 0 || u.memberships.length > 0;
	if (deleteZone) {
		deleteZone.hidden = isSelf;
		if (deleteBtn) {
			deleteBtn.disabled = hasRolesOrMemberships;
			deleteBtn.title = hasRolesOrMemberships ? "Revoke all roles and memberships before deleting" : "";
		}
	}
}
function buildToggleRow(u, label, prefix, audit, onClick) {
	const row = document.createElement("div");
	row.className = "perms-toggle-row";
	const lbl = document.createElement("span");
	lbl.className = "perms-toggle-label";
	lbl.textContent = `${prefix}${label}`;
	if (audit) {
		const meta = document.createElement("span");
		meta.className = "perms-toggle-meta";
		meta.textContent = `(${auditTooltip(audit)})`;
		lbl.appendChild(meta);
	}
	row.appendChild(lbl);
	const sw = document.createElement("button");
	sw.type = "button";
	sw.className = `perms-switch${audit ? " on" : ""}`;
	sw.setAttribute("role", "switch");
	sw.setAttribute("aria-checked", audit ? "true" : "false");
	sw.setAttribute("aria-label", label);
	sw.addEventListener("click", () => onClick(sw));
	row.appendChild(sw);
	return row;
}
/**
* Toggle a permission on or off. `granting=true` calls /grant; false calls
* /revoke. The cell is briefly disabled while the request is in flight, then
* the canonical state is re-fetched from the server.
*/
async function togglePerm(targetUserId, kind, agentGroupId, granting, cellEl) {
	if (cellEl) cellEl.classList.add("busy");
	const ok = granting ? await grantPerm(targetUserId, kind, agentGroupId) : await revokePermSilent(targetUserId, kind, agentGroupId);
	if (cellEl) cellEl.classList.remove("busy");
	if (ok) await refreshPermissions();
}
async function revokePermSilent(targetUserId, kind, agentGroupId) {
	try {
		const r = await authFetch("/api/permissions/revoke", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({
				userId: targetUserId,
				kind,
				agentGroupId
			})
		});
		if (!r.ok) {
			showToast("Revoke failed: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return false;
		}
		return true;
	} catch (err) {
		showToast("Revoke failed: " + err.message, { kind: "error" });
		return false;
	}
}
async function deleteUser(targetUserId) {
	if (!await showConfirmModal({
		title: "Delete user",
		body: `Delete ${targetUserId}? This removes the user record. They will be re-added automatically if they authenticate again.`,
		confirmLabel: "Delete",
		destructive: true
	})) return;
	try {
		const r = await authFetch(`/api/users/${encodeURIComponent(targetUserId)}`, {
			method: "DELETE",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!r.ok) {
			showToast("Delete failed: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return;
		}
		showToast(`Deleted user ${targetUserId}.`, { kind: "success" });
		permsSelectedUserId = null;
		await refreshPermissions();
		permsShowList();
	} catch (err) {
		showToast("Delete failed: " + err.message, { kind: "error" });
	}
}
function permsShowList() {
	$("#perms-body").dataset.mode = "list";
	$("#perms-detail-empty").hidden = false;
	$("#perms-detail-view").hidden = true;
	$("#perms-create-view").hidden = true;
}
function permsShowDetail() {
	$("#perms-body").dataset.mode = "detail";
	$("#perms-detail-empty").hidden = true;
	$("#perms-detail-view").hidden = false;
	$("#perms-create-view").hidden = true;
}
var serverAuthMethods = null;
var permsCreateChannelTouched = false;
async function ensureServerAuthMethods() {
	if (serverAuthMethods) return serverAuthMethods;
	try {
		const r = await fetch("/api/auth/info");
		if (r.ok) serverAuthMethods = (await r.json()).methods || null;
	} catch {}
	return serverAuthMethods;
}
function normalizeWebchatHandle(raw) {
	return raw.toLowerCase().replace(/[^a-z0-9._@+-]/g, "-");
}
function applyCreateAuthDefault() {
	const m = serverAuthMethods || {};
	if (!permsCreateChannelTouched) $("#perms-create-channel").value = m.tailscale ? "webchat:tailscale" : "webchat";
	const hint = $("#perms-create-method-hint");
	if (m.tailscale) hint.textContent = "This install signs people in via Tailscale — they appear as webchat:tailscale:<email>.";
	else if (m.proxy) hint.textContent = "This install signs people in via SSO / reverse proxy (e.g. Entra ID) — they appear as webchat:<email>.";
	else if (m.bearer) hint.textContent = "This install uses a shared bearer token — per-user ids only differ when a proxy or Tailscale also fronts it.";
	else hint.textContent = "";
	permsRefreshCreateUI();
}
function permsShowCreate() {
	$("#perms-body").dataset.mode = "detail";
	$("#perms-detail-empty").hidden = true;
	$("#perms-detail-view").hidden = true;
	$("#perms-create-view").hidden = false;
	permsCreateChannelTouched = false;
	$("#perms-create-handle").value = "";
	$("#perms-create-raw").value = "";
	$("#perms-create-kind").value = "member";
	$("#perms-create-group").value = "";
	const me = permsUsers.find((u) => u.id === myUserId);
	const canGrantRoles = !!(me && userIsOwner(me));
	const kindSel = $("#perms-create-kind");
	if (kindSel) {
		kindSel.querySelectorAll("option").forEach((opt) => {
			opt.hidden = !canGrantRoles && opt.value !== "member";
		});
		if (!canGrantRoles) kindSel.value = "member";
	}
	applyCreateAuthDefault();
	ensureServerAuthMethods().then(applyCreateAuthDefault);
	$("#perms-create-handle").focus();
}
async function grantPerm(targetUserId, kind, agentGroupId) {
	try {
		const r = await authFetch("/api/permissions/grant", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({
				userId: targetUserId,
				kind,
				agentGroupId
			})
		});
		if (!r.ok) {
			showToast("Grant failed: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return false;
		}
		return true;
	} catch (err) {
		showToast("Grant failed: " + err.message, { kind: "error" });
		return false;
	}
}
$("#perms-exit").addEventListener("click", togglePermissions);
$("#perms-refresh").addEventListener("click", refreshPermissions);
$("#perms-new-btn").addEventListener("click", () => {
	permsSelectedUserId = null;
	$("#perms-user-list").querySelectorAll("li").forEach((li) => li.classList.remove("active"));
	permsShowCreate();
});
$("#perms-detail-back").addEventListener("click", permsShowList);
$("#perms-create-back").addEventListener("click", permsShowList);
$("#perms-delete-btn").addEventListener("click", () => {
	if (permsSelectedUserId) deleteUser(permsSelectedUserId);
});
function permsCreateComposedId() {
	const channel = $("#perms-create-channel").value;
	if (channel === "__raw__") return $("#perms-create-raw").value.trim();
	let handle = $("#perms-create-handle").value.trim();
	if (!handle) return "";
	if (channel === "webchat" || channel.startsWith("webchat:")) handle = normalizeWebchatHandle(handle);
	return `${channel}:${handle}`;
}
function permsRefreshCreateUI() {
	const isRaw = $("#perms-create-channel").value === "__raw__";
	$("#perms-create-handle-label").hidden = isRaw;
	$("#perms-create-raw-label").hidden = !isRaw;
	const composed = permsCreateComposedId();
	$("#perms-create-preview").textContent = composed ? `Resolved id: ${composed}` : "Resolved id will appear here.";
	const kind = $("#perms-create-kind").value;
	const wantsGroup = kind === "admin" || kind === "member";
	$("#perms-create-group-label").hidden = !wantsGroup;
}
$("#perms-create-channel").addEventListener("change", () => {
	permsCreateChannelTouched = true;
	permsRefreshCreateUI();
});
$("#perms-create-handle").addEventListener("input", permsRefreshCreateUI);
$("#perms-create-raw").addEventListener("input", permsRefreshCreateUI);
$("#perms-create-kind").addEventListener("change", permsRefreshCreateUI);
$("#perms-create-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const userId = permsCreateComposedId();
	if (!userId) {
		showToast("Enter a handle / email (or pick \"raw user_id\" and enter the full id).", { kind: "error" });
		return;
	}
	if (!userId.includes(":")) {
		showToast("user_id must be namespaced (channel:handle).", { kind: "error" });
		return;
	}
	const kind = $("#perms-create-kind").value;
	const agentGroupId = $("#perms-create-group").value || null;
	if (kind === "owner" && agentGroupId) {
		showToast("owner role is always global — pick \"— global —\".", { kind: "error" });
		return;
	}
	if (kind === "member" && !agentGroupId) {
		showToast("member role requires an agent group.", { kind: "error" });
		return;
	}
	if (await grantPerm(userId, kind, agentGroupId)) {
		permsSelectedUserId = userId;
		await refreshPermissions();
		permsShowDetail();
	}
});
function relativeTime(ts) {
	const diff = Date.now() - (typeof ts === "number" ? ts : new Date(ts).getTime());
	if (diff < 0 || diff < 6e4) return "just now";
	if (diff < 36e5) return `${Math.floor(diff / 6e4)}m ago`;
	if (diff < 864e5) return `${Math.floor(diff / 36e5)}h ago`;
	return `${Math.floor(diff / 864e5)}d ago`;
}
function formatUptime(seconds) {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor(seconds % 86400 / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}
async function refreshDashboard() {
	let snap;
	try {
		const res = await authFetch("/api/overview");
		if (!res.ok) {
			$("#dash-graph").innerHTML = `<div class="dash-empty">Unable to load overview (${res.status})</div>`;
			return;
		}
		snap = await res.json();
	} catch (err) {
		$("#dash-graph").innerHTML = `<div class="dash-empty">Unable to load overview: ${esc(err.message)}</div>`;
		return;
	}
	renderHealthStrip(snap);
	renderMetrics(snap);
	refreshRouterMetrics();
}
async function refreshRouterMetrics() {
	const section = $("#dash-router-section");
	if (!section) return;
	try {
		const res = await authFetch("/api/router/metrics?days=7");
		if (!res.ok) {
			section.hidden = true;
			return;
		}
		const m = await res.json();
		if (!m.available || m.total === 0) {
			section.hidden = true;
			return;
		}
		section.hidden = false;
		const max = Math.max(...m.byModel.map((x) => x.count), 1);
		const bars = m.byModel.map((x) => `
      <div class="router-bar-row" title="${esc(x.model)}">
        <span class="router-bar-label">${esc(x.model)}</span>
        <span class="router-bar-track"><span class="router-bar-fill" style="width:${Math.max(3, Math.round(100 * x.count / max))}%"></span></span>
        <span class="router-bar-count">${x.count}</span>
      </div>`).join("");
		const routes = m.byRoute.filter((r) => r.route !== "__error__").map((r) => `${esc(r.route)} ${r.count}`).join(" · ");
		const health = [];
		health.push(`${m.total} request${m.total === 1 ? "" : "s"}`);
		health.push(`${m.live} via auto`);
		if (m.escalations > 0) health.push(`${m.escalations} escalated to Claude`);
		if (m.errors > 0) health.push(`${m.errors} classifier error${m.errors === 1 ? "" : "s"}`);
		$("#dash-router").innerHTML = `<div class="router-summary">${esc(health.join(" · "))}</div>` + bars + (routes ? `<div class="router-routes">Routes: ${routes}</div>` : "");
	} catch {
		section.hidden = true;
	}
}
function renderHealthStrip(snap) {
	const wsOk = ws && ws.readyState === WebSocket.OPEN;
	const pills = [
		{
			dot: "ok",
			label: "Server",
			value: "Online"
		},
		{
			dot: "ok",
			label: "Uptime",
			value: snap.health.uptime ? formatUptime(snap.health.uptime) : "—"
		},
		{
			dot: wsOk ? "ok" : "err",
			label: "WebSocket",
			value: wsOk ? "Connected" : "Disconnected"
		}
	];
	if (snap.health.container_runtime_ok !== void 0 && !snap.restricted) pills.push({
		dot: snap.health.container_runtime_ok ? "ok" : "warn",
		label: "Containers",
		value: snap.health.container_runtime_ok ? "Up" : "Unreachable"
	});
	$("#dash-health").innerHTML = pills.map((p) => `<div class="dash-pill"><span class="pill-dot ${p.dot}"></span><span class="pill-label">${esc(p.label)}</span><span class="pill-value">${esc(p.value)}</span></div>`).join("");
}
function renderMetrics(snap) {
	const el = $("#dash-graph");
	const num = (v) => esc(String(Number(v) || 0));
	const agentsLabel = snap.restricted ? "Visible agents" : "Agents";
	const agentsCard = `<div class="metric-card clickable" data-detail="agents">
    <div class="metric-value">${num(snap.restricted ? snap.agents.visible : snap.agents.total)}</div>
    <div class="metric-label">${esc(agentsLabel)}</div>
  </div>`;
	const sessionsCard = `<div class="metric-card">
    <div class="metric-value">${num(snap.sessions.active)}</div>
    <div class="metric-label">Active sessions</div>
    <div class="metric-sub">${num(snap.sessions.total)} total</div>
  </div>`;
	const messagesCard = `<div class="metric-card clickable" data-detail="messages">
    <div class="metric-value">${num(snap.messages.webchat_24h)}</div>
    <div class="metric-label">Webchat messages (24h)</div>
  </div>`;
	let containersCard;
	if (snap.restricted || snap.active_containers === null) containersCard = `<div class="metric-card">
      <div class="metric-value">—</div>
      <div class="metric-label">Containers</div>
    </div>`;
	else containersCard = `<div class="metric-card clickable" data-detail="containers">
      <div class="metric-value">${num(snap.active_containers)}</div>
      <div class="metric-label">Active containers</div>
    </div>`;
	const topRow = `<div class="metrics-grid">${agentsCard}${sessionsCard}${messagesCard}${containersCard}</div>`;
	let systemCards = "";
	if (snap.system) {
		const memBar = snap.system.memory_used_pct;
		const memColor = memBar > 85 ? "var(--delete-color)" : memBar > 60 ? "#ffd54f" : "var(--accent)";
		const loadStr = snap.system.load_avg.join(" / ");
		const sysCard = `<div class="metric-card wide">
      <div class="metric-label">System</div>
      <div class="sys-row"><span>Memory</span><span>${num(snap.system.memory_used_gb)} / ${num(snap.system.memory_total_gb)} GB (${num(memBar)}%)</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${num(memBar)}%;background:${memColor}"></div></div>
      <div class="sys-row"><span>CPU Load (1/5/15m)</span><span>${esc(loadStr)}</span></div>
      <div class="sys-row"><span>CPUs</span><span>${num(snap.system.cpus)}</span></div>
      <div class="sys-row"><span>Platform</span><span>${esc(snap.system.platform)}</span></div>
    </div>`;
		let ollamaCard;
		if (!snap.ollama) ollamaCard = `<div class="metric-card wide">
        <div class="metric-label">Ollama</div>
        <div class="metric-sub">Not configured</div>
      </div>`;
		else {
			const dot = snap.ollama.ok ? "<span class=\"pill-dot ok\"></span>" : "<span class=\"pill-dot err\"></span>";
			const models = snap.ollama.models && snap.ollama.models.length ? snap.ollama.models.map((m) => `<span class="model-tag">${esc(m)}</span>`).join(" ") : "<span class=\"metric-sub\">No models</span>";
			ollamaCard = `<div class="metric-card wide">
        <div class="metric-label">${dot} Ollama</div>
        <div class="sys-row"><span>Host</span><span>${esc(snap.ollama.host)}</span></div>
        <div class="sys-row"><span>Status</span><span>${snap.ollama.ok ? "Connected" : "Unreachable"}</span></div>
        <div style="margin-top:6px">${models}</div>
      </div>`;
		}
		systemCards = `<div class="metrics-grid two-col">${sysCard}${ollamaCard}</div>`;
	}
	const channelEntries = Object.entries(snap.channels).sort((a, b) => b[1] - a[1]);
	const channelsCard = `<div class="metric-card">
    <div class="metric-label">Channels</div>
    ${channelEntries.length === 0 ? "<div class=\"metric-sub\">No channels wired</div>" : channelEntries.map(([ch, count]) => `<div class="channel-row"><span class="channel-name">${esc(ch)}</span><span class="channel-count">${count}</span></div>`).join("")}
  </div>`;
	let busiestCard;
	if (snap.busiest_rooms !== null) busiestCard = `<div class="metric-card">
      <div class="metric-label">Busiest rooms (24h)</div>
      ${snap.busiest_rooms.length === 0 ? "<div class=\"metric-sub\">No activity</div>" : snap.busiest_rooms.map((r) => `<div class="channel-row"><span class="channel-name">#${esc(r.id)}</span><span class="channel-count">${r.count} msgs</span></div>`).join("")}
    </div>`;
	else busiestCard = "";
	const breakdownRow = busiestCard ? `<div class="metrics-grid two-col">${channelsCard}${busiestCard}</div>` : `<div class="metrics-grid two-col">${channelsCard}</div>`;
	el.innerHTML = topRow + systemCards + breakdownRow;
	const details = {
		agents: showAgentsDetail,
		messages: showMessagesDetail,
		containers: showContainersDetail
	};
	el.querySelectorAll("[data-detail]").forEach((card) => {
		card.addEventListener("click", details[card.dataset.detail]);
	});
}
function showDetail(title, html) {
	$("#dash-detail-title").textContent = title;
	$("#dash-detail-body").innerHTML = html;
	$("#dash-detail").hidden = false;
	$("#dash-detail").scrollIntoView({
		behavior: "smooth",
		block: "nearest"
	});
}
function hideDetail() {
	$("#dash-detail").hidden = true;
}
$("#dash-detail-close").addEventListener("click", hideDetail);
async function showMessagesDetail() {
	const rooms = await authFetch("/api/rooms").then((r) => r.json()).catch(() => []);
	const since = Date.now() - 864e5;
	const all = (await Promise.all(rooms.map((room) => authFetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`).then((r) => r.json()).then((msgs) => msgs.filter((m) => m.created_at > since).map((m) => ({
		...m,
		roomId: room.id
	}))).catch(() => [])))).flat().sort((a, b) => b.created_at - a.created_at).slice(0, 50);
	if (all.length === 0) {
		showDetail("Messages (24h)", "<div class=\"metric-sub\">No messages in the last 24 hours</div>");
		return;
	}
	showDetail("Messages (24h)", `<table class="detail-table">
      <thead><tr><th>Time</th><th>Room</th><th>Sender</th><th>Message</th></tr></thead>
      <tbody>${all.map((m) => {
		const time = new Date(m.created_at).toLocaleTimeString();
		const icon = m.sender_type === "agent" ? lucide$1("bot") : lucide$1("user");
		return `<tr>
      <td>${esc(time)}</td>
      <td style="color:${roomColor(m.roomId)}">#${esc(m.roomId)}</td>
      <td>${icon} ${esc(m.sender)}</td>
      <td class="msg-content">${esc(String(m.content || "").slice(0, 100))}</td>
    </tr>`;
	}).join("")}</tbody>
    </table>`);
}
async function showContainersDetail() {
	showDetail("Active containers", `<div class="metric-sub">Run <code>docker ps --filter name=nanoclaw-</code> on the host to see container details. The number on the card reflects what was running at the moment of the last refresh.</div>`);
}
async function showAgentsDetail() {
	const agents = await authFetch("/api/agents").then((r) => r.json()).catch(() => []);
	if (agents.length === 0) {
		showDetail("Agents", "<div class=\"metric-sub\">No agents</div>");
		return;
	}
	showDetail("Agents", `<table class="detail-table">
      <thead><tr><th>Name</th><th>Folder</th><th>Room</th><th>Created</th></tr></thead>
      <tbody>${[...agents].sort((a, b) => a.name.localeCompare(b.name)).map((b) => {
		const room = b.room_id ? `<code>${esc(b.room_id)}</code>` : "<span class=\"metric-sub\">—</span>";
		return `<tr>
      <td>${esc(b.name)}</td>
      <td><code>${esc(b.folder)}</code></td>
      <td>${room}</td>
      <td><span class="metric-sub">${esc(new Date(b.created_at).toLocaleString())}</span></td>
    </tr>`;
	}).join("")}</tbody>
    </table>`);
}
window.showMessagesDetail = showMessagesDetail;
window.showContainersDetail = showContainersDetail;
window.showAgentsDetail = showAgentsDetail;
var allAgents = [];
var selectedAgentId = null;
var showArchivedAgents = false;
async function fetchAgents() {
	try {
		allAgents = await (await authFetch("/api/agents" + (showArchivedAgents ? "?includeArchived=1" : ""))).json();
		renderAgents();
	} catch (err) {
		console.error("Failed to fetch agents:", err);
	}
}
var AGENT_STATUS_HINTS = {
	active: "Responds normally and appears everywhere.",
	paused: "Wiring is kept, but the agent never responds. Still listed.",
	archived: "Retired: never responds and hidden from lists, pickers, and the map."
};
function renderAgents() {
	const list = $("#agent-list");
	list.innerHTML = "";
	const byName = (a, b) => a.name.localeCompare(b.name);
	const sorted = agentSortAz ? [...allAgents].sort(byName) : [...allAgents].sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || byName(a, b));
	for (const agent of sorted) {
		const li = document.createElement("li");
		li.dataset.agentId = agent.id;
		if (agent.id === selectedAgentId) li.classList.add("active");
		const icon = document.createElement("span");
		icon.className = "agent-icon";
		icon.innerHTML = lucide$1("bot");
		li.appendChild(icon);
		const info = document.createElement("span");
		info.className = "agent-info";
		const nameSpan = document.createElement("span");
		nameSpan.className = "agent-info-name";
		nameSpan.textContent = agent.name;
		info.appendChild(nameSpan);
		const status = agent.status || "active";
		if (status !== "active") {
			const badge = document.createElement("span");
			badge.className = "agent-status-badge status-" + status;
			badge.textContent = status;
			info.appendChild(badge);
		}
		if (agent.provider === "opencode") {
			const hb = document.createElement("span");
			hb.className = "agent-harness-badge";
			hb.textContent = "OpenCode";
			hb.title = "Runs on the OpenCode harness";
			info.appendChild(hb);
		}
		li.appendChild(info);
		li.setAttribute("role", "button");
		li.setAttribute("tabindex", "0");
		li.addEventListener("click", () => {
			if (selectedAgentId === agent.id && !$("#agent-detail").hidden) closeAgentDetail();
			else openAgentDetail(agent.id);
		});
		li.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openAgentDetail(agent.id);
			}
		});
		list.appendChild(li);
	}
	const toggle = $("#agent-show-archived");
	if (toggle) {
		toggle.hidden = false;
		toggle.textContent = showArchivedAgents ? "Hide archived agents" : "Show archived agents";
	}
}
function setAgentEgressControl(egress) {
	const mode = egress || "open";
	const ctl = $("#agent-egress-control");
	if (!ctl) return;
	ctl.querySelectorAll(".setting-option").forEach((b) => {
		b.classList.toggle("active", b.dataset.egress === mode);
	});
	const badge = $("#agent-egress-badge");
	if (badge) badge.textContent = mode === "open" ? "" : mode === "host-only" ? "Locked down" : mode;
	const note = $("#agent-egress-note");
	if (!note) return;
	const cliOnly = mode !== "open" && mode !== "host-only";
	note.hidden = !cliOnly;
	if (cliOnly) note.textContent = `Set to "${mode}" with ncl — not changeable here`;
	ctl.querySelectorAll(".setting-option").forEach((b) => b.disabled = cliOnly);
}
function setAgentStatusControl(status) {
	const s = status || "active";
	document.querySelectorAll("#agent-status-control .setting-option").forEach((b) => {
		b.classList.toggle("active", b.dataset.status === s);
	});
}
function setAgentHarnessControl(provider) {
	const p = provider === "opencode" ? "opencode" : "claude";
	document.querySelectorAll("#agent-harness-control .setting-option").forEach((b) => {
		const on = b.dataset.provider === p;
		b.classList.toggle("active", on);
		b.setAttribute("aria-pressed", String(on));
	});
	const hint = $("#agent-harness-hint");
	if (hint) hint.textContent = p === "opencode" ? "OpenCode — a model-agnostic loop; much cleaner on small local models." : "Claude — the built-in Claude Agent SDK harness (default).";
}
$("#agent-harness-control")?.addEventListener("click", async (e) => {
	const btn = e.target.closest(".setting-option");
	if (!btn || !selectedAgentId) return;
	const provider = btn.dataset.provider;
	const agent = allAgents.find((a) => a.id === selectedAgentId);
	if (!agent || (agent.provider || "claude") === provider) return;
	setAgentHarnessControl(provider);
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/provider`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider })
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
		showToast(`Harness → ${provider === "opencode" ? "OpenCode" : "Claude"} — restarting the agent…`, { kind: "success" });
		await fetchAgents();
	} catch (err) {
		setAgentHarnessControl(agent.provider);
		toastError(err, "Could not change harness");
	}
});
function setAgentSubtab(name) {
	document.querySelectorAll("#agent-edit-view .agent-subtab").forEach((t) => {
		const on = t.dataset.subtab === name;
		t.classList.toggle("active", on);
		t.setAttribute("aria-selected", on ? "true" : "false");
	});
	document.querySelectorAll("#agent-edit-view .agent-subtab-panel").forEach((p) => {
		p.hidden = p.dataset.subtabPanel !== name;
	});
}
document.querySelectorAll("#agent-edit-view .agent-subtab").forEach((tab) => {
	tab.addEventListener("click", () => setAgentSubtab(tab.dataset.subtab));
});
async function openAgentDetail(id) {
	const agent = allAgents.find((b) => b.id === id);
	if (!agent) return;
	selectedAgentId = id;
	renderAgents();
	closeRoomDetail();
	closeModelDetail();
	closeMcpDetail();
	$("#agent-edit-view").hidden = false;
	$("#agent-create-view").hidden = true;
	setAgentSubtab("settings");
	$("#agent-detail-title").textContent = agent.name;
	$("#agent-name").value = agent.name;
	if (allModels.length === 0) await fetchModels();
	populateAgentModelSelect(agent.assigned_model_id);
	$("#agent-config-model").value = agent.config_model || "";
	populateKnownModelOptions();
	setAgentStatusControl(agent.status);
	setAgentHarnessControl(agent.provider);
	setAgentEgressControl(agent.egress);
	renderAgentEnv(id);
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(id)}/instructions`);
		if (res.ok) {
			const { content, legacyBytes } = await res.json();
			$("#agent-instructions").value = content;
			const note = $("#agent-instructions-legacy");
			if (note) {
				const show = !content && legacyBytes > 0;
				note.hidden = !show;
				if (show) note.textContent = `This agent also has a ${Math.round(legacyBytes / 1024)} KB CLAUDE.local.md from before standing instructions moved here. It is not edited on this screen — run /migrate-memory to fold it in.`;
			}
		}
	} catch {}
	await loadAgentRooms(id);
	renderAgentMcp(id);
	renderAgentLearning(id);
	renderAgentSkills(id);
	renderAgentSecrets(id);
	renderAgentKeys(id);
	renderAgentSessions(id);
	captureAgentDetailBaseline();
	$("#agent-detail").hidden = false;
	$("#members-panel").hidden = true;
}
function closeAgentDetail() {
	$("#agent-detail").hidden = true;
	$("#agent-edit-view").hidden = false;
	$("#agent-create-view").hidden = true;
	selectedAgentId = null;
	agentDetailBaseline = null;
	renderAgents();
}
$("#agent-detail-close").addEventListener("click", closeAgentDetail);
$("#agent-create-close").addEventListener("click", closeAgentDetail);
var agentDetailBaseline = null;
function agentDetailSnapshot() {
	return {
		name: $("#agent-name").value.trim(),
		model: $("#agent-model").value || "",
		configModel: $("#agent-config-model").value.trim(),
		instructions: $("#agent-instructions").value
	};
}
var knownModelOptions = null;
async function populateKnownModelOptions() {
	const list = $("#agent-config-model-options");
	if (!list) return;
	if (knownModelOptions === null) try {
		const res = await authFetch("/api/models/known");
		knownModelOptions = res.ok ? (await res.json()).models || [] : [];
	} catch {
		knownModelOptions = [];
	}
	if (list.childElementCount === knownModelOptions.length) return;
	list.textContent = "";
	for (const id of knownModelOptions) {
		const opt = document.createElement("option");
		opt.value = id;
		list.appendChild(opt);
	}
}
function captureAgentDetailBaseline() {
	agentDetailBaseline = agentDetailSnapshot();
	refreshAgentSaveDirty();
}
function refreshAgentSaveDirty() {
	const btn = $("#agent-detail-form button.btn-primary");
	if (!btn || !agentDetailBaseline) return;
	if (btn.classList.contains("success") || btn.textContent === "Saving…") return;
	const now = agentDetailSnapshot();
	btn.disabled = now.name === agentDetailBaseline.name && now.model === agentDetailBaseline.model && now.configModel === agentDetailBaseline.configModel && now.instructions === agentDetailBaseline.instructions;
}
$("#agent-name").addEventListener("input", refreshAgentSaveDirty);
$("#agent-instructions").addEventListener("input", refreshAgentSaveDirty);
$("#agent-config-model").addEventListener("input", refreshAgentSaveDirty);
$("#agent-status-control").addEventListener("click", async (e) => {
	const btn = e.target.closest(".setting-option");
	if (!btn || !selectedAgentId) return;
	const status = btn.dataset.status;
	const agent = allAgents.find((b) => b.id === selectedAgentId);
	if (agent && (agent.status || "active") === status) return;
	setAgentStatusControl(status);
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/status`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status })
		});
		if (!res.ok) throw new Error("status " + res.status);
		if (agent) agent.status = status;
		showToast(`${status[0].toUpperCase()}${status.slice(1)} — ${AGENT_STATUS_HINTS[status] || ""}`);
		renderAgents();
	} catch (err) {
		console.error("Failed to set agent status:", err);
		showToast("Could not change status", { kind: "error" });
		if (agent) setAgentStatusControl(agent.status);
	}
});
$("#agent-egress-control").addEventListener("click", async (e) => {
	const btn = e.target.closest(".setting-option");
	if (!btn || btn.disabled || !selectedAgentId) return;
	const egress = btn.dataset.egress;
	const agent = allAgents.find((b) => b.id === selectedAgentId);
	const current = agent && agent.egress || "open";
	if (current === egress) return;
	if (egress === "host-only") {
		if (!await showConfirmModal({
			title: "Lock down this agent?",
			body: "It will only reach the network through the credential gateway. Anything it does over HTTPS keeps working. Direct connections stop — SSH and rsync, services on your LAN, and a model server running on this host. Applies the next time the agent starts.",
			confirmLabel: "Lock down",
			destructive: true
		})) return;
	}
	setAgentEgressControl(egress);
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/egress`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ egress })
		});
		if (!res.ok) throw new Error("status " + res.status);
		if (agent) agent.egress = egress;
		showToast(egress === "host-only" ? "Locked down — applies when the agent restarts" : "Open network");
	} catch (err) {
		console.error("Failed to set agent egress:", err);
		showToast("Could not change network mode", { kind: "error" });
		setAgentEgressControl(current);
	}
});
$("#agent-show-archived").addEventListener("click", async () => {
	showArchivedAgents = !showArchivedAgents;
	await fetchAgents();
});
var agentDetailRooms = [];
var canManageAgentRooms = false;
async function loadAgentRooms(agentId) {
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/rooms`);
		canManageAgentRooms = res.ok;
		agentDetailRooms = res.ok ? await res.json() : [];
	} catch {
		canManageAgentRooms = false;
		agentDetailRooms = [];
	}
	renderAgentWiredRooms();
	$("#agent-rooms-section").hidden = false;
}
function renderAgentWiredRooms() {
	const list = $("#agent-wired-rooms");
	list.innerHTML = "";
	const roomCount = $("#agent-rooms-count");
	if (roomCount) roomCount.textContent = agentDetailRooms.length ? String(agentDetailRooms.length) : "";
	if (agentDetailRooms.length === 0) {
		const li = document.createElement("li");
		li.className = "empty-note";
		li.textContent = "Not assigned to any room yet.";
		list.appendChild(li);
	}
	for (const room of agentDetailRooms) {
		const li = document.createElement("li");
		const name = document.createElement("span");
		name.className = "room-wired-name room-wired-name-link";
		name.textContent = room.name;
		name.setAttribute("role", "button");
		name.setAttribute("tabindex", "0");
		name.title = `Open ${room.name} settings`;
		const openRoomSettings = () => openRoomDetail(room.id);
		name.addEventListener("click", openRoomSettings);
		name.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openRoomSettings();
			}
		});
		if (room.is_prime) {
			const badge = document.createElement("span");
			badge.className = "room-wired-prime-badge";
			badge.textContent = " default";
			name.appendChild(badge);
		}
		li.appendChild(name);
		if (canManageAgentRooms) {
			const onlyAgent = room.agent_count <= 1;
			const removeBtn = document.createElement("button");
			removeBtn.type = "button";
			removeBtn.className = "room-wired-remove";
			removeBtn.innerHTML = lucide$1("x");
			removeBtn.title = onlyAgent ? "Cannot unassign — this agent is the room's only agent (delete the room instead)" : `Remove this agent from ${room.name}`;
			removeBtn.disabled = onlyAgent;
			removeBtn.addEventListener("click", () => removeRoomFromAgent(room.id, room.name));
			li.appendChild(removeBtn);
		}
		list.appendChild(li);
	}
	$("#agent-add-room-toggle").hidden = !canManageAgentRooms;
}
async function removeRoomFromAgent(roomId, roomName) {
	if (!selectedAgentId) return;
	if (!await showConfirmModal({
		title: "Remove from room",
		body: `Remove this agent from "${roomName}"? The room and its other agents are unaffected.`,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(selectedAgentId)}`, { method: "DELETE" });
		if (!res.ok) {
			showToast("Failed to remove from room: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		showToast(`Removed from "${roomName}".`, { kind: "success" });
		await loadAgentRooms(selectedAgentId);
	} catch (err) {
		showToast("Failed to remove from room: " + err.message, { kind: "error" });
	}
}
$("#agent-add-room-toggle").addEventListener("click", async () => {
	const agentId = selectedAgentId;
	if (!agentId) return;
	let allRooms = [];
	try {
		const res = await authFetch("/api/rooms");
		allRooms = res.ok ? await res.json() : [];
	} catch {}
	openAttachPicker({
		title: "Rooms",
		searchPlaceholder: "Search rooms…",
		emptyText: "No rooms yet.",
		items: () => allRooms,
		searchText: (r) => r.name || r.id,
		name: (r) => r.name || r.id,
		isAttached: (r) => agentDetailRooms.some((x) => x.id === r.id),
		onToggle: async (r, add) => {
			const res = add ? await authFetch(`/api/rooms/${encodeURIComponent(r.id)}/agents`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "existing",
					id: agentId
				})
			}) : await authFetch(`/api/rooms/${encodeURIComponent(r.id)}/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
			showToast(add ? `Wired to ${r.name || r.id}` : `Unwired from ${r.name || r.id}`, { kind: "success" });
			await loadAgentRooms(agentId);
		}
	});
});
var agentMcpServers = [];
async function renderAgentSessions(agentId) {
	const list = $("#agent-sessions-list");
	const countEl = $("#agent-sessions-count");
	if (!list) return;
	list.innerHTML = "<li class=\"agent-session-row muted\">Loading…</li>";
	let sessions = [];
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/sessions`);
		if (!res.ok) throw new Error((await res.json()).error || res.status);
		sessions = (await res.json()).sessions || [];
	} catch (err) {
		list.innerHTML = `<li class="agent-session-row muted">Sessions unavailable: ${esc(err.message)}</li>`;
		if (countEl) countEl.textContent = "";
		return;
	}
	if (countEl) countEl.textContent = sessions.length ? String(sessions.length) : "";
	list.innerHTML = "";
	if (sessions.length === 0) {
		list.innerHTML = "<li class=\"agent-session-row muted\">No active sessions.</li>";
		return;
	}
	for (const s of sessions) {
		const li = document.createElement("li");
		li.className = "agent-session-row";
		const label = s.thread_id ? `thread: ${s.thread_id}` : "main / a2a";
		const when = s.last_active ? new Date(s.last_active).toLocaleString() : "—";
		const meta = document.createElement("div");
		meta.className = "agent-session-meta";
		meta.innerHTML = `<span class="agent-session-label">${esc(label)}</span><span class="agent-session-sub">${esc(s.container_status || "stopped")} · ${esc(when)}</span>`;
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn btn-ghost agent-session-reset";
		btn.textContent = "Reset";
		btn.title = "Reset this session (inject /clear — drops context, next turn starts fresh)";
		btn.addEventListener("click", () => resetAgentSession(agentId, s.id, btn));
		li.appendChild(meta);
		li.appendChild(btn);
		list.appendChild(li);
	}
}
async function resetAgentSession(agentId, sessionId, btn) {
	if (!await showConfirmModal({
		title: "Reset session",
		body: "Inject /clear into this session — it drops the accumulated context and the next turn starts fresh. Useful when a session is stuck or \"autocompact is thrashing\".",
		confirmLabel: "Reset"
	})) return;
	btn.disabled = true;
	btn.textContent = "Resetting…";
	try {
		const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/reset`, { method: "POST" });
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		showToast("Session reset — /clear queued", { kind: "success" });
		renderAgentSessions(agentId);
	} catch (err) {
		showToast("Could not reset: " + err.message, { kind: "error" });
		btn.disabled = false;
		btn.textContent = "Reset";
	}
}
async function renderAgentSkills(agentId) {
	const list = $("#agent-skills-list");
	const saveBtn = $("#agent-skills-save");
	if (!list) return;
	list.innerHTML = "";
	let data = {
		available: [],
		enabled: []
	};
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/skills`);
		if (res.ok) data = await res.json();
	} catch (err) {
		console.error("Failed to load skills:", err);
	}
	const enabled = new Set(data.enabled || []);
	const count = $("#agent-skills-count");
	const scoped = data.scoped || [];
	if (count) count.textContent = enabled.size + scoped.length ? String(enabled.size + scoped.length) : "";
	if (saveBtn) saveBtn.disabled = true;
	renderAgentScopedSkills(agentId, scoped);
	if (!(data.available || []).length) {
		const empty = document.createElement("li");
		empty.className = "agent-mcp-empty";
		empty.textContent = "No skills available in this install";
		list.appendChild(empty);
		return;
	}
	for (const s of data.available) {
		const li = document.createElement("li");
		li.className = "agent-skill-row";
		const info = document.createElement("div");
		info.className = "agent-mcp-info";
		const name = document.createElement("span");
		name.className = "agent-mcp-name";
		name.textContent = s.name;
		const meta = document.createElement("span");
		meta.className = "agent-mcp-meta";
		meta.textContent = s.description || "";
		info.append(name, meta);
		info.style.cursor = "pointer";
		info.setAttribute("role", "button");
		info.setAttribute("tabindex", "0");
		info.title = "View skill details";
		info.addEventListener("click", () => openPoolSkillFromAgent(s.name));
		info.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openPoolSkillFromAgent(s.name);
			}
		});
		const toggle = document.createElement("input");
		toggle.type = "checkbox";
		toggle.className = "agent-skill-toggle";
		toggle.checked = enabled.has(s.name);
		toggle.dataset.skill = s.name;
		toggle.setAttribute("aria-label", `Enable skill ${s.name}`);
		toggle.addEventListener("change", () => {
			if (saveBtn) saveBtn.disabled = false;
		});
		li.append(info, toggle);
		list.appendChild(li);
	}
	if (saveBtn) saveBtn.onclick = () => saveAgentSkills(agentId);
}
function renderAgentScopedSkills(agentId, scoped) {
	const list = $("#agent-scoped-list");
	const addBtn = $("#agent-scoped-add");
	const urlInput = $("#agent-scoped-url");
	if (!list) return;
	list.innerHTML = "";
	if (!scoped.length) {
		const empty = document.createElement("li");
		empty.className = "agent-mcp-empty";
		empty.textContent = "None yet — import one below (this agent only).";
		list.appendChild(empty);
	}
	for (const s of scoped) {
		const li = document.createElement("li");
		li.className = "agent-skill-row";
		const info = document.createElement("div");
		info.className = "agent-mcp-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		const name = document.createElement("span");
		name.className = "agent-mcp-name";
		name.textContent = s.name;
		head.appendChild(name);
		if (s.origin && s.origin.label) head.appendChild(originBadgeEl(s.origin));
		const meta = document.createElement("span");
		meta.className = "agent-mcp-meta";
		meta.textContent = s.description || "";
		info.append(head, meta);
		info.style.cursor = "pointer";
		info.setAttribute("role", "button");
		info.setAttribute("tabindex", "0");
		info.title = "View / edit this skill";
		info.addEventListener("click", () => openScopedSkillEditor(agentId, s.name));
		info.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openScopedSkillEditor(agentId, s.name);
			}
		});
		const del = document.createElement("button");
		del.type = "button";
		del.className = "skill-delete";
		del.textContent = "Remove";
		del.addEventListener("click", () => removeAgentScopedSkill(agentId, s.name, del));
		li.append(info, del);
		list.appendChild(li);
	}
	if (addBtn) addBtn.onclick = () => importAgentScopedSkill(agentId, addBtn, urlInput);
}
async function importAgentScopedSkill(agentId, btn, urlInput) {
	const url = (urlInput?.value || "").trim();
	if (!url) return showToast("Paste a GitHub repo or folder URL", { kind: "error" });
	btn.disabled = true;
	btn.textContent = "Importing…";
	try {
		showToast(`Wired ${(await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/import`, {
			method: "POST",
			body: { url }
		})).name} to this agent — applies on its next turn`, { kind: "success" });
		if (urlInput) urlInput.value = "";
		renderAgentSkills(agentId);
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
	} finally {
		btn.disabled = false;
		btn.textContent = "Import";
	}
}
async function removeAgentScopedSkill(agentId, name, btn, onDone) {
	if (!await showConfirmModal({
		title: `Remove ${name}?`,
		body: "Unwires it from this agent.",
		confirmLabel: "Remove",
		destructive: true
	})) return;
	btn.disabled = true;
	try {
		await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}`, { method: "DELETE" });
		showToast(`Removed ${name}`, { kind: "success" });
		if (onDone) onDone();
		else renderAgentSkills(agentId);
	} catch (err) {
		showToast("Remove failed: " + (err?.message || err), { kind: "error" });
		btn.disabled = false;
	}
}
async function saveAgentSkills(agentId) {
	const saveBtn = $("#agent-skills-save");
	const skills = [...document.querySelectorAll("#agent-skills-list .agent-skill-toggle")].filter((t) => t.checked).map((t) => t.dataset.skill);
	if (saveBtn) saveBtn.disabled = true;
	try {
		showToast((await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills`, {
			method: "PUT",
			body: { skills }
		})).restarted ? "Skills saved — agent restarting" : "Skills saved (applies on next message)", { kind: "success" });
		await renderAgentSkills(agentId);
	} catch (err) {
		showToast("Couldn’t save skills: " + (err?.message || err), { kind: "error" });
		if (saveBtn) saveBtn.disabled = false;
	}
}
/** Confirm modal with one switch option — the modal twin of .setting-toggle
* (DESIGN.md §2b: binary choices are switches, never raw checkboxes). */
async function confirmWithToggle({ title, toggleLabel, note, confirmLabel }) {
	const el = document.createElement("div");
	const lbl = document.createElement("label");
	lbl.className = "setting-toggle";
	const txt = document.createElement("span");
	txt.textContent = toggleLabel;
	const cb = document.createElement("input");
	cb.type = "checkbox";
	lbl.append(txt, cb);
	el.appendChild(lbl);
	if (note) {
		const n = document.createElement("div");
		n.className = "import-note";
		n.textContent = note;
		el.appendChild(n);
	}
	return {
		ok: await showConfirmModal({
			title,
			body: el,
			confirmLabel
		}),
		checked: cb.checked
	};
}
$("#agent-export-btn")?.addEventListener("click", async () => {
	if (!selectedAgentId) return;
	const { ok, checked } = await confirmWithToggle({
		title: "Export this agent?",
		toggleLabel: "Include conversations (larger; briefly stops this agent)",
		note: "Credentials never export — the bundle lists what to reconnect on import.",
		confirmLabel: "Export"
	});
	if (!ok) return;
	const a = document.createElement("a");
	a.href = `/api/agents/${encodeURIComponent(selectedAgentId)}/export${checked ? "?conversations=1" : ""}`;
	a.download = "";
	document.body.appendChild(a);
	a.click();
	a.remove();
	showToast("Export started — check your downloads", { kind: "success" });
});
$("#room-export-btn")?.addEventListener("click", () => {
	const roomId = selectedRoomId || currentRoom;
	if (!roomId) return;
	const a = document.createElement("a");
	a.href = `/api/rooms/${encodeURIComponent(roomId)}/export`;
	a.download = "";
	document.body.appendChild(a);
	a.click();
	a.remove();
	showToast("Room export started", { kind: "success" });
});
$("#import-any-btn")?.addEventListener("click", () => {
	const el = document.createElement("div");
	el.className = "import-note";
	el.textContent = "Pick a .tgz exported from NanoClaw — an agent bundle or a room bundle.";
	showConfirmModal({
		title: "Import from bundle",
		body: el,
		confirmLabel: "Choose file…"
	}).then((ok) => {
		if (ok) $("#import-any-file")?.click();
	});
});
$("#import-any-file")?.addEventListener("change", async (e) => {
	const file = e.target.files?.[0];
	e.target.value = "";
	if (!file) return;
	const tryUpload = async (endpoint) => {
		const fd = new FormData();
		fd.append("bundle", file);
		const res = await authFetch(endpoint, {
			method: "POST",
			body: fd
		});
		const body = await res.json().catch(() => ({}));
		return {
			ok: res.ok,
			body
		};
	};
	showToast("Uploading bundle…", { kind: "info" });
	let kind = "room";
	let up = await tryUpload("/api/rooms/import");
	if (!up.ok && /room export/i.test(up.body.error || "")) {
		kind = "agent";
		up = await tryUpload("/api/agents/import");
	}
	if (!up.ok) {
		showToast("Import failed: " + (up.body.error || "unrecognized bundle"), { kind: "error" });
		return;
	}
	if (kind === "room") return continueRoomImport(up.body);
	return continueAgentImport(up.body);
});
$("#import-room-file")?.addEventListener("change", async (e) => {
	const file = e.target.files?.[0];
	e.target.value = "";
	if (!file) return;
	showToast("Uploading room bundle…", { kind: "info" });
	let up;
	try {
		const fd = new FormData();
		fd.append("bundle", file);
		const res = await authFetch("/api/rooms/import", {
			method: "POST",
			body: fd
		});
		up = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(up.error || res.statusText);
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
		return;
	}
	return continueRoomImport(up);
});
async function continueRoomImport(up) {
	const p = up.preview;
	const el = document.createElement("div");
	const line = (t, cls) => {
		const d = document.createElement("div");
		if (cls) d.className = cls;
		d.textContent = t;
		el.appendChild(d);
	};
	line(`${p.manifest.entity.name} → imports as #${p.suggestedRoomId}`);
	line(`${p.manifest.counts.messages} messages · ${p.manifest.counts.threads} threads · ${p.manifest.counts.files} files`);
	const found = p.agents.filter((a) => a.found).map((a) => a.name);
	const missing = p.agents.filter((a) => !a.found).map((a) => a.name);
	if (found.length) line(`Re-wires agents: ${found.join(", ")}`);
	if (missing.length) line(`⚠ Agents not on this install (wiring skipped): ${missing.join(", ")}`, "import-warning");
	if (!await showConfirmModal({
		title: "Import this room?",
		body: el,
		confirmLabel: "Import"
	})) return;
	try {
		const out = await apiJson("/api/rooms/import/apply", {
			method: "POST",
			body: { token: up.token }
		});
		showToast(`Imported #${out.roomId} — ${out.messages} messages`, { kind: "success" });
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
	}
}
$("#system-export-btn")?.addEventListener("click", async () => {
	const { ok, checked } = await confirmWithToggle({
		title: "Download system backup?",
		toggleLabel: "Lean (skip conversation history — much smaller)",
		note: "Secrets and host identity never travel; a restored install keeps its own credentials.",
		confirmLabel: "Download"
	});
	if (!ok) return;
	const a = document.createElement("a");
	a.href = `/api/system/export${checked ? "?lean=1" : ""}`;
	a.download = "";
	document.body.appendChild(a);
	a.click();
	a.remove();
	showToast("Backup started — this can take a while for large installs", { kind: "success" });
});
$("#system-import-btn")?.addEventListener("click", () => $("#system-import-file")?.click());
$("#system-import-file")?.addEventListener("change", async (e) => {
	const file = e.target.files?.[0];
	e.target.value = "";
	if (!file) return;
	showToast("Uploading backup…", { kind: "info" });
	let up;
	try {
		const fd = new FormData();
		fd.append("bundle", file);
		const res = await authFetch("/api/system/import", {
			method: "POST",
			body: fd
		});
		up = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(up.error || res.statusText);
	} catch (err) {
		showToast("Restore failed: " + (err?.message || err), { kind: "error" });
		return;
	}
	const m = up.preview.manifest;
	const el = document.createElement("div");
	const line = (t, cls) => {
		const d = document.createElement("div");
		if (cls) d.className = cls;
		d.textContent = t;
		el.appendChild(d);
	};
	line(`Backup from ${new Date(m.createdAt).toLocaleString()}${m.lean ? " (lean — no conversations)" : ""}`);
	line(`${m.counts.agents} agents · ${m.counts.rooms} rooms · ${m.counts.models} models · ${m.counts.mcpServers} MCP servers`);
	line("⚠ REPLACES everything on this install. Current state is kept aside as *.pre-restore-* for manual rollback.", "import-warning");
	line("The host restarts to finish the restore — the app will reconnect.", "import-note");
	if (!await showConfirmModal({
		title: "Restore this backup?",
		body: el,
		confirmLabel: "Restore and restart",
		destructive: true
	})) return;
	try {
		await apiJson("/api/system/import/apply", {
			method: "POST",
			body: { token: up.token }
		});
		showToast("Restoring — the host is restarting…", { kind: "info" });
	} catch (err) {
		showToast("Restore failed: " + (err?.message || err), { kind: "error" });
	}
});
$("#import-agent-btn")?.addEventListener("click", () => $("#import-agent-file")?.click());
$("#import-agent-file")?.addEventListener("change", async (e) => {
	const file = e.target.files?.[0];
	e.target.value = "";
	if (!file) return;
	showToast("Uploading bundle…", { kind: "info" });
	let up;
	try {
		const fd = new FormData();
		fd.append("bundle", file);
		const res = await authFetch("/api/agents/import", {
			method: "POST",
			body: fd
		});
		up = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(up.error || res.statusText);
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
		return;
	}
	return continueAgentImport(up);
});
async function continueAgentImport(up) {
	const p = up.preview;
	const el = document.createElement("div");
	const line = (t, cls) => {
		const d = document.createElement("div");
		if (cls) d.className = cls;
		d.textContent = t;
		el.appendChild(d);
	};
	line(`${p.manifest.entity.name} → imports as “${p.suggestedName}” (${p.suggestedFolder})`);
	line(p.manifest.includesConversations ? "Includes conversation history" : "Config, memory and skills only");
	const roomsOk = p.rooms.filter((r) => r.found).map((r) => r.platform_id);
	const roomsMiss = p.rooms.filter((r) => !r.found).map((r) => r.platform_id);
	if (roomsOk.length) line(`Re-links rooms: ${roomsOk.join(", ")}`);
	if (roomsMiss.length) line(`⚠ Rooms not on this install (skipped): ${roomsMiss.join(", ")}`, "import-warning");
	const mcpMiss = p.mcpServers.filter((m) => !m.found).map((m) => m.name);
	if (mcpMiss.length) line(`⚠ MCP servers to recreate: ${mcpMiss.join(", ")}`, "import-warning");
	if (!p.modelFound && p.manifest.references.model) line(`⚠ Model not found here: ${p.manifest.references.model.model_id}`, "import-warning");
	for (const c of p.manifest.requiredCredentials) line(`⚠ Needs: ${c}`, "import-warning");
	if (!await showConfirmModal({
		title: "Import this agent?",
		body: el,
		confirmLabel: "Import"
	})) return;
	try {
		showToast(`Imported ${(await apiJson("/api/agents/import/apply", {
			method: "POST",
			body: { token: up.token }
		})).name}`, { kind: "success" });
		await fetchAgents();
		renderAgents();
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
	}
}
async function renderAgentLearning(agentId) {
	const section = $("#agent-learning-section");
	const accordion = section?.closest("details");
	if (!section) return;
	if (!learningMasterEnabled) {
		if (accordion) accordion.hidden = true;
		return;
	}
	let cfg = null;
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/learning`);
		if (res.ok) cfg = await res.json();
	} catch {}
	if (!cfg) {
		if (accordion) accordion.hidden = true;
		return;
	}
	if (accordion) accordion.hidden = false;
	$("#agent-learning-keep-row").hidden = !cfg.canAutoKeep;
	const paint = (groupEl, on) => {
		groupEl.querySelectorAll(".setting-option").forEach((b) => {
			b.classList.toggle("active", b.dataset.on === "1" === on);
		});
	};
	paint($("#agent-learning-distill"), cfg.autoTrigger);
	paint($("#agent-learning-keep"), cfg.autoKeep);
	const wire = (groupEl, key) => {
		groupEl.querySelectorAll(".setting-option").forEach((b) => {
			b.onclick = async () => {
				const on = b.dataset.on === "1";
				try {
					const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/learning`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ [key]: on })
					});
					if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
					paint(groupEl, on);
					showToast("Learning defaults saved");
				} catch (err) {
					toastError(err, "Could not save");
				}
			};
		});
	};
	wire($("#agent-learning-distill"), "autoTrigger");
	wire($("#agent-learning-keep"), "autoKeep");
	const put = async (patch) => {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/learning`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch)
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
	};
	const reviewSel = $("#agent-learning-review-model");
	if (reviewSel) {
		reviewSel.innerHTML = "";
		const addOpt = (value, label) => {
			const opt = document.createElement("option");
			opt.value = value;
			opt.textContent = label;
			reviewSel.appendChild(opt);
		};
		addOpt("", "Agent's model");
		try {
			const models = await (await authFetch("/api/models")).json();
			for (const m of models) addOpt(m.id, `${m.name} (${m.model_id})`);
		} catch {}
		for (const id of ["claude-haiku-4-5", "claude-sonnet-5"]) if (![...reviewSel.options].some((o) => o.value === id)) addOpt(id, id);
		let stored = cfg.reviewModel || "";
		if (stored && ![...reviewSel.options].some((o) => o.value === stored)) addOpt(stored, stored);
		reviewSel.value = stored;
		reviewSel.onchange = async () => {
			try {
				await put({ reviewModel: reviewSel.value || null });
				stored = reviewSel.value;
				showToast("Learning defaults saved");
			} catch (err) {
				toastError(err, "Could not save");
				reviewSel.value = stored;
			}
		};
	}
	const inputGroup = $("#agent-learning-review-input");
	if (inputGroup) {
		const paintInput = (replay) => {
			inputGroup.querySelectorAll(".setting-option").forEach((b) => {
				b.classList.toggle("active", b.dataset.value === (replay ? "replay" : "digest"));
			});
		};
		paintInput(cfg.replayReview === true);
		inputGroup.querySelectorAll(".setting-option").forEach((b) => {
			b.onclick = async () => {
				const replay = b.dataset.value === "replay";
				try {
					await put({ replayReview: replay });
					paintInput(replay);
					showToast("Learning defaults saved");
				} catch (err) {
					toastError(err, "Could not save");
				}
			};
		});
	}
}
async function renderAgentMcp(agentId) {
	const list = $("#agent-mcp-list");
	list.innerHTML = "";
	agentMcpServers = [];
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`);
		if (res.ok) agentMcpServers = (await res.json()).servers || [];
	} catch (err) {
		console.error("Failed to load MCP servers:", err);
	}
	const mcpCount = $("#agent-mcp-count");
	if (mcpCount) mcpCount.textContent = agentMcpServers.length ? String(agentMcpServers.length) : "";
	if (agentMcpServers.length === 0) return;
	for (const s of agentMcpServers) {
		const li = document.createElement("li");
		li.className = "agent-mcp-row";
		const info = document.createElement("div");
		info.className = "agent-mcp-info";
		const name = document.createElement("span");
		name.className = "agent-mcp-name";
		name.textContent = s.name;
		const meta = document.createElement("span");
		meta.className = "agent-mcp-meta";
		meta.textContent = `${s.transport} · ${s.target}`;
		info.append(name, meta);
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "agent-mcp-remove";
		remove.setAttribute("aria-label", `Detach ${s.name}`);
		remove.innerHTML = lucide$1("x");
		remove.addEventListener("click", () => detachAgentMcp(agentId, s));
		li.append(info, remove);
		list.appendChild(li);
	}
}
async function setAgentMcp(agentId, body, okMsg) {
	await apiJson(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`, {
		method: "PUT",
		body
	});
	showToast(okMsg, { kind: "success" });
	await renderAgentMcp(agentId);
}
async function detachAgentMcp(agentId, server) {
	if (!await showConfirmModal({
		title: `Detach ${server.name}?`,
		body: "The agent loses these tools on its next message.",
		confirmLabel: "Detach",
		destructive: true
	})) return;
	try {
		await setAgentMcp(agentId, { remove: [server.id] }, `Detached ${server.name}`);
	} catch (err) {
		showToast("Detach failed: " + (err.message || err), { kind: "error" });
	}
}
var attachPickerCfg = null;
function openAttachPicker(cfg) {
	attachPickerCfg = cfg;
	$("#attach-picker-title").textContent = cfg.title;
	const search = $("#attach-picker-search");
	search.value = "";
	search.placeholder = cfg.searchPlaceholder || "Search…";
	const addBtn = $("#attach-picker-add-new");
	addBtn.hidden = !cfg.onAddNew;
	addBtn.textContent = cfg.addNewLabel || "+ Add new";
	renderAttachPickerList("");
	const picker = $("#attach-picker");
	picker.hidden = false;
	picker.offsetHeight;
	picker.classList.add("open");
	if (window.matchMedia("(min-width: 720px)").matches) setTimeout(() => search.focus(), 60);
}
function closeAttachPicker() {
	const picker = $("#attach-picker");
	picker.classList.remove("open");
	setTimeout(() => {
		picker.hidden = true;
	}, 220);
}
function renderAttachPickerList(filterText) {
	const cfg = attachPickerCfg;
	const list = $("#attach-picker-list");
	list.innerHTML = "";
	if (!cfg) return;
	const q = (filterText || "").trim().toLowerCase();
	const items = cfg.items().filter((it) => !q || cfg.searchText(it).toLowerCase().includes(q));
	if (items.length === 0) {
		const empty = document.createElement("li");
		empty.className = "model-picker-empty";
		empty.textContent = q ? `No matches for "${filterText}".` : cfg.emptyText || "Nothing to show.";
		list.appendChild(empty);
		return;
	}
	for (const it of items) {
		const attached = cfg.isAttached(it);
		const li = document.createElement("li");
		li.className = "model-picker-row attach-picker-row" + (attached ? " selected" : "");
		li.tabIndex = 0;
		const top = document.createElement("div");
		top.className = "model-picker-row-top";
		const name = document.createElement("span");
		name.className = "model-picker-row-name";
		name.textContent = cfg.name(it);
		const toggle = document.createElement("span");
		toggle.className = "attach-picker-toggle";
		toggle.textContent = attached ? "−" : "+";
		top.append(name, toggle);
		li.appendChild(top);
		const meta = cfg.meta ? cfg.meta(it) : "";
		if (meta) {
			const sub = document.createElement("div");
			sub.className = "model-picker-row-sub";
			sub.textContent = meta;
			li.appendChild(sub);
		}
		const act = async () => {
			li.style.pointerEvents = "none";
			try {
				await cfg.onToggle(it, !attached);
			} catch (err) {
				showToast("Failed: " + (err.message || err), { kind: "error" });
			}
			renderAttachPickerList($("#attach-picker-search").value);
		};
		li.addEventListener("click", act);
		li.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				act();
			}
		});
		list.appendChild(li);
	}
}
$("#attach-picker-close").addEventListener("click", closeAttachPicker);
$("#attach-picker .model-picker-backdrop").addEventListener("click", closeAttachPicker);
$("#attach-picker-search").addEventListener("input", (e) => renderAttachPickerList(e.target.value));
$("#attach-picker-add-new").addEventListener("click", () => attachPickerCfg?.onAddNew?.());
$("#agent-mcp-attach-toggle").addEventListener("click", async () => {
	const agentId = selectedAgentId;
	if (!agentId) return;
	await fetchMcpServers();
	openAttachPicker({
		title: "MCP servers",
		searchPlaceholder: "Search servers…",
		emptyText: "No servers yet — use “+ Add new server”.",
		addNewLabel: "+ Add new server",
		items: () => allMcpServers,
		searchText: (s) => `${s.name} ${s.transport} ${s.target}`,
		name: (s) => s.name,
		meta: (s) => `${s.transport} · ${s.target}`,
		isAttached: (s) => agentMcpServers.some((a) => a.id === s.id),
		onToggle: (s, add) => setAgentMcp(agentId, add ? { add: [s.id] } : { remove: [s.id] }, add ? `Attached ${s.name}` : `Detached ${s.name}`),
		onAddNew: () => {
			mcpAddInProgress = true;
			mcpAgentForAdd = agentId;
			closeAttachPicker();
			setTimeout(() => $("#create-mcp-btn").click(), 180);
		}
	});
});
var mcpAddInProgress = false;
var mcpAgentForAdd = null;
async function maybeAttachAfterMcpAdd(newId, name) {
	if (!mcpAddInProgress) return;
	const agentId = mcpAgentForAdd;
	mcpAddInProgress = false;
	mcpAgentForAdd = null;
	if (!agentId || !newId) return;
	try {
		await setAgentMcp(agentId, { add: [newId] }, `Attached ${name}`);
	} catch (err) {
		showToast("Attach failed: " + (err.message || err), { kind: "error" });
	}
	await openAgentDetail(agentId);
}
$("#agent-detail-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	if (!selectedAgentId) return;
	const btn = $("#agent-detail-form button.btn-primary");
	const originalLabel = btn.textContent;
	btn.disabled = true;
	btn.textContent = "Saving…";
	btn.classList.remove("success");
	const updates = { name: $("#agent-name").value.trim() };
	try {
		await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(updates)
		});
		await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/instructions`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: $("#agent-instructions").value })
		});
		const selectedModel = $("#agent-model").value || null;
		if (selectedModel !== (allAgents.find((b) => b.id === selectedAgentId)?.assigned_model_id || null)) {
			const mRes = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/model`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: selectedModel })
			});
			try {
				if (mRes.ok) warnIfUnreachable((await mRes.json()).reachability);
			} catch {}
		}
		const configModel = $("#agent-config-model").value.trim();
		const currentConfigModel = allAgents.find((b) => b.id === selectedAgentId)?.config_model || "";
		if (configModel !== currentConfigModel) {
			const cRes = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/config-model`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: configModel })
			});
			if (!cRes.ok) {
				let detail = `HTTP ${cRes.status}`;
				try {
					detail = (await cRes.json()).error || detail;
				} catch {}
				$("#agent-config-model").value = currentConfigModel;
				throw new Error(detail);
			}
		}
		await fetchAgents();
		agentDetailBaseline = agentDetailSnapshot();
		btn.textContent = "✓ Saved";
		btn.classList.add("success");
		setTimeout(() => {
			if (btn.isConnected) {
				btn.textContent = originalLabel;
				btn.classList.remove("success");
				refreshAgentSaveDirty();
			}
		}, 1500);
	} catch (err) {
		console.error("Failed to update agent:", err);
		showToast("Failed to save agent: " + (err.message || "Unknown error"), { kind: "error" });
		btn.textContent = originalLabel;
		btn.classList.remove("success");
		btn.disabled = false;
	}
});
$("#agent-delete").addEventListener("click", async () => {
	if (!selectedAgentId) return;
	const agent = allAgents.find((b) => b.id === selectedAgentId);
	if (!await showConfirmModal({
		title: "Delete agent",
		body: `Delete "${agent?.name}"? This removes the agent, its workspace, and all session history. This cannot be undone.`,
		confirmLabel: "Delete",
		destructive: true
	})) return;
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}`, { method: "DELETE" });
		if (!res.ok) {
			showToast(`Failed to delete agent: ${(await res.json().catch(() => ({}))).error || res.statusText}`, { kind: "error" });
			return;
		}
		showToast(`Deleted "${agent?.name}".`, { kind: "success" });
		closeAgentDetail();
		await fetchAgents();
	} catch (err) {
		showToast(`Failed to delete agent: ${err.message}`, { kind: "error" });
	}
});
$("#create-agent-btn").addEventListener("click", () => {
	selectedAgentId = null;
	renderAgents();
	$("#agent-edit-view").hidden = true;
	$("#agent-create-view").hidden = false;
	$("#agent-create-name").value = "";
	$("#agent-detail").hidden = false;
	$("#members-panel").hidden = true;
	$("#agent-create-name").focus();
});
var suggestTimer = null;
var suggestSeq = 0;
function scheduleSkillSuggest() {
	clearTimeout(suggestTimer);
	suggestTimer = setTimeout(refreshSkillSuggestions, 700);
}
async function refreshSkillSuggestions() {
	const text = [
		$("#agent-create-draft-prompt").value,
		$("#agent-create-name").value,
		$("#agent-create-instructions").value
	].join(" ").trim();
	const block = $("#agent-create-skills");
	if (text.length < 12) {
		block.hidden = true;
		return;
	}
	const seq = ++suggestSeq;
	let suggestions = [];
	try {
		const res = await authFetch(`/api/skills/suggest?text=${encodeURIComponent(text.slice(0, 2e3))}`);
		if (res.ok) suggestions = (await res.json()).suggestions || [];
	} catch {}
	if (seq !== suggestSeq) return;
	const list = $("#agent-create-skills-list");
	list.innerHTML = "";
	if (!suggestions.length) {
		block.hidden = true;
		return;
	}
	for (const s of suggestions) {
		const li = document.createElement("li");
		li.className = "agent-create-skill-row";
		const info = document.createElement("div");
		info.className = "skill-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		const name = document.createElement("span");
		name.className = "skill-name";
		name.textContent = s.name;
		head.appendChild(name);
		const desc = document.createElement("span");
		desc.className = "skill-desc";
		desc.textContent = s.description || "";
		info.append(head, desc);
		li.appendChild(info);
		if (s.source === "installed") {
			const got = document.createElement("span");
			got.className = "skill-badge";
			got.textContent = "available";
			li.appendChild(got);
		} else {
			const check = document.createElement("input");
			check.type = "checkbox";
			check.className = "agent-create-skill-check";
			check.dataset.url = s.url;
			check.dataset.name = s.name;
			check.setAttribute("aria-label", `Add skill ${s.name} (${s.source})`);
			li.appendChild(check);
		}
		list.appendChild(li);
	}
	block.hidden = false;
}
for (const sel of [
	"#agent-create-draft-prompt",
	"#agent-create-name",
	"#agent-create-instructions"
]) $(sel)?.addEventListener("input", scheduleSkillSuggest);
$("#agent-create-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = $("#agent-create-name").value.trim();
	if (!name) return;
	const instructions = $("#agent-create-instructions").value;
	try {
		const res = await authFetch("/api/agents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name,
				instructions: instructions || void 0
			})
		});
		if (!res.ok) {
			showToast("Failed to create agent: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		const checked = [...document.querySelectorAll("#agent-create-skills-list .agent-create-skill-check:checked")];
		if (checked.length) showToast(`Adding ${checked.length} suggested skill(s)…`, { kind: "info" });
		for (const c of checked) try {
			await apiJson("/api/skills/import", {
				method: "POST",
				body: { url: c.dataset.url }
			});
			showToast(`Added skill ${c.dataset.name}`, { kind: "success" });
		} catch (err) {
			showToast(`Skill ${c.dataset.name} failed: ` + (err?.message || err), { kind: "error" });
		}
		$("#agent-create-skills").hidden = true;
		$("#agent-create-skills-list").innerHTML = "";
		await fetchAgents();
		closeAgentDetail();
	} catch (err) {
		showToast("Failed to create agent: " + err.message, { kind: "error" });
	}
});
var DRAFTER_TARGETS = {
	"agent-create": {
		prompt: "#agent-create-draft-prompt",
		name: "#agent-create-name",
		instructions: "#agent-create-instructions"
	},
	"room-create": {
		prompt: "#room-create-draft-prompt",
		name: "#room-create-new-name",
		instructions: "#room-create-new-instructions"
	},
	"room-add-agent": {
		prompt: "#room-add-agent-draft-prompt",
		name: "#room-add-agent-new-name",
		instructions: "#room-add-agent-new-instructions"
	}
};
document.querySelectorAll(".drafter-btn").forEach((btn) => {
	btn.addEventListener("click", () => draftFor(btn));
});
async function draftFor(btn) {
	const target = DRAFTER_TARGETS[btn.dataset.drafterTarget];
	if (!target) return;
	const promptEl = $(target.prompt);
	const nameEl = $(target.name);
	const instructionsEl = $(target.instructions);
	const prompt = (promptEl?.value || "").trim();
	if (!prompt) {
		showToast("Type a description first, e.g. \"An agent that helps me draft replies to emails\".", { kind: "error" });
		return;
	}
	const original = btn.innerHTML;
	btn.disabled = true;
	btn.innerHTML = "<span class=\"btn-spinner\" aria-hidden=\"true\"></span> Drafting…";
	try {
		const res = await authFetch("/api/agents/draft", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt })
		});
		const body = await res.json().catch(() => ({}));
		if (!res.ok) {
			showToast("Drafter failed: " + (body.error || res.statusText), { kind: "error" });
			return;
		}
		if (nameEl) nameEl.value = body.name || "";
		if (instructionsEl) instructionsEl.value = body.instructions || "";
		nameEl?.focus();
		nameEl?.select();
	} catch (err) {
		showToast("Drafter failed: " + err.message, { kind: "error" });
	} finally {
		btn.disabled = false;
		btn.innerHTML = original;
	}
}
var selectedRoomId = null;
var roomDetailWiredAgents = [];
function showRoomSettingsToggle(visible) {
	$("#room-name").classList.toggle("has-settings", visible);
}
async function openRoomDetail(roomId) {
	selectedRoomId = roomId;
	closeAgentDetail();
	closeMcpDetail();
	$("#room-create-view").hidden = true;
	$("#room-edit-view").hidden = false;
	const room = lastRoomsList.find((r) => r.id === roomId);
	$("#room-detail-title").textContent = room ? `${room.name} — settings` : "Room settings";
	const renameField = $("#room-rename-field");
	if (isOwnerView && room) {
		renameField.hidden = false;
		$("#room-rename-input").value = room.name || "";
	} else renameField.hidden = true;
	const archiveBtn = $("#room-archive-toggle");
	if (room && room.canArchive) {
		archiveBtn.hidden = false;
		archiveBtn.textContent = room.archived ? "Unarchive room" : "Archive room";
	} else archiveBtn.hidden = true;
	await refreshRoomWiredAgents(roomId);
	const credSection = $("#room-credential-mode-section");
	if (credSection) {
		if (room && room.canArchive) {
			credSection.hidden = false;
			document.querySelectorAll("#room-credential-modes .setting-option").forEach((b) => b.classList.remove("active"));
			const hintEl = $("#room-cred-default-hint");
			if (hintEl) hintEl.textContent = "";
			authFetch(`/api/rooms/${encodeURIComponent(roomId)}/credential-mode`).then((r) => r.ok ? r.json() : null).then((d) => {
				if (!d) {
					if (hintEl) hintEl.textContent = "(couldn’t load — try reopening)";
					return;
				}
				const effective = d.mode === "inherit" ? d.defaultMode : d.mode;
				document.querySelectorAll("#room-credential-modes .setting-option").forEach((b) => b.classList.toggle("active", b.dataset.value === effective));
				if (hintEl) hintEl.textContent = "";
			}).catch(() => {
				if (hintEl) hintEl.textContent = "(couldn’t load — try reopening)";
			});
		} else credSection.hidden = true;
	}
	$("#room-detail").hidden = false;
	$("#members-panel").hidden = true;
	$("#agent-detail").hidden = true;
}
function closeRoomDetail() {
	$("#room-detail").hidden = true;
	$("#room-edit-view").hidden = false;
	$("#room-create-view").hidden = true;
	selectedRoomId = null;
}
async function saveRoomName() {
	const id = selectedRoomId;
	if (!id) return;
	const name = $("#room-rename-input").value.trim();
	if (!name) {
		showToast("Enter a room name", { kind: "error" });
		return;
	}
	try {
		await apiJson(`/api/rooms/${encodeURIComponent(id)}/name`, {
			method: "PUT",
			body: { name }
		});
		showToast("Room renamed", { kind: "success" });
	} catch (err) {
		showToast("Rename failed: " + (err.message || err), { kind: "error" });
	}
}
var roomDetailEngageMode = "mention-only";
async function refreshRoomWiredAgents(roomId) {
	try {
		const [agentsRes, modeRes] = await Promise.all([authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`), authFetch(`/api/rooms/${encodeURIComponent(roomId)}/engage-mode`)]);
		roomDetailWiredAgents = await agentsRes.json();
		await modeRes.json().catch(() => ({}));
		roomDetailEngageMode = "mention-only";
	} catch (err) {
		console.error("Failed to fetch wired agents:", err);
		roomDetailWiredAgents = [];
		roomDetailEngageMode = "mention-only";
	}
	renderRoomWiredAgents();
	await populateAddAgentSelect();
	renderRoomSkills();
}
/**
* Learning loop, room-level view: what this room's agents have proposed and what
* they've learned — in the room, rather than buried in the global Skills page.
* Pending proposals first (they need a decision); learned skills below, removable.
* Purely a view over existing endpoints — no new backend.
*/
async function renderRoomSkills() {
	const section = $("#room-skills-section");
	const list = $("#room-skills-list");
	const count = $("#room-skills-count");
	if (!section || !list) return;
	const agents = roomDetailWiredAgents.slice();
	if (agents.length === 0) {
		section.hidden = true;
		return;
	}
	const ids = new Set(agents.map((a) => a.id));
	const nameOf = (id) => agents.find((a) => a.id === id)?.name || "agent";
	let drafts = [];
	let learned = [];
	let archived = [];
	try {
		const [draftRes, ...skillRes] = await Promise.all([authFetch("/api/skill-drafts"), ...agents.map((a) => authFetch(`/api/agents/${encodeURIComponent(a.id)}/skills`))]);
		drafts = ((await draftRes.json()).drafts || []).filter((d) => ids.has(d.agentGroupId));
		(await Promise.all(skillRes.map((r) => r.json().catch(() => ({}))))).forEach((payload, i) => {
			for (const s of payload.scoped || []) learned.push({
				...s,
				agentId: agents[i].id
			});
			for (const s of payload.archived || []) archived.push({
				...s,
				agentId: agents[i].id
			});
		});
	} catch (err) {
		console.error("Failed to load room skills:", err);
		section.hidden = true;
		return;
	}
	section.hidden = false;
	count.textContent = drafts.length + learned.length ? String(drafts.length + learned.length) : "";
	list.innerHTML = "";
	renderDistillButton(agents);
	if (drafts.length === 0 && learned.length === 0 && archived.length === 0) return;
	for (const d of drafts) {
		const li = document.createElement("li");
		li.className = "room-skill-row proposed";
		const head = document.createElement("div");
		head.className = "room-skill-head";
		const name = document.createElement("span");
		name.className = "room-skill-name";
		name.textContent = d.kind === "patch" ? `Change to ${d.targetSkill || d.skillName}` : d.skillName;
		head.append(name, originBadgeEl({
			label: `proposed · ${d.agentName || nameOf(d.agentGroupId)}`,
			official: false
		}));
		const desc = document.createElement("div");
		desc.className = "room-skill-desc";
		desc.textContent = d.description || "";
		const actions = document.createElement("div");
		actions.className = "room-skill-actions";
		const view = document.createElement("button");
		view.type = "button";
		view.className = "btn btn-ghost";
		view.textContent = "View";
		view.addEventListener("click", () => openSkillDraft(d.id));
		const keep = document.createElement("button");
		keep.type = "button";
		keep.className = "btn btn-primary";
		keep.textContent = "Keep";
		keep.title = `Wire to ${d.agentName || nameOf(d.agentGroupId)}`;
		keep.dataset.draftId = d.id;
		if (reviewingDrafts.has(d.id)) markDraftReviewing(keep, true);
		keep.addEventListener("click", () => armUndo(actions, `Keeping ${d.skillName}…`, UNDO_SECONDS, async (restore) => {
			restore();
			await keepSkillDraft({
				id: d.id,
				agentGroupId: d.agentGroupId,
				agentName: d.agentName
			}, keep);
			renderRoomSkills();
		}));
		const drop = document.createElement("button");
		drop.type = "button";
		drop.className = "skill-delete";
		drop.textContent = "Discard";
		drop.addEventListener("click", () => armUndo(actions, `Discarding ${d.skillName}…`, UNDO_SECONDS, async () => {
			await discardSkillDraft(d.id);
			renderRoomSkills();
		}));
		actions.append(view, keep, drop);
		li.append(head, desc, actions);
		list.appendChild(li);
	}
	for (const s of learned) {
		const li = document.createElement("li");
		li.className = "room-skill-row";
		const head = document.createElement("div");
		head.className = "room-skill-head";
		const name = document.createElement("span");
		name.className = "room-skill-name";
		name.textContent = s.name;
		head.appendChild(name);
		if (s.origin) head.appendChild(originBadgeEl(s.origin));
		if (agents.length > 1) {
			const who = document.createElement("span");
			who.className = "room-skill-agent";
			who.textContent = nameOf(s.agentId);
			head.appendChild(who);
		}
		if (s.invocations > 0) {
			const uses = document.createElement("span");
			uses.className = "room-skill-agent";
			uses.textContent = `used ${s.invocations}×`;
			head.appendChild(uses);
		}
		if (s.hasHistory) {
			const revert = document.createElement("button");
			revert.type = "button";
			revert.className = "btn btn-ghost";
			revert.textContent = "Revert";
			revert.title = "Back to the previous revision";
			revert.addEventListener("click", async () => {
				if (!await showConfirmModal({
					title: `Revert ${s.name}?`,
					body: "Back to the previous revision. The current version stays in history — a revert can itself be reverted.",
					confirmLabel: "Revert"
				})) return;
				try {
					const res = await authFetch(`/api/agents/${encodeURIComponent(s.agentId)}/skills/scoped/${encodeURIComponent(s.name)}/revert`, { method: "POST" });
					if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
					showToast(`Reverted ${s.name}`);
					renderRoomSkills();
				} catch (err) {
					toastError(err, "Could not revert");
				}
			});
			head.appendChild(revert);
		}
		const del = document.createElement("button");
		del.type = "button";
		del.className = "skill-delete";
		del.title = `Remove from ${nameOf(s.agentId)}`;
		del.textContent = "✕";
		del.addEventListener("click", async () => {
			if (!await showConfirmModal({
				title: `Remove ${s.name}?`,
				body: `It will no longer be available to ${nameOf(s.agentId)}.`,
				confirmLabel: "Remove",
				destructive: true
			})) return;
			try {
				const res = await authFetch(`/api/agents/${encodeURIComponent(s.agentId)}/skills/scoped/${encodeURIComponent(s.name)}`, { method: "DELETE" });
				if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
				showToast(`Removed ${s.name}`);
				renderRoomSkills();
			} catch (err) {
				toastError(err, "Failed to remove skill");
			}
		});
		li.append(head, del);
		list.appendChild(li);
	}
	for (const s of archived) {
		const li = document.createElement("li");
		li.className = "room-skill-row room-skill-archived";
		const head = document.createElement("div");
		head.className = "room-skill-head";
		const name = document.createElement("span");
		name.className = "room-skill-name";
		name.textContent = s.name;
		head.appendChild(name);
		const tag = document.createElement("span");
		tag.className = "room-skill-agent";
		tag.textContent = "archived — unused";
		head.appendChild(tag);
		const restore = document.createElement("button");
		restore.type = "button";
		restore.className = "btn btn-ghost";
		restore.textContent = "Restore";
		restore.addEventListener("click", async () => {
			try {
				const res = await authFetch(`/api/agents/${encodeURIComponent(s.agentId)}/skills/archived/${encodeURIComponent(s.name)}/restore`, { method: "POST" });
				if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
				showToast(`Restored ${s.name}`);
				renderRoomSkills();
			} catch (err) {
				toastError(err, "Could not restore");
			}
		});
		li.append(head, restore);
		list.appendChild(li);
	}
}
function renderRoomWiredAgents() {
	const list = $("#room-wired-agents");
	list.innerHTML = "";
	const effectiveMode = roomDetailWiredAgents.some((a) => a.is_prime) ? "prime" : roomDetailEngageMode;
	for (const agent of roomDetailWiredAgents) {
		const li = document.createElement("li");
		const primeBtn = document.createElement("button");
		primeBtn.type = "button";
		primeBtn.className = "room-wired-prime" + (agent.is_prime ? " active" : "");
		primeBtn.innerHTML = agent.is_prime ? lucide$1("star", "icon--fill") : lucide$1("star");
		primeBtn.title = agent.is_prime ? `Stop ${agent.name} replying to everything — back to only when @-mentioned` : `Make ${agent.name} the default — replies to all messages (not just @-mentions)`;
		primeBtn.addEventListener("click", () => togglePrimeAgent(agent));
		li.appendChild(primeBtn);
		const onlyOne = roomDetailWiredAgents.length <= 1;
		const name = document.createElement("span");
		name.className = "room-wired-name room-wired-name-link";
		name.textContent = agent.name;
		name.setAttribute("role", "button");
		name.setAttribute("tabindex", "0");
		name.title = `Open ${agent.name} settings`;
		const openAgentSettings = async () => {
			if (!allAgents.some((x) => x.id === agent.id)) await fetchAgents();
			await openAgentDetail(agent.id);
		};
		name.addEventListener("click", openAgentSettings);
		name.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openAgentSettings();
			}
		});
		if (agent.is_prime) {
			const badge = document.createElement("span");
			badge.className = "room-wired-prime-badge";
			badge.textContent = " default";
			name.appendChild(badge);
		}
		li.appendChild(name);
		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "room-wired-remove";
		removeBtn.innerHTML = lucide$1("x");
		removeBtn.title = onlyOne ? "Cannot remove the last agent (delete the room instead)" : `Remove ${agent.name}`;
		removeBtn.disabled = onlyOne;
		removeBtn.addEventListener("click", () => removeAgentFromRoom(agent.id, agent.name));
		li.appendChild(removeBtn);
		list.appendChild(li);
	}
	const modeTip = effectiveMode === "prime" ? `Replies to everything: ${roomDetailWiredAgents.find((a) => a.is_prime)?.name ?? "unknown"} — except messages that @-mention a different agent.` : "No agents reply unless @-mentioned. Star an agent to make it reply to everything.";
	const modeInfo = $("#room-mode-info");
	if (modeInfo) {
		modeInfo.hidden = false;
		modeInfo.className = `mode-info-btn mode-${effectiveMode}`;
		modeInfo.setAttribute("aria-label", `Reply mode — ${modeTip}`);
		modeInfo.onclick = (e) => {
			e.stopPropagation();
			toggleModeInfoPopup(modeInfo, modeTip);
		};
	}
}
function toggleModeInfoPopup(anchor, text) {
	const wrap = anchor.closest(".form-label-row");
	const existing = wrap.querySelector(".mode-info-popup");
	if (existing) {
		existing.remove();
		return;
	}
	const pop = document.createElement("div");
	pop.className = "mode-info-popup";
	pop.setAttribute("role", "tooltip");
	pop.textContent = text;
	wrap.appendChild(pop);
	const close = (e) => {
		if (e && (pop.contains(e.target) || anchor.contains(e.target))) return;
		pop.remove();
		document.removeEventListener("click", close);
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e) => {
		if (e.key === "Escape") close();
	};
	setTimeout(() => {
		document.addEventListener("click", close);
		document.addEventListener("keydown", onKey);
	}, 0);
}
async function togglePrimeAgent(agent) {
	if (!selectedRoomId) return;
	const url = `/api/rooms/${encodeURIComponent(selectedRoomId)}/prime`;
	try {
		const res = agent.is_prime ? await authFetch(url, { method: "DELETE" }) : await authFetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: agent.id })
		});
		if (!res.ok) {
			showToast("Could not update the default agent: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		await refreshRoomWiredAgents(selectedRoomId);
	} catch (err) {
		showToast("Could not update the default agent: " + err.message, { kind: "error" });
	}
}
async function populateAddAgentSelect() {
	if (allAgents.length === 0) await fetchAgents();
	const wiredIds = new Set(roomDetailWiredAgents.map((a) => a.id));
	const candidates = allAgents.filter((a) => !wiredIds.has(a.id) && a.status !== "archived");
	const list = $("#room-add-agent-list");
	list.innerHTML = "";
	if (candidates.length === 0) {
		const li = document.createElement("li");
		li.className = "empty-note";
		li.textContent = "No unwired agents — switch to \"New\" to create one.";
		list.appendChild(li);
		updateAddAgentSubmitLabel();
		return;
	}
	const sorted = [...candidates].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
	for (const agent of sorted) {
		const li = document.createElement("li");
		li.className = "room-add-agent-row";
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.value = agent.id;
		cb.id = `room-add-agent-${agent.id}`;
		cb.addEventListener("change", updateAddAgentSubmitLabel);
		const lbl = document.createElement("label");
		lbl.htmlFor = cb.id;
		lbl.className = "room-add-agent-label";
		const name = document.createElement("span");
		name.className = "room-add-agent-name";
		name.textContent = agent.name || agent.id;
		const sub = document.createElement("span");
		sub.className = "room-add-agent-sub";
		sub.textContent = agent.folder || agent.id;
		lbl.appendChild(name);
		lbl.appendChild(sub);
		li.appendChild(cb);
		li.appendChild(lbl);
		list.appendChild(li);
	}
	updateAddAgentSubmitLabel();
}
function updateAddAgentSubmitLabel() {
	const checked = $("#room-add-agent-list").querySelectorAll("input[type=checkbox]:checked");
	const btn = $("#room-add-agent-existing-submit");
	const n = checked.length;
	btn.textContent = n > 0 ? `Wire selected (${n})` : "Wire selected";
	btn.disabled = n === 0;
}
async function addExistingAgentToRoom() {
	if (!selectedRoomId) return;
	const checked = Array.from($("#room-add-agent-list").querySelectorAll("input[type=checkbox]:checked"));
	if (checked.length === 0) return;
	const ids = checked.map((cb) => cb.value);
	$("#room-add-agent-existing-submit").disabled = true;
	try {
		for (const id of ids) await addAgentToRoom(selectedRoomId, {
			kind: "existing",
			id
		});
	} finally {
		updateAddAgentSubmitLabel();
	}
}
async function addNewAgentToRoom() {
	if (!selectedRoomId) return;
	const name = $("#room-add-agent-new-name").value.trim();
	if (!name) return;
	const instructions = $("#room-add-agent-new-instructions").value;
	await addAgentToRoom(selectedRoomId, {
		kind: "new",
		name,
		instructions
	});
}
async function addAgentToRoom(roomId, ref) {
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(ref)
		});
		if (!res.ok) {
			showToast("Failed to add agent: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		$("#room-add-agent-new-name").value = "";
		$("#room-add-agent-new-instructions").value = "";
		await fetchAgents();
		await refreshRoomWiredAgents(roomId);
	} catch (err) {
		showToast("Failed to add agent: " + err.message, { kind: "error" });
	}
}
async function removeAgentFromRoom(agentId, agentName) {
	if (!selectedRoomId) return;
	if (!await showConfirmModal({
		title: "Remove agent",
		body: `Remove "${agentName}" from this room? The agent itself will not be deleted.`,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(selectedRoomId)}/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
		if (!res.ok) {
			showToast("Failed to remove agent: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		showToast(`Removed "${agentName}" from the room.`, { kind: "success" });
		await refreshRoomWiredAgents(selectedRoomId);
	} catch (err) {
		showToast("Failed to remove agent: " + err.message, { kind: "error" });
	}
}
async function deleteCurrentRoom() {
	if (!selectedRoomId) return;
	const room = lastRoomsList.find((r) => r.id === selectedRoomId);
	const label = room ? room.name : selectedRoomId;
	if (!await showConfirmModal({
		title: "Delete room",
		body: `Delete room "${label}"? Wired agents will be preserved — delete them separately if you want them gone.`,
		confirmLabel: "Delete",
		destructive: true
	})) return;
	const roomToClose = selectedRoomId;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomToClose)}`, { method: "DELETE" });
		if (!res.ok) {
			showToast("Failed to delete room: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		showToast(`Deleted room "${label}".`, { kind: "success" });
		closeRoomDetail();
		if (currentRoom === roomToClose) {
			currentRoom = null;
			$("#room-name").textContent = "Select a room";
			$("#message-input").disabled = true;
			$("#message-form button[type=submit]").disabled = true;
			$("#messages").innerHTML = "<div class=\"empty-state\">Select a room from the sidebar to start chatting</div>";
			showRoomSettingsToggle(false);
		}
	} catch (err) {
		showToast("Failed to delete room: " + err.message, { kind: "error" });
	}
}
function toggleRoomSettings() {
	if (!currentRoom) return;
	if (selectedRoomId === currentRoom && !$("#room-detail").hidden) closeRoomDetail();
	else openRoomDetail(currentRoom);
}
$("#room-name").addEventListener("click", toggleRoomSettings);
$("#room-name").addEventListener("keydown", (e) => {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		toggleRoomSettings();
	}
});
async function syncThread(direction) {
	if (!currentRoom || currentThread === "main") return;
	const room = currentRoom;
	const thread = currentThread;
	const isPull = direction === "pull";
	if (!await showConfirmModal({
		title: isPull ? "Pull main chat down" : "Push this thread up",
		body: "",
		confirmLabel: isPull ? "Pull down" : "Push up"
	})) return;
	try {
		const r = await authFetch(`/api/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(thread)}/${direction}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" }
		});
		if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
		const { copied = 0 } = await r.json();
		if (copied === 0) showToast(isPull ? "Nothing new to pull" : "Nothing new to push", { kind: "info" });
		else showToast(`Copied ${copied} message${copied === 1 ? "" : "s"}`, { kind: "success" });
	} catch (err) {
		showToast("Sync failed: " + (err.message || err), { kind: "error" });
	}
}
$("#thread-switch")?.addEventListener("click", (e) => {
	e.stopPropagation();
	openThreadSwitcher();
});
$("#thread-pull")?.addEventListener("click", () => syncThread("pull"));
$("#thread-push")?.addEventListener("click", () => syncThread("push"));
$("#thread-delete")?.addEventListener("click", () => {
	if (!currentRoom || currentThread === "main") return;
	const thread = roomThreads().find((t) => t.thread_id === currentThread);
	if (thread) deleteThreadConfirm(thread);
});
$("#room-detail-close").addEventListener("click", closeRoomDetail);
$("#room-delete").addEventListener("click", deleteCurrentRoom);
$("#room-credential-modes")?.addEventListener("click", async (e) => {
	const btn = e.target.closest(".setting-option");
	if (!btn || !selectedRoomId) return;
	const mode = btn.dataset.value;
	const r = await authFetch(`/api/rooms/${encodeURIComponent(selectedRoomId)}/credential-mode`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"X-Webchat-CSRF": "1"
		},
		body: JSON.stringify({ mode })
	});
	if (r.ok) {
		document.querySelectorAll("#room-credential-modes .setting-option").forEach((b) => b.classList.toggle("active", b === btn));
		const hintEl = $("#room-cred-default-hint");
		if (hintEl) hintEl.textContent = "";
		showToast(`User credentials: ${{
			disabled: "off",
			optional: "optional",
			required: "required"
		}[mode] ?? mode}.`, { kind: "success" });
		if (selectedRoomId === currentRoom) updateUserCredsBanner(currentRoom);
	} else showToast("Failed to set mode: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
});
$("#room-rename-save")?.addEventListener("click", saveRoomName);
$("#room-rename-input")?.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		saveRoomName();
	}
});
$("#room-archive-toggle").addEventListener("click", async () => {
	if (!selectedRoomId) return;
	const room = lastRoomsList.find((r) => r.id === selectedRoomId);
	if (!room) return;
	await toggleRoomArchive(selectedRoomId, !room.archived);
	if (!$("#room-detail").hidden) openRoomDetail(selectedRoomId);
});
$("#room-add-agent-existing-submit").addEventListener("click", addExistingAgentToRoom);
$("#room-add-agent-new-submit").addEventListener("click", addNewAgentToRoom);
document.querySelectorAll(".room-agent-picker-tab").forEach((tab) => {
	tab.addEventListener("click", () => {
		document.querySelectorAll(".room-agent-picker-tab").forEach((t) => t.classList.remove("active"));
		tab.classList.add("active");
		const which = tab.dataset.picker;
		$("#room-add-agent-existing").hidden = which !== "existing";
		$("#room-add-agent-new").hidden = which !== "new";
	});
});
async function openRoomCreate() {
	selectedRoomId = null;
	closeAgentDetail();
	$("#room-edit-view").hidden = true;
	$("#room-create-view").hidden = false;
	$("#room-create-name").value = "";
	$("#room-create-new-name").value = "";
	$("#room-create-new-instructions").value = "";
	$("#room-create-new-block").hidden = true;
	await fetchAgents();
	renderRoomCreateAgentChecklist();
	$("#room-detail").hidden = false;
	$("#members-panel").hidden = true;
	$("#agent-detail").hidden = true;
	$("#room-create-name").focus();
}
function renderRoomCreateAgentChecklist() {
	const list = $("#room-create-existing-agents");
	list.innerHTML = "";
	if (allAgents.length === 0) {
		const li = document.createElement("li");
		li.className = "empty-note";
		li.textContent = "No agents yet — create one inline below.";
		list.appendChild(li);
		return;
	}
	const sorted = [...allAgents].filter((a) => a.status !== "archived").sort((a, b) => a.name.localeCompare(b.name));
	for (const agent of sorted) {
		const li = document.createElement("li");
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.value = agent.id;
		cb.id = `room-create-agent-${agent.id}`;
		const lbl = document.createElement("label");
		lbl.htmlFor = cb.id;
		lbl.textContent = agent.name;
		li.appendChild(cb);
		li.appendChild(lbl);
		list.appendChild(li);
	}
}
$("#create-room-btn").addEventListener("click", openRoomCreate);
$("#archived-toggle").addEventListener("click", () => {
	showArchived = !showArchived;
	sessionStorage.setItem("webchat:showArchived", showArchived ? "1" : "0");
	if (lastRoomsList.length) renderRooms(lastRoomsList);
});
$("#hidden-toggle").addEventListener("click", () => {
	showHidden = !showHidden;
	sessionStorage.setItem("webchat:showHidden", showHidden ? "1" : "0");
	if (lastRoomsList.length) renderRooms(lastRoomsList);
});
function wireSortToggle(btnId, storageKey, isOn, setOn, rerender) {
	const btn = $(btnId);
	if (!btn) return;
	const sync = () => {
		btn.classList.toggle("active", isOn());
		btn.setAttribute("aria-pressed", isOn() ? "true" : "false");
	};
	sync();
	btn.addEventListener("click", () => {
		setOn(!isOn());
		sessionStorage.setItem(storageKey, isOn() ? "1" : "0");
		sync();
		rerender();
	});
}
wireSortToggle("#room-sort-az", "webchat:roomSortAz", () => roomSortAz, (v) => roomSortAz = v, () => {
	if (lastRoomsList.length) renderRooms(lastRoomsList);
});
wireSortToggle("#perms-sort-az", "webchat:usersSortAz", () => usersSortAz, (v) => usersSortAz = v, () => renderPermsUserList());
function syncManageSortIcon() {
	const btn = $("#manage-sort-az");
	if (!btn) return;
	const on = manageTab === "models" ? modelSortAz : agentSortAz;
	btn.classList.toggle("active", on);
	btn.setAttribute("aria-pressed", on ? "true" : "false");
}
$("#manage-sort-az")?.addEventListener("click", () => {
	if (manageTab === "models") {
		modelSortAz = !modelSortAz;
		sessionStorage.setItem("webchat:modelSortAz", modelSortAz ? "1" : "0");
		renderModels();
	} else {
		agentSortAz = !agentSortAz;
		sessionStorage.setItem("webchat:agentSortAz", agentSortAz ? "1" : "0");
		renderAgents();
	}
	syncManageSortIcon();
});
$("#room-create-close").addEventListener("click", closeRoomDetail);
$("#room-create-toggle-new").addEventListener("click", () => {
	$("#room-create-new-block").hidden = !$("#room-create-new-block").hidden;
	if (!$("#room-create-new-block").hidden) $("#room-create-new-name").focus();
});
$("#room-create-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = $("#room-create-name").value.trim();
	if (!name) return;
	const checked = Array.from($("#room-create-existing-agents").querySelectorAll("input[type=checkbox]")).filter((cb) => cb.checked).map((cb) => ({
		kind: "existing",
		id: cb.value
	}));
	const newName = $("#room-create-new-name").value.trim();
	const refs = [...checked];
	if (newName) refs.push({
		kind: "new",
		name: newName,
		instructions: $("#room-create-new-instructions").value || void 0
	});
	if (refs.length === 0) {
		showToast("Pick at least one existing agent or create a new one inline.", { kind: "error" });
		return;
	}
	try {
		const res = await authFetch("/api/rooms", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name,
				agents: refs
			})
		});
		if (!res.ok) {
			showToast("Failed to create room: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		const body = await res.json();
		closeRoomDetail();
		await fetchAgents();
		if (body.room) joinRoom(body.room.id, body.room.name);
	} catch (err) {
		showToast("Failed to create room: " + err.message, { kind: "error" });
	}
});
function handleTypingEvent(msg) {
	if (msg.room_id !== currentRoom) return;
	const { identity, identity_type, is_typing } = msg;
	if (is_typing) {
		if (identity_type === "agent") agentName = identity;
		if (typingUsers.has(identity)) clearTimeout(typingUsers.get(identity).timeout);
		const timeout = setTimeout(() => {
			typingUsers.delete(identity);
			renderTypingIndicator();
		}, identity_type === "agent" ? 12e4 : 5e3);
		typingUsers.set(identity, {
			timeout,
			identity_type
		});
	} else {
		if (typingUsers.has(identity)) clearTimeout(typingUsers.get(identity).timeout);
		typingUsers.delete(identity);
	}
	renderTypingIndicator();
}
function renderTypingIndicator() {
	const el = $("#typing-indicator");
	const entries = [...typingUsers.entries()];
	const userTypers = entries.filter(([, v]) => v.identity_type !== "agent");
	const typingAgents = entries.filter(([, v]) => v.identity_type === "agent").map(([n]) => n);
	for (const name of typingAgents) if (!bubbleFor(name)) ensureThinkingBubble(name);
	for (const b of document.querySelectorAll("#messages .thinking-bubble")) {
		if (b.dataset.statusLive === "1") continue;
		if (typingAgents.includes(b.dataset.agent)) continue;
		b.remove();
	}
	if (userTypers.length > 0) {
		const names = userTypers.map(([n]) => esc(n));
		el.innerHTML = `${names.length === 1 ? `${names[0]} is typing` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are typing`}<span class="dots"><span></span><span></span><span></span></span>`;
		el.className = "typing-indicator is-visible";
		el.removeAttribute("aria-hidden");
	} else {
		el.classList.remove("is-visible");
		el.setAttribute("aria-hidden", "true");
	}
}
var TOOL_LABELS = {
	Bash: "Running command",
	Read: "Reading file",
	Write: "Writing file",
	Edit: "Editing file",
	Glob: "Searching files",
	Grep: "Searching code",
	WebSearch: "Searching the web",
	WebFetch: "Fetching page",
	Task: "Managing tasks",
	NotebookEdit: "Editing notebook"
};
function triggerLearn(command = "/learn") {
	const input = $("#message-input");
	if (!input || input.disabled || !currentRoom) return;
	hideLearnNudge();
	input.value = command;
	sendCurrentMessage();
}
function learnSourceFirstToken(value) {
	return value.trim().split(/\s+/)[0] || "";
}
function isLearnUrlToken(tok) {
	if (!/^https?:\/\/\S+$/i.test(tok)) return false;
	try {
		new URL(tok);
		return true;
	} catch {
		return false;
	}
}
function isLearnPathToken(tok) {
	return tok === "~" || tok === "." || tok === ".." || /^(\/|\.\/|\.\.\/|~\/)/.test(tok);
}
async function promptLearnSource({ title, placeholder, check, invalid }) {
	return await showInputModal({
		title,
		placeholder,
		confirmLabel: "Learn",
		validate: (val) => val && check(learnSourceFirstToken(val)) ? null : invalid
	});
}
var LEARN_NUDGE_MIN_TOOLS = 5;
var roomAutoLearn = /* @__PURE__ */ new Map();
async function refreshRoomAutoLearn(roomId) {
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/learning`);
		if (!res.ok) return;
		const cfg = await res.json();
		roomAutoLearn.set(roomId, cfg.autoTrigger === true);
	} catch {}
}
var learnTurnToolCount = 0;
function showLearnNudge() {
	if (!learningMasterEnabled) return;
	const n = $("#learn-nudge");
	if (n) n.hidden = false;
}
function hideLearnNudge() {
	const n = $("#learn-nudge");
	if (n) n.hidden = true;
}
/**
* 🎓 popover (DESIGN.md § Composer popups — mirrors .mention-popover, no third
* style). Click the icon → "Distill now" plus the per-agent automation toggles:
*   Auto-distill — admin-tier; it only stages drafts (default ON).
*   Auto-keep    — owner-tier; it writes live agent context, so the server
*                  refuses the toggle for anyone else and the row only renders
*                  when the server says canAutoKeep.
*/
async function toggleLearnMenu() {
	const menu = $("#learn-menu");
	if (!menu) return;
	if (!menu.hidden) {
		closeLearnMenu();
		return;
	}
	if (!currentRoom) return;
	menu.innerHTML = "";
	const item = (icon, label, onPick) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "learn-menu-item";
		b.setAttribute("role", "menuitem");
		b.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"></use></svg><span class="learn-menu-key">${label}</span>`;
		b.addEventListener("click", () => {
			closeLearnMenu();
			onPick();
		});
		return b;
	};
	menu.appendChild(item("i-sparkles", "This session", () => triggerLearn()));
	menu.appendChild(item("i-link", "From a link…", async () => {
		const v = await promptLearnSource({
			title: "Learn from a link",
			placeholder: "https://…",
			check: isLearnUrlToken,
			invalid: "Start with a full link (http:// or https://)"
		});
		if (v) triggerLearn("/learn " + v);
	}));
	menu.appendChild(item("i-folder", "From a folder…", async () => {
		const v = await promptLearnSource({
			title: "Learn from a folder",
			placeholder: "/workspace/…",
			check: isLearnPathToken,
			invalid: "Start with a path (/, ./ or ~/)"
		});
		if (v) triggerLearn("/learn " + v);
	}));
	let cfg = null;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/learning`);
		if (res.ok) cfg = await res.json();
	} catch {}
	if (cfg && cfg.canManage && learningMasterEnabled) {
		menu.appendChild(learnToggleRow("Auto-distill busy turns (this room)", cfg.autoTrigger, (on) => putRoomLearning({ autoTrigger: on })));
		menu.appendChild(learnToggleRow("Auto-keep drafts (this room)", cfg.autoKeep, (on) => putRoomLearning({ autoKeep: on })));
	}
	menu.hidden = false;
	$("#learn-btn")?.setAttribute("aria-expanded", "true");
}
function closeLearnMenu() {
	const menu = $("#learn-menu");
	if (menu) menu.hidden = true;
	$("#learn-btn")?.setAttribute("aria-expanded", "false");
}
async function putRoomLearning(patch) {
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/learning`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch)
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
		showToast("Learning settings saved for this room");
		refreshRoomAutoLearn(currentRoom);
		return true;
	} catch (err) {
		toastError(err, "Could not save");
		return false;
	}
}
function learnToggleRow(label, on, onChange) {
	const row = document.createElement("button");
	row.type = "button";
	row.className = "learn-menu-item";
	row.setAttribute("role", "menuitemcheckbox");
	row.setAttribute("aria-checked", String(!!on));
	const state = document.createElement("span");
	state.className = "learn-menu-state" + (on ? " on" : "");
	state.textContent = on ? "on" : "off";
	const text = document.createElement("span");
	text.textContent = label;
	row.append(text, state);
	row.addEventListener("click", async () => {
		const next = state.textContent !== "on";
		if (await onChange(next)) {
			state.textContent = next ? "on" : "off";
			state.classList.toggle("on", next);
			row.setAttribute("aria-checked", String(next));
		}
	});
	return row;
}
$("#learn-btn")?.addEventListener("click", toggleLearnMenu);
(() => {
	const more = document.getElementById("composer-more");
	const tools = document.getElementById("composer-tools");
	if (!more || !tools) return;
	const close = () => {
		tools.classList.remove("open");
		more.setAttribute("aria-expanded", "false");
	};
	more.addEventListener("click", (e) => {
		e.stopPropagation();
		const open = !tools.classList.contains("open");
		tools.classList.toggle("open", open);
		more.setAttribute("aria-expanded", String(open));
	});
	tools.addEventListener("click", (e) => {
		if (e.target.closest("button")) close();
	});
	document.addEventListener("click", (e) => {
		if (tools.classList.contains("open") && !tools.contains(e.target) && e.target.closest("#composer-more") === null) close();
	});
})();
document.addEventListener("click", (e) => {
	const menu = $("#learn-menu");
	if (menu && !menu.hidden && !menu.contains(e.target) && e.target.closest("#learn-btn") === null) closeLearnMenu();
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !($("#learn-menu")?.hidden ?? true)) closeLearnMenu();
});
$("#learn-nudge-go")?.addEventListener("click", () => triggerLearn());
$("#learn-nudge-dismiss")?.addEventListener("click", hideLearnNudge);
function handleStatusEvent(msg) {
	if (msg.room_id !== currentRoom) return;
	const name = msg.agent_name || agentName || "Agent";
	switch (msg.event) {
		case "start":
			beginAgentTurn(name);
			learnTurnToolCount = 0;
			break;
		case "tool":
			markTurnActivity(name);
			learnTurnToolCount++;
			updateThinkingBubble(name, msg.text ? TOOL_LABELS[msg.text] || `Using ${msg.text}` : "Working", msg.detail || null);
			break;
		case "progress":
			markTurnActivity(name);
			if (msg.text) setThinkingMilestone(name, msg.text);
			break;
		case "reasoning":
			markTurnActivity(name);
			if (msg.text) pushReasoning(name, msg.text);
			break;
		case "done":
			endAgentTurn(name);
			if (learnTurnToolCount >= LEARN_NUDGE_MIN_TOOLS && roomAutoLearn.get(currentRoom) !== true) showLearnNudge();
			learnTurnToolCount = 0;
			break;
		case "stalled":
			endAgentTurn(name);
			appendSystem(msg.text || "The agent stopped responding. You may want to resend your message.");
	}
}
var TURN_QUIET_MS = 5e3;
var REASONING_LOG_MAX = 500;
var turnElapsedTimer = null;
function bubbleFor(name) {
	return $(`#messages .thinking-bubble[data-agent="${window.CSS && CSS.escape ? CSS.escape(name || "Agent") : name || "Agent"}"]`);
}
function ensureElapsedTimer() {
	if (!turnElapsedTimer) turnElapsedTimer = setInterval(updateTurnElapsed, 1e3);
}
function beginAgentTurn(name) {
	const bubble = ensureThinkingBubble(name);
	bubble._turn = {
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		reasoningLog: []
	};
	bubble.dataset.statusLive = "1";
	ensureElapsedTimer();
	updateTurnElapsed();
	return bubble;
}
function endAgentTurn(name) {
	const bubble = bubbleFor(name);
	if (bubble) bubble.remove();
	if (turnElapsedTimer && !$("#messages .thinking-bubble")) {
		clearInterval(turnElapsedTimer);
		turnElapsedTimer = null;
	}
}
function endAllAgentTurns() {
	for (const b of document.querySelectorAll("#messages .thinking-bubble")) b.remove();
	if (turnElapsedTimer) {
		clearInterval(turnElapsedTimer);
		turnElapsedTimer = null;
	}
}
function markTurnActivity(name) {
	const bubble = bubbleFor(name);
	if (bubble && bubble._turn) bubble._turn.lastActivityAt = Date.now();
}
function updateTurnElapsed() {
	let any = false;
	for (const bubble of document.querySelectorAll("#messages .thinking-bubble")) {
		any = true;
		const t = bubble._turn;
		const el = bubble.querySelector(".thinking-elapsed");
		if (!t || !el) continue;
		const secs = Math.floor((Date.now() - t.startedAt) / 1e3);
		if (secs < 2) {
			el.textContent = "";
			continue;
		}
		el.textContent = Date.now() - t.lastActivityAt > TURN_QUIET_MS ? ` · still working ${secs}s` : ` · ${secs}s`;
	}
	if (!any && turnElapsedTimer) {
		clearInterval(turnElapsedTimer);
		turnElapsedTimer = null;
	}
}
var THINKING_DETAIL_MAX = 64;
function interruptAgent(name) {
	if (!currentRoom || !ws || ws.readyState !== WebSocket.OPEN) return;
	ws.send(JSON.stringify({
		type: "interrupt",
		room_id: currentRoom,
		agent_name: name || null
	}));
	endAgentTurn(name);
	appendSystem(name ? `Stopped ${name}.` : "Stopped.");
}
function ensureThinkingBubble(name) {
	const key = name || agentName || "Agent";
	let bubble = bubbleFor(key);
	if (bubble) return bubble;
	const shouldScroll = isNearBottom() || forceScrollCount > 0 && !userScrolledAway;
	bubble = document.createElement("div");
	bubble.className = "msg agent thinking-bubble";
	bubble.dataset.agent = key;
	bubble._turn = {
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		reasoningLog: []
	};
	const sender = document.createElement("div");
	sender.className = "sender";
	sender.appendChild(lucideEl("bot"));
	sender.appendChild(document.createTextNode(` ${key} — `));
	const verb = document.createElement("span");
	verb.className = "thinking-verb";
	verb.textContent = "Thinking";
	sender.appendChild(verb);
	const elapsed = document.createElement("span");
	elapsed.className = "thinking-elapsed";
	sender.appendChild(elapsed);
	const chevron = document.createElement("span");
	chevron.className = "thinking-chevron";
	chevron.appendChild(lucideEl("chevron-right"));
	sender.appendChild(chevron);
	const stop = document.createElement("button");
	stop.type = "button";
	stop.className = "thinking-stop";
	stop.title = "Stop the agent";
	stop.setAttribute("aria-label", "Stop the agent");
	stop.innerHTML = "<span class=\"stop-square\" aria-hidden=\"true\"></span>Stop";
	stop.addEventListener("click", (e) => {
		e.stopPropagation();
		interruptAgent(key);
	});
	sender.appendChild(stop);
	bubble.appendChild(sender);
	const content = document.createElement("div");
	content.className = "bubble";
	content.innerHTML = "<div class=\"thinking-milestone\" hidden></div><div class=\"thinking-target\" hidden></div><div class=\"thinking-feed\" hidden></div><div class=\"thinking-fulltrace\"></div><span class=\"dots\"><span></span><span></span><span></span></span>";
	bubble.appendChild(content);
	bubble.addEventListener("click", (e) => {
		if (e.target.closest("a, button")) return;
		toggleThinkingExpanded(bubble);
	});
	$("#messages").appendChild(bubble);
	if (shouldScroll) scrollToBottom();
	return bubble;
}
function toggleThinkingExpanded(bubble) {
	if (bubble.classList.toggle("expanded")) renderFullTrace(bubble);
}
function renderFullTrace(bubble) {
	const el = bubble.querySelector(".thinking-fulltrace");
	if (!el) return;
	const log = bubble._turn && bubble._turn.reasoningLog || [];
	if (log.length === 0) el.textContent = "No reasoning captured for this turn yet.";
	else {
		el.textContent = "";
		for (const line of log) {
			const row = document.createElement("div");
			row.className = "thinking-fulltrace-line";
			row.textContent = line;
			el.appendChild(row);
		}
	}
	el.scrollTop = el.scrollHeight;
}
function updateThinkingBubble(name, label, detail) {
	const bubble = ensureThinkingBubble(name);
	const verbEl = bubble.querySelector(".thinking-verb");
	if (verbEl) verbEl.textContent = label;
	const target = bubble.querySelector(".thinking-target");
	if (target) {
		if (detail) {
			target.textContent = detail.length > THINKING_DETAIL_MAX ? `${detail.slice(0, 63)}…` : detail;
			target.hidden = false;
		} else target.hidden = true;
	}
}
function setThinkingMilestone(name, text) {
	const el = ensureThinkingBubble(name).querySelector(".thinking-milestone");
	if (el) {
		el.textContent = text;
		el.hidden = false;
	}
}
var REASONING_FEED_BUFFER = 40;
var REASONING_FEED_TTL = 7e3;
var REASONING_FADE_MS = 500;
function pushReasoning(name, text) {
	const bubble = ensureThinkingBubble(name);
	if (!bubble._turn) bubble._turn = {
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		reasoningLog: []
	};
	bubble._turn.reasoningLog.push(text);
	if (bubble._turn.reasoningLog.length > REASONING_LOG_MAX) bubble._turn.reasoningLog.shift();
	if (bubble.classList.contains("expanded")) renderFullTrace(bubble);
	const feed = bubble.querySelector(".thinking-feed");
	if (!feed) return;
	feed.hidden = false;
	const line = document.createElement("div");
	line.className = "thinking-feed-line";
	line.textContent = text;
	feed.appendChild(line);
	while (feed.children.length > REASONING_FEED_BUFFER) {
		const oldest = feed.firstChild;
		if (oldest._fadeTimer) clearTimeout(oldest._fadeTimer);
		feed.removeChild(oldest);
	}
	feed.scrollTop = feed.scrollHeight;
	line._fadeTimer = setTimeout(() => {
		line.classList.add("fading");
		setTimeout(() => {
			line.remove();
			if (feed.children.length === 0) feed.hidden = true;
		}, REASONING_FADE_MS);
	}, REASONING_FEED_TTL);
	if (isNearBottom() || forceScrollCount > 0 && !userScrolledAway) scrollToBottom();
}
var typingTimeout = null;
var isTyping = false;
$("#message-input").addEventListener("input", function() {
	updateSlashMenu();
	const prevH = this._prevScrollHeight || this.clientHeight;
	if (this.scrollHeight > this.clientHeight || this.scrollHeight < prevH) {
		this.style.height = "0";
		this.style.height = Math.min(this.scrollHeight, 120) + "px";
	}
	this._prevScrollHeight = this.scrollHeight;
	if (!currentRoom || !ws || ws.readyState !== WebSocket.OPEN) return;
	if (!isTyping) {
		isTyping = true;
		ws.send(JSON.stringify({
			type: "typing",
			is_typing: true
		}));
	}
	clearTimeout(typingTimeout);
	typingTimeout = setTimeout(() => {
		isTyping = false;
		ws.send(JSON.stringify({
			type: "typing",
			is_typing: false
		}));
	}, 2e3);
});
$("#message-form").addEventListener("submit", () => {
	if (isTyping) {
		isTyping = false;
		clearTimeout(typingTimeout);
		ws.send(JSON.stringify({
			type: "typing",
			is_typing: false
		}));
	}
});
var messagesEl = $("#messages");
messagesEl.addEventListener("dragover", (e) => {
	e.preventDefault();
	messagesEl.classList.add("drag-over");
});
messagesEl.addEventListener("dragleave", () => {
	messagesEl.classList.remove("drag-over");
});
messagesEl.addEventListener("drop", (e) => {
	e.preventDefault();
	messagesEl.classList.remove("drag-over");
	if (e.dataTransfer.files.length > 0) stageFiles(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
	if (!currentRoom) return;
	const files = [...e.clipboardData?.files || []];
	if (files.length > 0) {
		e.preventDefault();
		stageFiles(files);
	}
});
$("#message-input").addEventListener("paste", (e) => {
	if (e.clipboardData?.files?.length) return;
	const text = e.clipboardData?.getData("text/plain") ?? "";
	if (!text.includes("\n")) return;
	e.preventDefault();
	const input = e.currentTarget;
	const longestTicks = (text.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
	const fence = "`".repeat(Math.max(3, longestTicks + 1));
	const before = input.value.slice(0, input.selectionStart);
	const insert = `${before.length > 0 && !before.endsWith("\n") ? "\n" : ""}${fence}\n${text.replace(/\n+$/, "")}\n${fence}\n`;
	const valBefore = input.value;
	document.execCommand("insertText", false, insert);
	if (input.value === valBefore) {
		input.setRangeText(insert, input.selectionStart, input.selectionEnd, "end");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
});
$("#file-picker").addEventListener("click", () => {
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	input.addEventListener("change", () => {
		if (input.files.length > 0) stageFiles(input.files);
	});
	input.click();
});
$("#camera-btn").addEventListener("click", () => {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*";
	input.capture = "environment";
	input.addEventListener("change", () => {
		if (input.files.length > 0) stageFile(input.files[0]);
	});
	input.click();
});
async function clearBadgeCount() {
	try {
		const db = await new Promise((resolve, reject) => {
			const r = indexedDB.open("nanoclaw-badge", 1);
			r.onupgradeneeded = () => r.result.createObjectStore("state");
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => reject(r.error);
		});
		await new Promise((resolve) => {
			const tx = db.transaction("state", "readwrite");
			tx.objectStore("state").put(0, "count");
			tx.oncomplete = () => resolve();
		});
	} catch {}
	if ("clearAppBadge" in navigator) try {
		await navigator.clearAppBadge();
	} catch {}
}
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) clearBadgeCount();
});
if (!document.hidden) clearBadgeCount();
if ("serviceWorker" in navigator) {
	let swReg = null;
	const checkForUpdate = () => swReg && swReg.update().catch(() => {});
	navigator.serviceWorker.register("/sw.js").then((reg) => {
		if (!reg) return;
		swReg = reg;
		reg.update().catch(() => {});
		setInterval(checkForUpdate, 6e4);
		reg.addEventListener("updatefound", () => {
			const nw = reg.installing;
			if (nw) nw.addEventListener("statechange", () => {
				if (nw.state === "installed" && navigator.serviceWorker.controller) tryReload();
			});
		});
	});
	let refreshing = false;
	let reloadPending = false;
	function safeToReload() {
		const input = document.getElementById("message-input");
		const hasDraft = input && input.value.trim().length > 0;
		const hasStagedFile = Array.isArray(pendingFiles) && pendingFiles.length > 0;
		if (hasDraft || hasStagedFile) return false;
		const loginScreen = document.getElementById("login-screen");
		const tokenField = document.getElementById("login-token");
		const onLogin = loginScreen && !loginScreen.hidden;
		const typingToken = tokenField && tokenField.value.trim().length > 0;
		if (onLogin && !typingToken) return true;
		return document.hidden;
	}
	function tryReload() {
		if (refreshing) return;
		if (safeToReload()) {
			refreshing = true;
			location.reload();
		} else {
			reloadPending = true;
			showUpdateBanner();
		}
	}
	function showUpdateBanner() {
		if (document.getElementById("update-banner")) return;
		const b = document.createElement("button");
		b.id = "update-banner";
		b.type = "button";
		b.className = "update-banner";
		b.textContent = "A new version is ready — tap to refresh";
		b.addEventListener("click", () => {
			refreshing = true;
			location.reload();
		});
		document.body.appendChild(b);
	}
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			if (reloadPending) tryReload();
		} else checkForUpdate();
	});
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		tryReload();
	});
	navigator.serviceWorker.addEventListener("message", (e) => {
		if (e.data && e.data.type === "open-room" && e.data.roomId) {
			const agent = allAgents.find((b) => b.room_id === e.data.roomId);
			joinRoom(e.data.roomId, agent?.name || e.data.roomId);
		}
	});
	const coldRoom = new URLSearchParams(location.search).get("room");
	if (coldRoom) {
		const tryJoin = () => {
			const agent = allAgents.find((b) => b.room_id === coldRoom);
			if (allAgents.length) joinRoom(coldRoom, agent?.name || coldRoom);
			else setTimeout(tryJoin, 200);
		};
		tryJoin();
	}
}
var allModels = [];
var selectedModelId = null;
async function fetchModels() {
	try {
		allModels = await (await authFetch("/api/models")).json();
		renderModels();
		loadOllamaHosts();
	} catch (err) {
		console.error("Failed to fetch models:", err);
	}
}
var ollamaPullPoller = null;
async function loadOllamaHosts() {
	const wrap = $("#ollama-hosts");
	if (!wrap) return;
	if (routingClassifierModel === null) await probeRoutingAvailability();
	try {
		const hostsRes = await authFetch("/api/ollama/hosts");
		if (!hostsRes.ok) {
			wrap.hidden = true;
			return;
		}
		const { hosts } = await hostsRes.json();
		wrap.hidden = hosts.length === 0;
		if (wrap.hidden) return;
		const cards = $("#ollama-host-cards");
		cards.innerHTML = "";
		for (const host of hosts) {
			cards.appendChild(buildOllamaHostCard(host));
			loadOllamaHostModels(host);
		}
		pollOllamaPulls();
	} catch (err) {
		console.error("Failed to load servers:", err);
		wrap.hidden = true;
	}
}
function ollamaCardId(host) {
	return "ollama-card-" + host.replace(/[^a-z0-9]/gi, "-");
}
function findSelectable(kind, endpoint, modelId) {
	const norm = (e) => (e || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
	return allModels.find((r) => {
		if (r.model_id !== modelId) return false;
		if (kind === "ollama") return r.kind === "ollama" && norm(r.endpoint) === norm(endpoint);
		return r.kind === "openai-compatible" && /:4000(\/v1)?$/.test(norm(r.endpoint));
	});
}
function buildSelectToggle(kind, endpoint, modelId, displayName) {
	const existing = findSelectable(kind, endpoint, modelId);
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "btn btn-ghost select-toggle" + (existing ? " on" : "");
	btn.textContent = existing ? "−" : "+";
	btn.title = existing ? "Remove from selectable models" : "Add to selectable models";
	btn.setAttribute("aria-label", btn.title);
	btn.addEventListener("click", async () => {
		btn.disabled = true;
		try {
			if (existing) {
				const r = await authFetch("/api/models/" + encodeURIComponent(existing.id), { method: "DELETE" });
				if (!r.ok) {
					const body = await r.json().catch(() => ({}));
					const who = (existing.agents || []).map((a) => a.name).join(", ");
					throw new Error(who ? "in use by " + who + " — unassign first" : body.error || r.status);
				}
				showToast("Removed from selectable models");
			} else {
				const r = await authFetch("/api/models", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: displayName,
						kind,
						endpoint,
						model_id: modelId
					})
				});
				if (!r.ok) throw new Error((await r.json()).error || r.status);
				showToast("Added to selectable models", { kind: "success" });
			}
			await fetchModels();
			if (!$("#mtab-routing").hidden) renderRouterRoster();
		} catch (err) {
			showToast(String(err.message || err), { kind: "error" });
			btn.disabled = false;
		}
	});
	return btn;
}
function cardOpen(key) {
	return localStorage.getItem("serverCardOpen:" + key) === "1";
}
function setCardOpen(key, open) {
	localStorage.setItem("serverCardOpen:" + key, open ? "1" : "0");
}
function makeCardAccordion(card, head, key, summaryEl) {
	const chev = document.createElement("span");
	chev.className = "ollama-card-chevron";
	chev.textContent = "›";
	head.prepend(chev);
	const body = document.createElement("div");
	card.appendChild(body);
	const apply = () => {
		const open = cardOpen(key);
		body.hidden = !open;
		if (summaryEl) summaryEl.hidden = open;
		chev.classList.toggle("open", open);
	};
	head.classList.add("clickable");
	head.setAttribute("role", "button");
	head.setAttribute("tabindex", "0");
	head.addEventListener("click", (e) => {
		if (e.target.closest("button")) return;
		setCardOpen(key, !cardOpen(key));
		apply();
	});
	apply();
	return body;
}
function buildOllamaHostCard(host) {
	const card = document.createElement("div");
	card.className = "ollama-host-card";
	card.id = ollamaCardId(host);
	card.dataset.host = host;
	const head = document.createElement("div");
	head.className = "ollama-host-head";
	const label = document.createElement("span");
	label.className = "ollama-host-name";
	label.textContent = host.replace(/^https?:\/\//, "");
	head.appendChild(label);
	const summary = document.createElement("span");
	summary.className = "ollama-card-summary";
	summary.textContent = "…";
	head.appendChild(summary);
	card.appendChild(head);
	const body = makeCardAccordion(card, head, host, summary);
	card._summary = summary;
	const ul = document.createElement("ul");
	ul.className = "ollama-model-list";
	ul.innerHTML = "<li class=\"ollama-muted\">Loading…</li>";
	body.appendChild(ul);
	const pullRow = document.createElement("div");
	pullRow.className = "ollama-pull-row";
	const input = document.createElement("input");
	input.type = "text";
	input.placeholder = "Model to pull, e.g. qwen3.5:4b…";
	input.className = "ollama-pull-input";
	const btn = document.createElement("button");
	btn.className = "btn btn-secondary";
	btn.type = "button";
	btn.textContent = "Pull";
	btn.addEventListener("click", () => startOllamaPull(host, input.value.trim(), input, btn));
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") startOllamaPull(host, input.value.trim(), input, btn);
	});
	pullRow.appendChild(input);
	pullRow.appendChild(btn);
	body.appendChild(pullRow);
	const progress = document.createElement("div");
	progress.className = "ollama-pull-status";
	progress.hidden = true;
	card.appendChild(progress);
	return card;
}
async function loadOllamaHostModels(host) {
	const card = document.getElementById(ollamaCardId(host));
	if (!card) return;
	const ul = card.querySelector(".ollama-model-list");
	try {
		const res = await authFetch("/api/ollama/models?host=" + encodeURIComponent(host));
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		ul.innerHTML = "";
		const sum = card._summary;
		if (sum) sum.textContent = body.models.length + " model" + (body.models.length === 1 ? "" : "s");
		if (body.models.length === 0) {
			ul.innerHTML = "<li class=\"ollama-muted\">No models installed</li>";
			return;
		}
		const buildModelRow = (m, selectable) => {
			const li = document.createElement("li");
			const name = document.createElement("span");
			name.className = "ollama-model-name";
			name.textContent = m.name;
			li.appendChild(name);
			const meta = document.createElement("span");
			meta.className = "ollama-model-meta";
			meta.textContent = (m.size / 1e9).toFixed(1) + " GB";
			li.appendChild(meta);
			if (m.loaded) {
				const badge = document.createElement("span");
				badge.className = "ollama-loaded-badge";
				badge.textContent = "in memory";
				badge.title = (m.size_vram / 1e9).toFixed(1) + " GB in VRAM";
				li.appendChild(badge);
			}
			if (selectable) li.appendChild(buildSelectToggle("ollama", host, m.name, m.name));
			else {
				const tag = document.createElement("span");
				tag.className = "ollama-model-systag";
				tag.textContent = "classifier";
				tag.title = "Auto-routing classifier — infrastructure, not selectable as an agent model";
				li.appendChild(tag);
			}
			ul.appendChild(li);
		};
		const isClassifier = (m) => routingClassifierModel && m.name === routingClassifierModel;
		const selectableModels = body.models.filter((m) => !isClassifier(m));
		const systemModels = body.models.filter(isClassifier);
		for (const m of selectableModels) buildModelRow(m, true);
		if (systemModels.length) {
			const head = document.createElement("li");
			head.className = "ollama-model-sysheading";
			head.textContent = "System — not selectable";
			ul.appendChild(head);
			for (const m of systemModels) buildModelRow(m, false);
		}
	} catch (err) {
		ul.innerHTML = "";
		const li = document.createElement("li");
		li.className = "ollama-muted";
		li.textContent = "Unreachable: " + err.message;
		ul.appendChild(li);
	}
}
async function startOllamaPull(host, model, input, btn) {
	if (!model) return;
	btn.disabled = true;
	try {
		const res = await authFetch("/api/ollama/pull", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				host,
				model
			})
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		input.value = "";
		pollOllamaPulls();
	} catch (err) {
		showToast("Pull failed to start: " + err.message, { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
function renderOllamaPulls(pulls) {
	for (const job of pulls) {
		const card = document.getElementById(ollamaCardId(job.host));
		if (!card) continue;
		const box = card.querySelector(".ollama-pull-status");
		box.hidden = false;
		const pct = job.total > 0 ? Math.min(100, Math.round(100 * job.completed / job.total)) : 0;
		if (job.status === "pulling") box.innerHTML = "<div class=\"ollama-pull-line\">Pulling " + job.model + " — " + job.detail + "</div><div class=\"ollama-pull-bar\"><span style=\"width:" + pct + "%\"></span></div>";
		else if (job.status === "success") box.innerHTML = "<div class=\"ollama-pull-line ok\">Pulled " + job.model + "</div>";
		else box.innerHTML = "<div class=\"ollama-pull-line err\">Pull of " + job.model + " failed: " + (job.error || "") + "</div>";
		if (job.status !== "pulling" && !box.dataset["done_" + job.model]) {
			box.dataset["done_" + job.model] = "1";
			if (job.status === "success") {
				showToast("Pulled " + job.model, { kind: "success" });
				loadOllamaHostModels(job.host);
			}
		}
	}
}
async function pollOllamaPulls() {
	if (ollamaPullPoller) return;
	const tick = async () => {
		try {
			const res = await authFetch("/api/ollama/pulls");
			if (!res.ok) throw new Error(res.status);
			const { pulls } = await res.json();
			renderOllamaPulls(pulls);
			if (pulls.some((p) => p.status === "pulling")) ollamaPullPoller = setTimeout(tick, 1500);
			else ollamaPullPoller = null;
		} catch {
			ollamaPullPoller = null;
		}
	};
	ollamaPullPoller = setTimeout(tick, 0);
}
var routingDraft = null;
var routingRouterInfo = null;
var routingAvailable = false;
var routingClassifierModel = null;
async function probeRoutingAvailability() {
	try {
		const res = await authFetch("/api/router/routes");
		const data = await res.json().catch(() => ({}));
		routingAvailable = res.ok && data.installed !== false;
		routingClassifierModel = data.classifier || null;
	} catch {
		routingAvailable = false;
	}
	document.querySelectorAll(".manage-tab[data-mtab=\"routing\"], .overflow-item[data-action=\"routing\"]").forEach((el) => {
		el.hidden = !routingAvailable;
	});
	if (!routingAvailable && manageTab === "routing") switchManageTab("agents");
}
var routingCurrentRouter = null;
async function loadRoutingTab() {
	try {
		const q = routingCurrentRouter ? `?router=${encodeURIComponent(routingCurrentRouter)}` : "";
		const [routesRes, rosterRes] = await Promise.all([authFetch("/api/router/routes" + q), authFetch("/api/router/models")]);
		if (!routesRes.ok) throw new Error((await routesRes.json()).error || routesRes.status);
		routingDraft = await routesRes.json();
		routingCurrentRouter = routingDraft.router ?? null;
		routingRouterInfo = rosterRes.ok ? await rosterRes.json() : null;
	} catch (err) {
		showToast("Auto routing config unavailable: " + err.message, { kind: "error" });
		return;
	}
	if (allModels.length === 0) await fetchModels();
	renderRouterPicker();
	renderRouteList();
	renderRouterRoster();
	renderRouteSuggestions();
	if (routingSubtab === "logs") refreshRoutingDecisions();
	$("#routing-bench-result").hidden = true;
	$("#routing-bench-result-log").hidden = true;
}
function renderRouterPicker() {
	const sel = $("#router-select");
	const names = routingDraft?.routers ?? [routingCurrentRouter ?? "auto"];
	const picker = $("#router-picker");
	picker.hidden = names.length <= 1;
	sel.innerHTML = "";
	for (const n of names) {
		const o = document.createElement("option");
		o.value = n;
		o.textContent = n;
		if (n === routingCurrentRouter) o.selected = true;
		sel.appendChild(o);
	}
	$("#router-delete-btn").disabled = names.length <= 1;
	updateRoutingIntro();
}
async function updateRoutingIntro() {
	const intro = $("#routing-intro");
	if (intro) intro.hidden = true;
}
$("#router-select")?.addEventListener("change", (e) => {
	routingCurrentRouter = e.target.value;
	loadRoutingTab();
});
$("#router-new-btn")?.addEventListener("click", async () => {
	const name = await showInputModal({
		title: "New routing profile",
		placeholder: "letters, digits, dash"
	});
	if (!name) return;
	try {
		const res = await authFetch("/api/router/routers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name,
				target
			})
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		routingCurrentRouter = name;
		showToast(`Created routing profile "${name}" (cloned)`, { kind: "success" });
		await fetchModels();
		loadRoutingTab();
	} catch (err) {
		showToast("Could not create profile: " + err.message, { kind: "error" });
	}
});
$("#router-delete-btn")?.addEventListener("click", async () => {
	const name = routingCurrentRouter;
	if (!name) return;
	if (!await showConfirmModal({
		title: "Delete routing profile",
		body: `Delete the "${name}" routing profile? Agents must be unassigned from it first.`,
		confirmLabel: "Delete",
		destructive: true
	})) return;
	try {
		const res = await authFetch("/api/router/routers/" + encodeURIComponent(name), { method: "DELETE" });
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		routingCurrentRouter = null;
		showToast(`Deleted "${name}"`);
		await fetchModels();
		loadRoutingTab();
	} catch (err) {
		showToast("Could not delete: " + err.message, { kind: "error" });
	}
});
var routingSubtab = "rules";
function switchRoutingSubtab(which) {
	routingSubtab = which;
	document.querySelectorAll(".routing-subtab").forEach((b) => {
		const on = b.dataset.rsub === which;
		b.classList.toggle("active", on);
		b.setAttribute("aria-selected", on ? "true" : "false");
	});
	$("#rsub-rules").hidden = which !== "rules";
	$("#rsub-models").hidden = which !== "models";
	$("#rsub-logs").hidden = which !== "logs";
	if (which === "logs") refreshRoutingDecisions();
}
document.querySelectorAll(".routing-subtab").forEach((b) => {
	b.addEventListener("click", () => switchRoutingSubtab(b.dataset.rsub));
});
function renderRouterRoster() {
	const list = $("#router-roster-list");
	list.innerHTML = "";
	if (!routingRouterInfo || routingRouterInfo.models.length === 0) {
		list.innerHTML = "<li class=\"ollama-muted\">Router not reachable right now…</li>";
		return;
	}
	const buildRow = (id, selectable) => {
		const li = document.createElement("li");
		const name = document.createElement("span");
		name.className = "ollama-model-name";
		name.textContent = id;
		li.appendChild(name);
		if (selectable) li.appendChild(buildSelectToggle("openai-compatible", routingRouterInfo.endpoint, id, id));
		else {
			const tag = document.createElement("span");
			tag.className = "ollama-model-systag";
			tag.textContent = "classifier";
			tag.title = "Auto-routing classifier — infrastructure, not a selectable or route-target model";
			li.appendChild(tag);
		}
		list.appendChild(li);
	};
	const isClassifier = (id) => routingClassifierModel && id === routingClassifierModel;
	const selectable = routingRouterInfo.models.filter((id) => !isClassifier(id));
	const system = routingRouterInfo.models.filter(isClassifier);
	for (const id of selectable) buildRow(id, true);
	if (system.length) {
		const head = document.createElement("li");
		head.className = "ollama-model-sysheading";
		head.textContent = "System — not selectable";
		list.appendChild(head);
		for (const id of system) buildRow(id, false);
	}
}
async function renderRouteSuggestions() {
	const box = $("#route-suggestions");
	if (!box) return;
	let suggestions = [];
	try {
		const res = await authFetch("/api/router/suggestions");
		if (res.ok) suggestions = (await res.json()).suggestions || [];
	} catch {}
	box.innerHTML = "";
	box.hidden = suggestions.length === 0;
	for (const s of suggestions) {
		const row = document.createElement("div");
		row.className = "route-suggestion";
		const text = document.createElement("span");
		text.className = "route-suggestion-text";
		text.innerHTML = `<strong>${esc(s.model)}</strong> can do <strong>${esc(s.capability)}</strong> — no route covers it yet.`;
		row.appendChild(text);
		const btn = document.createElement("button");
		btn.className = "btn btn-secondary";
		btn.type = "button";
		btn.textContent = `Create ${s.capability} route`;
		btn.addEventListener("click", () => createRouteFromSuggestion(s, btn));
		row.appendChild(btn);
		box.appendChild(row);
	}
}
async function createRouteFromSuggestion(s, btn) {
	if (!routingDraft) return;
	if (routingDraft.routes.some((r) => r.name === s.capability)) return;
	btn.disabled = true;
	routingDraft.routes.push({
		name: s.capability,
		description: s.description,
		model: s.model
	});
	try {
		await saveRoutingConfig();
		showToast(`Created ${s.capability} route → ${s.model}`, { kind: "success" });
		renderRouteSuggestions();
	} catch (err) {
		routingDraft.routes = routingDraft.routes.filter((r) => r.name !== s.capability);
		showToast("Could not create route: " + err.message, { kind: "error" });
		btn.disabled = false;
	}
}
async function runRosterRefresh() {
	const btn = $("#roster-refresh-btn");
	const log = $("#roster-refresh-log");
	btn.disabled = true;
	log.hidden = false;
	log.textContent = "Starting…";
	try {
		const res = await authFetch("/api/router/roster-refresh", { method: "POST" });
		if (!res.ok) throw new Error((await res.json()).error || res.status);
		while (true) {
			await new Promise((r) => setTimeout(r, 2e3));
			const st = await (await authFetch("/api/router/roster-refresh")).json();
			log.textContent = st.lines.slice(-12).join("\n");
			log.scrollTop = log.scrollHeight;
			if (!st.running) {
				if (st.exitCode === 0) {
					showToast("Roster refreshed", { kind: "success" });
					setTimeout(() => {
						log.hidden = true;
					}, 4e3);
					loadRoutingTab();
				} else showToast("Roster refresh failed — see log", { kind: "error" });
				break;
			}
		}
	} catch (err) {
		log.textContent = "Refresh failed: " + err.message;
		showToast("Roster refresh failed", { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
$("#roster-refresh-btn")?.addEventListener("click", runRosterRefresh);
async function saveRoutingConfig() {
	const res = await authFetch("/api/router/routes" + (routingCurrentRouter ? `?router=${encodeURIComponent(routingCurrentRouter)}` : ""), {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			routes: routingDraft.routes,
			default_route: routingDraft.default_route
		})
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || res.status);
	routingDraft = body;
	renderRouteList();
}
var selectedRouteIdx = null;
function makeRowActivatable(li, activate) {
	li.setAttribute("role", "button");
	li.setAttribute("tabindex", "0");
	li.addEventListener("click", activate);
	li.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			activate();
		}
	});
}
function renderRouteList() {
	const list = $("#route-list");
	list.innerHTML = "";
	if (routingDraft.routes.length === 0) {
		const empty = document.createElement("li");
		empty.className = "ollama-muted";
		empty.textContent = "No routes yet — add one, or a suggestion will offer to.";
		list.appendChild(empty);
		return;
	}
	routingDraft.routes.forEach((r, i) => {
		const li = document.createElement("li");
		li.classList.add("route-row");
		if (i === selectedRouteIdx && !$("#route-detail").hidden) li.classList.add("active");
		const top = document.createElement("div");
		top.className = "route-row-top";
		if (r.escalate) {
			const badge = document.createElement("span");
			badge.className = "model-kind-badge kind-anthropic";
			badge.textContent = "escalate";
			top.appendChild(badge);
		}
		const name = document.createElement("span");
		name.className = "model-row-name";
		name.textContent = r.name;
		top.appendChild(name);
		if (routingDraft.default_route === r.name) {
			const chip = document.createElement("span");
			chip.className = "model-kind-badge model-default-badge";
			chip.textContent = "default";
			top.appendChild(chip);
		}
		if (r.pinned) {
			const chip = document.createElement("span");
			chip.className = "model-row-uses";
			chip.textContent = "pinned";
			top.appendChild(chip);
		}
		if (!r.escalate) {
			const host = document.createElement("span");
			host.className = "model-row-host";
			host.textContent = r.model || "";
			top.appendChild(host);
		}
		li.appendChild(top);
		const desc = document.createElement("div");
		desc.className = "route-row-desc";
		desc.textContent = r.description || "No description — click to add the rule";
		if (!r.description) desc.classList.add("empty");
		li.appendChild(desc);
		makeRowActivatable(li, () => {
			if (selectedRouteIdx === i && !$("#route-detail").hidden) closeRouteDetail();
			else openRouteDetail(i);
		});
		list.appendChild(li);
	});
}
function openRouteDetail(i) {
	const r = routingDraft.routes[i];
	if (!r) return;
	selectedRouteIdx = i;
	populateRouteDetail(r, false);
}
function openNewRouteDetail() {
	if (!routingDraft) return;
	selectedRouteIdx = -1;
	populateRouteDetail({
		name: "",
		description: "",
		model: (routingRouterInfo?.models ?? [])[0] || ""
	}, true);
}
function populateRouteDetail(r, isNew) {
	closeModelDetail();
	renderRouteList();
	$("#route-detail-title").textContent = isNew ? "New route" : r.name;
	const badge = $("#route-detail-badge");
	badge.hidden = !r.escalate;
	if (r.escalate) {
		badge.className = "model-kind-badge kind-anthropic";
		badge.textContent = "escalate";
	}
	$("#route-name").value = r.name;
	$("#route-description").value = r.description || "";
	$("#route-binding-label").hidden = Boolean(r.escalate);
	$("#route-escalate-note").hidden = !r.escalate;
	if (!r.escalate) {
		const sel = $("#route-binding");
		sel.innerHTML = "";
		for (const m of [.../* @__PURE__ */ new Set([r.model, ...routingRouterInfo?.models ?? []])].filter(Boolean)) {
			const o = document.createElement("option");
			o.value = m;
			o.textContent = m;
			if (m === r.model) o.selected = true;
			sel.appendChild(o);
		}
	}
	const pin = $("#route-pinned");
	pin.checked = Boolean(r.pinned);
	pin.parentElement.hidden = Boolean(r.escalate);
	const def = $("#route-default");
	def.checked = routingDraft.default_route === r.name;
	def.disabled = def.checked;
	def.parentElement.hidden = Boolean(r.escalate);
	$("#route-detail").hidden = false;
	$("#members-panel").hidden = true;
}
function closeRouteDetail() {
	$("#route-detail").hidden = true;
	selectedRouteIdx = null;
	if (routingDraft) renderRouteList();
}
$("#route-detail-close")?.addEventListener("click", closeRouteDetail);
$("#route-detail-form")?.addEventListener("submit", async (e) => {
	e.preventDefault();
	const isNew = selectedRouteIdx === -1;
	const r = isNew ? {
		name: "",
		description: "",
		model: ""
	} : routingDraft.routes[selectedRouteIdx];
	if (!r) return;
	const prevName = r.name;
	r.name = $("#route-name").value.trim();
	r.description = $("#route-description").value;
	if (!r.escalate) {
		r.model = $("#route-binding").value;
		r.pinned = $("#route-pinned").checked;
		if ($("#route-default").checked) routingDraft.default_route = r.name;
		else if (routingDraft.default_route === prevName) routingDraft.default_route = r.name;
	}
	if (isNew) {
		routingDraft.routes.push(r);
		selectedRouteIdx = routingDraft.routes.length - 1;
	}
	try {
		await saveRoutingConfig();
		showToast("Route saved — live now", { kind: "success" });
		if (isNew) closeRouteDetail();
		else $("#route-detail-title").textContent = r.name;
	} catch (err) {
		if (isNew) {
			routingDraft.routes.pop();
			selectedRouteIdx = -1;
		}
		showToast("Save failed: " + err.message, { kind: "error" });
	}
});
$("#route-delete")?.addEventListener("click", async () => {
	const r = routingDraft.routes[selectedRouteIdx];
	if (!r) return;
	if (!await showConfirmModal({
		title: `Delete the route "${r.name || r.model || "unnamed"}"?`,
		confirmLabel: "Delete",
		destructive: true
	})) return;
	routingDraft.routes.splice(selectedRouteIdx, 1);
	try {
		await saveRoutingConfig();
		closeRouteDetail();
		showToast("Route removed");
	} catch (err) {
		showToast("Delete failed: " + err.message, { kind: "error" });
		loadRoutingTab();
	}
});
$("#create-route-btn")?.addEventListener("click", openNewRouteDetail);
async function runBench(inputEl, outEl) {
	const prompt = inputEl.value.trim();
	if (!prompt) return;
	outEl.hidden = false;
	outEl.classList.remove("err");
	outEl.textContent = "Classifying…";
	try {
		const res = await authFetch("/api/router/classify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt })
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
		outEl.textContent = `→ ${body.route} · ${body.model ?? "(no binding)"} · ${body.ms} ms`;
	} catch (err) {
		outEl.classList.add("err");
		outEl.textContent = "Could not classify — " + (err.message || "classifier unavailable");
	}
}
function wireBench(inputId, runId, outId) {
	const input = document.getElementById(inputId);
	const out = document.getElementById(outId);
	if (!input || !out) return;
	document.getElementById(runId)?.addEventListener("click", () => runBench(input, out));
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") runBench(input, out);
	});
}
wireBench("routing-bench-input", "routing-bench-run", "routing-bench-result");
wireBench("routing-bench-input-log", "routing-bench-run-log", "routing-bench-result-log");
setTimeout(probeRoutingAvailability, 3e3);
async function refreshRoutingDecisions() {
	const list = $("#routing-decisions-list");
	try {
		const res = await authFetch("/api/router/decisions?limit=60");
		if (!res.ok) throw new Error(res.status);
		let { decisions } = await res.json();
		const cur = routingCurrentRouter ?? "auto";
		decisions = decisions.filter((d) => (d.router ?? "auto") === cur).slice(0, 15);
		list.innerHTML = "";
		if (decisions.length === 0) {
			list.innerHTML = `<div class="ollama-muted">No decisions yet for ${esc(cur)}</div>`;
			return;
		}
		for (const d of decisions) {
			const row = document.createElement("div");
			row.className = "routing-decision-row" + (d.route === "__error__" ? " err" : "");
			const when = new Date(d.ts).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit"
			});
			const route = d.route === "__error__" ? "classifier error" : d.route;
			const rawModel = d.final_model || d.bound_model || "";
			const model = rawModel === "__escalate__" ? "escalated to Claude" : rawModel;
			row.textContent = `${when} · ${d.mode || "shadow"} · ${route} → ${model} · ${d.ms} ms`;
			row.title = d.prompt_head || "";
			list.appendChild(row);
		}
	} catch {
		list.innerHTML = "<div class=\"ollama-muted\">Log unavailable</div>";
	}
}
function modelKindLabel(kind) {
	return kind === "openai-compatible" ? "openai" : kind;
}
function isRouterBackendModel(m) {
	if (m.kind !== "openai-compatible" || m.model_id === "auto") return false;
	const host = (m.endpoint || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
	return /:4000(\/v1)?$/.test(host);
}
function modelDisplayParts(model) {
	const host = model.endpoint ? model.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "") : null;
	let title = model.name;
	if (host && title.startsWith(host + " · ")) title = title.slice(host.length + 3);
	return {
		title,
		host
	};
}
function modelKindExplainer(kind) {
	if (kind === "anthropic") return "Anthropic model — credentials injected per request by the OneCLI gateway.";
	return "";
}
function renderModels() {
	const list = $("#model-list");
	list.innerHTML = "";
	const visibleModels = allModels.filter((m) => !isRouterBackendModel(m));
	if (visibleModels.length === 0) {
		const li = document.createElement("li");
		li.style.cursor = "default";
		li.style.opacity = "0.6";
		li.textContent = "No models selected yet — use + on a server below, or “Add model endpoint…” for anything else.";
		list.appendChild(li);
		return;
	}
	const byName = (a, b) => a.name.localeCompare(b.name);
	const sortedModels = modelSortAz ? [...visibleModels].sort(byName) : [...visibleModels].sort((a, b) => (a.kind === "anthropic" ? 0 : 1) - (b.kind === "anthropic" ? 0 : 1) || byName(a, b));
	for (const model of sortedModels) {
		const li = document.createElement("li");
		li.dataset.modelId = model.id;
		if (model.id === selectedModelId) li.classList.add("active");
		const isAuto = model.model_id === "auto";
		const badge = document.createElement("span");
		badge.className = `model-kind-badge kind-${isAuto ? "auto" : model.kind}`;
		badge.textContent = isAuto ? "auto" : modelKindLabel(model.kind);
		li.appendChild(badge);
		const parts = modelDisplayParts(model);
		const name = document.createElement("span");
		name.className = "model-row-name";
		name.textContent = parts.title;
		li.appendChild(name);
		if (isAuto) {
			const hint = document.createElement("span");
			hint.className = "model-row-hint";
			hint.textContent = "Manage in Auto routing →";
			li.appendChild(hint);
		} else if (parts.host) {
			const host = document.createElement("span");
			host.className = "model-row-host";
			host.textContent = parts.host;
			li.appendChild(host);
		}
		if (model.agents_assigned > 0) {
			const uses = document.createElement("span");
			uses.className = "model-row-uses";
			uses.textContent = `${model.agents_assigned}×`;
			li.appendChild(uses);
		}
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "btn btn-ghost select-toggle on";
		remove.textContent = "−";
		remove.title = "Remove from selectable models";
		remove.setAttribute("aria-label", remove.title);
		remove.addEventListener("click", async (e) => {
			e.stopPropagation();
			remove.disabled = true;
			try {
				const r = await authFetch("/api/models/" + encodeURIComponent(model.id), { method: "DELETE" });
				if (!r.ok) {
					const body = await r.json().catch(() => ({}));
					const who = (model.agents || []).map((a) => a.name).join(", ");
					throw new Error(who ? "in use by " + who + " — unassign first" : body.error || r.status);
				}
				showToast("Removed from selectable models");
				if (selectedModelId === model.id) closeModelDetail();
				fetchModels();
			} catch (err) {
				showToast(String(err.message || err), { kind: "error" });
				remove.disabled = false;
			}
		});
		li.appendChild(remove);
		makeRowActivatable(li, () => {
			if (isAuto) {
				if (routingAvailable) switchManageTab("routing");
				else openModelDetail(model.id);
				return;
			}
			if (selectedModelId === model.id && !$("#model-detail").hidden) closeModelDetail();
			else openModelDetail(model.id);
		});
		list.appendChild(li);
	}
}
var REACH_META = {
	ok: {
		label: "Reachable",
		warn: false
	},
	timeout: {
		label: "Blocked (timeout)",
		warn: true
	},
	refused: {
		label: "Refused",
		warn: true
	},
	dns: {
		label: "Can't resolve",
		warn: true
	},
	incompatible: {
		label: "Reachable, wrong API",
		warn: true
	},
	skipped: {
		label: "Not preflighted",
		warn: false
	},
	error: {
		label: "Probe error",
		warn: true
	}
};
function warnIfUnreachable(result) {
	if (!result || !REACH_META[result.verdict] || !REACH_META[result.verdict].warn) return;
	showToast(`Agent containers can't reach this model — ${result.detail} Open the model to see the fix.`, {
		kind: "error",
		timeout: 1e4
	});
}
var reachabilityReqSeq = 0;
async function renderReachabilityPanel(model) {
	const facts = $("#model-live-facts");
	if (!facts) return;
	let panel = $("#model-reachability-panel");
	if (!panel) {
		panel = document.createElement("div");
		panel.id = "model-reachability-panel";
		panel.className = "model-reachability";
		facts.insertAdjacentElement("afterend", panel);
	}
	panel.innerHTML = "";
	if (!model.endpoint) {
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	const out = document.createElement("div");
	out.className = "model-reachability-result";
	out.textContent = "Checking reachability…";
	panel.appendChild(out);
	const reqId = ++reachabilityReqSeq;
	try {
		const res = await authFetch("/api/models/reachability", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: model.endpoint })
		});
		if (reqId !== reachabilityReqSeq || selectedModelId !== model.id) return;
		const result = await res.json();
		if (!res.ok) {
			out.classList.add("warn");
			out.textContent = result.error || res.statusText;
			return;
		}
		renderReachabilityOutcome(out, result);
	} catch (err) {
		if (reqId !== reachabilityReqSeq) return;
		out.classList.add("warn");
		out.textContent = String(err.message || err);
	}
}
function renderReachabilityOutcome(out, result) {
	out.hidden = false;
	out.innerHTML = "";
	const meta = REACH_META[result.verdict] || REACH_META.error;
	out.classList.toggle("warn", meta.warn);
	const head = document.createElement("div");
	head.className = "model-reachability-verdict";
	head.textContent = `${meta.warn ? "✕" : "✓"} ${meta.label} — ${result.detail}`;
	out.appendChild(head);
	if (result.fix) {
		const pre = document.createElement("pre");
		pre.className = "model-reachability-fix";
		pre.textContent = result.fix;
		out.appendChild(pre);
		const copy = document.createElement("button");
		copy.type = "button";
		copy.className = "btn btn-ghost";
		copy.textContent = "Copy fix";
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(result.fix);
				copy.textContent = "Copied";
				setTimeout(() => copy.textContent = "Copy fix", 1500);
			} catch {
				showToast("Copy failed — select the text manually.", { kind: "error" });
			}
		});
		out.appendChild(copy);
	}
}
async function openModelDetail(id) {
	const model = allModels.find((m) => m.id === id);
	if (!model) return;
	selectedModelId = id;
	renderModels();
	if (typeof closeRouteDetail === "function") closeRouteDetail();
	closeAgentDetail();
	closeRoomDetail();
	closeMcpDetail();
	$("#model-edit-view").hidden = false;
	$("#model-create-view").hidden = true;
	const parts = modelDisplayParts(model);
	$("#model-detail-title").textContent = parts.title;
	const badge = $("#model-detail-badge");
	badge.textContent = modelKindLabel(model.kind);
	badge.className = `model-kind-badge kind-${model.kind}`;
	badge.hidden = false;
	const kindExplainer = modelKindExplainer(model.kind);
	$("#model-kind-explainer").textContent = kindExplainer;
	$("#model-kind-explainer").hidden = !kindExplainer;
	$("#model-name").value = model.name;
	$("#model-kind").value = modelKindLabel(model.kind);
	$("#model-kind").dataset.kind = model.kind;
	$("#model-endpoint").value = model.endpoint || "";
	$("#model-endpoint-label").hidden = model.kind !== "ollama";
	$("#model-model-id").value = model.model_id;
	$("#model-discover-select").hidden = true;
	loadModelLiveFacts(model);
	renderReachabilityPanel(model);
	const usage = $("#model-detail-usage");
	usage.innerHTML = "";
	if (model.agents && model.agents.length > 0) {
		usage.appendChild(document.createTextNode("Assigned to: "));
		for (const a of model.agents) {
			const chip = document.createElement("span");
			chip.className = "model-assignee-chip";
			chip.textContent = a.name;
			usage.appendChild(chip);
		}
	} else usage.textContent = "Not assigned to any agent yet.";
	const roomsEl = $("#model-detail-rooms");
	roomsEl.innerHTML = "";
	if (model.rooms && model.rooms.length > 0) {
		roomsEl.hidden = false;
		roomsEl.appendChild(document.createTextNode("In rooms: "));
		for (const r of model.rooms) {
			const chip = document.createElement("button");
			chip.type = "button";
			chip.className = "model-assignee-chip model-room-chip";
			chip.textContent = r.name;
			chip.title = "Open room settings";
			chip.addEventListener("click", () => openRoomDetail(r.id));
			roomsEl.appendChild(chip);
		}
	} else roomsEl.hidden = true;
	$("#model-detail").hidden = false;
	$("#members-panel").hidden = true;
}
async function loadModelLiveFacts(model) {
	const el = $("#model-live-facts");
	el.hidden = true;
	el.classList.remove("warn");
	if (model.kind !== "ollama" || !model.endpoint) return;
	try {
		const res = await authFetch("/api/ollama/models?host=" + encodeURIComponent(model.endpoint));
		if (!res.ok) return;
		const { models } = await res.json();
		if (selectedModelId !== model.id) return;
		const hit = models.find((m) => m.name === model.model_id);
		if (!hit) {
			el.textContent = "Not installed on this endpoint — pull it below or pick another model id.";
			el.classList.add("warn");
		} else {
			const gb = (hit.size / 1e9).toFixed(1);
			el.textContent = hit.loaded ? `Installed \u00b7 ${gb} GB \u00b7 in memory (${(hit.size_vram / 1e9).toFixed(1)} GB VRAM)` : `Installed \u00b7 ${gb} GB`;
		}
		el.hidden = false;
	} catch {}
}
function closeModelDetail() {
	$("#model-detail").hidden = true;
	$("#model-edit-view").hidden = false;
	$("#model-create-view").hidden = true;
	selectedModelId = null;
	renderModels();
}
$("#model-detail-close").addEventListener("click", closeModelDetail);
$("#model-create-close").addEventListener("click", closeModelDetail);
$("#create-model-btn").addEventListener("click", () => {
	selectedModelId = null;
	renderModels();
	$("#model-edit-view").hidden = true;
	$("#model-create-view").hidden = false;
	$("#model-create-name").value = "";
	$("#model-create-endpoint").value = "";
	$("#model-create-model-id").value = "";
	$("#model-create-discover-select").hidden = true;
	$("#model-create-kind").value = "anthropic";
	syncCreateFormToKind();
	$("#model-probe-url").value = "";
	$("#model-probe-status").hidden = true;
	$("#model-probe-results").hidden = true;
	lastProbeResult = null;
	$("#model-detail").hidden = false;
	$("#members-panel").hidden = true;
	$("#model-probe-url").focus();
});
function syncCreateFormToKind() {
	const kind = $("#model-create-kind").value;
	$("#model-create-endpoint-label").hidden = kind === "anthropic";
	const placeholders = {
		anthropic: "claude-sonnet-4-6",
		ollama: "llama3.1:70b",
		"openai-compatible": "gpt-4o-mini or qwen2.5:14b"
	};
	$("#model-create-model-id").placeholder = placeholders[kind] || "";
}
$("#model-create-kind").addEventListener("change", syncCreateFormToKind);
var lastProbeResult = null;
$("#model-probe-btn").addEventListener("click", runProbe);
$("#model-probe-url").addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		runProbe();
	}
});
$("#model-probe-select-all").addEventListener("click", () => {
	document.querySelectorAll("#model-probe-list input[type=checkbox]").forEach((cb) => {
		cb.checked = true;
	});
});
$("#model-probe-add-selected").addEventListener("click", addSelectedFromProbe);
async function runProbe() {
	const url = $("#model-probe-url").value.trim();
	if (!url) {
		showToast("Enter a URL or host first (e.g. localhost:11434, api.anthropic.com).", { kind: "error" });
		return;
	}
	if (/\s|[<>]/.test(url)) {
		showToast("URL contains invalid characters.", { kind: "error" });
		return;
	}
	const status = $("#model-probe-status");
	const results = $("#model-probe-results");
	status.classList.remove("error");
	status.textContent = "Probing…";
	status.hidden = false;
	results.hidden = true;
	$("#model-probe-btn").disabled = true;
	try {
		const res = await authFetch("/api/models/probe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url })
		});
		const body = await res.json();
		if (!res.ok) {
			status.textContent = body.error || `Probe failed (${res.status})`;
			status.classList.add("error");
			return;
		}
		lastProbeResult = body;
		if (!body.kind) {
			status.textContent = body.reason || "No known provider responded.";
			status.classList.add("error");
			return;
		}
		status.hidden = true;
		renderProbeResults(body);
	} catch (err) {
		status.textContent = "Probe failed: " + err.message;
		status.classList.add("error");
	} finally {
		$("#model-probe-btn").disabled = false;
	}
}
function renderProbeResults(probe) {
	const summary = $("#model-probe-results .model-probe-summary");
	const kindBadge = summary.querySelector(".model-probe-kind");
	const notesEl = summary.querySelector(".model-probe-notes");
	kindBadge.className = `model-probe-kind kind-${probe.kind}`;
	kindBadge.textContent = modelKindLabel(probe.kind);
	notesEl.textContent = probe.notes || "";
	const list = $("#model-probe-list");
	list.innerHTML = "";
	if (probe.models.length === 0) {
		const li = document.createElement("li");
		li.className = "empty-note";
		li.textContent = probe.requires_credential ? "Endpoint detected, but the model list is gated. Use the Advanced section below to add a specific model id manually." : "No models advertised — use the Advanced section to add manually.";
		list.appendChild(li);
	} else {
		const host = (() => {
			try {
				return new URL(probe.endpoint).host;
			} catch {
				return probe.endpoint;
			}
		})();
		for (const modelId of probe.models) {
			const li = document.createElement("li");
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.value = modelId;
			cb.checked = probe.models.length === 1;
			const lbl = document.createElement("label");
			lbl.appendChild(cb);
			const slug = document.createElement("span");
			slug.textContent = modelId;
			slug.style.flex = "1";
			lbl.appendChild(slug);
			li.appendChild(lbl);
			const nameInput = document.createElement("input");
			nameInput.type = "text";
			nameInput.value = `${host} · ${modelId}`;
			nameInput.placeholder = "Display name";
			nameInput.dataset.modelId = modelId;
			li.appendChild(nameInput);
			list.appendChild(li);
		}
	}
	$("#model-probe-results").hidden = false;
}
async function addSelectedFromProbe() {
	if (!lastProbeResult || !lastProbeResult.kind) return;
	const checked = Array.from(document.querySelectorAll("#model-probe-list input[type=checkbox]:checked"));
	if (checked.length === 0) {
		showToast("Select at least one model.", { kind: "error" });
		return;
	}
	const items = checked.map((cb) => {
		return {
			name: (cb.closest("li").querySelector("input[type=text]")?.value || cb.value).trim(),
			kind: lastProbeResult.kind,
			endpoint: lastProbeResult.endpoint,
			model_id: cb.value
		};
	});
	const btn = $("#model-probe-add-selected");
	const original = btn.textContent;
	btn.disabled = true;
	btn.textContent = `Adding ${items.length}…`;
	try {
		const res = await authFetch("/api/models/bulk", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ models: items })
		});
		const out = await res.json();
		if (!res.ok) {
			showToast("Bulk add failed: " + (out.error || res.statusText), { kind: "error" });
			return;
		}
		if (out.failed && out.failed.length > 0) {
			const lines = out.failed.map((f) => `  • ${items[f.index].model_id}: ${f.error}`).join("\n");
			showToast(`Added ${out.created_count}, ${out.failed.length} failed:\n${lines}`, { kind: "error" });
		}
		await fetchModels();
		closeModelDetail();
		await maybeAssignAfterPickerAdd((out.created || []).map((m) => m.id));
	} catch (err) {
		showToast("Bulk add failed: " + err.message, { kind: "error" });
	} finally {
		btn.disabled = false;
		btn.textContent = original;
	}
}
async function discoverModels(kind, endpoint) {
	const res = await authFetch("/api/models/discover", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(kind === "anthropic" ? { kind } : {
			kind,
			endpoint
		})
	});
	const out = await res.json();
	if (!res.ok) throw new Error(out.error || "discover failed");
	return out.models || [];
}
function bindDiscover(buttonId, kindGetter, endpointGetter, modelIdInput, selectEl) {
	$(buttonId).addEventListener("click", async () => {
		const kind = kindGetter();
		const endpoint = endpointGetter();
		if (kind === "ollama" && !endpoint) {
			showToast("Enter an Ollama endpoint first (e.g. http://localhost:11434)", { kind: "error" });
			return;
		}
		const btn = $(buttonId);
		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = "…";
		try {
			const models = await discoverModels(kind, endpoint);
			const select = $(selectEl);
			select.innerHTML = "<option value=\"\">— pick a model —</option>";
			for (const m of models) {
				const opt = document.createElement("option");
				opt.value = m;
				opt.textContent = m;
				select.appendChild(opt);
			}
			select.hidden = models.length === 0;
			if (models.length === 0) showToast("No models found at that endpoint.", { kind: "error" });
			select.onchange = () => {
				if (select.value) {
					$(modelIdInput).value = select.value;
					select.hidden = true;
				}
			};
		} catch (err) {
			showToast("Discover failed: " + err.message, { kind: "error" });
		} finally {
			btn.disabled = false;
			btn.textContent = original;
		}
	});
}
bindDiscover("#model-create-discover-btn", () => $("#model-create-kind").value, () => $("#model-create-endpoint").value.trim(), "#model-create-model-id", "#model-create-discover-select");
bindDiscover("#model-discover-btn", () => $("#model-kind").dataset.kind || $("#model-kind").value, () => $("#model-endpoint").value.trim(), "#model-model-id", "#model-discover-select");
$("#model-create-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const body = {
		name: $("#model-create-name").value.trim(),
		kind: $("#model-create-kind").value,
		model_id: $("#model-create-model-id").value.trim(),
		endpoint: $("#model-create-endpoint").value.trim() || null
	};
	if (!body.name || !body.model_id) {
		showToast("Name and Model ID are required.", { kind: "error" });
		return;
	}
	try {
		const res = await authFetch("/api/models", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body)
		});
		const out = await res.json();
		if (!res.ok) {
			showToast("Failed to create model: " + (out.error || res.statusText), { kind: "error" });
			return;
		}
		warnIfUnreachable(out.reachability);
		await fetchModels();
		closeModelDetail();
		const createdId = out.model && out.model.id;
		if (createdId) await maybeAssignAfterPickerAdd([createdId]);
	} catch (err) {
		showToast("Failed to create model: " + err.message, { kind: "error" });
	}
});
$("#model-detail-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	if (!selectedModelId) return;
	const btn = $("#model-detail-form button.btn-primary");
	const original = btn.textContent;
	btn.disabled = true;
	btn.textContent = "Saving…";
	btn.classList.remove("success");
	const patch = {
		name: $("#model-name").value.trim(),
		model_id: $("#model-model-id").value.trim(),
		endpoint: $("#model-endpoint").value.trim() || null
	};
	try {
		const res = await authFetch(`/api/models/${encodeURIComponent(selectedModelId)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch)
		});
		const out = await res.json();
		if (!res.ok) {
			showToast("Failed to save model: " + (out.error || res.statusText), { kind: "error" });
			btn.textContent = original;
			btn.disabled = false;
			return;
		}
		await fetchModels();
		btn.textContent = "✓ Saved";
		btn.classList.add("success");
		setTimeout(() => {
			if (btn.isConnected) {
				btn.textContent = original;
				btn.classList.remove("success");
				btn.disabled = false;
			}
		}, 1500);
	} catch (err) {
		showToast("Failed to save model: " + err.message, { kind: "error" });
		btn.textContent = original;
		btn.disabled = false;
	}
});
$("#model-delete").addEventListener("click", async () => {
	if (!selectedModelId) return;
	const model = allModels.find((m) => m.id === selectedModelId);
	if (!model) return;
	try {
		const res = await authFetch(`/api/models/${encodeURIComponent(selectedModelId)}`, { method: "DELETE" });
		if (res.status === 409) {
			const impact = await res.json();
			const n = (impact.assigned_agent_group_ids || []).length;
			const routes = impact.routes_bound || [];
			const parts = [];
			if (n > 0) parts.push(`"${model.name}" is assigned to ${n} agent${n === 1 ? "" : "s"} — they fall back to the default model on their next spawn.`);
			if (routes.length > 0) parts.push(`Also removes routing rule${routes.length === 1 ? "" : "s"}: ` + routes.map((r) => `${r.route} (${r.router})`).join(", ") + ".");
			if (!await showConfirmModal({
				title: "Delete model",
				body: parts.join(" ") || impact.error || "This model is in use.",
				confirmLabel: "Delete anyway",
				destructive: true
			})) return;
			const force = await authFetch(`/api/models/${encodeURIComponent(selectedModelId)}?force=1`, { method: "DELETE" });
			if (!force.ok) {
				showToast(`Failed to delete: ${(await force.json().catch(() => ({}))).error || force.statusText}`, { kind: "error" });
				return;
			}
		} else if (!res.ok) {
			showToast(`Failed to delete: ${(await res.json().catch(() => ({}))).error || res.statusText}`, { kind: "error" });
			return;
		}
		showToast(`Deleted model "${model.name}".`, { kind: "success" });
		closeModelDetail();
		await fetchModels();
		if (allAgents.length > 0) await fetchAgents();
	} catch (err) {
		showToast(`Failed to delete: ${err.message}`, { kind: "error" });
	}
});
var allMcpServers = [];
var selectedMcpId = null;
var lastMcpProbe = null;
async function fetchMcpServers() {
	try {
		allMcpServers = await (await authFetch("/api/mcp-servers")).json();
		renderMcpServers();
	} catch (err) {
		console.error("Failed to fetch MCP servers:", err);
	}
}
/**
* MCP catalog — browse the public registry, prefill the add form.
*
* Discovery only: choosing a row never writes anything. It fills in the form below,
* and the server still has to be probed and added like any hand-entered one.
*
* The remote/package split is the security line. A REMOTE server is a URL the
* container dials out to. A PACKAGE server is npm/pypi code that runs INSIDE the
* agent container, next to its credentials — so it's labelled, and picking one costs
* an explicit confirm naming the exact command. Browsing must never be one click
* away from executing a stranger's code.
*/
var mcpCatalogTimer = null;
var mcpRegistryDisabled = false;
/**
* The MCP registry is a switchable source, exactly like a skill collection: the
* same webchat_disabled_sources row, surfaced in Settings the same way. Off means
* off server-side too — the catalog block disappears and no request is made.
*/
var secretsWired = false;
async function renderToolSecrets() {
	const section = $("#settings-secrets");
	if (!section) return;
	section.hidden = !isOwnerView;
	if (!isOwnerView) return;
	if (!secretsWired) {
		secretsWired = true;
		$("#secret-save").addEventListener("click", () => void saveToolSecret());
		wireCustomScheme("#secret");
	}
	await loadToolSecretList();
}
/**
* Scope → query string. `null` = system-wide, a string = that agent,
* `{agentGroupId,userId}` = that one person's credential.
*/
function toolSecretUrl(scope, extra = "") {
	if (scope && typeof scope === "object") return `/api/tool-secrets?agentGroupId=${encodeURIComponent(scope.agentGroupId)}&userId=${encodeURIComponent(scope.userId)}${extra}`;
	return `/api/tool-secrets?agentGroupId=${encodeURIComponent(scope ?? "*")}${extra}`;
}
async function loadToolSecretList(scope = null, listSel = "#secrets-list") {
	const list = $(listSel);
	if (!list) return;
	list.innerHTML = "";
	let secrets = [];
	try {
		const r = await authFetch(toolSecretUrl(scope));
		if (r.ok) secrets = (await r.json()).secrets || [];
	} catch {
		secrets = [];
	}
	if (!secrets.length) {
		const li = document.createElement("li");
		li.className = "skill-desc";
		li.textContent = "No system secrets";
		list.appendChild(li);
		return;
	}
	for (const s of secrets) {
		const li = document.createElement("li");
		li.className = "skill-source-row secret-row";
		const info = document.createElement("div");
		info.className = "skill-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		const hostEl = document.createElement("span");
		hostEl.textContent = s.hostPattern;
		const pill = document.createElement("span");
		pill.className = "skill-badge secret-scope";
		pill.textContent = "shared";
		head.append(hostEl, pill);
		info.appendChild(head);
		const del = document.createElement("button");
		del.className = "btn btn-danger";
		del.type = "button";
		del.textContent = "Remove";
		del.addEventListener("click", () => void removeToolSecret(scope, s, listSel));
		li.append(info, del);
		list.appendChild(li);
	}
}
/**
* Reveal the header/template fields only when the operator opts into stating
* them. Wired once per form; the rows stay in the DOM so values survive a
* toggle away and back, and are cleared on a successful save with the rest.
*/
function wireCustomScheme(p) {
	const box = $(`${p}-custom`);
	if (!box || box.dataset.wired) return;
	box.dataset.wired = "1";
	const sync = () => {
		$(`${p}-custom-header-row`).hidden = !box.checked;
		$(`${p}-custom-format-row`).hidden = !box.checked;
	};
	box.addEventListener("change", sync);
	sync();
}
async function saveToolSecret(scope = null, p = "#secret") {
	const hostPattern = $(`${p}-host`).value.trim();
	const value = $(`${p}-value`).value;
	if (!hostPattern || !value) {
		showToast("Host and value are required", { kind: "error" });
		return;
	}
	let scheme;
	if ($(`${p}-custom`)?.checked) {
		const headerName = $(`${p}-custom-header`)?.value.trim() || "";
		const valueFormat = $(`${p}-custom-format`)?.value.trim() || "";
		if (!headerName || !valueFormat) {
			showToast("A custom header needs both a name and a value template", { kind: "error" });
			return;
		}
		scheme = {
			headerName,
			valueFormat
		};
	}
	const btn = $(`${p}-save`);
	btn.disabled = true;
	try {
		const r = await authFetch(toolSecretUrl(scope), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify(scheme ? {
				value,
				hostPattern,
				scheme
			} : {
				value,
				hostPattern
			})
		});
		if (!r.ok) {
			showToast((await r.json().catch(() => ({}))).error || "Could not add secret", { kind: "error" });
			return;
		}
		$(`${p}-value`).value = "";
		$(`${p}-host`).value = "";
		if ($(`${p}-custom-header`)) $(`${p}-custom-header`).value = "";
		if ($(`${p}-custom-format`)) $(`${p}-custom-format`).value = "";
		showToast(`Added ${hostPattern}`);
		if (scope) await renderAgentSecrets(typeof scope === "object" ? scope.agentGroupId : scope);
		else await loadToolSecretList(null, "#secrets-list");
	} catch {
		showToast("Could not add secret", { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
async function removeToolSecret(scope, secret, listSel = "#secrets-list", agentGroupId = null) {
	if (!await showConfirmModal({
		title: "Remove secret",
		body: `Delete the credential for ${secret.hostPattern}? Requests that rely on it will start failing.`,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	try {
		if (!(await authFetch(toolSecretUrl(scope, `&id=${encodeURIComponent(secret.id)}`), {
			method: "DELETE",
			headers: { "X-Webchat-CSRF": "1" }
		})).ok) {
			showToast("Could not remove secret", { kind: "error" });
			return;
		}
		showToast(`Removed ${secret.label}`);
		if (agentGroupId) await renderAgentSecrets(agentGroupId);
		else if (listSel) await loadToolSecretList(scope, listSel);
	} catch {
		showToast("Could not remove secret", { kind: "error" });
	}
}
var agentSecretsWired = false;
/**
* Per-agent env vars. The list shows NAMES only — the server never returns a
* value, so there is nothing to render and nothing to leak into a screenshot.
*/
async function renderAgentEnv(agentGroupId) {
	const box = $("#agent-env-list");
	if (!box) return;
	let names = [];
	try {
		const r = await authFetch(`/api/agents/${encodeURIComponent(agentGroupId)}/env`);
		if (r.ok) names = (await r.json()).names || [];
	} catch {}
	$("#agent-env-count").textContent = names.length ? String(names.length) : "";
	box.innerHTML = "";
	for (const name of names) {
		const row = document.createElement("div");
		row.className = "secret-row";
		const label = document.createElement("code");
		label.textContent = "$" + name;
		const del = document.createElement("button");
		del.className = "btn btn-ghost";
		del.type = "button";
		del.textContent = "Remove";
		del.addEventListener("click", async () => {
			del.disabled = true;
			try {
				if (!(await authFetch(`/api/agents/${encodeURIComponent(agentGroupId)}/env?name=${encodeURIComponent(name)}`, {
					method: "DELETE",
					headers: { "X-Webchat-CSRF": "1" }
				})).ok) throw new Error("delete failed");
				showToast(`Removed $${name} — applies when the agent restarts`);
				renderAgentEnv(agentGroupId);
			} catch {
				del.disabled = false;
				showToast("Could not remove variable", { kind: "error" });
			}
		});
		row.append(label, del);
		box.append(row);
	}
	const save = $("#agent-env-save");
	if (save && !save.dataset.wired) {
		save.dataset.wired = "1";
		save.addEventListener("click", async () => {
			const id = $("#agent-secrets-section").dataset.agentId;
			const name = $("#agent-env-name").value.trim();
			const value = $("#agent-env-value").value;
			if (!name || !value) {
				showToast("Name and value are required", { kind: "error" });
				return;
			}
			save.disabled = true;
			try {
				const r = await authFetch(`/api/agents/${encodeURIComponent(id)}/env`, {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						"X-Webchat-CSRF": "1"
					},
					body: JSON.stringify({
						name,
						value
					})
				});
				if (!r.ok) {
					showToast((await r.json().catch(() => ({}))).error || "Could not add variable", { kind: "error" });
					return;
				}
				$("#agent-env-value").value = "";
				$("#agent-env-name").value = "";
				showToast(`Added $${name} — applies when the agent restarts`);
				renderAgentEnv(id);
			} finally {
				save.disabled = false;
			}
		});
	}
}
async function renderAgentSecrets(agentGroupId) {
	const section = $("#agent-secrets-section");
	if (!section) return;
	if (!agentSecretsWired) {
		agentSecretsWired = true;
		$("#agent-secret-save").addEventListener("click", () => {
			const agentGroupId = $("#agent-secrets-section").dataset.agentId;
			const personal = $("#agent-secret-personal").checked;
			saveToolSecret(personal ? {
				agentGroupId,
				userId: myUserId
			} : agentGroupId, "#agent-secret");
		});
		wireCustomScheme("#agent-secret");
	}
	section.dataset.agentId = agentGroupId;
	let isolation = null;
	let secrets = [];
	let members = [];
	try {
		const r = await authFetch(toolSecretUrl(agentGroupId));
		if (r.ok) {
			const b = await r.json();
			isolation = b.isolation;
			secrets = b.secrets || [];
			members = b.members || [];
		}
	} catch {}
	const isolated = !!isolation?.isolated;
	$("#agent-secrets-note").textContent = !isolated && isolation?.available ? "Not private yet — secrets added here would also reach other agents" : "";
	$("#agent-secret-form").hidden = false;
	const enrolled = members.some((m) => m.userId === myUserId);
	const personalBox = $("#agent-secret-personal");
	const personalRow = $("#agent-secret-personal-row");
	personalRow.hidden = !enrolled;
	if (!enrolled) personalBox.checked = false;
	renderAgentSecretList(agentGroupId, secrets, members);
	const total = secrets.length + members.reduce((n, m) => n + m.secrets.length, 0);
	$("#agent-secrets-count").textContent = total ? String(total) : "";
}
/**
* One row per credential: the host, a scope pill, and Remove.
*
* The pill (not prose) carries ownership because it is the thing you scan for —
* and `personal` gets the accent colour because it is the EXCEPTION worth
* noticing; shared is the default and stays neutral. Reuses the `.skill-badge`
* vocabulary already used for skill provenance, so the panel doesn't invent a
* second badge language.
*/
function renderAgentSecretList(agentGroupId, secrets, members) {
	const list = $("#agent-secrets-list");
	list.innerHTML = "";
	const row = (sec, scope, personal, ownerLabel) => {
		const li = document.createElement("li");
		li.className = "skill-source-row secret-row";
		const info = document.createElement("div");
		info.className = "skill-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		const hostEl = document.createElement("span");
		hostEl.textContent = sec.hostPattern;
		const pill = document.createElement("span");
		pill.className = "skill-badge secret-scope" + (personal ? " skill-badge-user" : "");
		pill.textContent = personal ? "personal" : "shared";
		head.append(hostEl, pill);
		info.appendChild(head);
		if (personal) {
			const who = document.createElement("span");
			who.className = "skill-desc";
			who.textContent = ownerLabel;
			info.appendChild(who);
		}
		const del = document.createElement("button");
		del.className = "btn btn-danger";
		del.type = "button";
		del.textContent = "Remove";
		del.addEventListener("click", () => void removeToolSecret(scope, sec, "#agent-secrets-list", agentGroupId));
		li.append(info, del);
		return li;
	};
	for (const s of secrets) list.appendChild(row(s, agentGroupId, false));
	for (const m of members) for (const s of m.secrets) list.appendChild(row(s, {
		agentGroupId,
		userId: m.userId
	}, true, userDisplayName({ id: m.userId })));
}
async function renderMyCredentials() {
	const section = $("#settings-my-credentials");
	if (!section) return;
	let groups = [];
	try {
		const r = await authFetch("/api/tool-secrets/mine");
		if (r.ok) groups = (await r.json()).groups || [];
	} catch {
		groups = [];
	}
	section.hidden = groups.length === 0;
	if (!groups.length) return;
	const host = $("#my-credentials-list");
	host.innerHTML = "";
	for (const g of groups) host.appendChild(myCredentialGroupEl(g));
}
function myCredentialGroupEl(group) {
	const scope = {
		agentGroupId: group.agentGroupId,
		userId: myUserId
	};
	const wrap = document.createElement("div");
	wrap.className = "my-cred-group";
	const title = document.createElement("span");
	title.className = "form-label";
	title.textContent = group.name;
	wrap.appendChild(title);
	const list = document.createElement("ul");
	list.className = "skill-sources-list";
	for (const sec of group.secrets) {
		const li = document.createElement("li");
		li.className = "skill-source-row secret-row";
		const info = document.createElement("div");
		info.className = "skill-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		head.textContent = sec.hostPattern;
		info.appendChild(head);
		const del = document.createElement("button");
		del.className = "btn btn-danger";
		del.type = "button";
		del.textContent = "Remove";
		del.addEventListener("click", async () => {
			await removeToolSecret(scope, sec, null);
			await renderMyCredentials();
		});
		li.append(info, del);
		list.appendChild(li);
	}
	wrap.appendChild(list);
	const form = document.createElement("div");
	form.className = "secret-form";
	const hostField = fieldEl("Host", "text", "dev.azure.com");
	const valField = fieldEl("Token or key", "password", "");
	const save = document.createElement("button");
	save.className = "btn btn-primary";
	save.type = "button";
	save.textContent = "Add secret";
	save.addEventListener("click", async () => {
		const hostPattern = hostField.input.value.trim();
		const value = valField.input.value;
		if (!hostPattern || !value) {
			showToast("Host and value are required", { kind: "error" });
			return;
		}
		save.disabled = true;
		try {
			const r = await authFetch(toolSecretUrl(scope), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Webchat-CSRF": "1"
				},
				body: JSON.stringify({
					hostPattern,
					value
				})
			});
			if (!r.ok) {
				showToast((await r.json().catch(() => ({}))).error || "Could not add secret", { kind: "error" });
				return;
			}
			valField.input.value = "";
			hostField.input.value = "";
			showToast(`Added ${hostPattern}`);
			await renderMyCredentials();
		} catch {
			showToast("Could not add secret", { kind: "error" });
		} finally {
			save.disabled = false;
		}
	});
	form.append(hostField.label, valField.label, save);
	wrap.appendChild(form);
	return wrap;
}
/** Labelled input matching the .secret-field pattern used in the static forms. */
function fieldEl(labelText, type, placeholder) {
	const label = document.createElement("label");
	label.className = "secret-field";
	const span = document.createElement("span");
	span.className = "form-label";
	span.textContent = labelText;
	const input = document.createElement("input");
	input.type = type;
	if (placeholder) input.placeholder = placeholder;
	input.autocomplete = type === "password" ? "new-password" : "off";
	input.spellcheck = false;
	label.append(span, input);
	return {
		label,
		input
	};
}
var agentKeysWired = false;
async function renderAgentKeys(agentGroupId) {
	const section = $("#agent-keys-section");
	if (!section) return;
	if (!agentKeysWired) {
		agentKeysWired = true;
		$("#agent-key-create").addEventListener("click", () => void createAgentKey());
	}
	section.dataset.agentId = agentGroupId;
	let keys = [];
	try {
		const r = await authFetch(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId)}`);
		if (r.ok) keys = (await r.json()).keys || [];
	} catch {}
	const list = $("#agent-keys-list");
	list.innerHTML = "";
	for (const k of keys) list.appendChild(deployKeyRowEl(agentGroupId, k));
	$("#agent-keys-count").textContent = keys.length ? String(keys.length) : "";
}
function deployKeyRowEl(agentGroupId, key) {
	const li = document.createElement("li");
	li.className = "skill-source-row secret-row";
	const info = document.createElement("div");
	info.className = "skill-info";
	const head = document.createElement("div");
	head.className = "skill-head";
	head.textContent = key.name;
	const meta = document.createElement("span");
	meta.className = "skill-desc";
	meta.textContent = key.target ? `ssh -i ${key.path} ${key.target}` : `${key.path} · no login target set`;
	info.append(head, meta);
	const actions = document.createElement("div");
	actions.className = "secret-actions";
	const copy = document.createElement("button");
	copy.className = "btn btn-secondary";
	copy.type = "button";
	copy.textContent = "Copy public key";
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(key.publicKey);
			showToast("Public key copied");
		} catch {
			showToast("Could not copy", { kind: "error" });
		}
	});
	const del = document.createElement("button");
	del.className = "btn btn-danger";
	del.type = "button";
	del.textContent = "Remove";
	del.addEventListener("click", () => void removeAgentKey(agentGroupId, key));
	actions.append(copy, del);
	li.append(info, actions);
	return li;
}
async function createAgentKey() {
	const agentGroupId = $("#agent-keys-section").dataset.agentId;
	const name = $("#agent-key-name").value.trim().toLowerCase();
	$("#agent-key-target").value.trim();
	if (!name) {
		showToast("Name is required", { kind: "error" });
		return;
	}
	const btn = $("#agent-key-create");
	btn.disabled = true;
	try {
		const r = await authFetch(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId)}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ name })
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok) {
			showToast(body.error || "Could not create key", { kind: "error" });
			return;
		}
		$("#agent-key-name").value = "";
		$("#agent-key-target").value = "";
		try {
			await navigator.clipboard.writeText(body.key.publicKey);
			showToast(`Created ${name} — public key copied`);
		} catch {
			showToast(`Created ${name}`);
		}
		await renderAgentKeys(agentGroupId);
	} catch {
		showToast("Could not create key", { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
async function removeAgentKey(agentGroupId, key) {
	if (!await showConfirmModal({
		title: "Remove deploy key",
		body: `Delete “${key.name}”? Anything using it to authenticate will stop working.`,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	if (!(await authFetch(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId)}&name=${encodeURIComponent(key.name)}`, {
		method: "DELETE",
		headers: { "X-Webchat-CSRF": "1" }
	})).ok) {
		showToast("Could not remove key", { kind: "error" });
		return;
	}
	showToast(`Removed ${key.name}`);
	await renderAgentKeys(agentGroupId);
}
async function renderMcpSources() {
	const list = $("#mcp-sources-list");
	const section = $("#settings-mcp-sources");
	if (!list || !section) return;
	let sources = [];
	try {
		const res = await authFetch("/api/mcp-sources");
		if (!res.ok) {
			section.hidden = true;
			return;
		}
		sources = (await res.json()).sources || [];
	} catch {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	list.innerHTML = "";
	for (const src of sources) {
		const off = !!(src.removed || src.disabled);
		mcpRegistryDisabled = off;
		const li = document.createElement("li");
		li.className = "skill-source-row";
		if (off) li.classList.add("source-disabled");
		const info = document.createElement("div");
		info.className = "skill-info";
		const head = document.createElement("div");
		head.className = "skill-head";
		head.appendChild(originBadgeEl({
			label: "MCP registry",
			url: src.url,
			official: false
		}));
		const meta = document.createElement("span");
		meta.className = "skill-desc";
		meta.textContent = off ? "Removed from Add MCP server" : src.url.replace(/^https?:\/\//, "");
		info.append(head, meta);
		li.appendChild(info);
		const tag = document.createElement("span");
		tag.className = "skill-badge";
		tag.textContent = "built-in";
		li.appendChild(tag);
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = off ? "btn btn-ghost" : "skill-delete";
		toggle.textContent = off ? "Add" : "Remove";
		toggle.addEventListener("click", async () => {
			try {
				const res = await authFetch(`/api/mcp-sources/${encodeURIComponent(src.id)}`, { method: off ? "POST" : "DELETE" });
				if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
				renderMcpSources();
				applyMcpCatalogVisibility();
			} catch (err) {
				toastError(err, "Could not update the source");
			}
		});
		li.appendChild(toggle);
		list.appendChild(li);
	}
	applyMcpCatalogVisibility();
}
/**
* The learning loop's explicit trigger (docs/webchat/design/learning-loop.md §1): reviews
* THIS session and drafts a skill only if it taught something. It just sends
* `/learn` — one path, the same one the slash command takes, so there's no second
* implementation to keep in step.
*
* Only offered for the room you're actually in: `/learn` reviews the session, and
* the session is the one you have open.
*/
function renderDistillButton(agents) {
	const host = $("#room-skills-section .form-label-row");
	const existing = $("#room-distill-btn");
	if (existing) existing.remove();
	if (!host || !agents.length || selectedRoomId !== currentRoom) return;
	const btn = document.createElement("button");
	btn.id = "room-distill-btn";
	btn.type = "button";
	btn.className = "btn btn-secondary";
	btn.textContent = "Distill a skill…";
	btn.title = "Review this session and draft a skill if it taught something worth keeping";
	btn.addEventListener("click", () => {
		closeRoomDetail();
		triggerLearn();
	});
	host.appendChild(btn);
}
/** Hide the catalog entirely when its source is switched off. */
function applyMcpCatalogVisibility() {
	const block = $("#mcp-catalog-block");
	if (block) block.hidden = mcpRegistryDisabled;
}
async function loadMcpCatalog(q = "") {
	const list = $("#mcp-catalog-list");
	const status = $("#mcp-catalog-status");
	if (!list) return;
	list.innerHTML = loadingRow(q ? "Searching…" : "Loading catalog…");
	status.textContent = "";
	let servers = [];
	try {
		const payload = await apiJson(`/api/mcp-catalog${q ? `?q=${encodeURIComponent(q)}` : ""}`);
		if (payload.disabled) {
			mcpRegistryDisabled = true;
			applyMcpCatalogVisibility();
			return;
		}
		servers = payload.servers || [];
	} catch (err) {
		list.innerHTML = "";
		status.textContent = err.message || "Couldn't reach the registry";
		return;
	}
	status.textContent = servers.length ? `${servers.length} servers` : "No servers matched";
	list.innerHTML = "";
	for (const s of servers) {
		const li = document.createElement("li");
		li.className = "mcp-catalog-row";
		const head = document.createElement("div");
		head.className = "mcp-catalog-head";
		const title = document.createElement("span");
		title.className = "mcp-catalog-title";
		title.textContent = s.title || s.name;
		head.appendChild(title);
		if (s.publisher) head.appendChild(originBadgeEl({
			label: s.publisher,
			official: false,
			url: s.repoUrl || s.websiteUrl || ""
		}));
		const kind = document.createElement("span");
		kind.className = s.runsCode ? "mcp-kind mcp-kind-code" : "mcp-kind";
		kind.textContent = s.runsCode ? `${s.command === "uvx" ? "pypi" : "npm"} · runs in container` : "remote";
		head.appendChild(kind);
		const desc = document.createElement("div");
		desc.className = "mcp-catalog-desc";
		desc.textContent = s.description || "";
		const target = document.createElement("div");
		target.className = "mcp-catalog-target";
		if (s.runsCode) target.textContent = `${s.command} ${(s.args || []).join(" ")}`;
		else if (s.url) try {
			target.textContent = `connects to ${new URL(s.url).host}`;
		} catch {
			target.textContent = `connects to ${s.url}`;
		}
		const actions = document.createElement("div");
		actions.className = "mcp-catalog-actions";
		const use = document.createElement("button");
		use.type = "button";
		use.className = "btn btn-secondary";
		use.textContent = "Use";
		use.addEventListener("click", () => useMcpCatalogEntry(s));
		actions.appendChild(use);
		li.append(head, desc, target, actions);
		list.appendChild(li);
	}
}
/** Prefill the add form from a catalog row. Package servers gate on an explicit confirm. */
async function useMcpCatalogEntry(s) {
	if (s.runsCode) {
		const cmd = `${s.command} ${(s.args || []).join(" ")}`;
		if (!await showConfirmModal({
			title: `Run ${s.name} in your container?`,
			body: `This isn't a hosted server. It runs code inside your agent container, alongside the agent's credentials:\n\n${cmd}\n\nOnly continue if you trust the publisher (${s.publisher || "unknown"}).`,
			confirmLabel: "I trust it — fill in the form",
			destructive: true
		})) return;
	}
	const shortName = String(s.name).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	$("#mcp-create-name").value = shortName;
	const transport = $("#mcp-create-transport");
	if (s.kind === "remote") {
		transport.value = s.transport === "sse" ? "sse" : "http";
		transport.dispatchEvent(new Event("change"));
		$("#mcp-create-url").value = s.url || "";
		const probeUrl = $("#mcp-probe-url");
		if (probeUrl) probeUrl.value = s.url || "";
	} else {
		transport.value = "stdio";
		transport.dispatchEvent(new Event("change"));
		$("#mcp-create-command").value = s.command || "";
		$("#mcp-create-args").value = (s.args || []).join(" ");
	}
	const block = $("#mcp-catalog-block");
	if (block) block.open = false;
	showToast(s.kind === "remote" ? `Filled in ${shortName} — probe it, then add` : `Filled in ${shortName} — review the command, then add`);
	$("#mcp-create-name").scrollIntoView({
		behavior: "smooth",
		block: "center"
	});
}
(function wireMcpCatalog() {
	const block = document.getElementById("mcp-catalog-block");
	const search = document.getElementById("mcp-catalog-search");
	if (!block || !search) return;
	let loaded = false;
	block.addEventListener("toggle", () => {
		if (block.open && !loaded) {
			loaded = true;
			loadMcpCatalog("");
		}
	});
	search.addEventListener("input", () => {
		clearTimeout(mcpCatalogTimer);
		mcpCatalogTimer = setTimeout(() => void loadMcpCatalog(search.value.trim()), 300);
	});
})();
function renderMcpServers() {
	const list = $("#mcp-list");
	list.innerHTML = "";
	if (allMcpServers.length === 0) {
		const li = document.createElement("li");
		li.style.cursor = "default";
		li.style.opacity = "0.6";
		li.textContent = "No MCP servers registered. Click \"+ New server\" to add one.";
		list.appendChild(li);
		return;
	}
	const sorted = [...allMcpServers].sort((a, b) => a.name.localeCompare(b.name));
	for (const server of sorted) {
		const li = document.createElement("li");
		li.dataset.mcpId = server.id;
		if (server.id === selectedMcpId) li.classList.add("active");
		const badge = document.createElement("span");
		badge.className = `model-kind-badge kind-${server.transport}`;
		badge.textContent = server.transport;
		li.appendChild(badge);
		if (server.health && server.transport !== "stdio") {
			const dot = document.createElement("span");
			const st = server.health.status;
			dot.className = `mcp-health-dot mcp-health-${st}`;
			dot.title = st === "ok" ? `Healthy — ${server.health.toolCount ?? "?"} tools` : st === "drift" ? "Tool surface changed since approval" : st === "auth" ? "Rejecting credentials" : `Unreachable${server.health.reason ? `: ${server.health.reason}` : ""}`;
			li.appendChild(dot);
		}
		const name = document.createElement("span");
		name.className = "model-row-name";
		name.textContent = server.name;
		li.appendChild(name);
		if (server.agents_assigned > 0) {
			const uses = document.createElement("span");
			uses.className = "model-row-uses";
			uses.textContent = `${server.agents_assigned}×`;
			li.appendChild(uses);
		}
		makeRowActivatable(li, () => {
			if (selectedMcpId === server.id && !$("#mcp-detail").hidden) closeMcpDetail();
			else openMcpDetail(server.id);
		});
		list.appendChild(li);
	}
}
function openMcpDetail(id) {
	const server = allMcpServers.find((s) => s.id === id);
	if (!server) return;
	closeAgentDetail();
	closeRoomDetail();
	closeModelDetail();
	closeMcpDetail();
	selectedMcpId = id;
	renderMcpServers();
	$("#mcp-edit-view").hidden = false;
	$("#mcp-create-view").hidden = true;
	$("#mcp-detail-title").textContent = server.name;
	$("#mcp-name").value = server.name;
	$("#mcp-transport").value = server.transport;
	const remote = server.transport !== "stdio";
	$("#mcp-url-label").hidden = !remote;
	$("#mcp-command-label").hidden = remote;
	$("#mcp-token-label").hidden = !remote;
	$("#mcp-token").value = "";
	if (remote) $("#mcp-url").value = server.target;
	else $("#mcp-command").value = server.target;
	const usage = $("#mcp-detail-usage");
	usage.textContent = server.agents_assigned > 0 ? `Attached to ${server.agents_assigned} agent${server.agents_assigned === 1 ? "" : "s"}.` : "Not attached to any agent yet.";
	renderMcpHardening(server);
	$("#mcp-detail").hidden = false;
	$("#members-panel").hidden = true;
}
function renderMcpHardening(server) {
	const host = $("#mcp-hardening");
	if (!host) return;
	host.innerHTML = "";
	if (server.transport === "stdio") return;
	if (server.health) {
		const line = document.createElement("p");
		line.className = "room-prime-note";
		const st = server.health.status;
		const when = server.health.at ? new Date(server.health.at).toLocaleString() : "";
		line.textContent = st === "ok" ? `● Healthy — ${server.health.toolCount ?? "?"} tools (checked ${when})` : st === "auth" ? `● Rejecting credentials (checked ${when})` : st === "down" ? `● Unreachable (checked ${when})` : `● Tool surface changed (checked ${when})`;
		line.classList.add(`mcp-health-text-${st}`);
		host.appendChild(line);
	}
	if (server.drift) {
		const banner = document.createElement("div");
		banner.className = "mcp-drift-banner";
		const head = document.createElement("div");
		head.textContent = "Tools changed since you approved this server";
		head.style.fontWeight = "600";
		banner.appendChild(head);
		const parts = [];
		if (server.drift.added?.length) parts.push(`new: ${server.drift.added.join(", ")}`);
		if (server.drift.removed?.length) parts.push(`removed: ${server.drift.removed.join(", ")}`);
		if (server.drift.changed?.length) parts.push(`descriptions changed: ${server.drift.changed.join(", ")}`);
		const detail = document.createElement("div");
		detail.textContent = parts.join(" · ");
		banner.appendChild(detail);
		const approve = document.createElement("button");
		approve.type = "button";
		approve.className = "btn btn-secondary";
		approve.textContent = "Review + re-approve";
		approve.addEventListener("click", async () => {
			if (!await showConfirmModal({
				title: `Approve ${server.name}'s new tools?`,
				body: parts.join("\n") || "The tool surface changed.",
				confirmLabel: "Approve current tools"
			})) return;
			try {
				await apiJson(`/api/mcp-servers/${encodeURIComponent(server.id)}/repin`, { method: "POST" });
				showToast("Tool surface re-approved", { kind: "success" });
				await fetchMcpServers();
				openMcpDetail(server.id);
			} catch (err) {
				showToast("Re-approve failed: " + (err.message || err), { kind: "error" });
			}
		});
		banner.appendChild(approve);
		host.appendChild(banner);
	}
	if (Array.isArray(server.pinned_tools) && server.pinned_tools.length) {
		const wrap = document.createElement("div");
		const label = document.createElement("span");
		label.className = "form-label";
		label.textContent = `Tools (${server.pinned_tools.length})`;
		wrap.appendChild(label);
		const listEl = document.createElement("div");
		listEl.className = "mcp-tools-list";
		const enabled = Array.isArray(server.enabled_tools) ? new Set(server.enabled_tools) : null;
		for (const t of server.pinned_tools) {
			const row = document.createElement("label");
			row.className = "mcp-tool-row";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = enabled ? enabled.has(t.name) : true;
			cb.dataset.tool = t.name;
			const nm = document.createElement("span");
			nm.textContent = t.name;
			nm.title = t.description || "";
			row.append(cb, nm);
			listEl.appendChild(row);
		}
		wrap.appendChild(listEl);
		const save = document.createElement("button");
		save.type = "button";
		save.className = "btn btn-secondary";
		save.textContent = "Save tool selection";
		save.addEventListener("click", async () => {
			const boxes = [...listEl.querySelectorAll("input[type=checkbox]")];
			const chosen = boxes.filter((b) => b.checked).map((b) => b.dataset.tool);
			const body = { enabled: chosen.length === boxes.length ? null : chosen };
			try {
				await apiJson(`/api/mcp-servers/${encodeURIComponent(server.id)}/tools`, {
					method: "PUT",
					body
				});
				showToast(body.enabled ? `${chosen.length} of ${boxes.length} tools enabled` : "All tools enabled", { kind: "success" });
				await fetchMcpServers();
			} catch (err) {
				showToast("Save failed: " + (err.message || err), { kind: "error" });
			}
		});
		wrap.appendChild(save);
		host.appendChild(wrap);
	}
	const oauthBtn = document.createElement("button");
	oauthBtn.type = "button";
	oauthBtn.className = "btn btn-ghost";
	oauthBtn.textContent = server.auth?.kind === "oauth" ? "Reconnect (OAuth)" : "Connect with OAuth…";
	oauthBtn.addEventListener("click", async () => {
		oauthBtn.disabled = true;
		try {
			const res = await authFetch(`/api/mcp-servers/${encodeURIComponent(server.id)}/oauth/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}"
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.error || res.statusText);
			window.open(body.authorizeUrl, "_blank", "noopener");
			showToast("Finish authorizing in the new tab, then come back", { kind: "info" });
		} catch (err) {
			showToast("OAuth failed: " + (err.message || err), { kind: "error" });
		} finally {
			oauthBtn.disabled = false;
		}
	});
	host.appendChild(oauthBtn);
	if (server.auth) {
		const note = document.createElement("p");
		note.className = "room-prime-note";
		note.textContent = server.auth.kind === "oauth" ? "Connected via OAuth — the token lives on the host; agents go through the relay." : "Bearer token stored on the host — agents go through the relay, the token never enters a container.";
		host.appendChild(note);
	}
}
function closeMcpDetail() {
	$("#mcp-detail").hidden = true;
	$("#mcp-edit-view").hidden = false;
	$("#mcp-create-view").hidden = true;
	selectedMcpId = null;
	if (manageActive && manageTab === "mcp") renderMcpServers();
}
$("#mcp-detail-close").addEventListener("click", closeMcpDetail);
$("#mcp-create-close").addEventListener("click", closeMcpDetail);
$("#create-mcp-btn").addEventListener("click", () => {
	selectedMcpId = null;
	renderMcpServers();
	closeAgentDetail();
	closeRoomDetail();
	closeModelDetail();
	closeMcpDetail();
	$("#mcp-edit-view").hidden = true;
	$("#mcp-create-view").hidden = false;
	$("#mcp-probe-url").value = "";
	$("#mcp-probe-status").hidden = true;
	$("#mcp-probe-results").hidden = true;
	$("#mcp-probe-name").value = "";
	$("#mcp-probe-token").value = "";
	$("#mcp-probe-token-label").hidden = true;
	lastMcpProbe = null;
	lastMcpProbeToken = "";
	$("#mcp-create-name").value = "";
	$("#mcp-create-url").value = "";
	$("#mcp-create-command").value = "";
	$("#mcp-create-args").value = "";
	$("#mcp-create-token").value = "";
	$("#mcp-create-transport").value = "sse";
	syncMcpCreateTransportFields();
	$("#mcp-detail").hidden = false;
	$("#members-panel").hidden = true;
});
function syncMcpCreateTransportFields() {
	const remote = $("#mcp-create-transport").value !== "stdio";
	$("#mcp-create-token-label").hidden = !remote;
	$("#mcp-create-url-label").hidden = !remote;
	$("#mcp-create-command-label").hidden = remote;
	$("#mcp-create-args-label").hidden = remote;
}
$("#mcp-create-transport").addEventListener("change", syncMcpCreateTransportFields);
var lastMcpProbeToken = "";
function mcpProbeAuthHeaders() {
	const token = $("#mcp-probe-token").value.trim();
	return token ? { Authorization: `Bearer ${token}` } : void 0;
}
async function runMcpProbe() {
	const url = $("#mcp-probe-url").value.trim();
	if (!url) {
		showToast("Enter a server URL first (e.g. host:8000/sse).", { kind: "error" });
		return;
	}
	if (/\s|[<>]/.test(url)) {
		showToast("URL contains invalid characters.", { kind: "error" });
		return;
	}
	const status = $("#mcp-probe-status");
	const results = $("#mcp-probe-results");
	status.classList.remove("error");
	status.textContent = "Probing… (connects to the server and lists its tools)";
	status.hidden = false;
	results.hidden = true;
	$("#mcp-probe-btn").disabled = true;
	try {
		const headers = mcpProbeAuthHeaders();
		const res = await authFetch("/api/mcp-servers/probe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(headers ? {
				url,
				headers
			} : { url })
		});
		const body = await res.json();
		if (!res.ok) {
			status.textContent = body.error || `Probe failed (${res.status})`;
			status.classList.add("error");
			return;
		}
		if (!body.transport) {
			if (body.requiresAuth) {
				const tokenLabel = $("#mcp-probe-token-label");
				const hadToken = Boolean(headers);
				tokenLabel.hidden = false;
				status.textContent = hadToken ? "The server rejected that token — check it and probe again." : "This server requires a bearer token — enter it below and probe again.";
				status.classList.add("error");
				$("#mcp-probe-token").focus();
				return;
			}
			status.textContent = body.reason || "No MCP server responded.";
			status.classList.add("error");
			return;
		}
		lastMcpProbe = body;
		lastMcpProbeToken = $("#mcp-probe-token").value.trim();
		status.hidden = true;
		renderMcpProbeResults(body);
	} catch (err) {
		status.textContent = "Probe failed: " + err.message;
		status.classList.add("error");
	} finally {
		$("#mcp-probe-btn").disabled = false;
	}
}
function renderMcpProbeResults(probe) {
	$("#mcp-probe-kind").className = `model-probe-kind kind-${probe.transport}`;
	$("#mcp-probe-kind").textContent = probe.transport;
	const n = probe.tools.length;
	$("#mcp-probe-notes").textContent = `${probe.serverName || "MCP server"}${probe.serverVersion ? " v" + probe.serverVersion : ""} — ${n} tool${n === 1 ? "" : "s"}`;
	const list = $("#mcp-probe-tools");
	list.innerHTML = "";
	if (n === 0) {
		const li = document.createElement("li");
		li.className = "empty-note";
		li.textContent = "Connected, but the server advertises no tools.";
		list.appendChild(li);
	} else for (const tool of probe.tools) {
		const li = document.createElement("li");
		const name = document.createElement("b");
		name.textContent = tool.name;
		li.appendChild(name);
		if (tool.description) {
			const desc = document.createElement("span");
			desc.textContent = ` — ${tool.description}`;
			desc.style.opacity = "0.75";
			li.appendChild(desc);
		}
		list.appendChild(li);
	}
	if (!$("#mcp-probe-name").value && probe.serverName) $("#mcp-probe-name").value = probe.serverName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	$("#mcp-probe-results").hidden = false;
}
$("#mcp-probe-btn").addEventListener("click", runMcpProbe);
$("#mcp-probe-url").addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		runMcpProbe();
	}
});
$("#mcp-probe-add").addEventListener("click", async () => {
	if (!lastMcpProbe) return;
	const name = $("#mcp-probe-name").value.trim();
	if (!name) {
		showToast("Give the server a name first.", { kind: "error" });
		return;
	}
	const body = {
		name,
		transport: lastMcpProbe.transport,
		url: lastMcpProbe.endpoint
	};
	if (lastMcpProbeToken) body.headers = { Authorization: `Bearer ${lastMcpProbeToken}` };
	await createMcpServer(body, $("#mcp-probe-add"));
});
$("#mcp-create-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const transport = $("#mcp-create-transport").value;
	const body = {
		name: $("#mcp-create-name").value.trim(),
		transport
	};
	if (transport === "stdio") {
		body.command = $("#mcp-create-command").value.trim();
		body.args = $("#mcp-create-args").value.split("\n").map((l) => l.trim()).filter(Boolean);
	} else {
		body.url = $("#mcp-create-url").value.trim();
		const token = $("#mcp-create-token").value.trim();
		if (token) body.headers = { Authorization: `Bearer ${token}` };
	}
	await createMcpServer(body, $("#mcp-create-form button.btn-primary"));
});
async function createMcpServer(body, btn) {
	btn.disabled = true;
	try {
		const created = await apiJson("/api/mcp-servers", {
			method: "POST",
			body
		});
		showToast(`Added ${body.name}`, { kind: "success" });
		closeMcpDetail();
		await fetchMcpServers();
		await maybeAttachAfterMcpAdd(created.id || allMcpServers.find((s) => s.name === body.name)?.id, body.name);
	} catch (err) {
		showToast("Add failed: " + (err.message || err), { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
$("#mcp-detail-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	if (!selectedMcpId) return;
	const server = allMcpServers.find((s) => s.id === selectedMcpId);
	if (!server) return;
	const body = { name: $("#mcp-name").value.trim() };
	if (server.transport === "stdio") body.command = $("#mcp-command").value.trim();
	else body.url = $("#mcp-url").value.trim();
	const token = server.transport !== "stdio" ? $("#mcp-token").value.trim() : "";
	try {
		await apiJson(`/api/mcp-servers/${encodeURIComponent(selectedMcpId)}`, {
			method: "PUT",
			body
		});
		if (token) await apiJson(`/api/mcp-servers/${encodeURIComponent(selectedMcpId)}/auth`, {
			method: "PUT",
			body: { token }
		});
		showToast("Saved", { kind: "success" });
		closeMcpDetail();
		await fetchMcpServers();
	} catch (err) {
		showToast("Save failed: " + (err.message || err), { kind: "error" });
	}
});
$("#mcp-delete").addEventListener("click", async () => {
	if (!selectedMcpId) return;
	const server = allMcpServers.find((s) => s.id === selectedMcpId);
	if (!server) return;
	try {
		const res = await authFetch(`/api/mcp-servers/${encodeURIComponent(selectedMcpId)}`, { method: "DELETE" });
		if (res.status === 409) {
			const n = ((await res.json()).assigned_agent_group_ids || []).length;
			if (!await showConfirmModal({
				title: "Delete MCP server",
				body: `"${server.name}" is attached to ${n} agent${n === 1 ? "" : "s"}. They lose its tools on their next message.`,
				confirmLabel: "Delete anyway",
				destructive: true
			})) return;
			const force = await authFetch(`/api/mcp-servers/${encodeURIComponent(selectedMcpId)}?force=1`, { method: "DELETE" });
			if (!force.ok) {
				showToast(`Failed to delete: ${(await force.json().catch(() => ({}))).error || force.statusText}`, { kind: "error" });
				return;
			}
		} else if (!res.ok) {
			showToast(`Failed to delete: ${(await res.json().catch(() => ({}))).error || res.statusText}`, { kind: "error" });
			return;
		}
		showToast(`Deleted "${server.name}".`, { kind: "success" });
		closeMcpDetail();
		await fetchMcpServers();
	} catch (err) {
		showToast(`Failed to delete: ${err.message}`, { kind: "error" });
	}
});
function populateAgentModelSelect(currentModelId) {
	$("#agent-model").value = currentModelId || "";
	refreshAgentModelTrigger();
}
/**
* Update the picker trigger button's labels to reflect the currently-
* assigned model. Two-line layout: name on top, kind+model_id+host underneath.
* No selection → "Default" / "Built-in Anthropic".
*/
function refreshAgentModelTrigger() {
	const trigger = $("#agent-model-trigger");
	if (!trigger) return;
	const id = $("#agent-model").value;
	const nameEl = trigger.querySelector(".model-picker-trigger-name");
	const metaEl = trigger.querySelector(".model-picker-trigger-meta");
	if (!id) {
		nameEl.textContent = "Default";
		const derived = allAgents.find((a) => a.id === selectedAgentId)?.effective_model_label;
		metaEl.textContent = derived ? `${derived} · auto-detected` : "Built-in Anthropic";
		return;
	}
	const m = allModels.find((mm) => mm.id === id);
	if (!m) {
		nameEl.textContent = "Unknown model";
		metaEl.textContent = id;
		return;
	}
	nameEl.textContent = m.name;
	const host = endpointHost(m.endpoint);
	metaEl.textContent = host ? `${modelKindLabel(m.kind)} · ${m.model_id} · ${host}` : `${modelKindLabel(m.kind)} · ${m.model_id}`;
}
function endpointHost(endpoint) {
	if (!endpoint) return "";
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
}
var pickerAddInProgress = false;
var pickerAgentForAdd = null;
function openModelPicker() {
	const picker = $("#model-picker");
	picker.hidden = false;
	picker.offsetHeight;
	picker.classList.add("open");
	$("#model-picker-search").value = "";
	renderPickerList("");
	if (window.matchMedia("(min-width: 720px)").matches) setTimeout(() => $("#model-picker-search").focus(), 60);
}
function closeModelPicker() {
	const picker = $("#model-picker");
	picker.classList.remove("open");
	setTimeout(() => {
		picker.hidden = true;
	}, 220);
}
function renderPickerList(filterText) {
	const list = $("#model-picker-list");
	list.innerHTML = "";
	const q = (filterText || "").trim().toLowerCase();
	const currentSelected = $("#agent-model").value || "";
	const derived = allAgents.find((a) => a.id === selectedAgentId)?.effective_model_label;
	const defaultRow = createPickerRow({
		id: "",
		isDefault: true,
		name: "Default",
		sub: derived ? `${derived} · auto-detected` : "Built-in Anthropic"
	}, currentSelected);
	list.appendChild(defaultRow);
	const matches = allModels.filter((m) => {
		if (isRouterBackendModel(m)) return false;
		if (!q) return true;
		const host = endpointHost(m.endpoint).toLowerCase();
		return [
			m.name,
			m.model_id,
			host,
			m.kind
		].some((s) => (s || "").toLowerCase().includes(q));
	});
	if (matches.length === 0 && allModels.length > 0 && q) {
		const empty = document.createElement("li");
		empty.className = "model-picker-empty";
		empty.textContent = `No models match "${filterText}".`;
		list.appendChild(empty);
	} else if (allModels.length === 0) {
		const empty = document.createElement("li");
		empty.className = "model-picker-empty";
		empty.textContent = "No models registered yet. Use \"+ Add new model\" below.";
		list.appendChild(empty);
	}
	for (const m of matches) list.appendChild(createPickerRow(m, currentSelected));
}
function createPickerRow(m, currentSelected) {
	const li = document.createElement("li");
	li.className = "model-picker-row";
	li.tabIndex = 0;
	if (m.isDefault) li.classList.add("is-default");
	li.dataset.modelId = m.id || "";
	if ((m.id || "") === currentSelected) li.classList.add("selected");
	const top = document.createElement("div");
	top.className = "model-picker-row-top";
	const name = document.createElement("span");
	name.className = "model-picker-row-name";
	name.textContent = m.name;
	top.appendChild(name);
	const badge = document.createElement("span");
	if (m.isDefault) {
		badge.className = "model-kind-badge model-default-badge";
		badge.textContent = "default";
	} else {
		badge.className = `model-kind-badge kind-${m.kind}`;
		badge.textContent = modelKindLabel(m.kind);
	}
	top.appendChild(badge);
	li.appendChild(top);
	const sub = document.createElement("div");
	sub.className = "model-picker-row-sub";
	if (m.isDefault) sub.textContent = m.sub || "Built-in Anthropic";
	else {
		const host = endpointHost(m.endpoint);
		sub.textContent = host ? `${m.model_id} · ${host}` : m.model_id;
	}
	li.appendChild(sub);
	const onPick = () => selectFromPicker(m.id || "");
	li.addEventListener("click", onPick);
	li.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onPick();
		}
	});
	return li;
}
function selectFromPicker(modelId) {
	$("#agent-model").value = modelId;
	refreshAgentModelTrigger();
	refreshAgentSaveDirty();
	closeModelPicker();
}
$("#agent-model-trigger").addEventListener("click", () => {
	if (selectedAgentId) openModelPicker();
});
$("#model-picker-close").addEventListener("click", closeModelPicker);
$("#model-picker .model-picker-backdrop").addEventListener("click", closeModelPicker);
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !$("#model-picker").hidden) closeModelPicker();
});
$("#model-picker-search").addEventListener("input", (e) => {
	renderPickerList(e.target.value);
});
$("#model-picker-add-new").addEventListener("click", () => {
	if (!selectedAgentId) return;
	pickerAddInProgress = true;
	pickerAgentForAdd = selectedAgentId;
	closeModelPicker();
	setTimeout(() => $("#create-model-btn").click(), 180);
});
/**
* Called from both the manual create and the probe bulk-add success paths.
* If the picker initiated this add, assign the newly-created model to the
* agent and return the user to the agent detail. Bulk-add of >1 doesn't
* auto-assign — we leave the user on the agent detail and they can re-open
* the picker to choose explicitly.
*/
async function maybeAssignAfterPickerAdd(createdIds) {
	if (!pickerAddInProgress) return false;
	const agentId = pickerAgentForAdd;
	pickerAddInProgress = false;
	pickerAgentForAdd = null;
	if (!agentId) return false;
	if (createdIds.length === 1) try {
		const mRes = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/model`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ modelId: createdIds[0] })
		});
		if (mRes.ok) warnIfUnreachable((await mRes.json()).reachability);
	} catch (err) {
		console.error("Auto-assign new model failed:", err);
	}
	await fetchAgents();
	if (typeof openAgentDetail === "function") await openAgentDetail(agentId);
	return true;
}
initApp();
//#endregion
