<script setup lang="ts">
/**
 * The SKILL.md viewer/editor modal, one app per overlay appended to document.body.
 * Focus trap (SC 2.1.2): the focusable list is queried from the dialog in DOM order, so it
 * cannot drift as the footer changes. The body is assigned on mount, not bound (a textarea
 * has no `value` attribute); nothing re-reads it after open.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import BusyLabel from './BusyLabel.vue';

const props = defineProps<{
  name: string;
  body: string;
  editable: boolean;
  badgeText: string;
  actions: Array<{ label: string; onClick: () => void }>;
  onSave: (text: string) => Promise<unknown>;
  onClose: () => void;
}>();

const SAVING = 'Saving…';
const SAVE = 'Save';
const TITLE_ID = 'skill-edit-modal-title';

const dialog = ref<HTMLElement | null>(null);
const ta = ref<HTMLTextAreaElement | null>(null);
const saving = ref(false);

const closeLabel = computed(() => (props.editable ? 'Cancel' : 'Close'));

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    props.onClose();
    return;
  }
  // Focus trap: Tab cycles within the dialog (keyboard users must not land
  // behind the overlay — see manual-checks SC 2.1.2).
  if (e.key === 'Tab') {
    const focusables = [...(dialog.value?.querySelectorAll('textarea, button') ?? [])] as HTMLElement[];
    if (!focusables.length) return;
    const i = focusables.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      focusables[focusables.length - 1].focus();
    } else if (!e.shiftKey && (i === -1 || i === focusables.length - 1)) {
      e.preventDefault();
      focusables[0].focus();
    }
  }
}

async function save() {
  saving.value = true;
  try {
    await props.onSave(ta.value?.value ?? '');
    props.onClose();
  } catch (err) {
    // Toasting stays with the caller; this only restores the button.
    saving.value = false;
    throw err;
  }
}

onMounted(() => {
  if (ta.value) ta.value.value = props.body;
  document.addEventListener('keydown', onKey);
  setTimeout(() => ta.value?.focus(), 0);
});
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <div
    ref="dialog"
    class="modal skill-edit-modal"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="TITLE_ID"
  >
    <div class="modal-header">
      <span :id="TITLE_ID">{{ name }}</span
      ><span v-if="badgeText" class="skill-badge skill-badge-user">{{ badgeText }}</span>
    </div>
    <div class="modal-body">
      <textarea ref="ta" class="skill-edit-textarea" :readonly="!editable" spellcheck="false"></textarea>
    </div>
    <div class="confirm-actions">
      <button
        v-for="a in actions"
        :key="a.label"
        type="button"
        class="btn btn-ghost"
        @click="
          props.onClose();
          a.onClick();
        "
      >{{ a.label }}</button>
      <button type="button" class="btn-cancel" @click="props.onClose()">{{ closeLabel }}</button>
      <button
        v-if="editable"
        type="button"
        class="btn btn-primary"
        :disabled="saving || undefined"
        @click="save()"
      ><BusyLabel :busy="saving" :label="SAVE" :busy-label="SAVING" /></button>
    </div>
  </div>
</template>
