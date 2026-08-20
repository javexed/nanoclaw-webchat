<script setup lang="ts">
/**
 * The transcript — the conversion this whole phase was building toward.
 *
 * Mounted into <div id="messages">, which had TWELVE writers across nine
 * modules. Every other island in this phase owned a container nothing else
 * wrote to; this one could not be sliced, because the moment Vue owns
 * #messages' children every remaining imperative append is a second writer.
 * So appendMessage, appendSystem, the context divider, the thinking bubbles,
 * the file bubble, the thoughts disclosure, the delete button and the TTS
 * button all moved in one change.
 *
 * Rows are VIEW MODELS decided at append time, not raw messages — see
 * transcript-state.ts for why re-deciding later gives different answers.
 *
 * Thinking bubbles render AFTER the list, which is how "insert before the
 * thinking bubble" survives without an anchor: the imperative version had to
 * find the bubble and insertBefore it, and ordering here is just position.
 *
 * Markdown bodies go through v-html. Vue treats that subtree as opaque and
 * never diffs inside it, so decorateCodeBlocks and decorateMentions mutating
 * the rendered HTML is NOT the two-writers problem — they are decorating a
 * black box, and Vue only ever replaces it wholesale when the string changes.
 * That is why those two stay imperative and run from a ref callback.
 *
 * applyA2aClamp also runs from the ref: it measures, so it needs the element
 * attached, which is what the imperative version's post-insert call was for.
 */
import { messages, thinkingTurns, transcriptEmpty } from './transcript-state.js';
import type { MsgRow } from './transcript-state.js';
import ThinkingBubble from './ThinkingBubble.vue';
import MessageBubble from './MessageBubble.vue';
import MsgDeleteButton from './MsgDeleteButton.vue';
import ApprovalCard from './ApprovalCard.vue';

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
    The empty state and the transcript are mutually exclusive, so this guard
    decides whether content renders AT ALL — it is not just a placeholder.
    `transcriptEmpty` is set when you join a room whose history came back empty,
    and nothing clears it when a live message arrives: every row after that was
    pushed into `messages` and then rendered by the branch not taken. A brand
    new room swallowed your first message and the agent's reply, silently and
    without an error, until you left and came back and history refetched.
    Deriving the guard from the rows themselves makes that unrepresentable — an
    empty state can no longer hide content it is contradicted by.
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
