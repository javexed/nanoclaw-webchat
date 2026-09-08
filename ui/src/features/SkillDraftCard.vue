<script setup lang="ts">
/**
 * An in-transcript skill-draft card.
 *
 * Everything about a keep in progress — in flight, checking, overlapping,
 * kept, undone, failed — comes from ONE store keyed by draft id (draftAction),
 * not from props and not from imperative writes to the buttons. A root app's
 * props are read once, so a prop would freeze at mount; and the labels this
 * used to get written directly onto its buttons ('Keeping…', 'Reviewing…')
 * could never be reverted, because Vue owns them.
 *
 * Both decisions commit immediately and the card then offers Undo, which
 * reverses what happened rather than cancelling a countdown: a keep is undone
 * by deleting/reverting the skill, a discard by restoring the draft (the
 * server soft-discards, so the body is still there). No pre-commit timer
 * remains on this surface — the list surfaces keep theirs, because a
 * discarded draft leaves those lists and an Undo would have nowhere to live.
 */
import { computed } from 'vue';
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
</script>

<template>
  <!-- Terminal states. The server's resolve re-broadcast lands here too, but the
       phase gets us there first, so the card never sits on a stale Keep. -->
  <div v-if="draftAction[draftId]?.phase === 'kept'" class="skill-draft-card resolved">
    <div class="skill-head">
      <span class="skill-name"
        >✅ {{ (draftAction[draftId] as any).patched ? 'Updated' : 'Kept as' }}
        {{ (draftAction[draftId] as any).name }}</span
      ><OriginBadge v-if="agentName" :origin="{ label: `wired to ${agentName}`, official: false }" />
    </div>
    <div class="skill-draft-actions">
      <button type="button" class="btn btn-ghost" @click="props.onView()">{{ VIEW }}</button>
      <button type="button" class="btn btn-secondary" @click="props.onUndoKeep()">{{ UNDO }}</button>
    </div>
  </div>

  <div v-else-if="draftAction[draftId]?.phase === 'discarded'" class="approval-inroom-note resolved">
    <span>🗑 {{ (draftAction[draftId] as any).skillName || title }} — discarded</span>
    <button type="button" class="btn btn-ghost" @click="props.onUndoDiscard()">{{ UNDO }}</button>
  </div>

  <div v-else-if="draftAction[draftId]?.phase === 'undone'" class="approval-inroom-note resolved">
    ↩ {{ (draftAction[draftId] as any).name }} — undone
  </div>

  <div v-else-if="draftAction[draftId]?.phase === 'undoing'" class="approval-inroom-note">{{ UNDOING }}</div>

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
        {{
          draftAction[draftId]?.phase === 'saving'
            ? SAVING
            : draftAction[draftId]?.phase === 'checking'
              ? CHECKING
              : KEEP
        }}
      </button>
      <button type="button" class="skill-delete" :disabled="busy || undefined" @click="props.onDiscard()">
        {{ draftAction[draftId]?.phase === 'discarding' ? DISCARDING : DISCARD }}
      </button>
    </div>

    <div v-if="draftAction[draftId]?.phase === 'error'" class="import-warning">
      ⚠ {{ (draftAction[draftId] as any).error }}
    </div>
  </div>
</template>
