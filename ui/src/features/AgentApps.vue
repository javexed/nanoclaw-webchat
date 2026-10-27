<script setup lang="ts">
/**
 * An agent's apps, mounted into <div id="agent-apps"> (apps.ts). One row per app
 * (or per unpublished workload): name, state, route, who can open it, Open ↗ and
 * a ⋯ menu. Renders from apps-state.ts; every action lives in apps-actions.ts.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  appsBusy,
  appsDrawer,
  appsErrors,
  appsInfoKey,
  appsMenuKey,
  appsService,
  appsView,
  diskText,
  parseEmailList,
  routeOptions,
  rowKey,
  STATE_LABEL,
  whoOptions,
  type AppRow,
  type RouteChoice,
  type Who,
} from './apps-state.js';
import {
  closeDrawer,
  closeMenu,
  onRouteChange,
  onWhoChange,
  openLogs,
  openPeople,
  openRestore,
  pickService,
  remove,
  restore,
  savePeople,
  startStop,
  toggleInfo,
  toggleMenu,
} from './apps-actions.js';
import { lucide } from '../core/dom.js';

const KEBAB = lucide('ellipsis');
const INFO = lucide('info');
const NO_SERVICE =
  'None of its services declares a port to publish, so the agent publishes it with ncl workloads expose.';
const LOADING = 'Loading…';
const NO_LOGS = 'No logs yet';

// A click anywhere else, or Escape, closes the ⋯ menu.
const onDocClick = () => closeMenu();
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && appsMenuKey.value) closeMenu();
};
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});
const view = computed(() => appsView.value);
const disk = computed(() => diskText(view.value?.disk ?? null));

const busy = (r: AppRow) => appsBusy.value.has(rowKey(r));
const drawerOf = (r: AppRow) => (appsDrawer.value?.key === rowKey(r) ? appsDrawer.value : null);

// The people list being edited, for the row whose drawer is open.
const peopleText = ref('');
watch(
  () => appsDrawer.value,
  (d) => {
    if (d?.kind !== 'people') return;
    const row = view.value?.apps.find((a) => rowKey(a) === d.key);
    peopleText.value = row?.who === 'specific' ? row.emails.join(', ') : '';
  },
);
const people = computed(() => parseEmailList(peopleText.value));

const restoreStamp = ref('');
watch(
  () => appsDrawer.value,
  (d) => {
    if (d?.kind === 'restore') restoreStamp.value = d.backups?.[0]?.stamp ?? '';
  },
);
function doRestore(r: AppRow, backups: Array<{ stamp: string; at: string }>): void {
  const b = backups.find((x) => x.stamp === restoreStamp.value);
  if (b) void restore(r, b.stamp, b.at);
}

function routeChanged(r: AppRow, e: Event): void {
  const el = e.target as HTMLSelectElement;
  const v = el.value as RouteChoice;
  el.value = r.route; // the row shows what is live until the server says otherwise
  onRouteChange(r, v);
}
function whoChanged(r: AppRow, e: Event): void {
  const el = e.target as HTMLSelectElement;
  const v = el.value as Who;
  el.value = r.who;
  onWhoChange(r, v);
}
</script>

<template>
  <div v-if="view" class="apps">
    <div v-if="disk" class="apps-disk" :class="`apps-disk-${view.disk?.level}`">{{ disk }}</div>
    <p v-if="!view.apps.length" class="apps-empty">No apps yet</p>
    <ul v-else class="apps-list">
      <li v-for="r in view.apps" :key="rowKey(r)" class="app-row" :aria-busy="busy(r) || undefined">
        <div class="app-row-head">
          <span class="app-name">{{ r.app ?? r.workload }}</span>
          <span v-if="busy(r)" class="btn-spinner" aria-hidden="true"></span>
          <span class="app-state" :class="`app-state-${r.state}`">{{ STATE_LABEL[r.state] }}</span>
          <a v-if="r.url" class="app-open" :href="r.url" target="_blank" rel="noopener noreferrer">Open ↗</a>
          <button
            v-if="r.deployed"
            class="app-kebab"
            type="button"
            :aria-label="`Actions for ${r.app ?? r.workload}`"
            :aria-expanded="appsMenuKey === rowKey(r)"
            @click.stop="toggleMenu(r)"
            v-html="KEBAB"
          ></button>
        </div>
        <div v-if="r.deployed" class="app-row-controls">
          <select
            :value="r.route"
            aria-label="Route"
            :disabled="busy(r) || (r.route === 'off' && !r.canPublish) || undefined"
            @change="routeChanged(r, $event)"
          >
            <option v-for="o in routeOptions(view.routes, r.route)" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
          <select
            v-if="!r.app && r.services.length > 1"
            :value="appsService.get(rowKey(r)) ?? r.services[0]"
            aria-label="Service"
            :disabled="busy(r) || undefined"
            @change="pickService(r, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="sv in r.services" :key="sv" :value="sv">{{ sv }}</option>
          </select>
          <button
            v-if="!r.app && !r.canPublish"
            class="feature-info-btn"
            type="button"
            :aria-expanded="appsInfoKey === rowKey(r)"
            aria-label="Why it can’t be published here"
            @click="toggleInfo(r)"
            v-html="INFO"
          ></button>
          <select
            v-if="r.route !== 'off'"
            :value="r.who"
            aria-label="Who can open"
            :disabled="busy(r) || undefined"
            @change="whoChanged(r, $event)"
          >
            <option v-for="o in whoOptions(r.route)" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <button
            v-if="r.who === 'specific' && r.route === 'cloudflare'"
            class="btn btn-ghost"
            type="button"
            @click="openPeople(r)"
          >
            {{ r.emails.length === 1 ? '1 person' : `${r.emails.length} people` }}
          </button>
        </div>
        <p v-if="!r.app && !r.canPublish && appsInfoKey === rowKey(r)" class="cred-hint">{{ NO_SERVICE }}</p>
        <p v-if="appsErrors.get(rowKey(r))" class="cred-hint err" role="alert">{{ appsErrors.get(rowKey(r)) }}</p>
        <div v-if="appsMenuKey === rowKey(r)" class="app-menu" role="menu">
          <button type="button" role="menuitem" @click.stop="startStop(r)">{{ r.running ? 'Stop' : 'Start' }}</button>
          <button type="button" role="menuitem" @click.stop="openLogs(r)">Logs</button>
          <button type="button" role="menuitem" @click.stop="openRestore(r)">Restore backup…</button>
          <button type="button" role="menuitem" class="app-menu-danger" @click.stop="remove(r)">Delete…</button>
        </div>
        <template v-if="drawerOf(r)">
          <div v-if="drawerOf(r)!.kind === 'logs'" class="app-drawer">
            <div class="app-drawer-head">
              <span class="form-label">Logs</span>
              <button class="btn btn-ghost" type="button" @click="closeDrawer">Close</button>
            </div>
            <p v-if="(drawerOf(r) as any).text === null" class="apps-empty">
              <span class="btn-spinner" aria-hidden="true"></span>{{ LOADING }}
            </p>
            <pre v-else class="app-logs">{{ (drawerOf(r) as any).text || NO_LOGS }}</pre>
          </div>
          <div v-else-if="drawerOf(r)!.kind === 'restore'" class="app-drawer">
            <div class="app-drawer-head">
              <span class="form-label">Restore backup</span>
              <button class="btn btn-ghost" type="button" @click="closeDrawer">Close</button>
            </div>
            <p v-if="(drawerOf(r) as any).backups === null" class="apps-empty">
              <span class="btn-spinner" aria-hidden="true"></span>{{ LOADING }}
            </p>
            <p v-else-if="!(drawerOf(r) as any).backups.length" class="apps-empty">No backups yet</p>
            <div v-else class="app-drawer-row">
              <select v-model="restoreStamp" aria-label="Backup">
                <option v-for="b in (drawerOf(r) as any).backups" :key="b.stamp" :value="b.stamp">{{ b.at }}</option>
              </select>
              <button class="btn btn-danger" type="button" @click="doRestore(r, (drawerOf(r) as any).backups)">
                Restore
              </button>
            </div>
          </div>
          <div v-else class="app-drawer">
            <div class="app-drawer-head">
              <span class="form-label">Specific people</span>
              <button class="btn btn-ghost" type="button" @click="closeDrawer">Close</button>
            </div>
            <div class="app-drawer-row">
              <input
                v-model="peopleText"
                @keydown.enter.prevent="people.emails.length && !people.bad.length && savePeople(r, people.emails)"
                type="text"
                inputmode="email"
                autocomplete="off"
                spellcheck="false"
                placeholder="name@example.com, …"
                aria-label="Email addresses"
              />
              <button
                class="btn btn-primary"
                type="button"
                :disabled="!people.emails.length || people.bad.length > 0 || undefined"
                @click="savePeople(r, people.emails)"
              >
                Save
              </button>
            </div>
            <p v-if="people.bad.length" class="cred-hint err">Not an email address: {{ people.bad.join(', ') }}</p>
          </div>
        </template>
      </li>
    </ul>
  </div>
</template>
