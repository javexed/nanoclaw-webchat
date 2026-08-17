<script setup lang="ts">
/**
 * Read-aloud control on an agent reply, overlaid on the bubble's corner.
 *
 * buildTtsButton() returned null when no TTS path exists, so the button was
 * simply absent; the caller reproduces that with v-if on ttsOffered() rather
 * than rendering a disabled one.
 *
 * Three states, and the markup for each is exactly what resetTtsButton() and
 * markTtsPlaying() used to assign:
 *
 *   idle     volume-2  aria-label/title 'Read aloud'
 *   loading  volume-2  aria-label 'Synthesizing…', title UNCHANGED, +tts-loading
 *   playing  square    aria-label/title 'Stop', +tts-playing
 *
 * The loading state keeping the idle TITLE is not an oversight being tidied up:
 * speak() set only aria-label, and this phase reproduces it.
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
