// ── Cross-cutting webchat constants ──────────────────────────────────────────
// Read by server.ts and the route modules; a leaf module keeps imports acyclic.

export const DEFAULT_PORT = 3100;

// Stable id for the code-wired marketplace, so an owner can switch it off like a
// GitHub collection (persisted in webchat_disabled_sources).
export const MARKETPLACE_ID = 'awesomeskill';
