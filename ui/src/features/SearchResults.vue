<script setup lang="ts">
/**
 * Room-search results, mounted into <ul id="search-results">; the <ul>'s delegated
 * click listener survives the mount. The snippet is ONE v-html on the snip div, shaped in
 * rooms.ts: FTS5's «…» markers become <mark> only AFTER the text is escaped. That order is
 * the XSS guarantee, so it stays next to the escaping; this component never builds HTML.
 */
import { searchRows } from './search-results-state.js';

const EMPTY = 'No matches';
</script>

<template>
  <li v-if="searchRows.length === 0" class="search-empty">{{ EMPTY }}</li>
  <template v-else>
    <li
      v-for="r in searchRows"
      :key="r.id"
      class="search-result"
      :data-room-id="r.roomId"
      :data-room-name="r.roomName"
      :data-message-id="r.id"
    >
      <div class="search-result-head">
        <span class="search-result-room">#{{ r.roomName }}</span>
        <span class="search-result-time">{{ r.time }}</span>
      </div>
      <div class="search-result-snip" v-html="r.snipHtml"></div>
    </li>
  </template>
</template>
