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
import TurnThoughts from './TurnThoughts.vue';
import LimitRetry from './LimitRetry.vue';
import { servedModelShown } from './served-model.js';
import { state } from '../core/state.js';
import { approvalBusy, approvalErrors } from './approvals-state.js';
import { resendApproval } from './approvals.js';

const props = defineProps<{
  decorate: (bubble: HTMLElement) => void;
  clampA2a: (bubble: HTMLElement, container: HTMLElement) => void;
  onApprovalRespond: (questionId: string, value: string, reason?: string) => void;
  onOpenLightbox: (url: string, filename: string) => void;
  onStopAgent: (name: string) => void;
  onToggleTurn: (name: string) => void;
}>();

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

      <div v-else-if="row.kind === 'divider'" class="context-divider" :class="row.cls"><span>{{ row.text }}</span></div>

      <div v-else-if="row.kind === 'approval'" class="msg approval-msg" :data-question-id="row.id || ''">
        <ApprovalCard
          v-if="row.approvalState === 'eligible'"
          :approval="row.payload"
          :on-respond="props.onApprovalRespond"
        />
        <div
          v-else
          class="approval-inroom-note"
          :class="{ resolved: row.approvalState !== 'awaiting', failed: row.approvalResult?.failed }"
        >
          <div>{{ row.note }}</div>
          <div v-if="row.approvalResult" class="approval-result">{{ row.approvalResult.line }}</div>
          <details v-if="row.approvalResult?.details" class="approval-details">
            <summary>Details</summary>
            <pre class="approval-payload">{{ row.approvalResult.details }}</pre>
          </details>
        </div>
      </div>

      <div v-else-if="row.kind === 'approval-notice' && row.notice" class="msg approval-msg" :data-message-id="row.id || ''">
        <div class="approval-inroom-note approval-notice" :class="row.notice.kind">
          <span>{{ row.notice.text }}</span>
          <span v-if="row.notice.resentByName" class="approval-notice-done">Sent again by {{ row.notice.resentByName }}</span>
          <button
            v-else-if="row.notice.kind === 'expired'"
            type="button"
            class="btn btn-secondary"
            :disabled="approvalBusy.has(`resend:${row.notice.questionId}`) || undefined"
            @click="resendApproval(row.notice.questionId)"
          >Send again</button>
          <span v-if="approvalErrors[`resend:${row.notice.questionId}`]" class="approval-error">{{
            approvalErrors[`resend:${row.notice.questionId}`]
          }}</span>
        </div>
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

        <TurnThoughts v-if="row.isAgent" :row="row" />
        <LimitRetry v-if="row.limitResetsAt != null" :row="row" />

        <div v-if="row.timeStr" class="timestamp" :title="row.timeTitle || undefined">{{ row.timeStr
          }}<span v-if="servedModelShown(row, state.settings)" class="served-model">{{
            ' · ' + servedModelShown(row, state.settings)
          }}</span></div>
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
