// ── Ollama host card state ──────────────────────────────────────────────────
// Everything the OllamaHostCards island renders: the card, its model list and
// its pull line are separate slices so they cannot overwrite each other.
import { ref } from 'vue';

/** Configured hosts, in the order /api/ollama/hosts returned them. */
export const hosts = ref<string[]>([]);

export interface HostModels {
  /** loading is the state a freshly-built card starts in. */
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
  /** The ref this preview describes, so a slow response for a ref the
   *  operator has since changed is discarded rather than shown. */
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
 * Which cards are expanded. Backed by localStorage under `serverCardOpen:<host>`;
 * held as a Set so the template does not touch localStorage on every patch.
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

export interface HostHealth {
  status: 'up' | 'down';
  lastOk: number | null;
  lastError: string | null;
}

/** host → its last health check (GET /api/models/hosts). Absent = not checked yet. */
export const hostHealth = ref<Record<string, HostHealth>>({});

export interface FitJob {
  host: string;
  model: string;
  status: 'queued' | 'fitting' | 'fitted' | 'no-fit' | 'skipped' | 'error';
  ctx?: number;
  detail?: string;
  startedAt: number;
}

/** The GPU fits running or just finished, newest last. */
export const fitJobs = ref<FitJob[]>([]);

/** The owner's "Fit context to GPU" setting; null until loaded. */
export const fitContext = ref<boolean | null>(null);
