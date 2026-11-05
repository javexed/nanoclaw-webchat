/**
 * Latest-wins for overlapping async actions on the same thing (a default
 * picked twice in a row): each start takes a ticket, and a superseded run
 * checks `current` before its write and stops, so a slow earlier choice
 * cannot land after a later one.
 */
export function latestOnly(): { start: () => number; current: (ticket: number) => boolean } {
  let latest = 0;
  return {
    start: () => ++latest,
    current: (ticket) => ticket === latest,
  };
}
