<script setup lang="ts">
/**
 * Admin → Scaling → Machines (owners and global admins; the API is guarded
 * too). Machines join with a one-line install command; NanoClaw works out
 * what it may use on each (total minus other software's peak minus headroom),
 * and an optional cap lowers that. Server: server/routes-scaling.ts.
 */
import { onMounted, reactive, ref } from 'vue';

import { apiJson } from '../core/api.js';
import { lucide } from '../core/dom.js';
import { showToast } from '../core/toast.js';
import { copyTextToClipboard } from '../boot.js';
import { showConfirmModal } from './modals.js';
import {
  ago,
  availableLine,
  capForm,
  isolationLine,
  needsWorker,
  placedLine,
  statusOf,
  usageLine,
  type MachineRow,
} from './machines-view.js';
import SshJoin from './SshJoin.vue';

const T = {
  off: 'Off: NANOCLAW_MACHINE_PORT is not set',
  empty: 'No machines',
  add: 'Add machine',
  ssh: 'Join over SSH',
  run: 'Run on the machine (valid 1 hour, once):',
  copy: 'Copy',
  done: 'Done',
  drain: 'Drain',
  resume: 'Resume',
  revoke: 'Revoke',
  remove: 'Remove',
  cap: 'Cap',
  save: 'Save',
  cancel: 'Cancel',
  capMem: 'GB',
  capCpu: 'CPUs',
  uses: 'NanoClaw may use',
  reported: 'reported',
  linked: 'linked',
  noLink: 'no worker link',
  workerRun: 'Run once on the machine:',
  runHere: 'Run workloads here',
  fixInfo: 'How to fix',
  fixRun: 'Run on the machine as root:',
};
const INFO = lucide('info');

const listener = ref<{ address: string; port: number } | null>(null);
const machines = ref<MachineRow[]>([]);
const command = ref<string | null>(null);
const workerCommand = ref('');
const hostRulesCommand = ref('');
const fixOpen = ref<string | null>(null);
const ssh = ref(false);
const capping = ref<string | null>(null);
const cap = reactive({ memGb: '', cpus: '' });

const fail = (err: any): void => {
  showToast(err?.body?.error || err?.message || String(err), { kind: 'error' });
};

async function load(): Promise<void> {
  try {
    const d = await apiJson('/api/scaling/machines');
    listener.value = d.listener;
    machines.value = d.machines;
    workerCommand.value = d.workerCommand ?? '';
    hostRulesCommand.value = d.hostRulesCommand ?? '';
  } catch (err) {
    fail(err);
  }
}

async function add(): Promise<void> {
  try {
    command.value = (await apiJson('/api/scaling/machines/join', { method: 'POST', body: { role: 'worker' } })).command;
  } catch (err) {
    fail(err);
  }
}

async function act(m: MachineRow, path: string, body: unknown = {}): Promise<void> {
  try {
    await apiJson(`/api/scaling/machines/${encodeURIComponent(m.id)}/${path}`, { method: 'POST', body });
    await load();
  } catch (err) {
    fail(err);
  }
}

async function setRunHere(m: MachineRow): Promise<void> {
  await act(m, 'workloads', { on: !m.workloadsOn });
}

async function revoke(m: MachineRow): Promise<void> {
  const ok = await showConfirmModal({
    title: `Revoke ${m.name}?`,
    body: 'It is cut off at once.',
    confirmLabel: T.revoke,
    destructive: true,
  });
  if (ok) await act(m, 'revoke');
}

async function remove(m: MachineRow): Promise<void> {
  try {
    await apiJson(`/api/scaling/machines/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    fail(err);
  }
}

function startCap(m: MachineRow): void {
  capping.value = m.id;
  Object.assign(cap, capForm(m));
}

async function saveCap(m: MachineRow): Promise<void> {
  try {
    await apiJson(`/api/scaling/machines/${encodeURIComponent(m.id)}/cap`, {
      method: 'PUT',
      body: { memGb: cap.memGb.trim() || null, cpus: cap.cpus.trim() || null },
    });
    capping.value = null;
    await load();
  } catch (err) {
    fail(err);
  }
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <p v-if="!listener" class="setting-hint">{{ T.off }}</p>
  <template v-else>
    <ul class="skill-sources-list">
      <li v-if="!machines.length" class="setting-hint">{{ T.empty }}</li>
      <li v-for="m in machines" :key="m.id" class="skill-source-row secret-row machine-row">
        <div class="skill-info">
          <div class="skill-head">
            {{ m.name }} <span :class="['model-kind-badge', `kind-${statusOf(m)}`]">{{ statusOf(m) }}</span>
          </div>
          <span class="skill-desc">{{ usageLine(m) }} · {{ T.reported }} {{ ago(m.lastReport) }}</span>
          <span class="skill-desc"
            >{{ T.uses }}: {{ availableLine(m)
            }}<template v-if="m.role === 'worker' && m.linked !== undefined">
              · {{ m.linked ? T.linked : T.noLink }}</template
            ></span
          >
          <span v-if="isolationLine(m)" :class="['skill-desc', 'machine-isolation', isolationLine(m)!.tone]"
            >{{ isolationLine(m)!.text
            }}<button
              v-if="isolationLine(m)!.fix && hostRulesCommand"
              class="feature-info-btn"
              type="button"
              :aria-expanded="fixOpen === m.id"
              :aria-label="T.fixInfo"
              @click="fixOpen = fixOpen === m.id ? null : m.id"
              v-html="INFO"
            ></button
          ></span>
          <div v-if="fixOpen === m.id && isolationLine(m)?.fix" class="machine-command">
            <span class="setting-hint">{{ T.fixRun }}</span>
            <pre class="roster-refresh-log">{{ hostRulesCommand }}</pre>
            <button class="btn btn-secondary" type="button" @click="copyTextToClipboard(hostRulesCommand)">
              {{ T.copy }}
            </button>
          </div>
          <div v-if="m.role === 'worker' && m.state !== 'revoked'" class="machine-run-here">
            <span>{{ T.runHere }}</span>
            <button
              type="button"
              :class="['perms-switch', { on: m.workloadsOn }]"
              role="switch"
              :aria-checked="m.workloadsOn ? 'true' : 'false'"
              :aria-label="T.runHere"
              @click="setRunHere(m)"
            ></button>
          </div>
          <span v-for="p in m.placed ?? []" :key="p.name" class="skill-desc">{{ placedLine(p) }}</span>
          <div v-if="needsWorker(m) && workerCommand" class="machine-command">
            <span class="setting-hint">{{ T.workerRun }}</span>
            <pre class="roster-refresh-log">{{ workerCommand }}</pre>
            <button class="btn btn-secondary" type="button" @click="copyTextToClipboard(workerCommand)">
              {{ T.copy }}
            </button>
          </div>
          <form v-if="capping === m.id" class="machine-cap" @submit.prevent="saveCap(m)">
            <input v-model="cap.memGb" inputmode="decimal" :placeholder="T.capMem" :aria-label="T.capMem" />
            <input v-model="cap.cpus" inputmode="decimal" :placeholder="T.capCpu" :aria-label="T.capCpu" />
          </form>
        </div>
        <div class="secret-actions">
          <template v-if="capping === m.id">
            <button class="btn btn-primary" type="button" @click="saveCap(m)">{{ T.save }}</button>
            <button class="btn btn-secondary" type="button" @click="capping = null">{{ T.cancel }}</button>
          </template>
          <template v-else-if="m.state === 'revoked'">
            <button class="btn btn-danger" type="button" @click="remove(m)">{{ T.remove }}</button>
          </template>
          <template v-else>
            <button class="btn btn-secondary" type="button" @click="startCap(m)">{{ T.cap }}</button>
            <button class="btn btn-secondary" type="button" @click="act(m, 'drain', { on: m.state !== 'draining' })">
              {{ m.state === 'draining' ? T.resume : T.drain }}
            </button>
            <button class="btn btn-danger" type="button" @click="revoke(m)">{{ T.revoke }}</button>
          </template>
        </div>
      </li>
    </ul>
    <div v-if="command" class="machine-command">
      <span class="setting-hint">{{ T.run }}</span>
      <pre class="roster-refresh-log">{{ command }}</pre>
      <button class="btn btn-secondary" type="button" @click="copyTextToClipboard(command!)">{{ T.copy }}</button>
      <button
        class="btn btn-secondary"
        type="button"
        @click="
          command = null;
          load();
        "
      >
        {{ T.done }}
      </button>
    </div>
    <SshJoin
      v-else-if="ssh"
      @close="
        ssh = false;
        load();
      "
    />
    <div v-else class="secret-actions">
      <button class="btn btn-secondary" type="button" @click="add">{{ T.add }}</button>
      <button class="btn btn-secondary" type="button" @click="ssh = true">{{ T.ssh }}</button>
    </div>
  </template>
</template>
