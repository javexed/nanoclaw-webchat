<script setup lang="ts">
/**
 * The permissions user list — eleventh island.
 *
 * Mounted into <ul id="perms-user-list">, exclusively owned by this module.
 *
 * Sorting and filtering stay HERE rather than being shaped at the mount site
 * like ModelList and SearchResults. Those two shape upstream because their row
 * data needs something the component must not have (a module cycle, an escaping
 * order). This one needs neither: the inputs are the raw user records plus two
 * scalars, and the derivations are pure. Keeping them in a computed means the
 * A–Z toggle and the search box re-sort by touching a ref, instead of by
 * calling a render function that rebuilds the DOM.
 *
 * Rendering rules from the earlier islands, all load-bearing here:
 *   - text is BOUND, never written as template text (template text carries the
 *     surrounding newlines, which textContent did not have)
 *   - no comments in the template; Vue renders them as DOM comment nodes
 *   - v-bind an object for a conditional class; :class="{active:false}" emits
 *     class="" where the imperative version had no class attribute at all
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

/**
 * One keydown handler, not @keydown.enter plus @keydown.space. Two modifier
 * bindings on the same event compile to an array the invoker walks, which is
 * still a single addEventListener — but it is a detail of the compiler, and the
 * listener-set guard compares (id, type) pairs. Writing the original's single
 * handler keeps the comparison honest instead of relying on that.
 */
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
