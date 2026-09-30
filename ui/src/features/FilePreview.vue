<script setup lang="ts">
/**
 * Staged-file thumbnails above the composer, mounted into <div id="file-preview">. Rows
 * arrive with thumbUrl resolved: files.ts owns pendingThumbUrls and revokes them on clear,
 * so minting URLs here would leak one per re-render. Icons are lucide() SVG strings.
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
