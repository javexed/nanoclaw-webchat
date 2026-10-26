// ── Which model answered ────────────────────────────────────────────────────
// A reply's served model (the server stores what the runner reported) shows
// in its timestamp line only for a viewer who turned "Show model on replies"
// on — a per-browser setting, off by default. Unknown shows nothing.

export function servedModelShown(
  row: { isAgent?: boolean; servedModel?: string | null },
  settings: { showModel?: boolean } | null | undefined,
): string | null {
  if (settings?.showModel !== true || !row.isAgent) return null;
  return row.servedModel || null;
}
