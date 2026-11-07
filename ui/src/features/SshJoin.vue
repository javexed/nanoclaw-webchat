<script setup lang="ts">
/**
 * Admin → Machines → Join over SSH. Step 1 (Connect) shows the host key's
 * fingerprint; only after the person confirms it do the password or key go
 * to NanoClaw, which signs in and runs the installer, output streamed here.
 * The secrets live in this component's inputs only until Join is pressed:
 * they are cleared as the request is built. Server: server/routes-scaling.ts.
 */
import { reactive, ref } from 'vue';

import { apiJson, authFetch } from '../core/api.js';
import { showToast } from '../core/toast.js';
import {
  canConnect,
  canJoin,
  initialSsh,
  parseSse,
  reduceSsh,
  type SshAction,
  type SshState,
} from './ssh-join-view.js';

const emit = defineEmits<{ close: [] }>();

const T = {
  host: 'Host',
  port: 'Port',
  user: 'Username',
  connect: 'Connect',
  fp: 'Host key',
  confirm: 'Matches the server',
  password: 'Password',
  key: 'Private key',
  passphrase: 'Passphrase',
  join: 'Join',
  cancel: 'Cancel',
  done: 'Done',
  joined: 'Joined',
};

const s = ref<SshState>(initialSsh());
const secret = reactive({ password: '', privateKey: '', passphrase: '' });
const confirmed = ref(false);
const busy = ref(false);
let ctrl: AbortController | null = null;

const dispatch = (a: SshAction): void => {
  s.value = reduceSsh(s.value, a);
};
const fail = (err: any): void => {
  showToast(err?.body?.error || err?.message || String(err), { kind: 'error' });
};

async function connect(): Promise<void> {
  busy.value = true;
  try {
    const r = await apiJson('/api/scaling/machines/ssh/probe', {
      method: 'POST',
      body: { host: s.value.host.trim(), port: Number(s.value.port) },
    });
    confirmed.value = false;
    dispatch({ type: 'probed', probeId: r.probeId, fingerprint: r.fingerprint, address: r.address });
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

async function join(): Promise<void> {
  const body = JSON.stringify({
    probeId: s.value.probeId,
    fingerprint: s.value.fingerprint,
    username: s.value.username.trim(),
    role: 'worker',
    ...(s.value.auth === 'password'
      ? { password: secret.password }
      : { privateKey: secret.privateKey, ...(secret.passphrase ? { passphrase: secret.passphrase } : {}) }),
  });
  secret.password = secret.privateKey = secret.passphrase = '';
  dispatch({ type: 'start' });
  ctrl = new AbortController();
  try {
    const r = await authFetch('/api/scaling/machines/ssh/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) {
      const e = await r.json().catch(() => ({}));
      return dispatch({ type: 'event', event: { t: 'done', ok: false, error: e.error || `HTTP ${r.status}` } });
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSse(buf + dec.decode(value, { stream: true }));
      buf = parsed.rest;
      for (const event of parsed.events) dispatch({ type: 'event', event });
    }
    if (s.value.phase === 'running')
      dispatch({ type: 'event', event: { t: 'done', ok: false, error: 'Connection closed' } });
  } catch (err) {
    if (s.value.phase === 'running')
      dispatch({
        type: 'event',
        event: { t: 'done', ok: false, error: ctrl?.signal.aborted ? 'Cancelled' : String(err) },
      });
  } finally {
    ctrl = null;
  }
}

function cancel(): void {
  if (ctrl) return ctrl.abort();
  secret.password = secret.privateKey = secret.passphrase = '';
  emit('close');
}
</script>

<template>
  <div class="machine-ssh">
    <form v-if="s.phase === 'form'" class="machine-ssh-form" @submit.prevent="canConnect(s) && connect()">
      <input v-model="s.host" :placeholder="T.host" :aria-label="T.host" autocomplete="off" spellcheck="false" />
      <input v-model="s.port" :placeholder="T.port" :aria-label="T.port" inputmode="numeric" class="machine-ssh-port" />
      <input v-model="s.username" :placeholder="T.user" :aria-label="T.user" autocomplete="off" spellcheck="false" />
      <button class="btn btn-primary" type="submit" :disabled="!canConnect(s) || busy">{{ T.connect }}</button>
      <button class="btn btn-secondary" type="button" @click="cancel">{{ T.cancel }}</button>
    </form>

    <form
      v-else-if="s.phase === 'confirm'"
      class="machine-ssh-form"
      @submit.prevent="canJoin(s, secret) && confirmed && join()"
    >
      <span class="setting-hint">{{ T.fp }} ({{ s.address }}):</span>
      <code class="machine-ssh-fp">{{ s.fingerprint }}</code>
      <div class="machine-ssh-check">
        <button
          type="button"
          :class="['perms-switch', { on: confirmed }]"
          role="switch"
          :aria-checked="confirmed ? 'true' : 'false'"
          :aria-label="T.confirm"
          @click="confirmed = !confirmed"
        ></button>
        <span>{{ T.confirm }}</span>
      </div>
      <div class="setting-options">
        <button
          type="button"
          :class="['setting-option', { active: s.auth === 'password' }]"
          @click="s.auth = 'password'"
        >
          {{ T.password }}
        </button>
        <button type="button" :class="['setting-option', { active: s.auth === 'key' }]" @click="s.auth = 'key'">
          {{ T.key }}
        </button>
      </div>
      <input
        v-if="s.auth === 'password'"
        v-model="secret.password"
        type="password"
        :placeholder="T.password"
        :aria-label="T.password"
        autocomplete="off"
      />
      <template v-else>
        <textarea
          v-model="secret.privateKey"
          rows="4"
          :placeholder="T.key"
          :aria-label="T.key"
          spellcheck="false"
          autocomplete="off"
        ></textarea>
        <input
          v-model="secret.passphrase"
          type="password"
          :placeholder="T.passphrase"
          :aria-label="T.passphrase"
          autocomplete="off"
        />
      </template>
      <div class="secret-actions">
        <button class="btn btn-primary" type="submit" :disabled="!confirmed || !canJoin(s, secret)">
          {{ T.join }}
        </button>
        <button class="btn btn-secondary" type="button" @click="cancel">{{ T.cancel }}</button>
      </div>
    </form>

    <template v-else>
      <pre class="roster-refresh-log machine-ssh-out" aria-live="polite">{{ s.output }}</pre>
      <span v-if="s.phase === 'done'" :class="['setting-hint', s.ok ? '' : 'machine-ssh-error']">{{
        s.ok ? T.joined : s.error
      }}</span>
      <div class="secret-actions">
        <button v-if="s.phase === 'running'" class="btn btn-secondary" type="button" @click="cancel">
          {{ T.cancel }}
        </button>
        <button v-else class="btn btn-secondary" type="button" @click="emit('close')">{{ T.done }}</button>
      </div>
    </template>
  </div>
</template>
