// ── Modal state ─────────────────────────────────────────────────────────────
import { ref } from 'vue';

/** Is the image lightbox open? Gates the global key handlers it installs. */
export const lightboxOpen = ref(false);
