<script setup lang="ts">
/**
 * Admin → Publishing, mounted into <div id="publishing-panel"> (publishing.ts).
 * Per route: a switch, its settings (only while on), Connect and a status line
 * that reads Connected or names the one thing missing. Secrets typed here are
 * sent once and cleared; nothing reads them back.
 */
import { computed, reactive, ref, watch } from 'vue';
import { showToast } from '../core/toast.js';
import { connectRoute, saveRoute } from './publishing-actions.js';
import { changedFields, connectLabel, errorField, publishingView } from './publishing-state.js';
import { showConfirmModal } from './modals.js';
import BusyLabel from './BusyLabel.vue';

const view = computed(() => publishingView.value);

// Typed values, refreshed from the server whenever it answers.
const tsDomain = ref('');
const cf = reactive({ domain: '', accountId: '', zoneId: '', teamDomain: '' });
watch(
  view,
  (v) => {
    if (!v) return;
    tsDomain.value = v.tailnet.domain;
    Object.assign(cf, {
      domain: v.cloudflare.domain,
      accountId: v.cloudflare.accountId,
      zoneId: v.cloudflare.zoneId,
      teamDomain: v.cloudflare.teamDomain,
    });
  },
  { immediate: true },
);

const CF_FIELDS = [
  { key: 'domain', label: 'App domain', placeholder: 'example-apps.net' },
  { key: 'teamDomain', label: 'Team domain', placeholder: 'myteam.cloudflareaccess.com' },
  { key: 'accountId', label: 'Account ID', placeholder: '' },
  { key: 'zoneId', label: 'Zone ID', placeholder: '' },
] as const;

const errors = reactive<Record<string, string>>({});
const busy = ref('');
const connecting = ref<'' | 'tailnet' | 'cloudflare'>('');
const secret = reactive({ clientId: '', clientSecret: '', token: '' });

function clearErrors(prefix: string): void {
  for (const k of Object.keys(errors)) if (k.startsWith(prefix)) delete errors[k];
}

async function run(what: string, prefix: string, fn: () => Promise<void>): Promise<boolean> {
  busy.value = what;
  clearErrors(prefix);
  try {
    await fn();
    return true;
  } catch (err) {
    const field = errorField(err);
    errors[`${prefix}${field || 'form'}`] = (err as Error)?.message || 'That did not work';
    return false;
  } finally {
    busy.value = '';
  }
}

async function toggle(kind: 'tailnet' | 'cloudflare', e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  const on = el.checked;
  el.checked = !on; // shows what is saved until the server answers
  if (!on) {
    const ok = await showConfirmModal({
      title: `Turn off ${kind === 'tailnet' ? 'Tailnet' : 'Cloudflare'}?`,
      body: 'Apps published on it stop opening.',
      confirmLabel: 'Turn off',
      destructive: true,
    });
    if (!ok) return;
  }
  await run(`${kind}-switch`, `${kind}.`, () => saveRoute(kind, { on }));
}

const tsDirty = computed(() => !!view.value && tsDomain.value.trim() !== view.value.tailnet.domain);
const cfChanged = computed(() => (view.value ? changedFields(view.value.cloudflare, cf) : {}));
const cfDirty = computed(() => Object.keys(cfChanged.value).length > 0);

async function saveTailnet(): Promise<void> {
  if (await run('tailnet-save', 'tailnet.', () => saveRoute('tailnet', { domain: tsDomain.value.trim() })))
    showToast('Saved', { kind: 'success' });
}

async function saveCloudflare(): Promise<void> {
  if (await run('cloudflare-save', 'cloudflare.', () => saveRoute('cloudflare', { ...cfChanged.value })))
    showToast('Saved', { kind: 'success' });
}

function openConnect(kind: 'tailnet' | 'cloudflare'): void {
  connecting.value = kind;
  clearErrors(`${kind}.`);
}

function cancelConnect(): void {
  connecting.value = '';
  Object.assign(secret, { clientId: '', clientSecret: '', token: '' });
}

async function connect(kind: 'tailnet' | 'cloudflare'): Promise<void> {
  const body: Record<string, string> =
    kind === 'tailnet' ? { clientId: secret.clientId, clientSecret: secret.clientSecret } : { token: secret.token };
  const ok = await run(`${kind}-connect`, `${kind}.`, () => connectRoute(kind, body));
  // Never kept: cleared whether it worked or not.
  Object.assign(secret, { clientId: '', clientSecret: '', token: '' });
  if (ok) {
    connecting.value = '';
    showToast('Connected', { kind: 'success' });
  }
}
</script>

<template>
  <div v-if="view" class="publishing">
    <p v-if="view.gate" class="cred-hint err publishing-gate" :title="view.gate.detail || undefined">
      {{ view.gate.text }}
    </p>

    <div class="publishing-route">
      <div class="setting-group install-row">
        <span class="setting-label">Tailnet</span>
        <label class="setting-toggle"
          ><input
            type="checkbox"
            aria-label="Tailnet"
            :checked="view.tailnet.on"
            :disabled="busy === 'tailnet-switch' || undefined"
            @change="toggle('tailnet', $event)"
        /></label>
      </div>
      <p v-if="errors['tailnet.on'] || errors['tailnet.form']" class="cred-hint err">
        {{ errors['tailnet.on'] || errors['tailnet.form'] }}
      </p>
      <template v-if="view.tailnet.on">
        <p
          class="publishing-status"
          :class="{ ok: view.tailnet.status.ok }"
          :title="view.tailnet.status.detail || undefined"
        >
          <span class="publishing-dot" aria-hidden="true"></span>{{ view.tailnet.status.text }}
        </p>
        <p v-for="w in view.tailnet.status.warnings" :key="w.detail" class="cred-hint" :title="w.detail">
          {{ w.text }}
        </p>
        <div class="secret-form">
          <label class="secret-field"
            ><span class="form-label">Tailnet name</span
            ><input
              v-model="tsDomain"
              type="text"
              placeholder="tail1234.ts.net"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
          /></label>
          <button
            class="btn btn-secondary"
            type="button"
            :disabled="!tsDirty || busy === 'tailnet-save' || undefined"
            @click="saveTailnet"
          >
            <BusyLabel :busy="busy === 'tailnet-save'" label="Save" busy-label="Saving…" />
          </button>
        </div>
        <p v-if="errors['tailnet.domain']" class="cred-hint err">{{ errors['tailnet.domain'] }}</p>
        <button
          v-if="connecting !== 'tailnet'"
          class="btn btn-secondary publishing-connect"
          type="button"
          @click="openConnect('tailnet')"
        >
          {{ connectLabel(view.tailnet.status) }}
        </button>
        <template v-else>
          <div class="secret-form">
            <label class="secret-field"
              ><span class="form-label">Client ID</span
              ><input v-model="secret.clientId" type="text" autocomplete="off" autocapitalize="none" spellcheck="false"
            /></label>
            <label class="secret-field"
              ><span class="form-label">Client secret</span
              ><input
                v-model="secret.clientSecret"
                type="password"
                placeholder="tskey-client-…"
                autocomplete="new-password"
                spellcheck="false"
            /></label>
          </div>
          <p v-if="errors['tailnet.clientId'] || errors['tailnet.clientSecret']" class="cred-hint err">
            {{ errors['tailnet.clientId'] || errors['tailnet.clientSecret'] }}
          </p>
          <p class="cred-hint">Never shown again</p>
          <div class="publishing-actions">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="!secret.clientId || !secret.clientSecret || busy === 'tailnet-connect' || undefined"
              @click="connect('tailnet')"
            >
              <BusyLabel :busy="busy === 'tailnet-connect'" label="Connect" busy-label="Connecting…" />
            </button>
            <button class="btn btn-secondary" type="button" @click="cancelConnect">Cancel</button>
          </div>
        </template>
      </template>
    </div>

    <div class="publishing-route">
      <div class="setting-group install-row">
        <span class="setting-label">Cloudflare</span>
        <label class="setting-toggle"
          ><input
            type="checkbox"
            aria-label="Cloudflare"
            :checked="view.cloudflare.on"
            :disabled="busy === 'cloudflare-switch' || undefined"
            @change="toggle('cloudflare', $event)"
        /></label>
      </div>
      <p v-if="errors['cloudflare.on'] || errors['cloudflare.form']" class="cred-hint err">
        {{ errors['cloudflare.on'] || errors['cloudflare.form'] }}
      </p>
      <template v-if="view.cloudflare.on">
        <p
          class="publishing-status"
          :class="{ ok: view.cloudflare.status.ok }"
          :title="view.cloudflare.status.detail || undefined"
        >
          <span class="publishing-dot" aria-hidden="true"></span>{{ view.cloudflare.status.text }}
        </p>
        <p v-for="w in view.cloudflare.status.warnings" :key="w.detail" class="cred-hint" :title="w.detail">
          {{ w.text }}
        </p>
        <div class="publishing-fields">
          <label v-for="f in CF_FIELDS" :key="f.key" class="publishing-field"
            ><span class="form-label">{{ f.label }}</span
            ><input
              v-model="cf[f.key]"
              type="text"
              :placeholder="f.placeholder"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
            /><span v-if="errors[`cloudflare.${f.key}`]" class="cred-hint err">{{
              errors[`cloudflare.${f.key}`]
            }}</span></label
          >
          <button
            class="btn btn-secondary publishing-save"
            type="button"
            :disabled="!cfDirty || busy === 'cloudflare-save' || undefined"
            @click="saveCloudflare"
          >
            <BusyLabel :busy="busy === 'cloudflare-save'" label="Save" busy-label="Saving…" />
          </button>
        </div>
        <button
          v-if="connecting !== 'cloudflare'"
          class="btn btn-secondary publishing-connect"
          type="button"
          @click="openConnect('cloudflare')"
        >
          {{ connectLabel(view.cloudflare.status) }}
        </button>
        <template v-else>
          <div class="secret-form">
            <label class="secret-field"
              ><span class="form-label">API token</span
              ><input v-model="secret.token" type="password" autocomplete="new-password" spellcheck="false"
            /></label>
          </div>
          <p v-if="errors['cloudflare.token']" class="cred-hint err">{{ errors['cloudflare.token'] }}</p>
          <p class="cred-hint">Never shown again</p>
          <div class="publishing-actions">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="!secret.token || busy === 'cloudflare-connect' || undefined"
              @click="connect('cloudflare')"
            >
              <BusyLabel :busy="busy === 'cloudflare-connect'" label="Connect" busy-label="Connecting…" />
            </button>
            <button class="btn btn-secondary" type="button" @click="cancelConnect">Cancel</button>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
