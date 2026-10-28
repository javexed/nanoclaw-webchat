/**
 * The images NanoClaw itself runs for workloads, pinned by digest: a tag can
 * be moved by whoever controls the registry, a digest cannot. An operator may
 * point at a mirror through the environment, but only with a digest; a bare
 * tag there is refused at startup rather than pulled.
 */
import { workloadSetting } from './settings.js';

/** Busybox userland for NanoClaw's helper containers (build-context copies, image repacks, volume backups, the isolation probe). */
const DEFAULT_HELPER_IMAGE = 'alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f';

/** Rootless BuildKit for confined builds (builder.ts). */
const DEFAULT_BUILDKIT_IMAGE =
  'moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89';

export const DIGEST_RE = /@sha256:[a-f0-9]{64}$/;

/** An override from the environment, or the default; an override without a digest is an error. */
export function pinnedImage(envValue: string | undefined, fallback: string, key: string): string {
  const v = envValue?.trim();
  if (!v) return fallback;
  if (!DIGEST_RE.test(v)) throw new Error(`${key} must name an image by digest (…@sha256:<64 hex>), got ${v}`);
  return v;
}

export const HELPER_IMAGE = (): string =>
  pinnedImage(
    workloadSetting('NANOCLAW_WORKLOAD_HELPER_IMAGE'),
    DEFAULT_HELPER_IMAGE,
    'NANOCLAW_WORKLOAD_HELPER_IMAGE',
  );

export const BUILDKIT_IMAGE = (): string =>
  pinnedImage(
    workloadSetting('NANOCLAW_WORKLOAD_BUILDKIT_IMAGE'),
    DEFAULT_BUILDKIT_IMAGE,
    'NANOCLAW_WORKLOAD_BUILDKIT_IMAGE',
  );
