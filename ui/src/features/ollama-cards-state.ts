// ── Ollama host card state ──────────────────────────────────────────────────
// Everything the OllamaHostCards island renders. Three renderers used to write
// into one card subtree; they are three slices of this object now, which is the
// whole point of the conversion — the card, its model list and its pull line
// can no longer overwrite each other.
import { ref } from 'vue';

/** Configured hosts, in the order /api/ollama/hosts returned them. */
export const hosts = ref<string[]>([]);

export interface HostModels {
  /** loading is the state a freshly-built card starts in, as it always was. */
  phase: 'loading' | 'ready' | 'error';
  selectable: any[];
  system: any[];
  error: string;
}

/** host → its model list. Keyed by host because the fetches race. */
export const hostModels = ref<Record<string, HostModels>>({});

export interface HostPull {
  status: string;
  model: string;
  detail: string;
  error: string;
  pct: number;
  /** Fitness verdict for the JUST-pulled model, computed against the hardware
   *  at that moment — replaces the standing "Local models" analysis block. */
  verdict?: string[];
}

/** host → its in-flight or last-finished pull. Absent means no line shown. */
export const hostPulls = ref<Record<string, HostPull>>({});

export interface PullPreview {
  /**
   * The ref this preview describes. Kept so a slow response can be DISCARDED
   * when it lands after the operator has typed something else — otherwise the
   * line under the box reports the size of a model they already moved on from,
   * which is worse than showing nothing.
   */
  model: string;
  text: string;
  /** Drives the warning colour: the estimate says this will not fit in VRAM. */
  warn: boolean;
}

/**
 * host → what pulling the currently-typed ref would cost, or null for "say
 * nothing". Null is the resting state and the honest answer whenever the size
 * cannot be read; only a real measurement earns a line.
 */
export const hostPullPreview = ref<Record<string, PullPreview | null>>({});

/**
 * Which cards are expanded.
 *
 * Backed by localStorage under `serverCardOpen:<host>`, the same keys the
 * imperative accordion used — an operator's expanded cards survive this
 * conversion. Held as a Set rather than read from storage during render so the
 * template does not touch localStorage on every patch.
 */
export const openCards = ref<Set<string>>(new Set());

export function isCardOpen(host: string): boolean {
  return localStorage.getItem('serverCardOpen:' + host) === '1';
}

export function setCardOpen(host: string, open: boolean): void {
  localStorage.setItem('serverCardOpen:' + host, open ? '1' : '0');
  const next = new Set(openCards.value);
  // Reassigned rather than mutated: state.ts documents that this codebase
  // assigns collections wholesale, and a Set mutated in place would not wake
  // the template on a shallow ref.
  if (open) next.add(host);
  else next.delete(host);
  openCards.value = next;
}

/** Seed the open-set from storage for a freshly loaded host list. */
export function syncOpenCards(list: string[]): void {
  openCards.value = new Set(list.filter(isCardOpen));
}
