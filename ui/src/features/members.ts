// ── Members & users ──────────────────────────────────────────────────────────
// Room membership and the people behind it: the member list, handle chips and
// the handle popover, @-mention candidates, and the per-user credential
// (OAuth / vault) panels.
import { createApp } from 'vue';
import { userCredsConnected, userCredsOauthReturnFocus, userCredsOauthSessionId, userCredsOauthTarget, userCredsProvider, userCredsState, userCredsWords } from './user-creds-state.js';
import MembersList from './MembersList.vue';
import PermsUserList from './PermsUserList.vue';
import { members, membersFilter, usersSortAz } from './members-list-state.js';
import { permsMyUserId, permsSelectedUserId, permsSortAz, permsUserFilter, permsUsers, usersError } from './perms-list-state.js';
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { closeHandlePopover, showConfirmModal } from './modals.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';


/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideMembersDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface MembersDeps {
  permsShowDetail: () => any;
  permsShowList: () => any;
  refreshPermissions: () => any;
  renderPermsDetail: (a0?: any) => any;
  showConfirmModal: (a0?: any, a1?: any, a2?: any, a3?: any, a4?: any) => any;
}

const deps = {} as MembersDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideMembersDeps(provided: Partial<MembersDeps>): void {
  Object.assign(deps, provided);
}

export function rememberServerAuthHint(methods?: any) {
  if (!methods) return;
  state.serverUsesTailscale = !!methods.tailscale;
  try {
    localStorage.setItem('webchat-server-tailscale', state.serverUsesTailscale ? '1' : '0');
  } catch {}
}


export async function updateUserCredsBanner(roomId?: any) {
  const banner = $('#user-creds-banner');
  if (!banner || !roomId) return;
  const hideAll = () => {
    banner.hidden = true;
    userCredsState.value = null;
    userCredsConnected.value = false;
    updateHandleCreds();
    renderHandleChip();
  };
  try {
    const r = await authFetch(`/api/user-credentials/credential?roomId=${encodeURIComponent(roomId)}`);
    if (!r.ok) {
      hideAll();
      return;
    }
    const { connected, mode, oauthAllowed, apiKeyAllowed = true, provider = 'claude' } = await r.json();
    userCredsProvider.value = provider;
    const { name, subWord, keyWord, keyPlaceholder } = userCredsWords(provider);
    // The room's mode is the master switch: 'disabled' (User credentials: Off)
    // means no UserCreds at all — neither API keys NOR OAuth — regardless of what the
    // workspace accepts. When the room is on, each method is offered if the
    // workspace accepts it (credential types are workspace-wide).
    const apiOffered = mode !== 'disabled' && apiKeyAllowed;
    const oauthOffered = mode !== 'disabled' && oauthAllowed;
    if (!apiOffered && !oauthOffered) {
      hideAll();
      return;
    }

    userCredsState.value = { offered: true, connected, provider, oauthAllowed: oauthOffered, apiOffered, subWord, keyWord };
    userCredsConnected.value = connected;
    updateHandleCreds();
    renderHandleChip();

    // Connected → the @handle chip shows the 🔑 indicator (see renderHandleChip);
    // the full banner is only the actionable "connect" prompt, done once connected.
    if (connected) {
      banner.hidden = true;
      return;
    }

    // Not connected → show the actionable banner.
    const connectBtn = $('#user-creds-connect-btn')!;
    const oauthBtn = $('#user-creds-oauth-btn');
    const input = ($('#user-creds-key-input')!) as HTMLElement;
    banner.hidden = false;
    input.hidden = true;
    (input as HTMLInputElement).value = '';
    (input as HTMLInputElement).placeholder = keyPlaceholder;
    // Primary action: connect via subscription sign-in. Secondary: paste a key.
    if (oauthBtn) {
      oauthBtn.hidden = !oauthOffered;
      oauthBtn.textContent = `Connect to ${name}`;
    }
    connectBtn.hidden = !apiOffered;
    if (connectBtn) connectBtn.textContent = 'API key';
  } catch {
    hideAll();
  }
}

export async function disconnectUserCreds() {
  const r = await authFetch('/api/user-credentials/credential', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
    body: JSON.stringify({ roomId: state.currentRoom }),
  });
  if (r.ok) {
    showToast('Disconnected your account.', { kind: 'success' });
    await updateUserCredsBanner(state.currentRoom);
  } else {
    const err = await r.json().catch(() => ({}));
    showToast('Failed to disconnect: ' + (err.error || r.statusText), { kind: 'error' });
  }
}


export function closeUserCredsOauthModal() {
  if (userCredsOauthSessionId.value) {
    const cancelUrl =
      userCredsOauthTarget.value === 'workspace-codex'
        ? '/api/workspace-credential/codex/cancel'
        : userCredsOauthTarget.value === 'workspace'
          ? '/api/workspace-credential/oauth/cancel'
          : userCredsProvider.value === 'codex'
            ? '/api/user-credentials/codex/cancel'
            : '/api/user-credentials/oauth/cancel';
    authFetch(cancelUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ sessionId: userCredsOauthSessionId.value }),
    }).catch(() => {});
    userCredsOauthSessionId.value = null;
  }
  const modal = $('#user-creds-oauth-modal');
  if (modal) modal.hidden = true;
  // Return focus to whatever opened the dialog (a11y dismissal contract).
  if (userCredsOauthReturnFocus.value && typeof userCredsOauthReturnFocus.value.focus === 'function') userCredsOauthReturnFocus.value.focus();
  userCredsOauthReturnFocus.value = null;
}

export function renderMembers(members?: any) {
  members.value = members;
  const toggle = $('#members-toggle')!;
  toggle.textContent = members.length; // full count — independent of the filter
  toggle.hidden = !state.currentRoom;
  paintMembersList();
}

let membersListApp: ReturnType<typeof createApp> | null = null;

/** Mount the MembersList island into <ul id="members-list">, once. */
function mountMembersList(): void {
  if (membersListApp) return;
  const host = $('#members-list');
  if (!host) return;
  membersListApp = createApp(MembersList);
  membersListApp.mount(host);
}

export function paintMembersList(): void {
  mountMembersList();
}


export function toggleMembersPanel() {
  const panel = $('#members-panel')!;
  const overlay = $('#members-overlay')!;
  const visible = panel.hidden;
  panel.hidden = !visible;
  if (visible) overlay.classList.add('visible');
  else overlay.classList.remove('visible');
}

// Re-exported so the modules that already import these from here keep working:
// perms.ts, agents.ts (via a dep) and legacy.js all name this module. The
// definitions moved to perms-user-info.ts, which the PermsUserList island
// imports — a component importing THIS module would close a cycle, since this
// is where the island is mounted.
export { findMembership, userDisplayName, userIsOwner } from './perms-user-info.js';

let permsUserListApp: ReturnType<typeof createApp> | null = null;

function mountPermsUserList(): void {
  if (permsUserListApp) return;
  const host = $('#perms-user-list');
  if (!host) return;
  permsUserListApp = createApp(PermsUserList, { onSelect: permsSelectUser });
  permsUserListApp.mount(host);
}

/**
 * Sync the island's inputs and mount it on first call.
 *
 * The sort and the filter are NOT applied here — the component derives both
 * from these refs, so the A–Z toggle and the search box no longer need to call
 * this function at all. It stays because refreshPermissions() calls it after
 * fetching, which is a genuine data change.
 */
export function renderPermsUserList() {
  permsSortAz.value = !!usersSortAz.value;
  usersError.value = '';
  mountPermsUserList();
}

/**
 * Replace the user list with a failure message. Exported because the fetch that
 * fails lives in perms.ts, while the element and its island are owned here —
 * and the whole point of the usersError ref is that this module stays the only
 * writer of that DOM.
 */
export function showPermsUsersError(message: string) {
  usersError.value = message;
  mountPermsUserList();
}

function permsSelectUser(userId?: any) {
  permsSelectedUserId.value = userId;
  deps.renderPermsDetail(userId);
  // The imperative version cleared .active off every row here and re-rendered
  // to put it back. Both are gone: the class is bound to this ref.
  permsSelectedUserId.value = userId ?? null;
  deps.permsShowDetail();
}

export async function deleteUser(targetUserId?: any) {
  const confirmed = await deps.showConfirmModal({
    title: 'Delete user',
    body: `Delete ${targetUserId}? This removes the user record. They will be re-added automatically if they authenticate again.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const r = await authFetch(`/api/users/${encodeURIComponent(targetUserId)}`, {
      method: 'DELETE',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Delete failed: ' + (err.error || r.statusText), { kind: 'error' });
      return;
    }
    showToast(`Deleted user ${targetUserId}.`, { kind: 'success' });
    permsSelectedUserId.value = null;
    await deps.refreshPermissions();
    deps.permsShowList();
  } catch (err: any) {
    showToast('Delete failed: ' + err.message, { kind: 'error' });
  }
}


// ── Panel wiring ─────────────────────────────────────────────────────────────
// The room members panel: the invite form, role changes and removal.
//
// A function rather than module-scope code: legacy.js runs its blocks in source
// order around initApp(), so relocating them to another module's top level would
// silently re-order them. legacy calls wireMembersPanel() at the exact line the
// first block occupied, so execution order is unchanged.

export function wireMembersPanel(): void {
  $<HTMLButtonElement>('#handle-creds-action')?.addEventListener('click', async () => {
    if (!userCredsState.value) return;
    closeHandlePopover();
    if (userCredsState.value.connected) {
      const confirmed = await showConfirmModal({
        title: `Disconnect ${userCredsWords(userCredsState.value?.provider as string | undefined).name}?`,
        confirmLabel: 'Disconnect',
        destructive: true,
      });
      if (confirmed) await disconnectUserCreds();
    } else if (userCredsState.value.oauthAllowed) {
      // Subscriptions allowed → open the sign-in helper directly (what users expect
      // from a "Connect" action), rather than just surfacing the banner.
      $<HTMLButtonElement>('#user-creds-oauth-btn')?.click();
    } else {
      // API-key-only room → reveal the banner and its key input.
      const banner = $('#user-creds-banner');
      if (banner) {
        banner.hidden = false;
        banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        banner.classList.add('user-creds-banner-flash');
        setTimeout(() => banner.classList.remove('user-creds-banner-flash'), 1200);
      }
      $<HTMLButtonElement>('#user-creds-connect-btn')?.click(); // reveal the key input
    }
  });

  $<HTMLButtonElement>('#user-creds-connect-btn')?.addEventListener('click', async (e: any) => {
    const input = $<HTMLInputElement>('#user-creds-key-input');
    if (!input) return;
    // First click reveals the input; second (with a value) submits.
    if (input.hidden) {
      input.hidden = false;
      input.focus();
      return;
    }
    const apiKey = input.value.trim();
    if (!apiKey) return;
    // Busy-guard + try/catch: without them a network failure here was an
    // unhandled rejection — the user's key submit died with zero feedback.
    const btn = e.currentTarget as HTMLButtonElement;
    btn!.disabled = true;
    try {
      const r = await authFetch('/api/user-credentials/credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
        body: JSON.stringify({ roomId: state.currentRoom, apiKey }),
      });
      if (r.ok) {
        showToast(`Connected your ${userCredsWords(userCredsProvider.value).keyWord}.`, { kind: 'success' });
        await updateUserCredsBanner(state.currentRoom);
      } else {
        const err = await r.json().catch(() => ({}));
        showToast('Failed to connect key: ' + (err.error || r.statusText), { kind: 'error' });
      }
    } catch (err: any) {
      showToast('Failed to connect key: ' + (err?.message || 'network error'), { kind: 'error' });
    } finally {
      btn!.disabled = false;
    }
  });

  $<HTMLInputElement>('#user-creds-key-input')?.addEventListener('keydown', (e: any) => {
    if (e.key === 'Enter') $<HTMLButtonElement>('#user-creds-connect-btn')?.click();
  });


  // The connected state lives as a compact key chip in the header; clicking it
  // disconnects (after a confirm), so the full banner no longer sits over the chat.
  // ── UserCreds OAuth: connect a Claude subscription token ────────────────────────
  // Browser-mint OAuth: no terminal. Opening the form starts a server-side mint
  // (a throwaway container runs `claude setup-token`), surfaces the sign-in URL,
  // takes the pasted code, and onboards the resulting token per-member.
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// Blocks the census read as multi-owner: the union of every id they touch spans
// several modules, but the element each one WIRES belongs here.

export function wireMembersOauth1(): void {
  $('#user-creds-oauth-modal')?.addEventListener('click', (e: any) => {
    if (e.target === $('#user-creds-oauth-modal')) closeUserCredsOauthModal();
  });
  document.addEventListener('keydown', (e: any) => {
    const modal = $('#user-creds-oauth-modal');
    if (!modal || modal.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeUserCredsOauthModal();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>('button:not([hidden]), a[href], input:not([hidden])'),
    ).filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

export function wireMembersOauth2(): void {
  $('#members-overlay')?.addEventListener('click', toggleMembersPanel);
}

// The @handle popover mirrors the in-room banner state as a credentials shortcut
// (discoverability). Shown only when the open room offers UserCreds; acts on that room.
export function updateHandleCreds() {
  const wrap = $('#handle-creds');
  if (!wrap) return;
  if (!userCredsState.value || !userCredsState.value.offered) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const statusEl = $('#handle-creds-status');
  const actionBtn = $('#handle-creds-action');
  // Minimalist integrations-row style: a status dot + the provider name carry
  // the connected/not state; the action button does the rest.
  const { name } = userCredsWords(userCredsState.value?.provider as string | undefined);
  if (statusEl) {
    // Text carries the connected/not state too (not just the dot colour) — for
    // screen readers and colour-blind users.
    statusEl.textContent = `${name} — ${userCredsState.value.connected ? 'connected' : 'not connected'}`;
    statusEl.classList.toggle('is-connected', !!userCredsState.value?.connected);
  }
  if (actionBtn) actionBtn.textContent = userCredsState.value.connected ? 'Disconnect' : 'Connect';
}

// ── Header @handle chip + popover ────────────────────────────────────────────
// The chip lives top-right in the header; clicking it opens a focused popover to
// edit + save the handle. The editor (same #handle-input/#handle-save/
// #handle-status ids) lives here, not in Settings. Inline status only.
export function renderHandleChip() {
  const chip = $('#handle-chip');
  if (!chip) return;
  const label = state.myHandle ? `@${state.myHandle}` : '+ set @handle';
  // When the member has connected their own credential, the handle chip doubles
  // as the credential indicator (a 🔑 prefix) — there's no separate key chip.
  // The connect/disconnect controls live in the chip's popover (#handle-creds).
  chip.textContent = userCredsConnected.value ? `🔑 ${label}` : label;
  chip.classList.toggle('is-unset', !state.myHandle);
  chip.classList.toggle('has-cred', userCredsConnected.value);
  chip.title = userCredsConnected.value ? 'Billing your own account — click to manage' : 'Edit your handle';
  // Accessible name tracks the connected state (the 🔑/title are visual-only).
  chip.setAttribute('aria-label', userCredsConnected.value ? 'Billing your own account — manage credentials' : 'Edit your handle');
}

export async function saveHandle() {
  const input = $<HTMLInputElement>('#handle-input');
  const status = $('#handle-status');
  if (!input || !status) return;
  const next = input.value.trim().toLowerCase().replace(/^@/, '');
  const showStatus = (text: any, ok: any) => {
    status.hidden = false;
    status.textContent = text;
    status.classList.toggle('ok', !!ok);
    status.classList.toggle('err', !ok);
  };
  if (!/^[a-z0-9-]{1,32}$/.test(next)) {
    showStatus('Use 1–32 letters, numbers, or hyphens.', false);
    return;
  }
  if (next === state.myHandle) {
    showStatus('That’s already your handle.', true);
    return;
  }
  try {
    const res = await authFetch('/api/me/handle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ handle: next }),
    });
    if (res.ok) {
      state.myHandle = (((await res.json()).handle || next) + '').toLowerCase();
      input.value = state.myHandle;
      renderHandleChip();
      // Keep the popover open briefly showing the inline "Saved." status,
      // consistent with the prior in-Settings behavior.
      showStatus('Saved.', true);
    } else if (res.status === 409) {
      showStatus('That handle is taken.', false);
    } else if (res.status === 400) {
      showStatus('Use 1–32 letters, numbers, or hyphens.', false);
    } else {
      showStatus('Couldn’t save — try again.', false);
    }
  } catch {
    showStatus('Couldn’t save — try again.', false);
  }
}
