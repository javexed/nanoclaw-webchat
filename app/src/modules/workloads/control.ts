/**
 * The rules around a workload's life. Callers: `ncl workloads …` (cli.ts) and
 * the reconcile loop. The agent's quota covers ALL its stacks together; a
 * stack's approved size and shape are what an owner's card agreed to, and a
 * redeploy within them needs no new card.
 */
import fs from 'fs';
import path from 'path';

import { audit } from '../../audit.js';
import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { isPlainFile, readNoFollow } from '../../no-follow-fs.js';
import { availableOn, getMember, isolationRefusal } from '../machines/members.js';
import { backupWorkload, listBackups, restoreVolumes, type Backup } from './backup.js';
import { buildImage, ensureBuilder, removeBuilder } from './builder.js';
import { assertDiskRoom } from './disk.js';
import {
  builtImageName,
  compose,
  copyBuildContext,
  ensureNetwork,
  foreignIndexes,
  joinAgentContainers,
  LOCAL_NODE,
  networkName,
  pinRef,
  plainSegments,
  pruneOldImages,
  pulledImageName,
  pullHere,
  refuseReservedImageLabels,
  removeWorkloadFiles,
  resolveDigest,
  sha256,
  shipImage,
  sizeWorkerSlice,
  sliceStatus,
  tagHere,
  workDir,
  writeFiles,
} from './docker.js';
import { MAX_NETWORKS, serviceAddresses, subnetFor } from './override.js';
import { placeWorkload, workerRooms, type Placement } from './placement.js';
import { checkStack, type CheckedStack } from './policy.js';
import { requireWorkloads } from './preflight.js';
import { confinedBuildsOn } from './settings.js';
import { wakeWorkload } from './sleep.js';
import { translateCompose } from './translate.js';
import {
  decodeApproved,
  dockerfileOf,
  encodeApproved,
  hashArgs,
  hashText,
  stackShape,
  type Approved,
  type StackShape,
} from './shape.js';
import {
  buildsSince,
  claimNetwork,
  findWorkload,
  insertWorkload,
  listWorkloads,
  noteBuild,
  quotaFor,
  updateWorkload,
  type Workload,
} from './store.js';

export const WORKLOAD_NAME_RE = /^[a-z][a-z0-9-]{0,28}[a-z0-9]$/;
/** A first deploy runs this long; Extend makes it this long from today again. */
export const DEFAULT_DAYS = 30;
const actor = (g: string): string => `agent:${g}`;

/** How image references become digests; tests swap it. */
let resolver: (ref: string) => Promise<string> = resolveDigest;
export function __setResolverForTest(fn: ((ref: string) => Promise<string>) | null): void {
  resolver = fn ?? resolveDigest;
}

async function groupDir(agentGroupId: string): Promise<string> {
  const g = await getAgentGroup(agentGroupId);
  if (!g) throw new Error('unknown agent');
  const dir = path.join(GROUPS_DIR, g.folder);
  if (!fs.existsSync(dir)) throw new Error('this agent has no workspace folder yet');
  return dir;
}

const relOf = (file: string): string => file.replace(/^\/workspace\/agent\//, '').replace(/^\.\//, '');

/** The Compose file named by the agent, read from its own folder without following links. */
function readCompose(dir: string, file: string): string {
  const rel = relOf(file);
  if (path.isAbsolute(rel) || rel.split(/[/\\]/).includes('..'))
    throw new Error('the Compose file must be in your workspace');
  if (!isPlainFile(dir, rel)) throw new Error(`no file ${file} in your workspace`);
  const text = readNoFollow(dir, rel);
  if (text === null) throw new Error(`cannot read ${file}`);
  if (text.length > 256_000) throw new Error('the Compose file is too large');
  return text;
}

const hasBuild = (stack: CheckedStack): boolean =>
  Object.values(stack.compose.services).some((svc) => svc.build !== undefined);

export interface Checked {
  text: string;
  stack: CheckedStack;
  existing: Workload | null;
  shape: StackShape;
  composeHash: string;
  /** Where it runs: a new stack is placed now (placement.ts); an existing one stays put. */
  placement: Placement;
  /** What was translated to fit (translate.ts), for the agent and the card. */
  translated: string[];
}

/**
 * Check a stack against the policy, what is left of the agent's quota
 * (excluding the stack being replaced) and its node's ceiling, and work out
 * its shape: image services resolve to digests here, unless their reference is
 * unchanged since `approved` (then the approved digest stands).
 */
export async function checkWorkload(
  agentGroupId: string,
  name: string,
  file: string,
  approved: Approved | null = null,
): Promise<Checked> {
  if (!WORKLOAD_NAME_RE.test(name))
    throw new Error('name must be 2–30 lowercase letters, digits and hyphens, starting with a letter');
  requireWorkloads();
  const dir = await groupDir(agentGroupId);
  const text = readCompose(dir, file);
  const existing = await findWorkload(agentGroupId, name);
  const quota = await quotaFor(agentGroupId);
  assertDiskRoom(agentGroupId, quota.diskGb);
  const others = (await listWorkloads({ agentGroupId })).filter((w) => w.id !== existing?.id);
  const usedMem = others.reduce((a, w) => a + w.approvedMemoryMb, 0);
  const usedCpu = others.reduce((a, w) => a + w.approvedCpus, 0);
  // A project's own Compose file: the safe parts translated first (translate.ts); paths are workspace-relative after.
  const t = translateCompose(text, dir, path.dirname(path.join(dir, relOf(file))));
  if (t.errors.length) throw new Error(`the stack was refused:\n- ${t.errors.join('\n- ')}`);
  const r = checkStack(
    t.text,
    dir,
    { memoryMb: quota.memoryMb - usedMem, cpus: quota.cpus - usedCpu },
    { composeDir: dir, allowBuild: confinedBuildsOn() },
  );
  if (!r.ok) throw new Error(`the stack was refused:\n- ${r.errors.join('\n- ')}`);
  // A workload stays where it was placed; a new one is placed now (placement.ts).
  const placement: Placement = existing
    ? { node: existing.node, reason: existing.placementReason ?? '' }
    : await placeWorkload(agentGroupId, r.stack.total);
  if (placement.node === LOCAL_NODE) {
    const slice = await sliceStatus();
    if (!slice.ok) throw new Error(slice.reason);
    // The node's ceiling across every agent.
    const all = (await listWorkloads()).filter((w) => w.id !== existing?.id && w.node === LOCAL_NODE);
    const nodeMem = all.reduce((a, w) => a + w.approvedMemoryMb, 0) + r.stack.total.memoryMb;
    if (nodeMem > slice.memoryMaxMb)
      throw new Error(
        `this host's workload memory (${slice.memoryMaxMb} MB) would be exceeded (${nodeMem} MB); ask an owner`,
      );
  } else if (existing) {
    const m = await getMember(existing.node);
    const refused = m ? isolationRefusal(m) : null;
    if (refused) throw new Error(`${name} runs on a worker, and ${refused}; ask an owner`);
    const room = (await workerRooms(undefined, existing.id, { draining: true })).find(
      (x) => x.machine.id === existing.node,
    );
    if (!room)
      throw new Error(`${name} runs on a worker that is not connected now (${existing.node}); try again later`);
    if (room.freeMemMb < r.stack.total.memoryMb)
      throw new Error(
        `${name}'s worker ${room.machine.name} has ${room.freeMemMb} MB free for it, and this asks for ${r.stack.total.memoryMb} MB`,
      );
  }
  const shape = await stackShape(dir, r.stack, resolver, approved);
  // The pin covers what runs: the translated file, so an included file or .env changed later needs a new card.
  return {
    text,
    stack: r.stack,
    existing,
    shape,
    composeHash: sha256(t.text).slice(0, 32),
    placement,
    translated: t.notes,
  };
}

/** What an approval card pins for `up`: this exact Compose file and shape (digests, Dockerfiles, args). */
export const approvalPin = (c: Pick<Checked, 'composeHash' | 'shape'>): string => `${c.composeHash}:${c.shape.hash}`;

/** Builds an agent may start without a card in an hour (redeploy, start): each one costs CPU and disk. */
export const UNAPPROVED_BUILDS_PER_HOUR = 20;
const HOUR = 3_600_000;

/** Count an unapproved build; throws past the hourly limit. Kept in the database, so a restart does not reset it. */
export async function noteUnapprovedBuild(agentGroupId: string, now = Date.now()): Promise<void> {
  if ((await buildsSince(agentGroupId, now - HOUR)) >= UNAPPROVED_BUILDS_PER_HOUR)
    throw new Error(
      `${UNAPPROVED_BUILDS_PER_HOUR} builds in the last hour: wait, or batch your changes into one redeploy`,
    );
  await noteBuild(agentGroupId, now, now - HOUR);
}

/**
 * Would `redeploy` take this as it is? Same shape as approved (images by
 * digest, Dockerfiles, build args, capabilities), no more memory/CPU than
 * approved, and builds left this hour. Then `up` needs no card.
 */
export async function withinApproval(
  agentGroupId: string,
  c: Pick<Checked, 'stack' | 'existing' | 'shape'>,
  now = Date.now(),
): Promise<boolean> {
  const w = c.existing;
  if (!w || c.shape.hash !== decodeApproved(w.approvedShape)?.hash) return false;
  if (c.stack.total.memoryMb > w.approvedMemoryMb || c.stack.total.cpus > w.approvedCpus) return false;
  if (!hasBuild(c.stack)) return true;
  return (await buildsSince(agentGroupId, now - HOUR)) < UNAPPROVED_BUILDS_PER_HOUR;
}

/** The image each service runs: a pulled one by its approved digest, a built one under NanoClaw's name. */
export function serviceImages(w: Workload): Record<string, string> {
  const approved = decodeApproved(w.approvedShape);
  const out: Record<string, string> = {};
  for (const [name, svc] of Object.entries(w.stack.compose.services)) {
    if (svc.build !== undefined) out[name] = builtImageName(w, name);
    else {
      const a = approved?.services[name];
      if (a?.digest && a.ref === svc.image) out[name] = pinRef(String(svc.image), a.digest);
    }
  }
  return out;
}

/**
 * Build one service from a fresh copy of its context. The Dockerfile is
 * hashed again INSIDE the copy, and the build args from the stored stack,
 * right before the build: both must be what the owner approved, whatever
 * happened to the agent's folder since the card.
 */
async function buildService(
  w: Workload,
  dir: string,
  name: string,
  approved: Approved,
  builder: Awaited<ReturnType<typeof ensureBuilder>>,
): Promise<void> {
  const svc = w.stack.compose.services[name];
  const b = typeof svc.build === 'string' ? { context: svc.build } : (svc.build as Record<string, unknown>);
  const want = approved.services[name];
  if (!want?.dockerfile || !want.args) throw new Error(`${name}: its build was never approved`);
  const context = await copyBuildContext(dir, String(b.context ?? '.'), path.join(workDir(w.id), 'build', name));
  const dfRel = plainSegments(dockerfileOf(b), 'build.dockerfile').join('/');
  const df = path.join(context, dfRel);
  const st = fs.lstatSync(df, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new Error(`${name}: the Dockerfile must be a plain file`);
  if (hashText(fs.readFileSync(df, 'utf-8')) !== want.dockerfile)
    throw new Error(`${name}: the Dockerfile changed since the approval: run \`ncl workloads up\` for a new card`);
  if (hashArgs(b.args) !== want.args)
    throw new Error(`${name}: the build args changed since the approval: run \`ncl workloads up\` for a new card`);
  await buildImage(
    builder,
    { context, dockerfile: dfRel, target: b.target ? String(b.target) : undefined, args: b.args },
    builtImageName(w, name),
    path.join(workDir(w.id), 'image', name),
  );
}

/**
 * The images a stack on a worker runs, sent from here: each pulled image by
 * its approved digest, then tagged under NanoClaw's name (pulledImageName;
 * `docker save` keeps tags, not digests), and each built one under its own.
 * The worker never pulls from a registry or builds (worker-main.ts).
 */
async function shipImages(
  w: Workload,
  images: Record<string, string>,
  builds: string[],
): Promise<Record<string, string>> {
  const sent: Record<string, string> = {};
  for (const [name, ref] of Object.entries(images)) {
    if (builds.includes(name)) sent[name] = ref;
    else {
      await pullHere(ref);
      sent[name] = pulledImageName(w, name);
      await tagHere(ref, sent[name]);
    }
  }
  // Checked here, before anything is sent: the labels are what the image carries.
  await refuseReservedImageLabels(Object.values(sent));
  for (const image of new Set(Object.values(sent))) await shipImage(w.node, image);
  return sent;
}

async function deploy(w: Workload, agentGroupId: string): Promise<Workload> {
  requireWorkloads();
  const approved = decodeApproved(w.approvedShape);
  if (!approved) throw new Error(`${w.name} has no approval on record: run \`ncl workloads up\``);
  const remote = w.node !== LOCAL_NODE;
  if (remote) {
    const m = await getMember(w.node);
    if (!m) throw new Error(`${w.name}'s worker is gone (${w.node}); ask an owner`);
    // Never start anything on a worker a workload could break out of to the machine itself.
    const refused = isolationRefusal(m);
    if (refused) throw new Error(`${w.name} runs on a worker, and ${refused}; ask an owner`);
    await sizeWorkerSlice(w.node, availableOn(m));
  }
  const net = await claimNetwork(agentGroupId, networkName, MAX_NETWORKS, await foreignIndexes(w.node));
  const network = await ensureNetwork(net.idx, w.node);
  const taken = (await listWorkloads({ agentGroupId }))
    .filter((o) => o.id !== w.id)
    .flatMap((o) => Object.values(o.addresses));
  const addresses = serviceAddresses(
    subnetFor(net.idx).prefix,
    Object.keys(w.stack.compose.services),
    w.addresses,
    taken,
  );
  w = await updateWorkload(w.id, { addresses, state: 'deploying', lastError: null, asleepAt: null });
  try {
    const builds = Object.keys(w.stack.compose.services).filter((n) => w.stack.compose.services[n].build !== undefined);
    if (builds.length) {
      if (!confinedBuildsOn())
        throw new Error(
          'builds are off on this host (an owner can turn on confined builds in Admin → Publishing); use a published image',
        );
      const dir = await groupDir(agentGroupId);
      const builder = await ensureBuilder(agentGroupId);
      for (const name of builds) await buildService(w, dir, name, approved, builder);
    }
    const images = serviceImages(w);
    if (remote) writeFiles(w, network, await shipImages(w, images, builds));
    else {
      writeFiles(w, network, images);
      const pulled = Object.keys(w.stack.compose.services).filter((n) => !builds.includes(n));
      if (pulled.length) await compose(w, ['pull', '--quiet', ...pulled], 1_200_000);
      // An image may not carry NanoClaw's labels (they mark agent containers), whatever its Dockerfile says.
      await refuseReservedImageLabels(Object.values(images));
    }
    await compose(w, ['up', '-d', '--remove-orphans', '--no-build', '--pull', 'never'], 600_000);
    await pruneOldImages(w);
  } catch (err) {
    audit({ type: 'workload.deploy', actor: actor(agentGroupId), effect: 'failed', detail: { workload: w.id } });
    return updateWorkload(w.id, { state: 'failed', lastError: String((err as Error).message ?? err).slice(-2000) });
  }
  // On a worker the agent reaches its stack through its proxy over the link (index.ts).
  if (!remote) await joinAgentContainers(agentGroupId, network).catch(() => 0);
  audit({
    type: 'workload.deploy',
    actor: actor(agentGroupId),
    effect: 'allow',
    detail: { workload: w.id, memoryMb: w.memoryMb, shape: approved.hash, node: w.node },
  });
  return updateWorkload(w.id, { state: 'running' });
}

/**
 * First deploy, or a different shape or a bigger size: held for an owner's
 * card by the CLI, whose precheck pinned `approved`. Records the approval.
 * From the host (an operator) there is no card and no pin.
 */
export async function upWorkload(
  agentGroupId: string,
  name: string,
  file: string,
  createdBy: string | null,
  approved?: string,
): Promise<Workload> {
  // A card asks the registries afresh: an owner approving `up` approves today's digests.
  const checked = await checkWorkload(agentGroupId, name, file);
  const { text, stack, existing, shape, placement } = checked;
  // From a card: the stack must still be the one the owner saw (file, digests, Dockerfiles, args).
  if (approved !== undefined && approved !== approvalPin(checked))
    throw new Error(
      `${file}, its images or its Dockerfiles changed after the approval: run \`ncl workloads up\` again for a new card`,
    );
  const w = existing
    ? await updateWorkload(existing.id, {
        composeText: text,
        stack,
        approvedMemoryMb: stack.total.memoryMb,
        approvedCpus: stack.total.cpus,
        approvedShape: encodeApproved(shape),
      })
    : await insertWorkload({
        agentGroupId,
        name,
        composeText: text,
        stack,
        addresses: {},
        expiresAt: Date.now() + DEFAULT_DAYS * 86_400_000,
        createdBy,
        approvedShape: encodeApproved(shape),
      }).then((n) => updateWorkload(n.id, { node: placement.node, placementReason: placement.reason }));
  if (!existing) log.info('Workload placed', { workloadId: w.id, node: placement.node, reason: placement.reason });
  return deploy(w, agentGroupId);
}

/** A change within the approved size and shape: no card. */
export async function redeployWorkload(agentGroupId: string, name: string, file: string): Promise<Workload> {
  const existing = await findWorkload(agentGroupId, name);
  if (!existing)
    throw new Error(`no workload "${name}" yet: the first deploy is \`ncl workloads up\` (needs an approval)`);
  const approved = decodeApproved(existing.approvedShape);
  const { text, stack, shape } = await checkWorkload(agentGroupId, name, file, approved);
  if (!approved || shape.hash !== approved.hash)
    throw new Error(
      `the images, Dockerfiles, build args or capabilities changed since the approval: use \`ncl workloads up\` (needs an approval)`,
    );
  if (stack.total.memoryMb > existing.approvedMemoryMb || stack.total.cpus > existing.approvedCpus)
    throw new Error(
      `this asks for ${stack.total.memoryMb} MB / ${stack.total.cpus} CPUs, more than the approved ${existing.approvedMemoryMb} MB / ${existing.approvedCpus}: use \`ncl workloads up\` (needs an approval)`,
    );
  if (hasBuild(stack)) await noteUnapprovedBuild(agentGroupId);
  return deploy(await updateWorkload(existing.id, { composeText: text, stack }), agentGroupId);
}

/**
 * Deploy the stack as it is on record again: what an admin's Redeploy in
 * Agent → Apps runs. Builds are rebuilt from the agent's current folder,
 * held to the approved Dockerfiles and args like any start, so no card.
 */
export async function redeployApproved(agentGroupId: string, name: string): Promise<Workload> {
  const w = await own(agentGroupId, name);
  requireWorkloads();
  assertDiskRoom(agentGroupId, (await quotaFor(agentGroupId)).diskGb);
  if (hasBuild(w.stack)) await noteUnapprovedBuild(agentGroupId);
  return deploy(w, agentGroupId);
}

/**
 * Keep a workload for DEFAULT_DAYS from now. It never shortens one, and it
 * never stacks up past that: extending is keeping what was approved, not
 * approving more. A workload without an expiry stays without one.
 */
export async function extendWorkload(
  agentGroupId: string,
  name: string,
  by: string,
  now = Date.now(),
): Promise<Workload> {
  const w = await own(agentGroupId, name);
  if (w.expiresAt === null) return w;
  const expiresAt = Math.max(w.expiresAt, now + DEFAULT_DAYS * 86_400_000);
  if (expiresAt === w.expiresAt) return w;
  audit({
    type: 'workload.extend',
    actor: by,
    effect: 'allow',
    detail: { workload: w.id, from: w.expiresAt, to: expiresAt },
  });
  return updateWorkload(w.id, { expiresAt });
}

async function own(agentGroupId: string, name: string): Promise<Workload> {
  const w = await findWorkload(agentGroupId, name);
  if (!w) throw new Error(`you have no workload named "${name}"`);
  return w;
}

export async function psWorkload(agentGroupId: string, name: string): Promise<unknown> {
  const w = await own(agentGroupId, name);
  const out = await compose(w, ['ps', '--all', '--format', 'json'], 60_000);
  return parsePs(out).map((r) => ({
    service: r.Service,
    state: r.State,
    status: r.Status,
    address: w.addresses[String(r.Service)] ?? null,
  }));
}

/** `compose ps --format json` rows (one JSON object per line, or one array). Pure. */
export function parsePs(out: string): Array<Record<string, unknown>> {
  const t = out.trim();
  if (t.startsWith('[')) {
    try {
      return JSON.parse(t) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }
  return t
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

export async function logsWorkload(agentGroupId: string, name: string, service?: string, tail = 200): Promise<string> {
  const w = await own(agentGroupId, name);
  if (service && !w.stack.compose.services[service]) throw new Error(`no service "${service}" in ${name}`);
  return compose(
    w,
    ['logs', '--no-color', '--tail', String(Math.min(Math.max(tail, 1), 2000)), ...(service ? [service] : [])],
    60_000,
  );
}

export async function execWorkload(
  agentGroupId: string,
  name: string,
  service: string,
  command: string[],
): Promise<string> {
  const w = await own(agentGroupId, name);
  if (!w.stack.compose.services[service]) throw new Error(`no service "${service}" in ${name}`);
  if (!command.length) throw new Error('nothing to run');
  if (w.state === 'stopped' && w.asleepAt !== null) await wakeWorkload(w.id);
  return compose(w, ['exec', '-T', service, ...command], 120_000);
}

export async function stopWorkload(agentGroupId: string, name: string, reason = 'requested'): Promise<Workload> {
  const w = await own(agentGroupId, name);
  await compose(w, ['stop'], 300_000);
  audit({
    type: reason === 'requested' ? 'workload.stop' : 'workload.autostop',
    actor: actor(agentGroupId),
    effect: 'allow',
    reason,
    detail: { workload: w.id },
  });
  return updateWorkload(w.id, {
    state: 'stopped',
    asleepAt: null,
    ...(reason === 'requested' ? {} : { lastError: `stopped: ${reason}` }),
  });
}

export async function startWorkload(agentGroupId: string, name: string): Promise<Workload> {
  const w = await own(agentGroupId, name);
  if (w.state !== 'stopped' && w.state !== 'failed') return w;
  // Asleep: its containers are there, so a start is enough (no rebuild).
  if (w.state === 'stopped' && w.asleepAt !== null) {
    await wakeWorkload(w.id);
    return own(agentGroupId, name);
  }
  requireWorkloads();
  assertDiskRoom(agentGroupId, (await quotaFor(agentGroupId)).diskGb);
  if (hasBuild(w.stack)) await noteUnapprovedBuild(agentGroupId);
  // deploy() holds every build to the approved Dockerfile and args, and every image to its approved digest.
  return deploy(w, agentGroupId);
}

/** Remove the containers, keep the data. */
export async function downWorkload(agentGroupId: string, name: string): Promise<Workload> {
  const w = await own(agentGroupId, name);
  await compose(w, ['down', '--remove-orphans'], 300_000);
  audit({ type: 'workload.down', actor: actor(agentGroupId), effect: 'allow', detail: { workload: w.id } });
  return updateWorkload(w.id, { state: 'stopped', asleepAt: null });
}

/** Remove containers AND volumes. Held for an owner's card by the CLI. */
export async function deleteWorkload(agentGroupId: string, name: string): Promise<Workload> {
  const w = await own(agentGroupId, name);
  if (fs.existsSync(path.join(workDir(w.id), 'stack.yml')))
    await compose(w, ['down', '--volumes', '--remove-orphans', '--rmi', 'local'], 300_000).catch((err) => {
      throw new Error(`could not remove ${name}: ${String((err as Error).message).slice(-500)}`);
    });
  await removeWorkloadFiles(w);
  audit({ type: 'workload.delete', actor: actor(agentGroupId), effect: 'allow', detail: { workload: w.id } });
  const gone = await updateWorkload(w.id, { state: 'deleted' });
  if (!(await listWorkloads({ agentGroupId })).length) await removeBuilder(agentGroupId);
  return gone;
}

export async function backupsOf(agentGroupId: string, name: string): Promise<Backup[]> {
  return listBackups((await own(agentGroupId, name)).id);
}

export async function backupNow(agentGroupId: string, name: string): Promise<Backup> {
  const w = await own(agentGroupId, name);
  const b = await backupWorkload(w);
  if (!b) throw new Error(`${name} has no volumes to back up`);
  audit({
    type: 'workload.backup',
    actor: actor(agentGroupId),
    effect: 'allow',
    detail: { workload: w.id, stamp: b.stamp },
  });
  return b;
}

/** Put a backup's volumes back. Held for an owner's card by the CLI: it replaces live data. */
export async function restoreWorkload(agentGroupId: string, name: string, stamp: string): Promise<Workload> {
  const w = await own(agentGroupId, name);
  if (!listBackups(w.id).some((b) => b.stamp === stamp))
    throw new Error(`no backup ${stamp} of ${name}: see \`ncl workloads backups\``);
  const wasRunning = w.state === 'running';
  if (wasRunning) await compose(w, ['stop'], 300_000);
  try {
    await restoreVolumes(w, stamp);
  } finally {
    if (wasRunning) await compose(w, ['start'], 300_000).catch(() => undefined);
  }
  audit({ type: 'workload.restore', actor: actor(agentGroupId), effect: 'allow', detail: { workload: w.id, stamp } });
  return w;
}
