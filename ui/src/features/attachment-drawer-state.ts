// Open/close state for the attachment drawer, shared by the message bubbles that
// open it, the drawer island that renders it, and the composition root's
// popstate handler.
//
// The drawer owns one history entry while it is open, so the back gesture (the
// way out of the full-screen sheet on a phone) closes it instead of leaving the
// app. Opening another file while it is open swaps the content in place and
// keeps the same entry.
import { ref } from 'vue';
import type { AttachmentFile } from './attachment-preview.js';

export const drawerFile = ref<AttachmentFile | null>(null);

let trigger: HTMLElement | null = null;

export function openAttachmentDrawer(file: AttachmentFile, from?: HTMLElement | null): void {
  const wasOpen = drawerFile.value !== null;
  drawerFile.value = { ...file };
  if (from) trigger = from;
  if (!wasOpen) {
    try {
      history.pushState({ ...(history.state || {}), attachmentDrawer: true }, '');
    } catch {
      // a history entry is a convenience; the drawer still opens without one
    }
  }
}

/**
 * Close the drawer and give focus back to whatever opened it. `fromPopstate`:
 * the history entry is already gone, so do not pop it again.
 */
export function closeAttachmentDrawer(fromPopstate = false): void {
  if (drawerFile.value === null) return;
  drawerFile.value = null;
  if (!fromPopstate && history.state && history.state.attachmentDrawer) history.back();
  const t = trigger;
  trigger = null;
  if (t && t.isConnected) requestAnimationFrame(() => t.focus());
}

/**
 * popstate: close the drawer when history moved off its entry. A full view
 * opened on top of the drawer pushes its own entry over the drawer's; going
 * back from that view lands ON the drawer's entry, which must leave the drawer
 * open and let the view unwind.
 */
export function attachmentDrawerPopstate(state: unknown): boolean {
  if (drawerFile.value === null) return false;
  if (state && (state as { attachmentDrawer?: boolean }).attachmentDrawer) return false;
  closeAttachmentDrawer(true);
  return true;
}
