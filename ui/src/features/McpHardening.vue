<script setup lang="ts">
/**
 * An MCP server's hardening panel, mounted into <div id="mcp-hardening">: health, drift,
 * tool allowlist, OAuth, in that order; stdio servers render nothing. Tool checkboxes keep
 * their state in the DOM: Save compares the checked COUNT to the total because "all
 * checked" is stored as null (no restriction, so future tools flow through).
 */
import { computed } from 'vue';
import { isWorkspaceAdminView } from '../core/state.js';
import { hardeningServer, oauthBusy } from './mcp-panel-state.js';

const props = defineProps<{ onApprove: () => void; onSaveTools: () => void; onOauth: () => void }>();

const DRIFT_HEAD = 'Tools changed since you approved this server';
const APPROVE = 'Review + re-approve';
const SAVE_TOOLS = 'Save tool selection';
const BOLD = { fontWeight: '600' };

const s = computed(() => hardeningServer.value);
const show = computed(() => !!s.value && s.value.transport !== 'stdio');

const healthText = computed(() => {
  const h = s.value?.health;
  if (!h) return '';
  const when = h.at ? new Date(h.at).toLocaleString() : '';
  if (h.status === 'ok') return `● Healthy — ${h.toolCount ?? '?'} tools (checked ${when})`;
  if (h.status === 'auth') return `● Rejecting credentials (checked ${when})`;
  if (h.status === 'down') return `● Unreachable (checked ${when})`;
  return `● Tool surface changed (checked ${when})`;
});

/** The drift summary, in display order. */
const driftParts = computed(() => {
  const d = s.value?.drift;
  if (!d) return [];
  const parts: string[] = [];
  if (d.added?.length) parts.push(`new: ${d.added.join(', ')}`);
  if (d.removed?.length) parts.push(`removed: ${d.removed.join(', ')}`);
  if (d.changed?.length) parts.push(`descriptions changed: ${d.changed.join(', ')}`);
  return parts;
});

const tools = computed(() => {
  const p = s.value?.pinned_tools;
  if (!Array.isArray(p) || !p.length) return null;
  const enabled = Array.isArray(s.value.enabled_tools) ? new Set(s.value.enabled_tools) : null;
  return p.map((t: any) => ({ name: t.name, desc: t.description || '', checked: enabled ? enabled.has(t.name) : true }));
});

const oauthLabel = computed(() => (s.value?.auth?.kind === 'oauth' ? 'Reconnect (OAuth)' : 'Connect with OAuth…'));
const authNote = computed(() =>
  s.value?.auth?.kind === 'oauth'
    ? 'Connected via OAuth — the token lives on the host; agents go through the relay.'
    : 'Bearer token stored on the host — agents go through the relay, the token never enters a container.',
);
</script>

<template>
  <template v-if="show">
    <p v-if="s.health" :class="`room-prime-note mcp-health-text-${s.health.status}`">{{ healthText }}</p>
    <div v-if="s.drift" class="mcp-drift-banner">
      <div :style="BOLD">{{ DRIFT_HEAD }}</div>
      <div>{{ driftParts.join(' · ') }}</div>
      <button v-if="isWorkspaceAdminView" type="button" class="btn btn-secondary" @click="props.onApprove()">
        {{ APPROVE }}
      </button>
    </div>
    <div v-if="tools">
      <span class="form-label">Tools ({{ tools.length }})</span>
      <div class="mcp-tools-list">
        <label v-for="t in tools" :key="t.name" class="mcp-tool-row">
          <input type="checkbox" :checked="t.checked" :data-tool="t.name" :disabled="!isWorkspaceAdminView || undefined" /><span :title="t.desc">{{ t.name }}</span>
        </label>
      </div>
      <button v-if="isWorkspaceAdminView" type="button" class="btn btn-secondary" @click="props.onSaveTools()">
        {{ SAVE_TOOLS }}
      </button>
    </div>
    <button
      v-if="isWorkspaceAdminView"
      type="button"
      class="btn btn-ghost"
      :disabled="oauthBusy || undefined"
      @click="props.onOauth()"
    >
      {{ oauthLabel }}
    </button>
    <p v-if="s.auth" class="room-prime-note">{{ authNote }}</p>
  </template>
</template>
