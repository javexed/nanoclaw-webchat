/**
 * Array predicates that can await.
 *
 * WHY THIS FILE EXISTS. `Array.prototype.filter`/`some`/`every` take a
 * SYNCHRONOUS predicate. Hand one an async function and it returns a Promise —
 * which is truthy — so:
 *
 *     rooms.filter((r) => canAccessRoom(userId, r.id))   // keeps EVERY room
 *     agents.some((a) => hasAdminPrivilege(userId, a.id)) // always true
 *
 * and tsc says nothing: for an authorization filter that means it silently
 * stops filtering.
 *
 * Sequential ON PURPOSE: the predicates hit the same few rows, so a Promise.all
 * fan-out multiplies queries for no gain and makes DB access less predictable.
 */

/** `filter`, awaiting each predicate. */
export async function filterAsync<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean | Promise<boolean>,
): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  for (const item of items) {
    if (await predicate(item, i++)) out.push(item);
  }
  return out;
}

/** `some`, awaiting each predicate. Short-circuits on the first true. */
export async function someAsync<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean | Promise<boolean>,
): Promise<boolean> {
  let i = 0;
  for (const item of items) {
    if (await predicate(item, i++)) return true;
  }
  return false;
}

/** `every`, awaiting each predicate. Short-circuits on the first false. */
export async function everyAsync<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean | Promise<boolean>,
): Promise<boolean> {
  let i = 0;
  for (const item of items) {
    if (!(await predicate(item, i++))) return false;
  }
  return true;
}
