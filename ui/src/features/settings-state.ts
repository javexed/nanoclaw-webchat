// ── Settings panel state ────────────────────────────────────────────────────
import { ref } from 'vue';

/** Which speech backend the operator picked in the STT installer: 'local' | … */
export const sttChosenBackend = ref('local');
