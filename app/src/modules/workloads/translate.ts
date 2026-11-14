/**
 * Compose compatibility: a project's own docker-compose.yml, rewritten into
 * the subset policy.ts accepts, before it is checked. Only what can be done
 * without reaching past the agent's workspace is translated; what stays unsafe
 * (privileged, host paths, devices, host network …) is left for policy.ts to
 * refuse. Every change is reported, so the agent and the approval card say
 * what was translated.
 *
 *   ${VAR} …         filled from the .env next to the Compose file (never the host's environment)
 *   include, extends files inside the workspace, merged as Compose would
 *   env_file         read from the workspace into `environment` (environment wins)
 *   ports            become `expose`: nothing is published on a machine
 *   networks, links, container_name   dropped; names become aliases on the stack network
 *   profiles         a service with profiles is left out, as Compose does by default
 *   secrets/configs  files from the workspace, mounted as configs with inline content
 *   volume name/external              dropped: a local volume of the stack's own
 */
import fs from 'fs';
import path from 'path';

import { parse, stringify } from 'yaml';

export interface Translated {
  text: string;
  notes: string[];
  errors: string[];
}

/** NanoClaw's own service key for extra names on the stack network (override.ts). */
export const ALIASES_KEY = 'x-nanoclaw-aliases';
const MAX_DEPTH = 5;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

class Ctx {
  notes = new Set<string>();
  errors: string[] = [];
  constructor(readonly root: string) {}
  /** A path inside the workspace, links resolved; null (with an error) otherwise. */
  inside(fromDir: string, p: string, what: string): string | null {
    if (/^[a-z]+:\/\//i.test(p) || p.startsWith('~')) {
      this.errors.push(`${what}: ${p} is not a file in your workspace`);
      return null;
    }
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(fromDir, p));
    } catch {
      this.errors.push(`${what}: ${p} does not exist`);
      return null;
    }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      this.errors.push(`${what}: ${p} is outside your workspace`);
      return null;
    }
    return real;
  }
  read(fromDir: string, p: string, what: string, max = MAX_FILE_BYTES): string | null {
    const real = this.inside(fromDir, p, what);
    if (!real) return null;
    const st = fs.statSync(real);
    if (!st.isFile()) return (this.errors.push(`${what}: ${p} is not a file`), null);
    if (st.size > max) return (this.errors.push(`${what}: ${p} is larger than ${Math.round(max / 1024)} KB`), null);
    return fs.readFileSync(real, 'utf8');
  }
}

/** KEY=value lines (.env, env_file): comments, `export`, and quotes as Compose reads them. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
      const q = v[0];
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

const VAR_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])((?:[^}])*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Fill ${VAR} forms in one string from `env`; `$$` is a literal `$`. */
export function interpolate(s: string, env: Record<string, string>, unset: Set<string>, errors: string[]): string {
  return s.replace(VAR_RE, (all, braced?: string, op?: string, arg?: string, bare?: string) => {
    if (all === '$$') return '$';
    const name = (braced ?? bare)!;
    const v = env[name];
    const empty = v === undefined || (op?.startsWith(':') && v === '');
    switch (op?.replace(':', '')) {
      case '-':
        return empty ? (arg ?? '') : v!;
      case '+':
        return empty ? '' : (arg ?? '');
      case '?':
        if (empty) errors.push(`${name} must be set${arg ? `: ${arg}` : ''} (in the .env next to the Compose file)`);
        return v ?? '';
      default:
        if (v === undefined) unset.add(name);
        return v ?? '';
    }
  });
}

function interpolateAll(v: unknown, env: Record<string, string>, unset: Set<string>, errors: string[]): unknown {
  if (typeof v === 'string') return interpolate(v, env, unset, errors);
  if (Array.isArray(v)) return v.map((x) => interpolateAll(x, env, unset, errors));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolateAll(x, env, unset, errors)]));
  return v;
}

/** One Compose file, interpolated, with `include` merged in. Paths stay relative to `dir`. */
function loadFile(ctx: Ctx, file: string, depth: number, what: string): { doc: Obj; dir: string } | null {
  if (depth > MAX_DEPTH) return (ctx.errors.push(`${what}: include/extends nested too deep`), null);
  const real = ctx.inside(path.dirname(file), path.basename(file), what);
  if (!real) return null;
  const text = ctx.read(path.dirname(real), path.basename(real), what);
  if (text === null) return null;
  return loadText(ctx, text, path.dirname(real), depth, what);
}

function loadText(ctx: Ctx, text: string, dir: string, depth: number, what: string): { doc: Obj; dir: string } | null {
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 50 });
  } catch (err) {
    ctx.errors.push(`${what}: not valid YAML: ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
  if (!isObj(raw)) return (ctx.errors.push(`${what}: not a Compose file`), null);
  const envPath = path.join(dir, '.env');
  const env = fs.existsSync(envPath) ? parseEnvFile(ctx.read(dir, '.env', `${what} .env`) ?? '') : {};
  const unset = new Set<string>();
  const doc = interpolateAll(raw, env, unset, ctx.errors) as Obj;
  if (unset.size) ctx.notes.add(`not set, left empty: ${[...unset].sort().join(', ')} (add them to the .env next to ${what})`);
  rebaseAll(doc, dir, ctx.root);
  const includes = doc.include;
  delete doc.include;
  for (const inc of Array.isArray(includes) ? includes : includes ? [includes] : []) {
    const paths = typeof inc === 'string' ? [inc] : isObj(inc) ? [inc.path].flat() : [];
    for (const p of paths) {
      if (typeof p !== 'string') continue;
      const abs = path.resolve(ctx.root, p);
      const sub = loadFile(ctx, abs, depth + 1, `include ${path.relative(ctx.root, abs)}`);
      if (!sub) continue;
      ctx.notes.add(`included ${path.relative(ctx.root, abs)}`);
      for (const key of ['services', 'volumes', 'configs', 'secrets']) {
        const into = (doc[key] ??= {}) as Obj;
        for (const [n, v] of Object.entries((sub.doc[key] as Obj | undefined) ?? {})) {
          if (n in into) ctx.errors.push(`include ${p}: ${key.slice(0, -1)} ${n} is defined twice`);
          else into[n] = v;
        }
      }
    }
  }
  return { doc, dir };
}

/**
 * Paths in a file are relative to that file; once files are merged they must
 * all mean the same thing, so they are made workspace-relative here (policy.ts
 * and writeFiles resolve them against the workspace).
 */
function rebaseAll(doc: Obj, dir: string, root: string): void {
  const rel = (p: unknown): unknown =>
    typeof p === 'string' && !/^[a-z]+:\/\//i.test(p) && !path.isAbsolute(p) ? path.relative(root, path.resolve(dir, p)) || '.' : p;
  for (const svc of Object.values((doc.services as Obj | undefined) ?? {})) {
    if (!isObj(svc)) continue;
    if (typeof svc.build === 'string') svc.build = rel(svc.build);
    else if (isObj(svc.build)) {
      svc.build.context = rel(svc.build.context ?? '.');
      if (isObj(svc.build.additional_contexts))
        for (const k of Object.keys(svc.build.additional_contexts))
          svc.build.additional_contexts[k] = rel(svc.build.additional_contexts[k]);
    }
    if (svc.env_file !== undefined) {
      const list = Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
      svc.env_file = list.map((e) => (isObj(e) ? { ...e, path: rel(e.path) } : rel(e)));
    }
    if (isObj(svc.extends) && typeof svc.extends.file === 'string') svc.extends.file = rel(svc.extends.file);
  }
  for (const key of ['configs', 'secrets'])
    for (const def of Object.values((doc[key] as Obj | undefined) ?? {}))
      if (isObj(def) && typeof def.file === 'string') def.file = rel(def.file);
  if (Array.isArray(doc.include) || typeof doc.include === 'string' || isObj(doc.include)) {
    const list = Array.isArray(doc.include) ? doc.include : [doc.include];
    doc.include = list.map((i) => (typeof i === 'string' ? rel(i) : isObj(i) ? { ...i, path: [i.path].flat().map(rel) } : i));
  }
}

const NO_INHERIT = new Set(['depends_on', 'links', 'volumes_from', 'extends']);
const MERGE_MAPS = new Set(['environment', 'labels', 'deploy', 'healthcheck', 'build', 'logging']);
const CONCAT = new Set(['ports', 'expose', 'volumes', 'tmpfs', 'dns', 'env_file', 'configs', 'secrets']);

const envMap = (e: unknown): Obj =>
  Array.isArray(e)
    ? Object.fromEntries(
        e.map((x) => {
          const s = String(x);
          const i = s.indexOf('=');
          return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
        }),
      )
    : isObj(e)
      ? e
      : {};

/** A service with `extends` resolved (base first, this service's own settings over it). */
function resolveExtends(ctx: Ctx, name: string, services: Obj, depth = 0): Obj {
  const svc = services[name] as Obj;
  if (!svc.extends) return svc;
  if (depth > MAX_DEPTH) return (ctx.errors.push(`${name}: extends nested too deep`), svc);
  const ext = typeof svc.extends === 'string' ? { service: svc.extends } : (svc.extends as Obj);
  const baseName = String(ext.service ?? '');
  let base: Obj | undefined;
  if (typeof ext.file === 'string') {
    const f = loadFile(ctx, path.resolve(ctx.root, ext.file), depth + 1, `${name}: extends ${ext.file}`);
    const others = (f?.doc.services as Obj | undefined) ?? {};
    if (f && !isObj(others[baseName])) ctx.errors.push(`${name}: extends: no service ${baseName} in ${ext.file}`);
    else if (f) base = resolveExtends(ctx, baseName, others, depth + 1);
  } else if (isObj(services[baseName])) base = resolveExtends(ctx, baseName, services, depth + 1);
  else ctx.errors.push(`${name}: extends: no service ${baseName}`);
  const { extends: _x, ...own } = svc;
  if (!base) return own;
  const out: Obj = {};
  for (const [k, v] of Object.entries(base)) if (!NO_INHERIT.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(own)) {
    if (k === 'environment' && out[k] !== undefined) out[k] = { ...envMap(out[k]), ...envMap(v) };
    else if (MERGE_MAPS.has(k) && isObj(out[k]) && isObj(v)) out[k] = { ...(out[k] as Obj), ...v };
    else if (CONCAT.has(k) && Array.isArray(out[k]) && Array.isArray(v)) out[k] = [...(out[k] as unknown[]), ...v];
    else out[k] = v;
  }
  ctx.notes.add(`${name}: extends ${baseName}${typeof ext.file === 'string' ? ` from ${ext.file}` : ''}`);
  return out;
}

/** The container port of a `ports` entry ("8080:80", "127.0.0.1:8080:80/tcp", {target: 80}). */
function containerPort(p: unknown): string | null {
  if (typeof p === 'number') return String(p);
  if (isObj(p)) return p.target !== undefined ? String(p.target) : null;
  if (typeof p !== 'string') return null;
  const [main, proto] = p.split('/');
  const last = main!.split(':').at(-1)!;
  return /^\d+(-\d+)?$/.test(last) ? `${last}${proto && proto !== 'tcp' ? `/${proto}` : ''}` : null;
}

/** Translate `text` (the Compose file at `composeDir`, inside `groupDir`). */
export function translateCompose(text: string, groupDir: string, composeDir = groupDir): Translated {
  const root = fs.realpathSync(groupDir);
  const ctx = new Ctx(root);
  const loaded = loadText(ctx, text, fs.realpathSync(composeDir), 0, 'the Compose file');
  if (!loaded) return { text, notes: [], errors: ctx.errors };
  const doc = loaded.doc;
  const services = (isObj(doc.services) ? doc.services : {}) as Obj;

  // Top level.
  if (doc.networks !== undefined) {
    delete doc.networks;
    ctx.notes.add('networks dropped: every service is on the stack network');
  }
  for (const [n, v] of Object.entries((doc.volumes as Obj | undefined) ?? {})) {
    if (!isObj(v)) continue;
    if (v.name !== undefined) {
      delete v.name;
      ctx.notes.add(`volume ${n}: name dropped (the stack's own volume)`);
    }
    if (v.external) {
      delete v.external;
      ctx.notes.add(`volume ${n}: external dropped; it starts empty as the stack's own volume`);
    }
    if (v.labels !== undefined) delete v.labels;
  }

  // Configs and secrets from workspace files → configs with inline content.
  const configs: Obj = {};
  const defined = (key: 'configs' | 'secrets'): Obj => (isObj(doc[key]) ? (doc[key] as Obj) : {});
  const mountFile = (key: 'configs' | 'secrets', src: string, where: string): string | null => {
    const def = defined(key)[src];
    if (!isObj(def)) return (ctx.errors.push(`${where}: ${key.slice(0, -1)} ${src} is not defined`), null);
    if (typeof def.file !== 'string') {
      ctx.errors.push(
        `${where}: ${key.slice(0, -1)} ${src} must come from a file in your workspace`,
      );
      return null;
    }
    const content = ctx.read(root, def.file, `${key.slice(0, -1)} ${src}`, MAX_CONFIG_BYTES);
    if (content === null) return null;
    const id = `${key === 'secrets' ? 'secret' : 'config'}-${src}`;
    configs[id] = { content };
    return id;
  };

  for (const name of Object.keys(services)) {
    if (!isObj(services[name])) continue;
    services[name] = resolveExtends(ctx, name, services);
  }
  const aliasesFor = (svc: string): string[] => (((services[svc] as Obj)[ALIASES_KEY] as string[]) ??= []);
  for (const [name, raw] of Object.entries(services)) {
    if (!isObj(raw)) continue;
    const svc = raw;
    if (svc.profiles !== undefined) {
      delete services[name];
      ctx.notes.add(`${name}: left out (it has profiles; Compose leaves such services out by default)`);
      continue;
    }
    if (svc.env_file !== undefined) {
      const env: Obj = {};
      for (const e of Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file]) {
        const p = isObj(e) ? String(e.path ?? '') : String(e);
        const required = isObj(e) ? e.required !== false : true;
        if (!required && !fs.existsSync(path.resolve(root, p))) continue;
        const t = ctx.read(root, p, `${name}: env_file`);
        if (t !== null) Object.assign(env, parseEnvFile(t));
      }
      svc.environment = { ...env, ...envMap(svc.environment) };
      delete svc.env_file;
      ctx.notes.add(`${name}: env_file read into environment`);
    }
    if (svc.ports !== undefined) {
      const ports = (Array.isArray(svc.ports) ? svc.ports : []).map(containerPort).filter((p): p is string => !!p);
      svc.expose = [...new Set([...((svc.expose as unknown[]) ?? []).map(String), ...ports])];
      delete svc.ports;
      if (ports.length)
        ctx.notes.add(`${name}: ports → expose ${ports.join(', ')} (nothing is published on the machine; people reach it through ncl workloads expose)`);
    }
    if (svc.networks !== undefined) {
      if (isObj(svc.networks))
        for (const n of Object.values(svc.networks))
          if (isObj(n) && Array.isArray(n.aliases)) aliasesFor(name).push(...n.aliases.map(String));
      delete svc.networks;
    }
    if (typeof svc.container_name === 'string') {
      if (svc.container_name !== name) aliasesFor(name).push(svc.container_name);
      ctx.notes.add(`${name}: container_name ${svc.container_name} is a name other services can use instead`);
      delete svc.container_name;
    }
    if (svc.links !== undefined) {
      for (const l of Array.isArray(svc.links) ? svc.links : []) {
        const [target, alias] = String(l).split(':');
        if (alias && target && isObj(services[target])) aliasesFor(target).push(alias);
      }
      delete svc.links;
      ctx.notes.add(`${name}: links dropped (services reach each other by name)`);
    }
    for (const key of ['configs', 'secrets'] as const) {
      if (svc[key] === undefined) continue;
      const mounts: Obj[] = [];
      for (const m of Array.isArray(svc[key]) ? (svc[key] as unknown[]) : []) {
        const src = typeof m === 'string' ? m : isObj(m) ? String(m.source ?? '') : '';
        const id = mountFile(key, src, name);
        if (!id) continue;
        const target =
          isObj(m) && typeof m.target === 'string'
            ? m.target.startsWith('/')
              ? m.target
              : key === 'secrets'
                ? `/run/secrets/${m.target}`
                : `/${m.target}`
            : key === 'secrets'
              ? `/run/secrets/${src}`
              : `/${src}`;
        mounts.push({ source: id, target, ...(isObj(m) && m.mode !== undefined ? { mode: m.mode } : {}) });
      }
      delete svc[key];
      if (mounts.length) {
        svc.configs = [...((svc.configs as Obj[] | undefined) ?? []), ...mounts];
        ctx.notes.add(`${name}: ${key} mounted from workspace files`);
      }
    }
  }
  for (const s of Object.values(services))
    if (isObj(s) && Array.isArray(s[ALIASES_KEY])) {
      const a = [...new Set((s[ALIASES_KEY] as string[]).filter((x) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(x)))];
      if (a.length) s[ALIASES_KEY] = a;
      else delete s[ALIASES_KEY];
    }
  delete doc.secrets;
  if (Object.keys(configs).length) doc.configs = configs;
  else delete doc.configs;
  doc.services = services;
  return { text: stringify(doc), notes: [...ctx.notes], errors: ctx.errors };
}
