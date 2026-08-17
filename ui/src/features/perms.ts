// ── Permissions ──────────────────────────────────────────────────────────────
// The permissions view: the user list, the per-user detail pane, and the
// role/scope controls.
import { createApp } from 'vue';
import PermsGlobalToggles from './PermsGlobalToggles.vue';
import PermsMatrix from './PermsMatrix.vue';
import { permsActive, permsAgents, permsCreateChannelTouched, permsDetailUser, permsMyUserId, permsSelectedUserId, permsUserFilter, permsUsers } from './perms-list-state.js';
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { populatePermsAgentDropdowns } from './agents.js';
import { applyCreateAuthDefault, ensureServerAuthMethods } from './auth.js';
import { renderPermsUserList, showPermsUsersError, userDisplayName, userIsOwner } from './members.js';
import { closeView, hideOtherFullViews, openFullView, openView } from './views.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the providePermsDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface PermsDeps {
}

const deps = {} as PermsDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function providePermsDeps(provided: Partial<PermsDeps>): void {
  Object.assign(deps, provided);
}

function openPermissions() {
  openFullView(() => {
    hideOtherFullViews('permissions');
    permsActive.value = true;
    $('#chat')!.hidden = true;
    $('#permissions')!.hidden = false;
    $('#overflow-btn')?.classList.add('active');
    $('#app')!.classList.add('in-dashboard');
    $('#app')!.classList.remove('in-room');
    permsShowList();
    refreshPermissions();
    openView('permissions', teardownPermissions);
  });
}

function teardownPermissions() {
  permsActive.value = false;
  $('#chat')!.hidden = false;
  $('#permissions')!.hidden = true;
  $('#overflow-btn')?.classList.remove('active');
  $('#app')!.classList.remove('in-dashboard');
}

export function togglePermissions() {
  if (permsActive.value) closeView('permissions');
  else openPermissions();
}

export async function refreshPermissions() {
  try {
    const [usersRes, agentsRes] = await Promise.all([authFetch('/api/users'), authFetch('/api/agents')]);
    if (!usersRes.ok) {
      // Routed through state, not written into #perms-user-list. That element
      // is a Vue mount point now, and an innerHTML write behind Vue's back
      // leaves the vnode tree describing rows that are no longer in the DOM.
      showPermsUsersError('Failed to load users.');
      return;
    }
    permsUsers.value = await usersRes.json();
    permsAgents.value = agentsRes.ok ? await agentsRes.json() : [];
    populatePermsAgentDropdowns();
    renderPermsUserList();
    if (permsSelectedUserId.value && permsUsers.value.find((u: any) => u.id === permsSelectedUserId.value)) {
      renderPermsDetail(permsSelectedUserId.value);
    } else if (permsSelectedUserId.value) {
      // The selected user got revoked-into-nonexistence or otherwise vanished.
      permsSelectedUserId.value = null;
      permsShowList();
    }
  } catch (err) {
    console.error('refreshPermissions failed:', err);
  }
}

let globalTogglesApp: ReturnType<typeof createApp> | null = null;
let matrixApp: ReturnType<typeof createApp> | null = null;

function mountPermsDetail(): void {
  if (!globalTogglesApp) {
    const host = $('#perms-global-toggles');
    if (host) {
      globalTogglesApp = createApp(PermsGlobalToggles, {
        onToggle: (kind: string, granting: boolean) => {
          const u = permsDetailUser.value;
          if (u) togglePerm(u.id, kind, null, granting);
        },
      });
      globalTogglesApp.mount(host);
    }
  }
  if (!matrixApp) {
    const host = $('#perms-matrix');
    if (host) {
      matrixApp = createApp(PermsMatrix, {
        onToggle: (kind: string, agentGroupId: string, granting: boolean, el: HTMLElement) => {
          const u = permsDetailUser.value;
          if (u) togglePerm(u.id, kind, agentGroupId, granting, el);
        },
      });
      matrixApp.mount(host);
    }
  }
}

export function renderPermsDetail(userId: any) {
  const u = permsUsers.value.find((x: any) => x.id === userId);
  if (!u) return;
  $('#perms-detail-name')!.textContent = userDisplayName(u);
  $('#perms-detail-id')!.textContent = u.id;

  // The GLOBAL toggles and the PER-AGENT-GROUP matrix are two islands, mounted
  // into two separate containers because index.html puts a static
  // .perms-matrix-header between them. They share one input — the selected
  // user — so the toggle callbacks read it from the ref rather than closing
  // over `u`: a callback that captured this call's user would keep firing
  // against a stale id after the next selection.
  permsDetailUser.value = u;
  mountPermsDetail();

  // ── Delete user button ──────────────────────────────────────────────────
  // Always show the danger zone (except for yourself). Disable the button
  // with an explanation if roles or memberships are still present — the
  // server would reject it anyway, but this surfaces the blocker upfront.
  const deleteZone = $('#perms-delete-zone');
  const deleteBtn = ($('#perms-delete-btn')) as HTMLInputElement;
  const isSelf = u.id === permsMyUserId.value;
  const hasRolesOrMemberships = u.roles.length > 0 || u.memberships.length > 0;
  if (deleteZone) {
    deleteZone.hidden = isSelf;
    if (deleteBtn) {
      deleteBtn.disabled = hasRolesOrMemberships;
      deleteBtn.title = hasRolesOrMemberships ? 'Revoke all roles and memberships before deleting' : '';
    }
  }
}

async function togglePerm(targetUserId?: any, kind?: any, agentGroupId?: any, granting?: any, cellEl?: any) {
  if (cellEl) cellEl.classList.add('busy');
  const ok = granting
    ? await grantPerm(targetUserId, kind, agentGroupId)
    : await revokePermSilent(targetUserId, kind, agentGroupId);
  if (cellEl) cellEl.classList.remove('busy');
  if (ok) await refreshPermissions();
}

async function revokePermSilent(targetUserId: any, kind: any, agentGroupId: any) {
  // Same as revokePerm but no confirm() prompt — the matrix's tap-to-revoke
  // model relies on the visual "on → off" feedback being immediate. Last-
  // owner protection still trips the server's 409 response, surfaced as an
  // alert rather than a confirmation prompt.
  try {
    const r = await authFetch('/api/permissions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ userId: targetUserId, kind, agentGroupId }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Revoke failed: ' + (err.error || r.statusText), { kind: 'error' });
      return false;
    }
    return true;
  } catch (err) {
    showToast('Revoke failed: ' + (err as any)?.message, { kind: 'error' });
    return false;
  }
}

export function permsShowList() {
  $('#perms-body')!.dataset.mode = 'list';
  $('#perms-detail-empty')!.hidden = false;
  $('#perms-detail-view')!.hidden = true;
  $('#perms-create-view')!.hidden = true;
}

export function permsShowDetail() {
  $('#perms-body')!.dataset.mode = 'detail';
  $('#perms-detail-empty')!.hidden = true;
  $('#perms-detail-view')!.hidden = false;
  $('#perms-create-view')!.hidden = true;
}

export function permsShowCreate() {
  $('#perms-body')!.dataset.mode = 'detail';
  $('#perms-detail-empty')!.hidden = true;
  $('#perms-detail-view')!.hidden = true;
  $('#perms-create-view')!.hidden = false;
  // Reset the wizard fields each time it opens.
  permsCreateChannelTouched.value = false;
  $<HTMLInputElement>('#perms-create-handle')!.value = '';
  $<HTMLInputElement>('#perms-create-raw')!.value = '';
  $<HTMLInputElement>('#perms-create-kind')!.value = 'member';
  $<HTMLInputElement>('#perms-create-group')!.value = '';
  // Only owners can grant admin/owner roles — hide those options for everyone
  // else so the wizard matches the server's member-only rule for non-owners.
  const me = permsUsers.value.find((u: any) => u.id === permsMyUserId.value);
  const canGrantRoles = !!(me && userIsOwner(me));
  const kindSel = ($('#perms-create-kind')) as HTMLInputElement;
  if (kindSel) {
    kindSel.querySelectorAll('option').forEach((opt: any) => {
      opt.hidden = !canGrantRoles && opt.value !== 'member';
    });
    if (!canGrantRoles) kindSel.value = 'member';
  }
  applyCreateAuthDefault();
  ensureServerAuthMethods().then(applyCreateAuthDefault);
  $('#perms-create-handle')!.focus();
}

export async function grantPerm(targetUserId: any, kind: any, agentGroupId: any) {
  try {
    const r = await authFetch('/api/permissions/grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ userId: targetUserId, kind, agentGroupId }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Grant failed: ' + (err.error || r.statusText), { kind: 'error' });
      return false;
    }
    return true;
  } catch (err) {
    showToast('Grant failed: ' + (err as any)?.message, { kind: 'error' });
    return false;
  }
}

export function permsCreateComposedId() {
  const channel = $<HTMLInputElement>('#perms-create-channel')!.value;
  if (channel === '__raw__') return $<HTMLInputElement>('#perms-create-raw')!.value.trim();
  let handle = $<HTMLInputElement>('#perms-create-handle')!.value.trim();
  if (!handle) return '';
  // Webchat ids are case/charset-folded by the auth layer; fold here too so the
  // preview and the stored grant match the eventual login.
  if (channel === 'webchat' || channel.startsWith('webchat:')) handle = normalizeWebchatHandle(handle);
  return `${channel}:${handle}`;
}

export function permsRefreshCreateUI() {
  const channel = $<HTMLInputElement>('#perms-create-channel')!.value;
  const isRaw = channel === '__raw__';
  $('#perms-create-handle-label')!.hidden = isRaw;
  $('#perms-create-raw-label')!.hidden = !isRaw;
  const composed = permsCreateComposedId();
  $('#perms-create-preview')!.textContent = composed ? `Resolved id: ${composed}` : 'Resolved id will appear here.';
  // Show/hide the agent-group selector based on initial-role choice.
  const kind = $<HTMLInputElement>('#perms-create-kind')!.value;
  const wantsGroup = kind === 'admin' || kind === 'member';
  $('#perms-create-group-label')!.hidden = !wantsGroup;
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// Blocks whose SUBJECT element this module already owns. The ownership census
// reported them as multi-owner, which was the union of every id they touch
// rather than what they are for.

/** The permissions create form. */
export function wirePermsCreate(): void {
  $<HTMLFormElement>('#perms-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = permsCreateComposedId();
    if (!userId) {
      showToast('Enter a handle / email (or pick "raw user_id" and enter the full id).', { kind: 'error' });
      return;
    }
    if (!userId.includes(':')) {
      showToast('user_id must be namespaced (channel:handle).', { kind: 'error' });
      return;
    }
    const kind = ($<HTMLSelectElement>('#perms-create-kind')?.value ?? '');
    const groupVal = ($<HTMLSelectElement>('#perms-create-group')?.value ?? '');
    const agentGroupId = groupVal || null;
    if (kind === 'owner' && agentGroupId) {
      showToast('owner role is always global — pick "— global —".', { kind: 'error' });
      return;
    }
    if (kind === 'member' && !agentGroupId) {
      showToast('member role requires an agent group.', { kind: 'error' });
      return;
    }
    if (await grantPerm(userId, kind, agentGroupId)) {
      permsSelectedUserId.value = userId;
      await refreshPermissions();
      permsShowDetail();
    }
  });
}

/** The "new permission" button. */
export function wirePermsNew(): void {
  $<HTMLButtonElement>('#perms-new-btn')?.addEventListener('click', () => {
    permsSelectedUserId.value = null;
    $('#perms-user-list')
      ?.querySelectorAll<HTMLElement>('li')
      .forEach((li) => li.classList.remove('active'));
    permsShowCreate();
  });
}

// View switching within the detail pane (also flips the mobile data-mode)
// ── + New User wizard: auth-aware id defaults ────────────────────────────────
// The composed user_id must match EXACTLY what the auth layer mints at login.
// We default the channel prefix to whatever this install actually uses (from
// /api/auth/info) so admins don't, e.g., create a Tailscale-shaped id on an
// SSO/Entra install. Fetched once, best-effort.
// Mirror of normalizeId() in src/channels/webchat/auth.ts — fold a webchat
// handle to the canonical (lowercased, restricted-charset) form so the live
// preview shows the id the server will actually store and match.
export function normalizeWebchatHandle(raw: any) {
  return raw.toLowerCase().replace(/[^a-z0-9._@+-]/g, '-');
}
