<script setup lang="ts">
/**
 * One host's pull line: progress with Cancel, then the outcome. Shared by the
 * Ollama host cards and Add model → Server, so a pull looks the same wherever
 * it was started.
 */
import type { HostPull } from './ollama-cards-state.js';

const props = defineProps<{ pull: HostPull | null; onCancel: (model: string) => void }>();
const CANCEL = 'Cancel';
</script>

<template>
  <div class="ollama-pull-status" :hidden="!props.pull">
    <template v-if="props.pull">
      <template v-if="props.pull.status === 'pulling'">
        <div class="ollama-pull-line progress">
          <span class="ollama-pull-text">Pulling {{ props.pull.model }} — {{ props.pull.detail }}</span>
          <!-- The way out, at the point where it is wanted: mid-download,
               not in a dialog before one. Ollama keeps the blobs it already
               has, so a later re-pull resumes. -->
          <button class="ollama-pull-cancel" type="button" @click="props.onCancel(props.pull.model)">
            {{ CANCEL }}
          </button>
        </div>
        <div class="ollama-pull-bar"><span :style="{ width: props.pull.pct + '%' }"></span></div>
      </template>
      <template v-else-if="props.pull.status === 'success'">
        <div class="ollama-pull-line ok">Pulled {{ props.pull.model }}</div>
        <!-- Fitness at pull time — data, not prose: the three facts that
             decide whether this model works on THIS hardware right now. -->
        <div v-for="v in props.pull.verdict || []" :key="v" class="ollama-pull-line pull-verdict">{{ v }}</div>
      </template>
      <!-- Cancelled is neutral, not an error: the operator asked for it. -->
      <div v-else-if="props.pull.status === 'cancelled'" class="ollama-pull-line">
        Cancelled pull of {{ props.pull.model }}
      </div>
      <div v-else class="ollama-pull-line err">Pull of {{ props.pull.model }} failed: {{ props.pull.error }}</div>
    </template>
  </div>
</template>
