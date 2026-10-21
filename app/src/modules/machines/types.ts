/**
 * Agent machines: VMs an agent can have NanoClaw build for it, on pluggable
 * backends. Design: the "NanoClaw Agent Machines" doc (Backends, Machine
 * model, Agent commands and guardrails).
 *
 * The control plane (control.ts) never calls a cloud or hypervisor API
 * itself: each backend is a MachineDriver, and a site pairs a driver with its
 * region or cluster, sizes and caps.
 */

/** A machine's lifecycle state as NanoClaw records it. */
export type MachineState = 'provisioning' | 'running' | 'stopped' | 'failed' | 'deleting' | 'deleted';

/** A size a site offers, e.g. { vcpu: 4, memoryGb: 16, backendSize: 'Standard_D4s_v5' }. */
export interface SizeDef {
  vcpu: number;
  memoryGb: number;
  /** The backend's own name for it (an Azure VM size, a Proxmox template's cores/memory). */
  backendSize: string;
}

/** A backend plus where and how big. Stored in `machine_sites`. */
export interface Site {
  id: string;
  backend: string;
  label: string;
  /** Backend-specific settings (resource group, subnet, pool, template…). Never a credential. */
  config: Record<string, unknown>;
  sizes: Record<string, SizeDef>;
  /** Machines one agent may hold here at once (not counting deleted). */
  perAgentCap: number;
  /** Machines the whole install may hold here at once. */
  installCap: number;
  /** Daily stop time, HH:MM in the host's local time; null = none. */
  autoStopAt: string | null;
  enabled: boolean;
}

/** A machine record. Stored in `machines`; the backend is the source of truth for what exists. */
export interface Machine {
  id: string;
  agentGroupId: string;
  siteId: string;
  name: string;
  size: string;
  state: MachineState;
  /** The backend's id for it; null until create returns. */
  handle: string | null;
  privateIp: string | null;
  /** Idempotency key of the last change: a retry finds the half-done work instead of repeating it. */
  opId: string;
  lastError: string | null;
  expiresAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What a driver is asked to build. */
export interface MachineSpec {
  machineId: string;
  name: string;
  sizeName: string;
  size: SizeDef;
  agentGroupId: string;
  /** First-boot script (cloud-init). */
  cloudInit: string;
  /** Tags every machine carries; `nanoclaw-install` lets list() find this install's machines. */
  tags: Record<string, string>;
}

/** What the backend says about one machine. */
export interface Observation {
  handle: string;
  state: 'provisioning' | 'running' | 'stopped' | 'missing' | 'error';
  privateIp: string | null;
  sizeName?: string;
  detail?: string;
}

export interface DriverCapabilities {
  /** The backend can stop machines on a schedule by itself (Azure). */
  nativeAutoShutdown: boolean;
  /** Size changes without a stop (none of today's backends). */
  liveResize: boolean;
}

/** Who may connect in: SSH only from the NanoClaw host, app ports only from the gateway. */
export interface InboundRules {
  sshFrom: string[];
  appFrom: string[];
  appPorts: number[];
}

/**
 * One backend. Every method may be retried: `create` is idempotent by opId,
 * the others act on a handle and are no-ops when already in the target state.
 */
export interface MachineDriver {
  readonly backend: string;
  capabilities(): DriverCapabilities;
  /** Checked before an approval card is shown, so an owner never approves something that cannot be built. */
  validate(site: Site, spec: MachineSpec): Promise<{ ok: true } | { ok: false; reason: string }>;
  create(site: Site, spec: MachineSpec, opId: string): Promise<{ handle: string }>;
  get(site: Site, handle: string): Promise<Observation>;
  /** Every machine on this site tagged with this install's id. */
  list(site: Site, installTag: string): Promise<Array<Observation & { tags: Record<string, string> }>>;
  start(site: Site, handle: string): Promise<void>;
  stop(site: Site, handle: string): Promise<void>;
  resize(site: Site, handle: string, size: SizeDef): Promise<void>;
  delete(site: Site, handle: string): Promise<void>;
  setInbound(site: Site, handle: string, rules: InboundRules): Promise<void>;
}
