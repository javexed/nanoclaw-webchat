<script setup lang="ts">
/**
 * The attachment drawer: an in-app preview of a message's file, mounted into
 * <div id="attachment-drawer-root">. Right-hand panel on wide screens (resizable
 * by dragging, clicking through preset widths, or with the keyboard on its left
 * edge), a full-screen sheet on a
 * phone. Images keep the lightbox; everything else previewable opens here.
 *
 * Text is fetched and rendered by us (highlighted code, CSV table, JSON tree,
 * sanitized Markdown). PDFs load from the file URL itself in a frame: the server
 * serves every attachment with `CSP: sandbox`, so the framed document runs in an
 * opaque origin with the browser's own viewer.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { marked } from '/marked.min.js';
import DOMPurify from '/dompurify.min.js';
import { authFetch } from '../core/api.js';
import { lightboxOpen } from './modals-state.js';
import JsonNode from './JsonNode.vue';
import {
  CSV_ROW_LIMIT,
  TEXT_PREVIEW_MAX,
  clampDrawerWidth,
  codeLanguage,
  csvDelimiter,
  drawerMax,
  drawerWidthText,
  isTap,
  nextPresetWidth,
  DRAWER_MIN,
  formatSize,
  highlight,
  loadDrawerWidth,
  parseCsv,
  previewKind,
  resizeByKey,
  saveDrawerWidth,
  HTML_PREVIEW_MAX,
  htmlFrameUrl,
} from './attachment-preview.js';
import { composeTextFrom } from './attachment-compose.js';
import { prefillComposer } from './compose-prefill.js';
import { closeAttachmentDrawer, drawerFile } from './attachment-drawer-state.js';

// Storage, listeners and the saved width are all taken on OPEN, not at mount:
// the island mounts during boot, and boot is kept free of side effects that
// only matter once a file is being previewed.
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const viewport = ref(window.innerWidth);
const width = ref(0);
const maxWidth = computed(() => drawerMax(viewport.value));

const file = drawerFile;
const kind = computed(() => (file.value ? previewKind(file.value.filename, file.value.mime) : null));
const tooLarge = computed(
  () =>
    !!file.value &&
    ((['markdown', 'csv', 'json', 'code', 'text'].includes(kind.value ?? '') &&
      (file.value.size ?? 0) > TEXT_PREVIEW_MAX) ||
      (kind.value === 'html' && (file.value.size ?? 0) > HTML_PREVIEW_MAX)),
);

const loading = ref(false);
const failed = ref(false);
const mediaFailed = ref(false);
const text = ref<string | null>(null);
let loadSeq = 0;

async function loadText(): Promise<void> {
  const f = file.value;
  const seq = ++loadSeq;
  text.value = null;
  failed.value = false;
  mediaFailed.value = false;
  if (!f || !kind.value || tooLarge.value || ['pdf', 'video', 'audio', 'html'].includes(kind.value)) return;
  loading.value = true;
  try {
    const res = await authFetch(f.url);
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.text();
    if (seq === loadSeq) text.value = body.length > TEXT_PREVIEW_MAX ? body.slice(0, TEXT_PREVIEW_MAX) : body;
  } catch {
    if (seq === loadSeq) failed.value = true;
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

const codeHtml = computed(() => {
  if (text.value === null || !file.value) return '';
  const lang = kind.value === 'json' ? 'json' : kind.value === 'code' ? codeLanguage(file.value.filename) : null;
  return highlight(text.value, lang);
});

const json = computed<{ ok: true; value: unknown } | { ok: false }>(() => {
  if (kind.value !== 'json' || text.value === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch {
    return { ok: false };
  }
});

const csv = computed(() => {
  if (kind.value !== 'csv' || text.value === null || !file.value) return null;
  const rows = parseCsv(text.value, csvDelimiter(file.value.filename), CSV_ROW_LIMIT + 1);
  const [head = [], ...body] = rows;
  return { head, body: body.slice(0, CSV_ROW_LIMIT), truncated: body.length > CSV_ROW_LIMIT };
});

// Same sanitizer settings as message bodies (transcript.ts): no forms, no style.
const markdownHtml = computed(() => {
  if (kind.value !== 'markdown' || text.value === null) return '';
  try {
    return DOMPurify.sanitize(marked.parse(text.value), {
      FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'style'],
      FORBID_ATTR: ['style'],
    });
  } catch {
    return '';
  }
});

const markdownEl = ref<HTMLElement | null>(null);
// Links in a rendered document open beside the app, never in place of it.
watch(markdownHtml, async () => {
  await nextTick();
  markdownEl.value?.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
});

const closeBtn = ref<HTMLButtonElement | null>(null);
watch(
  () => file.value?.url,
  async (url, prev) => {
    if (!url) {
      detach();
      return;
    }
    if (!prev) {
      attach();
      viewport.value = window.innerWidth;
      width.value = clampDrawerWidth(loadDrawerWidth(storage()) ?? NaN, viewport.value);
    }
    const first = !prev;
    const load = loadText();
    if (first) {
      await nextTick();
      closeBtn.value?.focus();
    }
    await load;
  },
);

// ── Resize ────────────────────────────────────────────────────────────────
const dragging = ref(false);

// The app column makes room for the drawer on wide screens (style.css reads
// this from the root), so the composer stays usable beside an open preview.
watch(width, (w) => document.documentElement.style.setProperty('--attachment-drawer-w', `${w}px`));

function setWidth(w: number, persist: boolean): void {
  width.value = clampDrawerWidth(w, viewport.value);
  if (persist) saveDrawerWidth(storage(), width.value);
}

function onSepKey(e: KeyboardEvent): void {
  const next = resizeByKey(e.key, width.value, viewport.value, e.shiftKey);
  if (next === null) return;
  e.preventDefault();
  setWidth(next, true);
}

// A press only becomes a drag once it has moved TAP_SLOP pixels; released
// before that, it is a click and steps to the next preset width instead.
let press: { x: number; y: number } | null = null;
function onSepDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  press = { x: e.clientX, y: e.clientY };
}
function onSepMove(e: PointerEvent): void {
  if (!press) return;
  if (!dragging.value && isTap(e.clientX - press.x, e.clientY - press.y)) return;
  dragging.value = true;
  setWidth(window.innerWidth - e.clientX, false);
}
function endPress(e: PointerEvent, cancelled: boolean): void {
  if (!press) return;
  const wasDrag = dragging.value;
  press = null;
  dragging.value = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  if (wasDrag) saveDrawerWidth(storage(), width.value);
  else if (!cancelled) setWidth(nextPresetWidth(width.value, viewport.value), true);
}
const onSepUp = (e: PointerEvent) => endPress(e, false);
const onSepCancel = (e: PointerEvent) => endPress(e, true);
const widthText = computed(() => drawerWidthText(width.value, viewport.value));

function onResize(): void {
  viewport.value = window.innerWidth;
  width.value = clampDrawerWidth(width.value, viewport.value);
}

// ── Dismissal ─────────────────────────────────────────────────────────────
// Escape closes the drawer unless a layer above it owns the key: the lightbox,
// a modal, or a composer popup (those close on their own handlers).
function aboveDrawer(): boolean {
  if (lightboxOpen.value) return true;
  return !!document.querySelector(
    '.modal-overlay:not([hidden]), #mention-popover:not([hidden]), #slash-menu:not([hidden])',
  );
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !file.value || e.defaultPrevented || aboveDrawer()) return;
  e.preventDefault();
  closeAttachmentDrawer();
}

// ── HTML attachments ──────────────────────────────────────────────────────
// The rendered page may ask to pre-fill the composer. composeTextFrom accepts a
// message only from THIS frame's window and only in the one fixed shape; the
// text lands in the composer and the person still decides whether to send it.
const htmlFrame = ref<HTMLIFrameElement | null>(null);
// The frame keeps its window when the page navigates itself elsewhere (a
// sandboxed frame may), so a second load means it is no longer the attachment
// talking: from then on it is not heard.
let htmlLoads = 0;
function onHtmlLoad(): void {
  htmlLoads++;
}
watch(
  () => file.value?.url,
  () => {
    htmlLoads = 0;
  },
);
function onFrameMessage(e: MessageEvent): void {
  const f = file.value;
  if (!f || kind.value !== 'html' || htmlLoads > 1) return;
  const text = composeTextFrom(e, htmlFrame.value?.contentWindow);
  if (text !== null) prefillComposer(text, f.filename);
}

let attached = false;
function attach(): void {
  if (attached) return;
  attached = true;
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
  window.addEventListener('message', onFrameMessage);
}
function detach(): void {
  if (!attached) return;
  attached = false;
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('message', onFrameMessage);
}
onBeforeUnmount(detach);

const sizeLabel = computed(() => formatSize(file.value?.size));
</script>

<template>
  <aside
    v-if="file"
    id="attachment-drawer"
    class="attachment-drawer"
    :class="{ dragging }"
    role="dialog"
    aria-labelledby="attachment-drawer-title"
  >
    <div
      class="attachment-drawer-sep"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      aria-label="Resize preview"
      aria-controls="attachment-drawer"
      :aria-valuenow="width"
      :aria-valuetext="widthText"
      :aria-valuemin="DRAWER_MIN"
      :aria-valuemax="maxWidth"
      @keydown="onSepKey"
      @pointerdown="onSepDown"
      @pointermove="onSepMove"
      @pointerup="onSepUp"
      @pointercancel="onSepCancel"
    ></div>
    <header class="attachment-drawer-header">
      <h2 id="attachment-drawer-title" class="attachment-drawer-title" :title="file.filename">{{ file.filename }}</h2>
      <span v-if="sizeLabel" class="attachment-drawer-size">{{ sizeLabel }}</span>
      <!-- An HTML file opened as a file is a download, so it gets no "open" action. -->
      <a
        v-if="kind !== 'html'"
        class="btn-icon"
        :href="file.url"
        target="_blank"
        rel="noopener"
        aria-label="Open in new tab"
        title="Open in new tab"
        ><svg class="icon" aria-hidden="true"><use href="#i-external-link"></use></svg
      ></a>
      <a class="btn-icon" :href="file.url" :download="file.filename" aria-label="Download" title="Download"
        ><svg class="icon" aria-hidden="true"><use href="#i-download"></use></svg
      ></a>
      <button
        ref="closeBtn"
        class="btn-icon"
        type="button"
        aria-label="Close preview"
        title="Close"
        @click="closeAttachmentDrawer()"
      >
        <svg class="icon" aria-hidden="true"><use href="#i-x"></use></svg>
      </button>
    </header>

    <div class="attachment-drawer-body" :class="`attachment-drawer-${kind}`">
      <p v-if="tooLarge" class="attachment-drawer-status">Too large to preview</p>
      <p v-else-if="loading" class="attachment-drawer-status">
        <span class="btn-spinner" aria-hidden="true"></span>Loading…
      </p>
      <p v-else-if="failed" class="attachment-drawer-status">Couldn't load this file</p>

      <!-- sandbox: scripts only. Never allow-same-origin (the page would share the
           app's origin and its session) and never allow-popups-to-escape-sandbox. -->
      <iframe
        v-else-if="kind === 'html'"
        ref="htmlFrame"
        :key="file.url"
        class="attachment-drawer-frame attachment-drawer-page"
        :src="htmlFrameUrl(file.url)"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        :title="file.filename"
        @load="onHtmlLoad"
      ></iframe>

      <iframe
        v-else-if="kind === 'pdf'"
        class="attachment-drawer-frame"
        :src="file.url"
        :title="file.filename"
      ></iframe>

      <template v-else-if="kind === 'video'">
        <p v-if="mediaFailed" class="attachment-drawer-status">Can't play this file here</p>
        <video
          v-else
          class="attachment-drawer-video"
          :src="file.url"
          controls
          playsinline
          preload="metadata"
          @error="mediaFailed = true"
        ></video>
      </template>
      <template v-else-if="kind === 'audio'">
        <p v-if="mediaFailed" class="attachment-drawer-status">Can't play this file here</p>
        <audio
          v-else
          class="attachment-drawer-audio"
          :src="file.url"
          controls
          preload="metadata"
          @error="mediaFailed = true"
        ></audio>
      </template>

      <template v-else-if="text !== null">
        <div v-if="kind === 'markdown'" ref="markdownEl" class="attachment-drawer-md" v-html="markdownHtml"></div>
        <div v-else-if="kind === 'json' && json.ok" class="attachment-drawer-json">
          <JsonNode :value="json.value" :depth="0" />
        </div>
        <div v-else-if="kind === 'csv' && csv" class="attachment-drawer-table" tabindex="0" :aria-label="file.filename">
          <table>
            <thead>
              <tr>
                <th v-for="(h, i) in csv.head" :key="i" scope="col">{{ h }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, ri) in csv.body" :key="ri">
                <td v-for="(c, ci) in r" :key="ci">{{ c }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="csv.truncated" class="attachment-drawer-status">First {{ CSV_ROW_LIMIT }} rows</p>
        </div>
        <pre
          v-else
          class="attachment-drawer-code"
          tabindex="0"
          :aria-label="file.filename"
        ><code v-html="codeHtml"></code></pre>
      </template>
    </div>
  </aside>
</template>
