<script setup lang="ts">
/**
 * An in-transcript skill-draft card. Keep progress (in flight, checking, overlapping,
 * kept, undone, failed) comes from ONE store keyed by draft id (draftAction), because a
 * root app's props are read once. Both decisions commit immediately and Undo reverses
 * them (discards are soft on the server). The list surfaces keep a pre-commit timer: a
 * discarded draft leaves those lists, so an Undo would have nowhere to live.
 */
import { computed } from 'vue';
import BusyLabel from './BusyLabel.vue';
import OriginBadge from './OriginBadge.vue';
import { draftAction } from './skills-panel-state.js';
import type { OverlapDecision } from './skills.js';

const props = defineProps<{
  title: string;
  resolved: boolean;
  status: string;
  agentName: string;
  desc: string;
  undoSeconds: number;
  draftId: string;
  onView: () => void;
  onKeep: () => void;
  onDiscard: () => void;
  onUndoKeep: () => void;
  onUndoDiscard: () => void;
  onOverlapChoice: (decision: OverlapDecision) => void;
}>();

const VIEW = 'View';
const KEEP = 'Keep';
const DISCARD = 'Discard';
const SAVING = 'Keeping…';
const CHECKING = 'Checking for overlaps…';
const DISCARDING = 'Discarding…';
const UNDO = 'Undo';
const UNDOING = 'Undoing…';

// Only the moving phases lock the actions. An 'error' phase must leave Keep
// clickable — otherwise a failed keep is a dead end with no way to retry.
const busy = computed(() => {
  const p = draftAction.value[props.draftId]?.phase;
  return p === 'saving' || p === 'checking' || p === 'discarding';
});
const keepBusyLabel = computed(() => (draftAction.value[props.draftId]?.phase === 'checking' ? CHECKING : SAVING));
// An undo in flight keeps the outcome it is reversing on screen, with Undo busy.
const undoing = computed(() => draftAction.value[props.draftId]?.phase === 'undoing');
const shown = computed(() => {
  const p = draftAction.value[props.draftId];
  return p?.phase === 'undoing' ? p.from : p;
});
</script>

<template>
  <!-- Terminal states. The server's resolve re-broadcast lands here too, but the
       phase gets us there first, so the card never sits on a stale Keep. -->
  <div v-if="shown?.phase === 'kept'" class="skill-draft-card resolved">
    <div class="skill-head">
      <span class="skill-name"
        >✅ {{ shown.patched ? 'Updated' : 'Kept as' }}
        {{ shown.name }}</span
      ><OriginBadge v-if="agentName" :origin="{ label: `wired to ${agentName}`, official: false }" />
    </div>
    <div class="skill-draft-actions">
      <button type="button" class="btn btn-ghost" @click="props.onView()">{{ VIEW }}</button>
      <button type="button" class="btn btn-secondary" :disabled="undoing || undefined" @click="props.onUndoKeep()">
        <BusyLabel :busy="undoing" :label="UNDO" :busy-label="UNDOING" />
      </button>
    </div>
  </div>

  <div v-else-if="shown?.phase === 'discarded'" class="approval-inroom-note resolved">
    <span>🗑 {{ shown.skillName || title }} — discarded</span>
    <button type="button" class="btn btn-ghost" :disabled="undoing || undefined" @click="props.onUndoDiscard()">
      <BusyLabel :busy="undoing" :label="UNDO" :busy-label="UNDOING" />
    </button>
  </div>

  <div v-else-if="draftAction[draftId]?.phase === 'undone'" class="approval-inroom-note resolved">
    ↩ {{ (draftAction[draftId] as any).name }} — undone
  </div>

  <!-- A draft resolved by someone else (or before this tab loaded): the stored
       card carries the outcome, and there is no local phase to show. -->
  <div v-else-if="resolved" class="approval-inroom-note resolved">
    {{ status === 'kept' ? `✅ ${title} — kept` : `🗑 ${title} — discarded` }}
  </div>

  <div v-else class="skill-draft-card">
    <div class="skill-head">
      <span class="skill-name">{{ title }}</span
      ><OriginBadge v-if="agentName" :origin="{ label: `learned · ${agentName}`, official: false }" />
    </div>
    <div class="skill-desc">{{ desc }}</div>

    <!-- Overlap choice, inline: the comparison being asked for is this card
         against the ones it overlaps, which a modal puts out of view. -->
    <template v-if="draftAction[draftId]?.phase === 'overlaps'">
      <div
        v-for="o in (draftAction[draftId] as any).overlaps"
        :key="o.name"
        class="import-warning"
      >
        ⚠ {{ o.name }} ({{ o.source === 'pending-draft' ? 'pending draft' : o.source }}) — {{ o.reason }}
      </div>
      <div class="skill-draft-actions">
        <button
          v-for="o in (draftAction[draftId] as any).overlaps.filter((x: any) => x.source !== 'pending-draft')"
          :key="o.name"
          type="button"
          class="btn btn-primary"
          @click="props.onOverlapChoice({ action: 'update', target: o.name })"
        >
          Update {{ o.name }}
        </button>
        <button type="button" class="btn btn-secondary" @click="props.onOverlapChoice({ action: 'keep-new' })">
          Keep as new
        </button>
        <button type="button" class="skill-delete" @click="props.onOverlapChoice({ action: 'discard' })">
          {{ DISCARD }}
        </button>
      </div>
    </template>

    <div v-else class="skill-draft-actions">
      <button type="button" class="btn btn-ghost" @click="props.onView()">{{ VIEW }}</button>
      <button
        type="button"
        class="btn btn-primary"
        :title="`Wire to ${agentName}`"
        :data-draft-id="draftId"
        :disabled="busy || undefined"
        @click="props.onKeep()"
      >
        <BusyLabel
          :busy="draftAction[draftId]?.phase === 'saving' || draftAction[draftId]?.phase === 'checking'"
          :label="KEEP"
          :busy-label="keepBusyLabel"
        />
      </button>
      <button type="button" class="skill-delete" :disabled="busy || undefined" @click="props.onDiscard()">
        <BusyLabel :busy="draftAction[draftId]?.phase === 'discarding'" :label="DISCARD" :busy-label="DISCARDING" />
      </button>
    </div>

    <div v-if="draftAction[draftId]?.phase === 'error'" class="import-warning">
      ⚠ {{ (draftAction[draftId] as any).error }}
    </div>
  </div>
</template>
