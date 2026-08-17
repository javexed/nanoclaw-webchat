// ── MCP panel view state ────────────────────────────────────────────────────
// Bridge refs for the MCP sources list and the probe-results tool list. Both
// are fed by mcp.ts, which still owns the fetches.
import { ref } from 'vue';

/** /api/mcp-sources rows — the built-in registry entries and their on/off state. */
export const mcpSources = ref<any[]>([]);

/** The tools a probed server advertises. Empty is a rendered state, not absence. */
export const probeTools = ref<any[]>([]);

/** The selected server, as the hardening panel renders it. Null hides everything. */
export const hardeningServer = ref<any>(null);
/** true while the OAuth connect request is in flight. */
export const oauthBusy = ref(false);

/** Catalog rows, already shaped. Empty with phase 'ready' means no matches. */
export const mcpCatalog = ref<any[]>([]);
/** 'loading' | 'error' | 'ready' — 'error' clears the list and shows a status. */
export const mcpCatalogPhase = ref<'loading' | 'error' | 'ready'>('loading');
/** Drives the wait row's wording: searching vs first load. */
export const mcpCatalogQuery = ref('');
