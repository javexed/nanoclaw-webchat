<script setup lang="ts">
/**
 * The transcript, mounted into <div id="messages"> and the only writer of its children.
 * Rows are view models decided at append time (see transcript-state.ts). Thinking bubbles
 * render after the list, so "insert before the bubble" is just position. Markdown goes
 * through v-html, an opaque subtree, so decorateCodeBlocks/decorateMentions and
 * applyA2aClamp (which measures) run from a ref callback without being a second writer.
 */
import { messages, thinkingTurns, transcriptEmpty } from './transcript-state.js';
import ThinkingBubble from './ThinkingBubble.vue';
import MessageBubble from './MessageBubble.vue';
import MsgDeleteButton from './MsgDeleteButton.vue';
import ApprovalCard from './ApprovalCard.vue';
import SkillDraftCard from './SkillDraftCard.vue';

const props = defineProps<{
  decorate: (bubble: HTMLElement) => void;
  clampA2a: (bubble: HTMLElement, container: HTMLElement) => void;
  onApprovalRespond: (questionId: string, value: string) => void;
  onOpenLightbox: (url: string, filename: string) => void;
  onStopAgent: (name: string) => void;
  onToggleTurn: (name: string) => void;
}>();

const THOUGHTS = 'Thoughts';
const thoughtsPreview = (lines: string[]) => {
  const last = lines[lines.length - 1] || '';
  return last ? ' — ' + (last.length > 90 ? `${last.slice(0, 89)}…` : last) : '';
};

</script>

<template>
  <!--
    Derived from the rows as well as transcriptEmpty, which nothing clears when a live
    message arrives: an empty state must never hide content that contradicts it.
  -->
  <div v-if="transcriptEmpty && !messages.length && !thinkingTurns.length" class="empty-state">{{ transcriptEmpty }}</div>
  <template v-else>
    <template v-for="row in messages" :key="row.key">
      <div v-if="row.kind === 'system'" class="msg system">{{ row.text }}</div>

      <div v-else-if="row.kind === 'divider'" class="context-divider"><span>{{ row.text }}</span></div>

      <div v-else-if="row.kind === 'approval'" class="msg approval-msg" :data-question-id="row.id || ''">
        <div v-if="row.approvalState === 'resolved'" class="approval-inroom-note resolved">{{ row.note }}</div>
        <ApprovalCard
          v-else-if="row.approvalState === 'eligible'"
          :approval="row.payload"
          :on-respond="props.onApprovalRespond"
        />
        <div v-else class="approval-inroom-note">{{ row.note }}</div>
      </div>

      <!--
        Skill-draft card. Keyed `draft:<id>` so the resolve re-broadcast replaces this
        row; the wrapper mirrors the approval branch so it stays addressable by draft id.
      -->
      <div v-else-if="row.kind === 'draft'" class="msg skill-draft-msg" :data-draft-id="row.id || ''">
        <SkillDraftCard v-bind="row.payload" />
      </div>

      <div
        v-else
        :class="row.cls"
        v-bind="row.id ? { 'data-message-id': row.id } : {}"
        :style="row.isA2a ? { '--a2a-accent': row.a2aAccent } : undefined"
      >
        <div :class="row.isA2a ? 'sender a2a-label' : 'sender'">
          <template v-if="row.isA2a"
            ><span class="a2a-agent" :style="{ color: row.senderColor }">{{ row.sender }}</span
            ><template v-if="row.a2aTo"
              ><span class="a2a-arrow">→</span
              ><span class="a2a-agent" :style="{ color: row.toColor }">{{ row.a2aTo }}</span></template
            ></template
          ><template v-else-if="row.isAgent"
            ><svg class="icon" aria-hidden="true"><use href="#i-bot"></use></svg>{{ ' ' + row.sender }}</template
          ><template v-else>{{ row.isMine ? 'You' : row.sender }}</template>
        </div>

        <div v-if="row.body" class="msg-body">
          <MsgDeleteButton v-if="row.id" :message-id="row.id" /><MessageBubble
            :row="row"
            :decorate="props.decorate"
            :clamp-a2a="props.clampA2a"
            :on-open-lightbox="props.onOpenLightbox"
          />
        </div>
        <MessageBubble
          v-else
          :row="row"
          :decorate="props.decorate"
          :clamp-a2a="props.clampA2a"
          :on-open-lightbox="props.onOpenLightbox"
        />

        <details v-if="row.thoughts && row.thoughts.length" class="thoughts">
          <summary
            ><svg class="icon" aria-hidden="true"><use href="#i-sparkles"></use></svg
            >{{ ` ${THOUGHTS} (${row.thoughts.length})`
            }}<span v-if="thoughtsPreview(row.thoughts)" class="thoughts-preview">{{
              thoughtsPreview(row.thoughts)
            }}</span></summary
          >
          <div class="thoughts-body">
            <div v-for="(l, i) in row.thoughts" :key="i" class="thoughts-line">{{ l }}</div>
          </div>
        </details>

        <div v-if="row.timeStr" class="timestamp" :title="row.timeTitle || undefined">{{ row.timeStr }}</div>
        <div v-if="row.isMine && row.status" :class="row.status === '✓✓' ? 'status delivered' : 'status'">{{
          row.status
        }}</div>
      </div>
    </template>

    <ThinkingBubble
      v-for="t in thinkingTurns"
      :key="t.name"
      :turn="t"
      :on-stop="props.onStopAgent"
      :on-toggle="props.onToggleTurn"
    />
  </template>
</template>
