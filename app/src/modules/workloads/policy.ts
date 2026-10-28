/**
 * What an agent's Compose stack may contain. Pure: given the file text and
 * the agent's folder and quota, either a normalized stack or the reasons it is
 * refused. Everything that could reach past the agent is refused rather than
 * rewritten, so the agent learns the rule instead of getting a surprise.
 *
 * The file is parsed as YAML 1.2 with no merge keys and no tags. Compose
 * parses the file NanoClaw writes with its own rules, where `<<` merges and a
 * tag can change a value's meaning, so both are refused anywhere in the file:
 * what is checked here is exactly what Compose runs.
 */
import fs from 'fs';
import path from 'path';

import { isNode, parseDocument, visit } from 'yaml';

export interface Quota {
  memoryMb: number;
  cpus: number;
}

export interface ServiceLimits {
  memoryMb: number;
  cpus: number;
}

export interface CheckedStack {
  /** The stack as it will run, minus NanoClaw's override. */
  compose: { services: Record<string, Record<string, unknown>>; volumes?: Record<string, unknown> };
  limits: Record<string, ServiceLimits>;
  total: ServiceLimits;
}

export type CheckResult = { ok: true; stack: CheckedStack } | { ok: false; errors: string[] };

export interface CheckOptions {
  /** The Compose file's folder (inside the agent's folder); relative build contexts resolve from it. */
  composeDir?: string;
  /** Builds run only where they are confined (builder.ts); elsewhere `build:` is refused. */
  allowBuild?: boolean;
}

export const DEFAULT_MEMORY_MB = 512;
export const DEFAULT_CPUS = 0.5;

/** Top-level keys a stack may use (besides `x-*` extensions). */
const TOP_ALLOWED = new Set(['services', 'volumes', 'name', 'version']);

/** Service keys a stack may use (besides `x-*`). Anything else is refused by name. */
const SERVICE_ALLOWED = new Set([
  'image',
  'build',
  'command',
  'entrypoint',
  'environment',
  'working_dir',
  'user',
  'healthcheck',
  'depends_on',
  'expose',
  'labels',
  'volumes',
  'tmpfs',
  'mem_limit',
  'cpus',
  'deploy',
  'stop_grace_period',
  'stop_signal',
  'init',
  'read_only',
  'shm_size',
  'hostname',
  'platform',
  'restart',
  'cap_add',
]);

/**
 * Capabilities a service may add back. NanoClaw drops every capability
 * (override.ts); these are the ones ordinary images need to start as root and
 * then step down to their own user (a database's entrypoint chowns its data
 * folder and switches user). Nothing here reaches past the container.
 */
export const CAP_ADD_ALLOWED = new Set([
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'SETUID',
  'SETGID',
  'NET_BIND_SERVICE',
  'KILL',
]);

/** Keys refused with a reason, so the error says why rather than just "unknown". */
const SERVICE_REFUSED: Record<string, string> = {
  privileged: 'privileged containers can control the host',
  cap_drop: 'NanoClaw drops every capability; add back what the image needs with cap_add',
  devices: 'host devices are not allowed',
  security_opt: 'seccomp and AppArmor cannot be loosened',
  network_mode: 'a service joins its stack network only (no host network)',
  networks: 'NanoClaw puts every service on the stack network; custom networks are not allowed',
  pid: 'the host process namespace is not allowed',
  ipc: 'the host IPC namespace is not allowed',
  userns_mode: 'user namespace settings are fixed by NanoClaw',
  ports: 'no host ports: services are reached at their addresses on your own network',
  cgroup_parent: 'resource placement is fixed by NanoClaw',
  cgroup: 'resource placement is fixed by NanoClaw',
  sysctls: 'kernel settings are not allowed',
  volumes_from: 'share data through a named volume instead',
  container_name: 'NanoClaw names containers',
  runtime: 'the container runtime is fixed by NanoClaw',
  isolation: 'isolation is fixed by NanoClaw',
  oom_kill_disable: 'every container must be killable when out of memory',
  oom_score_adj: 'every container must be killable when out of memory',
  links: 'services reach each other by name on the stack network',
  external_links: 'services reach each other by name on the stack network',
  env_file: 'put variables in `environment` (env_file reads files outside the stack)',
  secrets: 'secrets from files are not supported yet',
  configs: 'configs from files are not supported yet',
  extends: 'extends reads other files',
  profiles: 'profiles are not supported',
  gpus: 'GPUs are not available',
  dns: 'DNS is fixed by NanoClaw',
  extra_hosts: 'extra host entries are not allowed',
  pull_policy: 'NanoClaw pulls the approved image itself',
  logging: 'logging is fixed by NanoClaw',
};

const isExt = (k: string): boolean => k.startsWith('x-');

/**
 * An image reference: [registry[:port]/]path[:tag][@sha256:digest], in
 * Docker's own character set. Anything else (spaces, newlines, quotes) is
 * refused, so a reference can never pass for more lines on a card.
 */
export const IMAGE_REF_RE =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** "512m", "2g", "1536M", 268435456 → megabytes. */
export function parseMemoryMb(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.ceil(v / (1024 * 1024));
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmg]?)b?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mb =
    unit === 'g'
      ? n * 1024
      : unit === 'm'
        ? n
        : unit === 'k'
          ? n / 1024
          : unit === 'b' || unit === ''
            ? n / (1024 * 1024)
            : NaN;
  return Number.isFinite(mb) && mb > 0 ? Math.ceil(mb) : null;
}

function parseCpus(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** A named-volume mount ("data:/var/lib/x[:ro]" or long syntax type: volume). Null when it is not one; '' for tmpfs. */
function namedVolume(v: unknown): string | null {
  if (typeof v === 'string') {
    const [src, dst] = v.split(':');
    // A source with a slash, or starting with "." or "~", is a host path.
    if (!dst || !src || /[/\\]/.test(src) || src.startsWith('.') || src.startsWith('~')) return null;
    return src;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'volume' && typeof o.source === 'string' && o.source && !/[/\\]/.test(o.source)) return o.source;
    if (o.type === 'tmpfs') return '';
  }
  return null;
}

/**
 * A build context must be a folder inside the agent's own folder, links
 * resolved. Relative to the Compose file's folder, as Compose has it. Returns
 * the context relative to the agent's folder (what the runner resolves), or
 * null when refused.
 */
function checkBuild(
  build: unknown,
  groupDir: string,
  composeDir: string,
  svc: string,
  errors: string[],
): string | null {
  const b = typeof build === 'string' ? { context: build } : (build as Record<string, unknown> | null);
  if (!b || typeof b !== 'object' || Array.isArray(b))
    return (errors.push(`${svc}: build must be a path or an object`), null);
  for (const k of Object.keys(b))
    if (!['context', 'dockerfile', 'args', 'target'].includes(k)) errors.push(`${svc}: build.${k} is not allowed`);
  if (b.args !== undefined && (typeof b.args !== 'object' || b.args === null))
    errors.push(`${svc}: build.args must be a map or a list`);
  if (b.target !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(b.target)))
    errors.push(`${svc}: build.target must be a stage name`);
  const ctx = String(b.context ?? '.');
  if (path.isAbsolute(ctx) || /^[a-z]+:\/\//i.test(ctx))
    return (errors.push(`${svc}: build context must be a folder in your workspace`), null);
  const root = fs.realpathSync(groupDir);
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(composeDir, ctx));
  } catch {
    return (errors.push(`${svc}: build context ${ctx} does not exist`), null);
  }
  if (real !== root && !real.startsWith(root + path.sep))
    return (errors.push(`${svc}: build context ${ctx} is outside your workspace`), null);
  if (
    b.dockerfile !== undefined &&
    (path.isAbsolute(String(b.dockerfile)) || String(b.dockerfile).split(/[/\\]/).includes('..'))
  )
    return (errors.push(`${svc}: build.dockerfile must be inside the build context`), null);
  return path.relative(root, real) || '.';
}

/** This service's limits as written, or the defaults. */
function limitsOf(svc: Record<string, unknown>): ServiceLimits {
  const res = ((svc.deploy as Record<string, unknown> | undefined)?.resources as Record<string, unknown> | undefined)
    ?.limits as Record<string, unknown> | undefined;
  return {
    memoryMb: parseMemoryMb(res?.memory ?? svc.mem_limit) ?? DEFAULT_MEMORY_MB,
    cpus: parseCpus(res?.cpus ?? svc.cpus) ?? DEFAULT_CPUS,
  };
}

/** Every `<<` key anywhere in a parsed value, as dotted paths. Pure. */
export function mergeKeys(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => mergeKeys(x, `${at}[${i}]`));
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [
    ...(k === '<<' ? [at || '(top level)'] : []),
    ...mergeKeys(x, at ? `${at}.${k}` : k),
  ]);
}

/** Parse as YAML 1.2, refusing explicit tags; null with errors pushed when it cannot be used. */
function parseStrict(text: string, errors: string[]): unknown {
  const doc = parseDocument(text, { merge: false, uniqueKeys: true });
  if (doc.errors.length) {
    errors.push(`not valid YAML: ${doc.errors[0].message.split('\n')[0]}`);
    return null;
  }
  const tags = new Set<string>();
  visit(doc, {
    Node(_, n) {
      if (isNode(n) && n.tag) tags.add(n.tag);
    },
  });
  if (tags.size) {
    errors.push(`YAML tags are not allowed (${[...tags].slice(0, 3).join(', ')}): write plain values`);
    return null;
  }
  try {
    return doc.toJS({ maxAliasCount: 50 });
  } catch (err) {
    errors.push(`not valid YAML: ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
}

export function checkStack(text: string, groupDir: string, quota: Quota, opts: CheckOptions = {}): CheckResult {
  const composeDir = opts.composeDir ?? groupDir;
  const errors: string[] = [];
  const doc = parseStrict(text, errors);
  if (errors.length) return { ok: false, errors };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, errors: ['not a Compose file'] };
  const merges = mergeKeys(doc);
  if (merges.length)
    return {
      ok: false,
      errors: [`YAML merge keys (<<) are not allowed (at ${merges.slice(0, 3).join(', ')}): write the values out`],
    };
  const top = doc as Record<string, unknown>;
  for (const k of Object.keys(top)) if (!TOP_ALLOWED.has(k) && !isExt(k)) errors.push(`top-level ${k} is not allowed`);
  const services = top.services as Record<string, Record<string, unknown>> | undefined;
  if (!services || typeof services !== 'object' || Array.isArray(services) || !Object.keys(services).length)
    errors.push('no services');

  const rawVolumes = top.volumes ?? {};
  if (typeof rawVolumes !== 'object' || Array.isArray(rawVolumes)) errors.push('top-level volumes must be a map');
  const volumes = (typeof rawVolumes === 'object' && !Array.isArray(rawVolumes) ? rawVolumes : {}) as Record<
    string,
    unknown
  >;
  const declaredVolumes = new Set(Object.keys(volumes));
  for (const [name, v] of Object.entries(volumes)) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name))
      errors.push(`volume name ${name} must be lowercase letters, digits, ., - or _`);
    const o = (v ?? {}) as Record<string, unknown>;
    if (typeof o !== 'object' || Array.isArray(o)) {
      errors.push(`volume ${name}: must be empty or { driver: local }`);
      continue;
    }
    if (o.external) errors.push(`volume ${name}: external volumes are not allowed`);
    if (o.driver_opts) errors.push(`volume ${name}: driver_opts can mount host paths and are not allowed`);
    if (o.driver !== undefined && o.driver !== 'local') errors.push(`volume ${name}: only the local driver`);
    // `name` would reuse any existing volume on the host (another stack's, NanoClaw's own).
    for (const k of Object.keys(o))
      if (!['driver', 'external', 'driver_opts'].includes(k) && !isExt(k))
        errors.push(`volume ${name}: ${k} is not allowed`);
  }

  const limits: Record<string, ServiceLimits> = {};
  const out: Record<string, Record<string, unknown>> = {};
  const svcEntries =
    services && typeof services === 'object' && !Array.isArray(services) ? Object.entries(services) : [];
  for (const [svcName, svcRaw] of svcEntries) {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(svcName))
      errors.push(`service name ${svcName} must be lowercase letters, digits, - or _`);
    const svc = (svcRaw ?? {}) as Record<string, unknown>;
    if (typeof svc !== 'object' || Array.isArray(svc)) {
      errors.push(`${svcName}: must be a map`);
      continue;
    }
    for (const k of Object.keys(svc)) {
      if (isExt(k)) continue;
      if (SERVICE_REFUSED[k]) errors.push(`${svcName}: ${k} — ${SERVICE_REFUSED[k]}`);
      else if (!SERVICE_ALLOWED.has(k)) errors.push(`${svcName}: ${k} is not allowed`);
    }
    if (!svc.image && svc.build === undefined) errors.push(`${svcName}: needs an image or a build`);
    if (svc.image !== undefined && (typeof svc.image !== 'string' || !IMAGE_REF_RE.test(svc.image)))
      errors.push(`${svcName}: image must be a plain image reference like nginx:1.27 or ghcr.io/org/app:1.0`);
    if (svc.build !== undefined && !opts.allowBuild)
      errors.push(
        `${svcName}: build is not available on this host (builds need confined builders); use a published image`,
      );
    const buildRel =
      svc.build !== undefined && opts.allowBuild ? checkBuild(svc.build, groupDir, composeDir, svcName, errors) : null;
    if (svc.cap_add !== undefined) {
      const caps = Array.isArray(svc.cap_add)
        ? svc.cap_add.map((c) => String(c).toUpperCase().replace(/^CAP_/, ''))
        : null;
      if (!caps) errors.push(`${svcName}: cap_add must be a list`);
      else
        for (const c of caps)
          if (!CAP_ADD_ALLOWED.has(c))
            errors.push(`${svcName}: cap_add ${c} is not allowed (allowed: ${[...CAP_ADD_ALLOWED].join(', ')})`);
    }
    const vols = svc.volumes ?? [];
    if (!Array.isArray(vols)) errors.push(`${svcName}: volumes must be a list`);
    for (const v of Array.isArray(vols) ? vols : []) {
      const name = namedVolume(v);
      if (name === null) errors.push(`${svcName}: volume ${JSON.stringify(v)} — only named volumes, no host paths`);
      else if (name && !declaredVolumes.has(name))
        errors.push(`${svcName}: volume ${name} is not declared under top-level volumes`);
    }
    const labels = svc.labels;
    const labelNames = Array.isArray(labels)
      ? labels.map((l) => String(l).split('=')[0])
      : Object.keys((labels as Record<string, unknown> | undefined) ?? {});
    for (const label of labelNames)
      if (/^(nanoclaw|dev\.nanoclaw|com\.docker\.)/i.test(label)) errors.push(`${svcName}: label ${label} is reserved`);
    const deploy = svc.deploy as Record<string, unknown> | undefined;
    if (deploy)
      for (const k of Object.keys(deploy)) if (k !== 'resources') errors.push(`${svcName}: deploy.${k} is not allowed`);
    limits[svcName] = limitsOf(svc);
    // Normalized: limits in one place, NanoClaw's restart policy, capabilities upper-cased.
    const { mem_limit: _m, cpus: _c, deploy: _d, restart: _r, cap_add: capAdd, ...rest } = svc;
    out[svcName] = {
      ...rest,
      // Relative to the agent's folder from here on (the runner resolves it there).
      ...(buildRel !== null
        ? {
            build:
              typeof svc.build === 'string'
                ? { context: buildRel }
                : { ...(svc.build as Record<string, unknown>), context: buildRel },
          }
        : {}),
      ...(Array.isArray(capAdd) && capAdd.length
        ? { cap_add: [...new Set(capAdd.map((c) => String(c).toUpperCase().replace(/^CAP_/, '')))].sort() }
        : {}),
      restart: 'unless-stopped',
      deploy: {
        resources: { limits: { memory: `${limits[svcName].memoryMb}M`, cpus: String(limits[svcName].cpus) } },
      },
    };
  }
  const total = Object.values(limits).reduce(
    (a, l) => ({ memoryMb: a.memoryMb + l.memoryMb, cpus: Math.round((a.cpus + l.cpus) * 1000) / 1000 }),
    { memoryMb: 0, cpus: 0 },
  );
  if (total.memoryMb > quota.memoryMb)
    errors.push(`the stack asks for ${total.memoryMb} MB of memory; your quota has ${quota.memoryMb} MB left`);
  if (total.cpus > quota.cpus) errors.push(`the stack asks for ${total.cpus} CPUs; your quota has ${quota.cpus} left`);
  if (total.memoryMb > quota.memoryMb || total.cpus > quota.cpus)
    errors.push(
      `to fit: give services smaller limits (deploy.resources.limits, e.g. cpus: "0.25", memory: 256M; the default is ${DEFAULT_CPUS} CPU / ${DEFAULT_MEMORY_MB} MB each), or delete a stack you no longer need (\`ncl workloads list\` shows what holds your quota; stopped stacks still count)`,
    );
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    stack: {
      compose: { services: out, ...(declaredVolumes.size ? { volumes } : {}) },
      limits,
      total,
    },
  };
}
