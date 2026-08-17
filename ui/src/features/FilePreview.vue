<script setup lang="ts">
/**
 * Staged-file thumbnails above the composer.
 *
 * Mounted into <div id="file-preview">. Rows arrive with thumbUrl already
 * resolved — files.ts owns the pendingThumbUrls map and revokes those URLs on
 * clear, so minting them here would leak one per re-render.
 *
 * Non-image rows show the paperclip icon and the remove button shows the x
 * icon; both are lucide() SVG strings, bound with v-html as the imperative
 * version assigned them into an innerHTML blob.
 */
import { lucide } from '../core/dom.js';
import { previewRows } from './file-preview-state.js';

const emit = defineEmits<{ (e: 'remove', id: number): void }>();

const clipIcon = lucide('paperclip');
const xIcon = lucide('x');
</script>

<template>
  <div v-for="r in previewRows" :key="r.id" class="file-preview-content" :data-id="r.id">
    <img v-if="r.thumbUrl" :src="r.thumbUrl" class="file-preview-thumb" alt="" />
    <span v-else class="file-preview-icon" v-html="clipIcon"></span>
    <span class="file-preview-name">{{ r.name }}</span>
    <span class="file-preview-size">{{ r.size }}</span>
    <button class="file-preview-remove" :data-remove-id="r.id" v-html="xIcon" @click="emit('remove', r.id)"></button>
  </div>
</template>
