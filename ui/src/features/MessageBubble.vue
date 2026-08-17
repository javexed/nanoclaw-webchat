<script setup lang="ts">
/**
 * One message's .bubble, in whichever of its three shapes applies.
 *
 * A component rather than markup repeated inside Transcript, because own
 * messages nest the same bubble inside a .msg-body row and everything else does
 * not — see appendMessage's note on why that row exists even for the optimistic
 * echo.
 *
 * Markdown goes on the bubble ITSELF with v-html, not into a wrapper div. The
 * imperative version assigned bubble.innerHTML, so the markdown nodes were the
 * bubble's own children; a wrapper would change what `.msg .bubble p:last-child`
 * and friends select.
 *
 * Which is why the TTS button is TELEPORTED in. v-html owns the element's
 * children, so the button cannot also be a template child of it — teleporting
 * lands it as the last child exactly where appendChild put it. row.html never
 * changes after append, so v-html never re-runs and never evicts it.
 *
 * The decorators run from the ref callback, in the same position the imperative
 * version called them: immediately after the innerHTML assignment.
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
  // a2a cards clamp to ~5 lines and the clamp MEASURES, so it needs the element
  // attached — this is the post-insert call the imperative version made.
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
