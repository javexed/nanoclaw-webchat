<script setup lang="ts">
/**
 * The +/− selectable-model control, declaratively.
 *
 * Not an island — it has no mount point of its own. It is the component half of
 * select-toggle.ts, used by islands that render server rows, while the still
 * imperative call sites keep using buildSelectToggle().
 *
 * It decides nothing. Both what it shows and what the click does come from the
 * module, so this and the imperative builder cannot drift — which matters here
 * because the click DELETES a registration when one already exists.
 *
 * `busy` is local rather than a shared ref: it disables THIS button while its
 * own request is in flight, exactly as `btn.disabled` did. Two rows can be
 * mid-request independently.
 */
import { computed, ref } from 'vue';
import { selectToggleProps, toggleSelectable } from './select-toggle.js';

const props = defineProps<{ kind: string; endpoint: string; modelId: string; displayName: string }>();

const busy = ref(false);
const p = computed(() => selectToggleProps(props.kind, props.endpoint, props.modelId));

function onClick() {
  void toggleSelectable(props.kind, props.endpoint, props.modelId, props.displayName, (b) => {
    busy.value = b;
  });
}
</script>

<template>
  <button
    type="button"
    :class="p.className"
    :title="p.title"
    :aria-label="p.title"
    :disabled="busy || undefined"
    @click="onClick"
  >{{ p.label }}</button>
</template>
