// ── Shared UI constants ─────────────────────────────────────────────────────
// Values with no owning feature, read by more than one.

/** Seconds a destructive action stays undoable before it commits. Shared by the
 *  thread-delete and skill-draft Keep/Discard undo flows. */
export const UNDO_SECONDS = 10;
