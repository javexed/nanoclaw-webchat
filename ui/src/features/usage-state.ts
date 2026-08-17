// ── Usage settings state ────────────────────────────────────────────────────
// Bridge refs for the three usage islands. settings.ts still fetches and shapes;
// the totals line, the range buttons and the table/empty hidden flags stay
// imperative because they live outside the three mount points.
import { ref } from 'vue';

/** Per-user rows, already formatted into display strings. */
export const usageRows = ref<any[]>([]);
/** Per-day bars: height in px and a title. Empty means the sparkline is hidden. */
export const usageBars = ref<any[]>([]);
/** Per-model chips, already formatted. */
export const usageModels = ref<string[]>([]);
