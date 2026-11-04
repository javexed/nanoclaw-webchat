// ── List search ──────────────────────────────────────────────────────────────
// One helper for every "Search …" box over a list already in memory: type to
// filter, case-insensitive, empty shows all. Static inputs in index.html wire
// to a ref with wireListSearch; components filter with filterList/matchesQuery.
import { ref, type Ref } from 'vue';
import { $ } from './dom.js';

/** What a list shows when its search matches nothing. */
export const NO_MATCH = 'No match';

/** A typed query as compared: trimmed, lower-cased. */
export function normQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Does any field contain the query? An empty query matches everything. */
export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = normQuery(query);
  return !q || fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

/** The items whose text contains the query, in their order. */
export function filterList<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  const q = normQuery(query);
  return q ? items.filter((i) => text(i).toLowerCase().includes(q)) : [...items];
}

/** Keep `query` in step with the search input at `sel`; returns the ref. */
export function wireListSearch(sel: string, query: Ref<string> = ref('')): Ref<string> {
  $<HTMLInputElement>(sel)?.addEventListener('input', (e) => {
    query.value = (e.target as HTMLInputElement).value;
  });
  return query;
}

/** Empty the search input at `sel` and its ref (a list opened afresh shows everything). */
export function clearListSearch(sel: string, query: Ref<string>): void {
  const el = $<HTMLInputElement>(sel);
  if (el) el.value = '';
  query.value = '';
}
