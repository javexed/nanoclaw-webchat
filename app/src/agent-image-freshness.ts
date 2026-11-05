/**
 * A per-agent image (an agent's own apt/npm packages layered on the base agent
 * image, built by buildAgentGroupImage) keeps the runner of the base it was
 * built on. Rebuilding the base does not touch it, so such an agent would go on
 * running the old runner until someone rebuilt its image by hand.
 *
 * Before a spawn, compare the image's `dev.nanoclaw.derived-from` label with the
 * current base image id; when they differ (or the label is missing), rebuild it
 * first. Running containers are never touched — only the next spawn changes.
 *
 * Only NanoClaw's own per-agent images are rebuilt: the tag must be
 * `<base repo>:<agent group id>` and the image must carry the
 * `dev.nanoclaw.image-source=derived` label buildAgentGroupImage stamps. An
 * image an operator pointed the agent at is never replaced.
 *
 * A failed rebuild is logged and the spawn goes ahead on the existing image: an
 * agent on an old runner beats an agent that cannot start. The same agent and
 * base are not tried again for an hour. One rebuild runs at a time across all
 * agents; a spawn that finds another agent's rebuild running starts on its
 * existing image and leaves the rebuild to a later spawn.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

export const DERIVED_FROM_LABEL = 'dev.nanoclaw.derived-from';
export const IMAGE_SOURCE_LABEL = 'dev.nanoclaw.image-source';

/** How long a failed rebuild of one agent on one base is left alone. */
export const REBUILD_BACKOFF_MS = 60 * 60 * 1000;
/** Rebuilds running at once, across all agents. */
export const MAX_CONCURRENT_REBUILDS = 1;

export interface ImageFreshnessDeps {
  /** The driver can build images (capabilities().imageBuild). */
  imageBuild: boolean;
  /** `docker image inspect --format <format> <ref>`, trimmed; null when the image is missing. */
  inspect?: (ref: string, format: string) => Promise<string | null>;
  /** Rebuild the agent's image on the current base (buildAgentGroupImage). */
  build: (agentGroupId: string) => Promise<void>;
  /** Clock, for the failure backoff. */
  now?: () => number;
}

async function dockerInspect(ref: string, format: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(CONTAINER_RUNTIME_BIN, ['image', 'inspect', '--format', format, ref]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** True for the tag buildAgentGroupImage gives this agent's own image. */
export function isOwnAgentImageTag(agentGroupId: string, imageTag: string): boolean {
  return imageTag === `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;
}

/** One check (and at most one rebuild) per agent at a time; concurrent spawns share it. */
const inFlight = new Map<string, Promise<void>>();
/** `<agent>\0<base id>` → when its rebuild last failed. */
const failedAt = new Map<string, number>();
let rebuildsRunning = 0;

/** Test hook: forget failures and in-flight checks. */
export function resetImageFreshnessState(): void {
  inFlight.clear();
  failedAt.clear();
  rebuildsRunning = 0;
}

export function ensureFreshAgentImage(agentGroupId: string, imageTag: string, deps: ImageFreshnessDeps): Promise<void> {
  if (!deps.imageBuild || !imageTag || imageTag === CONTAINER_IMAGE) return Promise.resolve();
  if (!isOwnAgentImageTag(agentGroupId, imageTag)) return Promise.resolve();
  const running = inFlight.get(agentGroupId);
  if (running) return running;
  const inspect = deps.inspect ?? dockerInspect;
  const now = deps.now ?? Date.now;
  const check = (async () => {
    const baseId = await inspect(CONTAINER_IMAGE, '{{.Id}}');
    // No base to compare with: leave the image alone; the spawn reports what is wrong.
    if (!baseId) return;
    const source = await inspect(imageTag, `{{index .Config.Labels "${IMAGE_SOURCE_LABEL}"}}`);
    // Missing, or not one NanoClaw derived: never replace it.
    if (source !== 'derived') return;
    const derivedFrom = await inspect(imageTag, `{{index .Config.Labels "${DERIVED_FROM_LABEL}"}}`);
    if (derivedFrom === baseId) return;

    const failKey = `${agentGroupId}\0${baseId}`;
    const lastFail = failedAt.get(failKey);
    if (lastFail !== undefined && now() - lastFail < REBUILD_BACKOFF_MS) return;
    if (rebuildsRunning >= MAX_CONCURRENT_REBUILDS) {
      log.info('Per-agent image is on an old base image; another rebuild is running, starting on the existing image', {
        agentGroupId,
        imageTag,
      });
      return;
    }

    log.info('Per-agent image is on an old base image; rebuilding before spawn', {
      agentGroupId,
      imageTag,
      derivedFrom: derivedFrom || null,
      baseId,
    });
    rebuildsRunning++;
    try {
      await deps.build(agentGroupId);
      failedAt.delete(failKey);
    } catch (err) {
      failedAt.set(failKey, now());
      log.error('Per-agent image rebuild failed; starting on the existing image', {
        agentGroupId,
        imageTag,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      rebuildsRunning--;
    }
  })().finally(() => inFlight.delete(agentGroupId));
  inFlight.set(agentGroupId, check);
  return check;
}
