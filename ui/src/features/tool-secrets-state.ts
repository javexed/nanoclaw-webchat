// ── System tool secrets state ───────────────────────────────────────────────
// Bridge ref for the ToolSecretList island (the workspace-scoped list). The
// per-agent list is a separate island — see AgentSecretList.
import { ref } from 'vue';

/** Workspace secrets, or empty for the "No system secrets" note. */
export const toolSecretRows = ref<any[]>([]);
