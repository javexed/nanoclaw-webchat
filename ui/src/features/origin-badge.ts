// ── Origin badge ────────────────────────────────────────────────────────────
// The little provenance pill that leads a skill or MCP row: who published it,
// linking to the source when there is a safe one.
//
// Out of legacy.js and into its own module because ten call sites across
// mcp.ts and skills.ts use it, and the islands need to render it declaratively
// while the not-yet-converted callers still need a DOM node.
//
// The shape is deliberate: originBadgeProps() makes every DECISION — including
// the http(s) test that keeps a javascript:/data: URL out of an href — and the
// two renderers below are thin. Writing the component's own conditionals would
// have meant two copies of that test, and the copy that drifts is the one that
// stops being a security check.

/**
 * Stable hue per label, so a publisher keeps its colour across renders.
 *
 * The 60–190 band is excluded, not wrapped around: those are the yellows and
 * greens that read as "warning" and "success" elsewhere in the console, and a
 * publisher name is neither. Copied exactly — a plain `% 360` would look right
 * and quietly recolour every badge.
 */
function labelHue(str: string): number {
  const BAND_LO = 60;
  const BAND_HI = 190;
  const usable = 360 - (BAND_HI - BAND_LO);
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) % usable;
  return h < BAND_LO ? h : h + (BAND_HI - BAND_LO);
}

export interface Origin {
  label: string;
  url?: string;
  official?: boolean;
}

export interface OriginBadgeProps {
  /** 'a' when there is a safe URL to link, 'span' otherwise. */
  tag: 'a' | 'span';
  className: string;
  label: string;
  /** null for official badges, which use the official colour instead. */
  hue: string | null;
  href: string | null;
  title: string | null;
}

/**
 * Everything the badge renders, decided once.
 *
 * Only http(s) — never let a javascript:/data: URL become a click-XSS sink
 * (defense-in-depth; the source list is owner-gated config).
 */
export function originBadgeProps(origin: Origin): OriginBadgeProps {
  const safeUrl = /^https?:\/\//i.test(origin.url || '') ? origin.url! : null;
  return {
    tag: safeUrl ? 'a' : 'span',
    className: 'skill-badge skill-badge-origin' + (origin.official ? ' skill-badge-official' : ''),
    label: origin.label,
    hue: origin.official ? null : String(labelHue(origin.label)),
    href: safeUrl,
    title: safeUrl ? `${origin.label} — open source ↗` : null,
  };
}

/**
 * The imperative renderer, for the call sites that are still imperative.
 * Byte-for-byte what legacy.js produced — this is a move, not a rewrite.
 */
export function originBadgeEl(origin: Origin): HTMLElement {
  const p = originBadgeProps(origin);
  const el = document.createElement(p.tag);
  el.className = p.className;
  el.textContent = p.label;
  if (p.hue !== null) el.style.setProperty('--badge-hue', p.hue);
  if (p.href) {
    (el as HTMLAnchorElement).href = p.href;
    (el as HTMLAnchorElement).target = '_blank';
    (el as HTMLAnchorElement).rel = 'noopener noreferrer';
    el.title = p.title!;
    // The installed-list row is itself clickable (opens the editor); don't let a
    // click on the badge trigger it.
    el.addEventListener('click', (e) => e.stopPropagation());
  }
  return el;
}
