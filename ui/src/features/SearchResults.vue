<script setup lang="ts">
/**
 * Room-search results.
 *
 * Mounted into <ul id="search-results">. The container keeps its DELEGATED
 * click listener — Vue replaces the container's children, not the container, so
 * a listener bound to the <ul> itself survives the mount and keeps working.
 *
 * The snippet line is a single v-html on the snip DIV, not a sender span plus a
 * v-html span beside it. The wrapper span that second form adds is a real
 * structural difference from the imperative markup — caught by the DOM diff —
 * and there is no way to v-html without an element, so the whole inner HTML is
 * shaped in rooms.ts instead.
 *
 * That is also where it belongs: FTS5 returns «…» markers around matches, and
 * the imperative version escaped the text FIRST and only then replaced the
 * markers with <mark>. That order is the XSS guarantee, so it stays next to the
 * escaping it depends on, and this component receives HTML it may not build.
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
