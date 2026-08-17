<script setup lang="ts">
/**
 * The SKILL.md viewer/editor modal — thirty-fourth island.
 *
 * Per-instance, like SkillDraftCard: an overlay is created and appended to
 * document.body, and one app is mounted into it. Nothing owns document.body, so
 * there is no container to claim.
 *
 * The FOCUS TRAP is the part that matters and is preserved exactly. Keyboard
 * users must not tab behind the overlay (manual-checks SC 2.1.2). The imperative
 * version built its focusable list as [textarea, ...actionButtons, closeButton,
 * saveButton]; that is also DOM order within the dialog, so this queries the
 * dialog instead of tracking each element — same sequence, one source of truth,
 * and it cannot drift as the footer changes.
 *
 * The body is ASSIGNED on mount, not bound. `value` is not a valid attribute on
 * a textarea, and Vue emits one for both :value and the .prop modifier — markup
 * the original never had, since it assigned the DOM property. The textarea is
 * uncontrolled either way: nothing re-reads `body` after open.
 *
 * Escape closes, clicking the overlay itself (never the modal) closes, and the
 * textarea takes focus on the next task — all as before.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';

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
const saveLabel = ref(SAVE);

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
  const prev = saveLabel.value;
  saveLabel.value = SAVING;
  try {
    await props.onSave(ta.value?.value ?? '');
    props.onClose();
  } catch (err) {
    // Toasting stays with the caller; this only restores the button.
    saving.value = false;
    saveLabel.value = prev;
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
      >{{ saveLabel }}</button>
    </div>
  </div>
</template>
