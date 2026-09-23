<script setup lang="ts">
/**
 * The user's own per-agent credentials — fifty-eighth island.
 *
 * Mounted into <div id="my-credentials-list">, exclusively owned by this module.
 * #settings-my-credentials keeps its hidden flag: with no connected credentials
 * anywhere the whole section disappears rather than explaining itself.
 *
 * ONE add-form per agent, not a shared form with an agent picker — that would
 * just be the "Used by" dropdown again, and this list is short by construction.
 *
 * These are the same rows the agent panel files under "Only you"; the badge and
 * the "For you" line use that panel's words so the two views read as one.
 *
 * The two fields are UNCONTROLLED and read at click time, exactly as the
 * imperative version read hostField.input.value. v-model would have been the
 * obvious Vue idiom and is wrong here: it attaches an input listener to every
 * field, which the original never had and which the listener-set guard counts.
 *
 * fieldEl() is absorbed; it was used only here. The password field keeps
 * autocomplete="new-password" — so browsers do not offer the user's saved
 * login for a token box — and spellcheck off.
 */
import { myCredGroups, myCredSaving } from './my-credentials-state.js';

const props = defineProps<{
  onRemove: (group: any, secret: any) => void;
  onAdd: (group: any, host: string, value: string, fields: HTMLInputElement[]) => void;
  onOpenAgent: (group: any) => void;
}>();

const ADD = 'Add secret';
const REMOVE = 'Remove';
const OPEN = 'Open agent';
const BADGE = 'only you';
const HOST_LABEL = 'Host';
const VALUE_LABEL = 'Token or key';
const HOST_PLACEHOLDER = 'dev.azure.com';
const SOURCE_WORD: Record<string, string> = { user: 'yours', agent: 'this agent’s', workspace: 'all agents’' };

function forYou(g: any): string {
  const parts = (g.effective ?? []).map((e: any) => `${e.hostPattern} → ${SOURCE_WORD[e.source] ?? e.source}`);
  return parts.length ? `For you: ${parts.join(' · ')}` : 'For you: no credential yet';
}

function add(g: any, e: Event) {
  const form = (e.currentTarget as HTMLElement).closest('.secret-form')!;
  const [host, value] = [...form.querySelectorAll('input')] as HTMLInputElement[];
  props.onAdd(g, host.value.trim(), value.value, [host, value]);
}
</script>

<template>
  <div v-for="g in myCredGroups" :key="g.agentGroupId" class="my-cred-group">
    <div class="my-cred-head">
      <span class="form-label">{{ g.name }}</span>
      <button class="btn btn-ghost" type="button" @click="props.onOpenAgent(g)">{{ OPEN }}</button>
    </div>
    <p class="secret-effective">{{ forYou(g) }}</p>
    <ul class="skill-sources-list">
      <li v-for="(sec, i) in g.secrets" :key="i" class="skill-source-row secret-row">
        <div class="skill-info">
          <div class="skill-head">
            <span>{{ sec.hostPattern }}</span><span class="skill-badge secret-scope skill-badge-user">{{ BADGE }}</span>
          </div>
        </div>
        <button class="btn btn-danger" type="button" @click="props.onRemove(g, sec)">{{ REMOVE }}</button>
      </li>
    </ul>
    <div class="secret-form">
      <label class="secret-field">
        <span class="form-label">{{ HOST_LABEL }}</span
        ><input type="text" :placeholder="HOST_PLACEHOLDER" autocomplete="off" autocapitalize="none" spellcheck="false" />
      </label>
      <label class="secret-field">
        <span class="form-label">{{ VALUE_LABEL }}</span
        ><input type="password" autocomplete="new-password" spellcheck="false" />
      </label>
      <button
        class="btn btn-primary"
        type="button"
        :disabled="myCredSaving.has(g.agentGroupId) || undefined"
        @click="add(g, $event)"
      >{{ ADD }}</button>
    </div>
  </div>
</template>
