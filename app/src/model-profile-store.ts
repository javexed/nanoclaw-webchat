/**
 * On-disk cache of probed model profiles, plus the fire-and-forget probe that
 * fills it.
 *
 * The spawn path is synchronous and must stay that way — a container start is
 * not the place to block on an HTTP round trip to a GPU box that may be asleep.
 * So the first spawn of an unknown model uses the documented default and kicks
 * off a probe in the background; the result lands in the cache and the NEXT
 * spawn uses it. One turn on default settings is a cheap price for never
 * stalling a start.
 */
import fs from 'fs';
import path from 'path';

import { probeModel } from './model-probe.js';
import { resolveModelProfile, type CachedProfile, type ResolvedProfile } from './model-profiles.js';

/** Models currently being probed in this process, so we probe each once. */
const inFlight = new Set<string>();

export function cachePath(dataDir: string): string {
  return path.join(dataDir, 'model-profiles.json');
}

export function readCache(dataDir: string): Record<string, CachedProfile> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath(dataDir), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, CachedProfile>) : {};
  } catch {
    // No cache yet, or an unreadable one. Either way there is nothing to
    // recover and a missing cache is a valid state, not an error.
    return {};
  }
}

/**
 * Merge one entry in. Re-reads first so two agent groups starting at once
 * cannot clobber each other's freshly probed model.
 */
export function writeCacheEntry(dataDir: string, entry: CachedProfile): void {
  try {
    const all = readCache(dataDir);
    all[entry.model] = entry;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath(dataDir), JSON.stringify(all, null, 2) + '\n');
  } catch {
    // A cache we cannot write costs a repeated probe, nothing more. Never let
    // it take down a spawn.
  }
}

/**
 * Resolve now, and if nothing is known about this model, start measuring it for
 * next time. Returns synchronously; the probe is deliberately not awaited.
 */
export function resolveWithBackgroundProbe(args: {
  dataDir: string;
  model: string;
  baseURL: string;
  parameterSize?: string | null;
  log?: (msg: string) => void;
}): ResolvedProfile {
  const cache = readCache(args.dataDir);
  const resolved = resolveModelProfile({
    model: args.model,
    parameterSize: args.parameterSize ?? cache[args.model]?.parameterSizeRaw ?? null,
    cache,
  });

  if (resolved.source === 'default' && !inFlight.has(args.model)) {
    inFlight.add(args.model);
    args.log?.(`model-profile: nothing known about ${args.model} — probing in the background`);
    void probeModel(args.baseURL, args.model)
      .then((res) => {
        if (!res) {
          args.log?.(`model-profile: probe of ${args.model} produced no verdict — keeping defaults`);
          return;
        }
        writeCacheEntry(args.dataDir, {
          ...res.profile,
          model: args.model,
          measuredAt: new Date().toISOString(),
          parameterSizeRaw: args.parameterSize ?? null,
        });
        args.log?.(
          `model-profile: ${args.model} reached for a tool in ` +
            `${res.verdict.reachedForTool}/${res.verdict.rounds} rounds — cached`,
        );
      })
      .catch(() => {
        /* probeModel already swallows its own failures; this is belt and braces */
      })
      .finally(() => inFlight.delete(args.model));
  }

  return resolved;
}
