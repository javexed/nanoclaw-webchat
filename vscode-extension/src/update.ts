// Served updates: central tells the runner which build it should be on (in
// the welcome frame); this decides what to do about it. Pure, so it is
// testable; the download and install live in extension.ts with the vscode API.
export type AutoUpdate = 'prompt' | 'auto' | 'off';

export interface UpdateOffer {
  version: string;
  sha256: string;
  size?: number;
}

/** Semver-ish: is `a` newer than `b`? Only the three numbers count; malformed input is never "newer". */
export function isNewer(a: string, b: string): boolean {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}

export type UpdatePlan = { action: 'none' } | { action: 'prompt' | 'install'; offer: UpdateOffer };

/**
 * What to do with an offer: nothing when it is not newer, was already offered
 * this session, or updates are off; otherwise prompt or install per setting.
 */
export function planUpdate(
  offer: UpdateOffer | undefined,
  current: string,
  setting: AutoUpdate,
  alreadyOffered: ReadonlySet<string>,
): UpdatePlan {
  if (!offer || setting === 'off') return { action: 'none' };
  if (!/^[0-9a-f]{64}$/.test(offer.sha256)) return { action: 'none' }; // a manifest we cannot verify is not an offer
  if (!isNewer(offer.version, current)) return { action: 'none' };
  if (alreadyOffered.has(offer.version)) return { action: 'none' };
  return { action: setting === 'auto' ? 'install' : 'prompt', offer };
}
