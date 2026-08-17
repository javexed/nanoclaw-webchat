// ── Files & uploads ──────────────────────────────────────────────────────────
// Staging files for a message, the upload round-trip (including the chunked
// path), attachment previews and the attach picker.
import { createApp } from 'vue';
import FilePreview from './FilePreview.vue';
import { previewRows } from './file-preview-state.js';
import AttachPicker from './AttachPicker.vue';
import { attachEmptyText, attachPickerCfg, attachRows, pendingFiles } from './attach-picker-state.js';
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { openLightbox, showConfirmModal } from './modals.js';
import { appendSystem, removeRow } from './transcript.js';
import { continueAgentImport } from './agents.js';
import { continueRoomImport } from './rooms.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideFilesDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface FilesDeps {
}

const deps = {} as FilesDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideFilesDeps(provided: Partial<FilesDeps>): void {
  Object.assign(deps, provided);
}


function formatFileSize(bytes?: any) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

let pendingFileSeq = 0;

const pendingThumbUrls = new Map();

export function stageFile(file?: any) {
  if (!state.currentRoom) return;
  const id = ++pendingFileSeq;
  pendingFiles.value.push({ id, file });
  renderFilePreview();
  const input = ($('#message-input')!) as HTMLElement;
  input.focus();
  (input as HTMLInputElement).placeholder =
    pendingFiles.value.length === 1
      ? `Add a message about ${file.name}…`
      : `Add a message about ${pendingFiles.value.length} files…`;
}

export function stageFiles(fileList?: any) {
  for (const f of fileList) stageFile(f);
}

function removeStagedFile(id?: any) {
  const url = pendingThumbUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    pendingThumbUrls.delete(id);
  }
  pendingFiles.value = pendingFiles.value.filter((p: any) => p.id !== id);
  if (pendingFiles.value.length === 0) {
    clearStagedFiles();
  } else {
    renderFilePreview();
    $<HTMLInputElement>('#message-input')!.placeholder =
      pendingFiles.value.length === 1
        ? `Add a message about ${pendingFiles.value[0].file.name}…`
        : `Add a message about ${pendingFiles.value.length} files…`;
  }
}

export function clearStagedFiles() {
  for (const url of pendingThumbUrls.values()) URL.revokeObjectURL(url);
  pendingThumbUrls.clear();
  pendingFiles.value = [];
  const preview = $('#file-preview');
  if (preview) {
    preview.hidden = true;
    preview.innerHTML = '';
  }
  $<HTMLInputElement>('#message-input')!.placeholder = 'Message…';
}

let filePreviewApp: ReturnType<typeof createApp> | null = null;

function mountFilePreview(): void {
  if (filePreviewApp) return;
  const host = $('#file-preview');
  if (!host) return;
  filePreviewApp = createApp(FilePreview, {
    onRemove: (id: number) => removeStagedFile(id),
  });
  filePreviewApp.mount(host);
}

function renderFilePreview(): void {
  const preview = $('#file-preview');
  if (!preview) return;
  const staged = pendingFiles.value ?? [];
  mountFilePreview();
  preview.hidden = staged.length === 0;
  previewRows.value = staged.map(({ id, file }: any) => {
    // Object URLs are minted here and revoked in clearStagedFiles(), so the map
    // stays the single owner of their lifetime.
    let thumbUrl: string | null = null;
    if (file.type.startsWith('image/')) {
      thumbUrl = pendingThumbUrls.get(id) ?? null;
      if (!thumbUrl) {
        thumbUrl = URL.createObjectURL(file);
        pendingThumbUrls.set(id, thumbUrl);
      }
    }
    return { id, name: file.name, size: formatFileSize(file.size), thumbUrl };
  });
}


const CHUNK_THRESHOLD = 512 * 1024; // Use chunked upload for files > 512KB

const CHUNK_SIZE = 512 * 1024; // 512KB per chunk

export async function uploadFile(file?: any, caption?: any) {
  if (!state.currentRoom) return;
  if (file.size > CHUNK_THRESHOLD) {
    return uploadFileChunked(file, caption);
  }
  const form = new FormData();
  form.append('file', file);
  if (caption) form.append('caption', caption);
  try {
    const res = await authFetch(
      `/api/rooms/${encodeURIComponent(state.currentRoom!)}/upload?thread_id=${encodeURIComponent(state.currentThread)}`,
      {
        method: 'POST',
        body: form,
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Upload failed:', err.error || res.statusText);
      appendSystem('Upload failed: ' + (err.error || res.statusText));
    }
  } catch (err) {
    console.error('Upload error:', err);
    appendSystem('Upload failed: ' + (err as any)?.message);
  }
}

async function uploadFileChunked(file?: any, caption?: any) {
  const uploadId = uuidv4();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const statusMsg = appendSystem(`Uploading ${file.name} (0/${totalChunks})…`);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const slice = file.slice(start, end);
    const buf = await slice.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);

    const body = {
      uploadId,
      chunkIndex: i,
      totalChunks,
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      data: b64,
    } as any;
    // Include caption on the last chunk
    if (i === totalChunks - 1 && caption) body.caption = caption;

    try {
      const res = await authFetch(
        `/api/rooms/${encodeURIComponent(state.currentRoom!)}/upload/chunk?thread_id=${encodeURIComponent(state.currentThread)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (statusMsg) statusMsg.text = `Upload failed: ${err.error || res.statusText}`;
        return;
      }
    } catch (err) {
      if (statusMsg) statusMsg.text = `Upload failed: ${(err as any)?.message}`;
      return;
    }
    if (statusMsg) statusMsg.text = `Uploading ${file.name} (${i + 1}/${totalChunks})…`;
  }
  if (statusMsg) removeRow(statusMsg);
}

export function openAttachPicker(cfg?: any) {
  attachPickerCfg.value = cfg;
  $('#attach-picker-title')!.textContent = cfg.title;
  const search = ($('#attach-picker-search')!) as HTMLElement;
  (search as HTMLInputElement).value = '';
  (search as HTMLInputElement).placeholder = cfg.searchPlaceholder || 'Search…';
  const addBtn = $('#attach-picker-add-new')!;
  addBtn.hidden = !cfg.onAddNew;
  addBtn.textContent = cfg.addNewLabel || '+ Add new';
  renderAttachPickerList('');
  const picker = $('#attach-picker')!;
  picker.hidden = false;
  void picker.offsetHeight; // reflow so the open transition runs
  picker.classList.add('open');
  if (window.matchMedia('(min-width: 720px)').matches) setTimeout(() => search.focus(), 60);
}

export function closeAttachPicker() {
  const picker = $('#attach-picker')!;
  picker.classList.remove('open');
  setTimeout(() => {
    picker.hidden = true;
  }, 220);
}

let attachPickerApp: ReturnType<typeof createApp> | null = null;

function mountAttachPicker(): void {
  if (attachPickerApp) return;
  const host = $('#attach-picker-list');
  if (!host) return;
  attachPickerApp = createApp(AttachPicker, {
    onToggle: async (key: string, attached: boolean, li: HTMLElement) => {
      const cfg = attachPickerCfg.value;
      if (!cfg) return;
      const item = cfg.items().find((it: any) => String(cfg.name(it)) === key);
      if (!item) return;
      try {
        await cfg.onToggle(item, !attached);
      } catch (err: any) {
        showToast('Failed: ' + (err?.message || err), { kind: 'error' });
      }
      li.style.pointerEvents = '';
      renderAttachPickerList($<HTMLInputElement>('#attach-picker-search')?.value);
    },
  });
  attachPickerApp.mount(host);
}

export function renderAttachPickerList(filterText?: any): void {
  const cfg = attachPickerCfg.value;
  mountAttachPicker();
  if (!cfg) {
    attachRows.value = [];
    attachEmptyText.value = '';
    return;
  }
  const q = (filterText || '').trim().toLowerCase();
  const items = cfg.items().filter((it: any) => !q || cfg.searchText(it).toLowerCase().includes(q));
  attachEmptyText.value = q ? `No matches for "${filterText}".` : cfg.emptyText || 'Nothing to show.';
  attachRows.value = items.map((it: any) => ({
    // The name doubles as the key: the picker's config has no id accessor, and
    // every caller's list is already unique by display name.
    key: String(cfg.name(it)),
    name: cfg.name(it),
    meta: cfg.meta ? cfg.meta(it) : '',
    attached: !!cfg.isAttached(it),
  }));
}


// ── Panel wiring ───────────────────────────────────────────────────────────
// File and import controls: system export/import, per-agent import, and the attach picker.
//
// These blocks were invisible to the ownership census: no module referenced
// their element ids, because the wiring that would have referenced them was
// still here in legacy.js. Attributed by the subject element's NAME instead.

export function wireFileControls1(): void {
  $<HTMLButtonElement>('#import-any-btn')?.addEventListener('click', () => {
    const el = document.createElement('div');
    el.className = 'import-note';
    el.textContent = 'Pick a .tgz exported from NanoClaw — an agent bundle or a room bundle.';
    showConfirmModal({ title: 'Import from bundle', body: el, confirmLabel: 'Choose file…' }).then((ok) => {
      if (ok) $<HTMLInputElement>('#import-any-file')?.click();
    });
  });
  $<HTMLInputElement>('#import-any-file')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!file) return;
    // Sniff the manifest by trying the room endpoint first; a format mismatch
    // comes back as 422 "Not a NanoClaw room export" → retry as agent.
    const tryUpload = async (endpoint: string) => {
      const fd = new FormData();
      fd.append('bundle', file);
      const res = await authFetch(endpoint, { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, body };
    };
    showToast('Uploading bundle…', { kind: 'info' });
    let kind = 'room';
    let up = await tryUpload('/api/rooms/import');
    if (!up.ok && /room export/i.test(up.body.error || '')) {
      kind = 'agent';
      up = await tryUpload('/api/agents/import');
    }
    if (!up.ok) {
      showToast('Import failed: ' + (up.body.error || 'unrecognized bundle'), { kind: 'error' });
      return;
    }
    if (kind === 'room') return continueRoomImport(up.body);
    return continueAgentImport(up.body);
  });
}

export function wireFileControls2(): void {
  $<HTMLButtonElement>('#system-import-btn')?.addEventListener('click', () => $<HTMLInputElement>('#system-import-file')?.click());
  $<HTMLInputElement>('#system-import-file')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!file) return;
    showToast('Uploading backup…', { kind: 'info' });
    let up;
    try {
      const fd = new FormData();
      fd.append('bundle', file);
      const res = await authFetch('/api/system/import', { method: 'POST', body: fd });
      up = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(up.error || res.statusText);
    } catch (err: any) {
      showToast('Restore failed: ' + (err?.message || err), { kind: 'error' });
      return;
    }
    const m = up.preview.manifest;
    const el = document.createElement('div');
    const line = (t: string, cls?: string) => {
      const d = document.createElement('div');
      if (cls) d.className = cls;
      d.textContent = t;
      el.appendChild(d);
    };
    line(`Backup from ${new Date(m.createdAt).toLocaleString()}${m.lean ? ' (lean — no conversations)' : ''}`);
    line(`${m.counts.agents} agents · ${m.counts.rooms} rooms · ${m.counts.models} models · ${m.counts.mcpServers} MCP servers`);
    line('⚠ REPLACES everything on this install. Current state is kept aside as *.pre-restore-* for manual rollback.', 'import-warning');
    line('The host restarts to finish the restore — the app will reconnect.', 'import-note');
    const ok = await showConfirmModal({ title: 'Restore this backup?', body: el, confirmLabel: 'Restore and restart', destructive: true });
    if (!ok) return;
    try {
      await apiJson('/api/system/import/apply', { method: 'POST', body: { token: up.token } });
      showToast('Restoring — the host is restarting…', { kind: 'info' });
    } catch (err: any) {
      showToast('Restore failed: ' + (err?.message || err), { kind: 'error' });
    }
  });
}

export function wireFileControls3(): void {
  $<HTMLButtonElement>('#file-picker')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      if (input.files?.length && input.files.length > 0) stageFiles(input.files);
    });
    input.click();
  });
}

// crypto.randomUUID is only exposed in secure contexts (HTTPS / localhost).
// Webchat is commonly served over plain HTTP on a tailnet hostname where it
// is absent — fall back to a getRandomValues-based v4 builder, which IS
// available in non-secure contexts. Format matches the server's UUID regex
// in src/channels/webchat/files.ts (handleChunkedUpload).
export function uuidv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function arrayBufferToBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
