// The transit shape central sends in `prepare`. Mirror of the server's
// drivers/remote-spec.ts — keep the two in step; the version field is the guard.
export const REMOTE_SPEC_VERSION = 1;
export const RELAY_SENTINEL = 'http://host.docker.internal:__NANOCLAW_RELAY_PORT__';

export interface SessionKey {
  installSlug: string;
  agentGroupId: string;
  sessionId: string;
}

export type RemoteMount =
  | { kind: 'content'; class: string; containerPath: string; bundle: string; file: boolean }
  | { kind: 'state'; class: 'group-state'; containerPath: string; stateId: string; seed?: string }
  | {
      kind: 'slot';
      class: 'allowlisted-extra';
      containerPath: string;
      mode: 'rw' | 'ro';
      exclude?: string[];
      propose?: boolean;
    };

export interface RemoteSpec {
  v: number;
  key: SessionKey;
  name: string;
  labels: Record<string, string>;
  image: string;
  /** Registry reference central is pinned to; the laptop may pull it instead of building. */
  imageRef?: string;
  /** Install-wide decision from central. 'pull'/'build' override this machine's own setting. */
  imagePolicy?: 'machine' | 'pull' | 'build';
  build?: { bundle: string; args: Record<string, string>; lockSha?: string };
  env: Record<string, string>;
  contributedEnv: Record<string, string>;
  command?: string[];
  args?: string[];
  containerLabels: Record<string, string>;
  mounts: RemoteMount[];
  resources: { memoryMb?: number; cpus?: string; pidsLimit?: number; shmSizeMb?: number };
  hardening: 'standard';
  runAs?: { uid: number; gid: number };
  stopGraceSeconds: number;
  network: 'default' | 'none';
}

export interface BundleDoc {
  v: 1;
  dirs: string[];
  files: Array<{ p: string; m: number; d: string }>;
  skipped: string[];
}

/** Set by every image build; identifies the agent-runner dependency set baked in. */
export const LOCK_LABEL = 'dev.nanoclaw.agent-runner-lock-sha256';

/** Canonical label keys — the adoption contract shared with the docker driver. */
export const LABELS = {
  install: 'nanoclaw-install',
  group: 'nanoclaw-group',
  session: 'nanoclaw-session',
  role: 'nanoclaw-role',
} as const;
