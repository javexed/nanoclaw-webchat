// ── Shared UI constants ─────────────────────────────────────────────────────
// Values with no owning feature, read by more than one.

/**
 * Seconds a destructive action stays undoable before it commits.
 *
 * Shared by the two sliding-undo flows — thread delete and skill draft
 * Keep/Discard — which is why it cannot live in either's module. It was a
 * legacy.js const behind a getUNDO_SECONDS() accessor on two bridges.
 */
export const UNDO_SECONDS = 10;
