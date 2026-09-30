<script setup lang="ts">
/**
 * One message's .bubble in whichever of its three shapes applies (own messages nest it
 * in a .msg-body row). Markdown goes on the bubble itself via v-html so selectors like
 * `.msg .bubble p:last-child` match; the TTS button is therefore teleported in as the last
 * child, and since row.html never changes, v-html never evicts it. Decorators run from the
 * ref callback right after the HTML lands.
 */
import { ref } from 'vue';
import type { MsgRow } from './transcript-state.js';
import TtsButton from './TtsButton.vue';
import { ttsOffered, ttsPlainText } from './voice.js';

const props = defineProps<{
  row: MsgRow;
  decorate: (bubble: HTMLElement) => void;
  clampA2a: (bubble: HTMLElement, container: HTMLElement) => void;
  onOpenLightbox: (url: string, filename: string) => void;
}>();

const DOWNLOAD = '<svg class="icon" aria-hidden="true"><use href="#i-download"></use></svg>';
const IMAGE = '<svg class="icon" aria-hidden="true"><use href="#i-image"></use></svg>';
const FILE_TEXT = '<svg class="icon" aria-hidden="true"><use href="#i-file-text"></use></svg>';
const PAPERCLIP = '<svg class="icon" aria-hidden="true"><use href="#i-paperclip"></use></svg>';
const DOWNLOAD_TITLE = 'Download';

const bubbleEl = ref<HTMLElement | null>(null);

const fileIcon = (m: any) =>
  m.mime?.startsWith('image/') ? IMAGE : m.mime?.includes('pdf') ? FILE_TEXT : PAPERCLIP;
const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const showTts = () => props.row.isAgent && !!props.row.ttsText && ttsOffered();

function bind(el: any): void {
  bubbleEl.value = el || null;
  if (!el) return;
  if (props.row.html) props.decorate(el);
  // a2a cards clamp to ~5 lines and the clamp MEASURES, so it needs the element attached.
  if (props.row.isA2a && el.parentElement) props.clampA2a(el, el.parentElement);
}
</script>

<template>
  <div v-if="row.file" ref="bubbleEl" class="bubble">
    <div class="file-bubble">
      <img
        v-if="row.file.mime?.startsWith('image/')"
        :src="row.file.url"
        :alt="row.file.filename"
        class="file-image-preview"
        loading="lazy"
        @click="props.onOpenLightbox(row.file.url, row.file.filename)"
      />
      <div class="file-info">
        <span class="file-icon" v-html="fileIcon(row.file)"></span><span class="file-name">{{
          row.file.filename
        }}</span><span class="file-size">{{ fileSize(row.file.size) }}</span
        ><a
          :href="row.file.url"
          :download="row.file.filename"
          class="file-download"
          :title="DOWNLOAD_TITLE"
          v-html="DOWNLOAD"
        ></a>
      </div>
    </div>
    <div v-if="row.caption" class="file-caption">{{ row.caption }}</div>
  </div>

  <div v-else-if="row.html" :ref="bind" class="bubble" v-html="row.html"></div>

  <div v-else :ref="bind" class="bubble">{{ row.text }}</div>

  <Teleport v-if="bubbleEl && showTts()" :to="bubbleEl">
    <TtsButton :msg-key="row.key" :get-text="() => ttsPlainText(row.ttsText)" />
  </Teleport>
</template>
