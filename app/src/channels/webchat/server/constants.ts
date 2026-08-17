// ── Cross-cutting webchat constants ──────────────────────────────────────────
// Values read by handlers on both sides of a server.ts split. They are one-line
// definitions, so keeping them where they happened to sit would force a route
// module to import back into the file it was carved out of — a cycle for the
// sake of two constants. A leaf module both import costs nothing and stays
// acyclic no matter which cluster comes out next.

export const DEFAULT_PORT = 3100;

// Stable id for the code-wired marketplace, so an owner can switch it off like a
// GitHub collection (persisted in webchat_disabled_sources).
export const MARKETPLACE_ID = 'awesomeskill';
