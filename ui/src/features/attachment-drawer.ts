// Mounts the attachment drawer island. Called from the composition root at its
// place in boot order; the island renders nothing until a file is opened.
import { createApp } from 'vue';
import { mountIsland } from '../core/island.js';
import AttachmentDrawer from './AttachmentDrawer.vue';

let drawerApp: ReturnType<typeof createApp> | null = null;

export function mountAttachmentDrawer(): void {
  drawerApp ??= mountIsland('#attachment-drawer-root', () => createApp(AttachmentDrawer));
}
