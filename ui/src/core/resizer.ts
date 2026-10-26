// ── Resizable panels ────────────────────────────────────────────────────────
// One separator element sizes one panel, by pointer drag or by keyboard (the
// WAI-ARIA window-splitter pattern): arrows step, Home/End go to the limits.
// A plain click or tap (no drag) cycles through preset sizes — the way to
// resize without dragging (WCAG 2.5.7). There is deliberately no double-click
// reset: its two clicks would cycle twice. The size is a CSS custom property on the
// panel, so a stylesheet rule can still override it (mobile goes full width),
// and it is remembered per viewer in localStorage.
//
// The handle element carries its own role/label/tabindex in the markup; this
// keeps aria-valuenow/min/max true to the current size.

export interface ResizerOptions {
  /** The focusable separator. */
  handle: HTMLElement;
  /** The panel being sized; receives `cssVar`. */
  target: HTMLElement;
  /** Custom property the panel's width rule reads, e.g. `--sidebar-width`. */
  cssVar: string;
  min: number;
  max: number;
  /** The stylesheet's default. */
  initial: number;
  /**
   * Sizes a click/tap cycles through, ascending (e.g. narrow, default, wide).
   * Defaults to [min, initial, max].
   */
  presets?: number[];
  /** Pixels per arrow key. */
  step?: number;
  /** localStorage key for this viewer's size. */
  storageKey: string;
  /**
   * Which way the separator moves to GROW the panel: a left sidebar's edge
   * grows to the right ('right'); a right-hand drawer grows to the left ('left').
   */
  growsToward?: 'right' | 'left';
}

export function clampSize(px: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, px)));
}

/** A stored size, or null when there is none or it is junk. Clamped, since the limits may have moved. */
export function readStoredSize(raw: string | null, min: number, max: number): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clampSize(n, min, max) : null;
}

/** The size a key moves to, or null when the key is not a resize key. */
export function sizeForKey(
  key: string,
  current: number,
  o: { min: number; max: number; step: number; growsToward: 'right' | 'left' },
): number | null {
  const grow = o.growsToward === 'right' ? 'ArrowRight' : 'ArrowLeft';
  const shrink = o.growsToward === 'right' ? 'ArrowLeft' : 'ArrowRight';
  if (key === grow) return clampSize(current + o.step, o.min, o.max);
  if (key === shrink) return clampSize(current - o.step, o.min, o.max);
  if (key === 'Home') return o.min;
  if (key === 'End') return o.max;
  return null;
}

/** Pointer travel below this is a click, not a drag. */
export const CLICK_SLOP_PX = 4;

/**
 * The next preset after `current`: the smallest one wider than it, wrapping to
 * the narrowest once at (or past) the widest. A size between presets — after a
 * drag — moves to the next one up.
 */
export function nextPreset(current: number, presets: number[]): number {
  const sorted = [...presets].sort((a, b) => a - b);
  return sorted.find((p) => p > current) ?? sorted[0];
}

/** What a screen reader announces for a size. */
export function sizeText(px: number): string {
  return `${px} pixels`;
}

/** The size after dragging `dx` pixels from where the drag started. */
export function sizeForDrag(
  start: number,
  dx: number,
  o: { min: number; max: number; growsToward: 'right' | 'left' },
): number {
  return clampSize(start + (o.growsToward === 'right' ? dx : -dx), o.min, o.max);
}

/** Wire a separator to its panel. Returns a teardown. */
export function wireResizer(opts: ResizerOptions): () => void {
  const { handle, target, cssVar, min, max, initial, storageKey } = opts;
  const step = opts.step ?? 20;
  const growsToward = opts.growsToward ?? 'right';
  const presets = (opts.presets ?? [min, initial, max]).map((p) => clampSize(p, min, max));
  let size = initial;

  const apply = (px: number) => {
    size = clampSize(px, min, max);
    target.style.setProperty(cssVar, `${size}px`);
    handle.setAttribute('aria-valuenow', String(size));
    handle.setAttribute('aria-valuetext', sizeText(size));
  };
  const save = () => {
    try {
      localStorage.setItem(storageKey, String(size));
    } catch {
      /* private mode / blocked storage: the size just isn't remembered */
    }
  };

  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(max));
  let stored: number | null = null;
  try {
    stored = readStoredSize(localStorage.getItem(storageKey), min, max);
  } catch {
    /* unreadable storage: start from the default */
  }
  apply(stored ?? initial);

  const onKey = (e: KeyboardEvent) => {
    const next = sizeForKey(e.key, size, { min, max, step, growsToward });
    if (next === null) return;
    e.preventDefault();
    apply(next);
    save();
  };

  let dragFrom: { x: number; size: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    dragFrom = { x: e.clientX, size };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
  };
  // Movement under the slop is a click in progress and must not nudge the size.
  const onMove = (e: PointerEvent) => {
    if (!dragFrom) return;
    const dx = e.clientX - dragFrom.x;
    if (Math.abs(dx) >= CLICK_SLOP_PX) apply(sizeForDrag(dragFrom.size, dx, { min, max, growsToward }));
  };
  const onUp = (e: PointerEvent) => {
    if (!dragFrom) return;
    const from = dragFrom;
    dragFrom = null;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    handle.classList.remove('dragging');
    if (e.type === 'pointerup' && Math.abs(e.clientX - from.x) < CLICK_SLOP_PX) apply(nextPreset(from.size, presets));
    save();
  };

  handle.addEventListener('keydown', onKey);
  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  return () => {
    handle.removeEventListener('keydown', onKey);
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
  };
}
