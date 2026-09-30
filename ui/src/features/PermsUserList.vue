<script setup lang="ts">
/**
 * The permissions user list, mounted into <ul id="perms-user-list">. Sorting and
 * filtering are computeds over the raw records plus two scalars, so the A–Z toggle and
 * the search box re-sort by touching a ref.
 */
import { computed } from 'vue';
import { permsUsers, permsUserFilter, permsSortAz, permsSelectedUserId, permsMyUserId, usersError } from './perms-list-state.js';
import { userDisplayName, userIsOwner, userIsGlobalAdmin, userScopedAdminCount, userRoleSummary } from './perms-user-info.js';

const props = defineProps<{ onSelect: (id: string) => void }>();

const NO_USERS = 'No users yet — anyone who authenticates will appear here.';
const NO_MATCH = 'No users match.';

const byName = (a: any, b: any) => userDisplayName(a).localeCompare(userDisplayName(b));

/**
 * A–Z toggle: flat alphabetical when on; the tiered "auto" order when off —
 * you first, then owners, then admins, then everyone else, alpha within tier.
 */
const sorted = computed(() =>
  permsSortAz.value
    ? [...permsUsers.value].sort(byName)
    : [...permsUsers.value].sort((a, b) => {
        const tier = (u: any) =>
          u.id === permsMyUserId.value ? 0 : userIsOwner(u) ? 1 : userIsGlobalAdmin(u) || userScopedAdminCount(u) ? 2 : 3;
        const ta = tier(a);
        const tb = tier(b);
        return ta !== tb ? ta - tb : byName(a, b);
      }),
);

/**
 * Match on display name AND the namespaced id, so you can find someone by
 * handle/email or by channel prefix (e.g. "slack:").
 */
const rows = computed(() =>
  permsUserFilter.value
    ? sorted.value.filter((u) => `${userDisplayName(u)} ${u.id}`.toLowerCase().includes(permsUserFilter.value))
    : sorted.value,
);

const emptyText = computed(() => (permsUsers.value.length === 0 ? NO_USERS : NO_MATCH));

function activate(u: any) {
  props.onSelect(u.id);
}

/** One keydown handler, not .enter plus .space modifiers: one listener per (id, type). */
function onKey(e: KeyboardEvent, u: any) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate(u);
  }
}
</script>

<template>
  <li v-if="usersError" class="perms-empty">{{ usersError }}</li>
  <li v-else-if="rows.length === 0" class="perms-empty" style="padding:16px;">{{ emptyText }}</li>
  <template v-else>
    <li
      v-for="u in rows"
      :key="u.id"
      tabindex="0"
      v-bind="u.id === permsSelectedUserId ? { class: 'active' } : {}"
      @click="activate(u)"
      @keydown="onKey($event, u)"
    >
      <div class="perms-user-name">
        <span class="perms-name-text">{{ userDisplayName(u) }}</span>
        <span v-if="u.id === permsMyUserId" class="perms-you-tag">YOU</span>
      </div>
      <div class="perms-user-id-sub">{{ u.id }}</div>
      <div class="perms-user-summary">{{ userRoleSummary(u) }}</div>
    </li>
  </template>
</template>
