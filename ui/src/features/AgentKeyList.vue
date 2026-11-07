<script setup lang="ts">
/**
 * An agent's SSH deploy keys, mounted into <ul id="agent-keys-list">; rows are shaped in
 * renderAgentKeys, including the one-string meta line (ssh command and target, or what
 * is missing). The private key is held on the host and never reaches the client, so
 * copying the public key is the whole workflow; it uses the .btn-icon copy control
 * (CopyIconButton), paired with Edit and Remove. Edit changes only the login targets
 * (user@host, comma-separated): the key stays the same, so the far end keeps trusting it. A key the
 * agent could once read is marked Exposed; Rotate replaces it with a new one, whose
 * public half then goes on the server.
 */
import { ref } from 'vue';
import { agentKeyRows } from './agent-lists-state.js';
import CopyIconButton from './CopyIconButton.vue';

const props = defineProps<{
  onRemove: (row: { key: unknown }) => void;
  onSaveTarget: (name: string, target: string) => Promise<boolean>;
  onRotate: (row: { name: string }) => void;
}>();

const T = {
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  remove: 'Remove',
  rotate: 'Rotate',
  target: 'user@host, user@host',
  exposed: 'Exposed',
  exposedTip: 'The agent could read this key once. Rotate it, then put the new public key on the server.',
};

/** Name of the row being edited, and its draft target. */
const editing = ref<string | null>(null);
const draft = ref('');
const saving = ref(false);

function startEdit(r: { name: string; target: string }): void {
  editing.value = r.name;
  draft.value = r.target;
}

async function save(name: string): Promise<void> {
  const target = draft.value.trim();
  if (!target || saving.value) return;
  saving.value = true;
  try {
    if (await props.onSaveTarget(name, target)) editing.value = null;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <li v-for="r in agentKeyRows" :key="r.name" class="skill-source-row secret-row">
    <div class="skill-info">
      <div class="skill-head">
        {{ r.name
        }}<span v-if="r.exposed" class="skill-badge skill-badge-warn" :title="T.exposedTip">{{ T.exposed }}</span>
      </div>
      <form v-if="editing === r.name" class="agent-key-edit" @submit.prevent="save(r.name)">
        <input
          v-model="draft"
          type="text"
          :placeholder="T.target"
          :aria-label="T.target"
          autocomplete="off"
          spellcheck="false"
          @keydown.esc="editing = null"
        />
      </form>
      <span v-else class="skill-desc">{{ r.meta }}</span>
    </div>
    <div class="secret-actions">
      <template v-if="editing === r.name">
        <button class="btn btn-primary" type="button" :disabled="!draft.trim() || saving" @click="save(r.name)">
          {{ T.save }}
        </button>
        <button class="btn btn-secondary" type="button" @click="editing = null">{{ T.cancel }}</button>
      </template>
      <template v-else>
        <CopyIconButton :text="r.publicKey" label="Copy public key" /><button
          v-if="r.exposed"
          class="btn btn-secondary"
          type="button"
          @click="props.onRotate(r)"
        >{{ T.rotate }}</button><button
          class="btn btn-secondary"
          type="button"
          @click="startEdit(r)"
        >{{ T.edit }}</button><button
          class="btn btn-danger"
          type="button"
          @click="props.onRemove(r)"
        >{{ T.remove }}</button>
      </template>
    </div>
  </li>
</template>
