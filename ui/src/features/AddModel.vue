<script setup lang="ts">
/**
 * Add model, mounted into <div id="model-add"> each time the panel opens:
 * Cloud (connect the provider's key, then pick from its own list), Server
 * (pull to an Ollama host from a short catalog, or add a model it has), or
 * Custom (the probe and manual form beside it, shown through onCustom).
 */
import { computed, onMounted, ref, watch } from 'vue';

import { apiJson } from '../core/api.js';
import { showToast } from '../core/toast.js';
import BusyLabel from './BusyLabel.vue';
import { loadCloudModels, waitForRouter, type CloudInfo } from './cloud-models.js';
import InstallProgress from './InstallProgress.vue';
import { installLogText } from './installer-state.js';
import { cancelOllamaPull, pollOllamaPulls } from './installers.js';
import { MODEL_CATALOG } from './model-catalog.js';
import { hostPulls } from './ollama-cards-state.js';
import OllamaPullStatus from './OllamaPullStatus.vue';

const props = defineProps<{ onDone: (models: any[]) => void; onCustom: (show: boolean) => void }>();

const MODES = [
  { id: 'cloud', label: 'Cloud' },
  { id: 'server', label: 'Server' },
  { id: 'custom', label: 'Custom' },
] as const;
type Mode = (typeof MODES)[number]['id'];
const mode = ref<Mode | null>(null);
const busy = ref(false);
/** Which action is in flight ('connect', 'disconnect', 'add', 'local:<tag>'): its button shows the wait. */
const doing = ref('');
/** The router install behind adding a cloud model (InstallProgress.vue). */
const installLog = ref('');

function choose(m: Mode) {
  mode.value = m;
  if (!busy.value) installLog.value = '';
  props.onCustom(m === 'custom');
}

function fail(err: unknown) {
  showToast(String((err as Error)?.message || err), { kind: 'error' });
}

// ── Cloud ──
const info = ref<CloudInfo | null>(null);
const provider = ref('');
const key = ref('');
const models = ref<string[]>([]);
const filter = ref('');
const picked = ref('');
const connected = computed(() => !!info.value?.stored.includes(provider.value));
const shown = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return f ? models.value.filter((m) => m.toLowerCase().includes(f)) : models.value;
});

async function listModels() {
  models.value = [];
  picked.value = '';
  if (!connected.value) return;
  try {
    const out = await apiJson(`/api/models/cloud/models?provider=${encodeURIComponent(provider.value)}`);
    models.value = out.models ?? [];
  } catch (err) {
    fail(err);
  }
}
watch(provider, () => void listModels());

async function connect() {
  busy.value = true;
  doing.value = 'connect';
  try {
    const out = await apiJson('/api/models/cloud/connect', {
      method: 'POST',
      body: { provider: provider.value, api_key: key.value },
    });
    key.value = '';
    info.value = { ...info.value!, stored: [...info.value!.stored, provider.value] };
    models.value = out.models ?? [];
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
    doing.value = '';
  }
}

async function disconnect() {
  busy.value = true;
  doing.value = 'disconnect';
  try {
    await apiJson(`/api/models/cloud/connect?provider=${encodeURIComponent(provider.value)}`, { method: 'DELETE' });
    info.value = { ...info.value!, stored: info.value!.stored.filter((p) => p !== provider.value) };
    models.value = [];
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
    doing.value = '';
  }
}

async function addCloud() {
  const modelId = picked.value;
  busy.value = true;
  doing.value = 'add';
  installLog.value = '';
  try {
    await apiJson('/api/models/cloud', {
      method: 'POST',
      body: { provider: provider.value, model_id: modelId, api_key: '' },
    });
    if (!(await waitForRouter((st) => (installLog.value = installLogText(st))))) throw new Error('Router failed');
    const fresh = await loadCloudModels();
    const all = (await apiJson('/api/models')) as any[];
    const model = all.find((m) => m.model_id === modelId && m.endpoint === fresh?.router.endpoint);
    if (!model) throw new Error('Added, but not registered');
    installLog.value = '';
    props.onDone([model]);
  } catch (err) {
    // A failed install keeps its log; one refused before it started has none.
    fail(err);
  } finally {
    busy.value = false;
    doing.value = '';
  }
}

// ── Server ──
const OTHER = '';
const hosts = ref<string[]>([]);
const host = ref<string>(OTHER);
const newHost = ref('');
const family = ref(Object.keys(MODEL_CATALOG)[0]!);
const installed = ref(new Set<string>());
const otherTag = ref('');
/** The host whose pull line shows here: the last one this panel started. */
const pullHost = ref('');

function serverUrl(): string {
  const raw = (host.value || newHost.value).trim().replace(/\/+$/, '');
  if (!raw) return '';
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return /:\d+$/.test(withScheme.replace(/^https?:\/\//, '')) ? withScheme : `${withScheme}:11434`;
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function loadInstalled() {
  installed.value = new Set();
  const url = serverUrl();
  if (!url) return;
  try {
    const out = await apiJson(`/api/ollama/models?host=${encodeURIComponent(url)}`);
    installed.value = new Set((out.models ?? []).map((m: any) => String(m.name)));
  } catch {
    /* unreachable: everything shows Install, and the pull says why */
  }
}
watch(host, () => void loadInstalled());

const has = (tag: string) => installed.value.has(tag) || installed.value.has(`${tag}:latest`);

const same = (a: string, b: string) => a === b || a === `${b}:latest`;

/** The pull through the shared poller, so its line is the host cards' own; resolves on its outcome. */
function waitForPull(url: string, tag: string): Promise<void> {
  pollOllamaPulls();
  return new Promise((resolve, reject) => {
    const stop = watch(
      () => hostPulls.value[url],
      (p) => {
        if (!p || !same(p.model, tag) || p.status === 'pulling') return;
        stop();
        if (p.status === 'success') resolve();
        else reject(null);
      },
      { immediate: true, deep: true },
    );
  });
}

async function addLocal(rawTag: string) {
  const tag = rawTag.trim();
  const url = serverUrl();
  if (!tag || !url) return;
  busy.value = true;
  doing.value = `local:${tag}`;
  try {
    if (!has(tag)) {
      pullHost.value = url;
      // The host's last pull line goes: a stale outcome must not end this one.
      hostPulls.value = Object.fromEntries(Object.entries(hostPulls.value).filter(([h]) => h !== url));
      await apiJson('/api/ollama/pull', { method: 'POST', body: { host: url, model: tag } });
      await waitForPull(url, tag);
    }
    const out = await apiJson('/api/models', {
      method: 'POST',
      body: { name: `${hostName(url)} · ${tag}`, kind: 'ollama', endpoint: url, model_id: tag },
    });
    props.onDone([out.model]);
  } catch (err) {
    // null: the pull's own line already says how it ended.
    if (err !== null) fail(err);
  } finally {
    busy.value = false;
    doing.value = '';
  }
}

onMounted(async () => {
  try {
    info.value = (await apiJson('/api/models/cloud')) as CloudInfo;
    provider.value = info.value.providers[0]?.id ?? '';
  } catch {
    /* no cloud models here */
  }
  try {
    hosts.value = (await apiJson('/api/ollama/hosts')).hosts ?? [];
    host.value = hosts.value[0] ?? OTHER;
  } catch {
    /* none known: type one */
  }
});
</script>

<template>
  <div class="model-add-modes">
    <button
      v-for="m in MODES"
      :key="m.id"
      type="button"
      :class="['btn', 'btn-sm', mode === m.id ? 'btn-primary' : 'btn-secondary']"
      @click="choose(m.id)"
    >
      {{ m.label }}
    </button>
  </div>

  <div v-if="mode === 'cloud' && info" class="model-add-step">
    <select v-model="provider" aria-label="Provider">
      <option v-for="p in info.providers" :key="p.id" :value="p.id">{{ p.label }}</option>
    </select>
    <div v-if="!connected" class="model-id-row">
      <input
        v-model="key"
        type="password"
        placeholder="API key"
        aria-label="API key"
        autocomplete="new-password"
        spellcheck="false"
      />
      <button type="button" class="btn btn-primary" :disabled="busy || !key.trim()" @click="connect">
        <BusyLabel :busy="doing === 'connect'" label="Connect" busy-label="Connecting…" />
      </button>
    </div>
    <template v-else>
      <input v-model="filter" type="text" placeholder="Filter" aria-label="Filter" autocomplete="off" />
      <select v-model="picked" size="8" aria-label="Model">
        <option v-for="m in shown" :key="m" :value="m">{{ m }}</option>
      </select>
      <InstallProgress :text="installLog" />
      <div class="agent-detail-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="disconnect">
          <BusyLabel :busy="doing === 'disconnect'" label="Disconnect" busy-label="Disconnecting…" />
        </button>
        <button type="button" class="btn btn-primary" :disabled="busy || !picked" @click="addCloud">
          <BusyLabel :busy="doing === 'add'" label="Add" busy-label="Adding…" />
        </button>
      </div>
    </template>
  </div>

  <div v-if="mode === 'server'" class="model-add-step">
    <select v-model="host" aria-label="Server">
      <option v-for="h in hosts" :key="h" :value="h">{{ h }}</option>
      <option :value="OTHER">Other…</option>
    </select>
    <input
      v-if="!host"
      v-model="newHost"
      type="text"
      placeholder="host:11434"
      aria-label="Server"
      autocomplete="off"
      @change="loadInstalled"
    />
    <select v-model="family" aria-label="Family">
      <option v-for="f in Object.keys(MODEL_CATALOG)" :key="f" :value="f">{{ f }}</option>
    </select>
    <ul class="model-probe-list">
      <li v-for="m in MODEL_CATALOG[family]" :key="m.tag" class="model-add-row">
        <span class="model-add-tag">{{ m.tag }}</span>
        <span class="skill-badge">{{ m.gb }} GB</span>
        <span v-if="m.licence" class="skill-badge">{{ m.licence }}</span>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="addLocal(m.tag)">
          <BusyLabel
            :busy="doing === `local:${m.tag}`"
            :label="has(m.tag) ? 'Add' : 'Install'"
            :busy-label="has(m.tag) ? 'Adding…' : 'Installing…'"
          />
        </button>
      </li>
      <li class="model-add-row">
        <input v-model="otherTag" type="text" placeholder="Other tag" aria-label="Other tag" autocomplete="off" />
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="busy || !otherTag.trim()"
          @click="addLocal(otherTag)"
        >
          <BusyLabel
            :busy="doing === `local:${otherTag.trim()}`"
            :label="has(otherTag.trim()) ? 'Add' : 'Install'"
            :busy-label="has(otherTag.trim()) ? 'Adding…' : 'Installing…'"
          />
        </button>
      </li>
    </ul>
    <OllamaPullStatus
      v-if="pullHost"
      :pull="hostPulls[pullHost] ?? null"
      :on-cancel="(m: string) => void cancelOllamaPull(pullHost, m)"
    />
  </div>

</template>
