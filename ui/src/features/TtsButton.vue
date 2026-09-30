<script setup lang="ts">
/**
 * Read-aloud control on an agent reply, overlaid on the bubble's corner; the caller
 * omits it (v-if on ttsOffered()) when no TTS path exists. Three states:
 *
 *   idle     volume-2  aria-label/title 'Read aloud'
 *   loading  volume-2  aria-label 'Synthesizing…', title UNCHANGED, +tts-loading
 *   playing  square    aria-label/title 'Stop', +tts-playing
 */
import { computed } from 'vue';
import { ttsActiveKey, ttsPhase, toggleTts } from './voice.js';

const props = defineProps<{ msgKey: string | number; getText: () => string }>();

const VOLUME = '<svg class="icon" aria-hidden="true"><use href="#i-volume-2"></use></svg>';
const SQUARE = '<svg class="icon" aria-hidden="true"><use href="#i-square"></use></svg>';

const phase = computed(() => (ttsActiveKey.value === props.msgKey ? ttsPhase.value : null));
const cls = computed(() =>
  phase.value === 'playing' ? 'tts-btn tts-playing' : phase.value === 'loading' ? 'tts-btn tts-loading' : 'tts-btn',
);
const label = computed(() =>
  phase.value === 'playing' ? 'Stop' : phase.value === 'loading' ? 'Synthesizing…' : 'Read aloud',
);
const title = computed(() => (phase.value === 'playing' ? 'Stop' : 'Read aloud'));
</script>

<template>
  <button
    type="button"
    :class="cls"
    :aria-label="label"
    :title="title"
    v-html="phase === 'playing' ? SQUARE : VOLUME"
    @click.stop="toggleTts(props.msgKey, props.getText)"
  ></button>
</template>
