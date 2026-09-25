// ── VS Code, first run ───────────────────────────────────────────────────────
// Someone signed in with no rooms yet (no agent assigned) sees the VS Code
// steps where the chat would be: pairing a machine is how they get an agent of
// their own. The card shows where they are — not connected, waiting for an
// owner's approval, approved — and goes away once a room exists.
// Hidden until the server has sent the room list, and only while an extension
// is published.
import { watchEffect } from 'vue';

import { authFetch } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { roomsReceived } from './room-list-state.js';
import { connect, download } from './vscode.js';

interface Machine {
  hostname: string;
  status: 'pending' | 'approved';
  connected: boolean;
}

const POLL_MS = 10_000;
let published: boolean | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

async function refreshStatus(): Promise<void> {
  const line = $('#vscode-start-status');
  if (!line) return;
  let machines: Machine[] = [];
  try {
    const r = await authFetch('/api/runners/mine');
    if (r.ok) machines = ((await r.json()) as { machines: Machine[] }).machines;
  } catch {
    machines = [];
  }
  const m = machines[0];
  line.hidden = !m;
  if (m) line.textContent = `${m.hostname || 'This machine'}: ${m.status === 'pending' ? 'waiting for approval' : 'approved'}`;
}

function show(on: boolean): void {
  const card = $('#vscode-start');
  if (!card) return;
  card.hidden = !on;
  if (on && !timer) {
    void refreshStatus();
    timer = setInterval(() => void refreshStatus(), POLL_MS);
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function initVsCodeStart(): void {
  if (started) return;
  started = true;
  $('#vscode-start-download')?.addEventListener('click', () => void download());
  $('#vscode-start-connect')?.addEventListener('click', () => void connect());
  void authFetch('/api/runners/extension')
    .then((r) => (published = r.ok))
    .catch(() => (published = false))
    .finally(() => {
      watchEffect(() => {
        show(Boolean(published) && roomsReceived.value && !state.currentRoom && state.lastRoomsList.length === 0);
      });
    });
}
