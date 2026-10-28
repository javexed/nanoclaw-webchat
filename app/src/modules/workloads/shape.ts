/**
 * What a stack runs, as an owner approves it. Per service: the image and the
 * digest it pointed at when the card was made, or for a build its folder, a
 * hash of the Dockerfile's text and a hash of its build args; and the
 * capabilities it adds back. A redeploy whose shape differs needs a new card;
 * code inside a build folder may change freely, the Dockerfile and args may not.
 *
 * Image services run the approved digest, not the tag: a tag that moves
 * upstream changes nothing here until the next card.
 */
import { createHash } from 'crypto';
import path from 'path';

import { quoteForCard } from '../../card-text.js';
import { isPlainFile, readNoFollow } from '../../no-follow-fs.js';
import type { CheckedStack } from './policy.js';

const sha = (v: string): string => createHash('sha256').update(v).digest('hex');

export interface ServiceShape {
  /** One line, hashed into the stack's shape. */
  line: string;
  /** For the card, in words; every untrusted value quoted. */
  text: string;
  ref?: string;
  digest?: string;
  /** sha256 of the Dockerfile's text. */
  dockerfile?: string;
  /** sha256 of the build args (sorted). */
  args?: string;
}

export interface StackShape {
  services: Record<string, ServiceShape>;
  lines: string[];
  /** What an owner approves. */
  hash: string;
}

export interface Approved {
  hash: string | null;
  services: Record<string, Omit<ServiceShape, 'text'>>;
}

/** Build args as a sorted list of NAME=value, whatever form Compose had them in. Pure. */
export function normalizeArgs(args: unknown): string[] {
  if (!args) return [];
  const pairs = Array.isArray(args)
    ? args.map((a) => {
        const s = String(a);
        const i = s.indexOf('=');
        return i < 0 ? `${s}=` : s;
      })
    : Object.entries(args as Record<string, unknown>).map(
        ([k, v]) => `${k}=${v === null || v === undefined ? '' : String(v)}`,
      );
  return [...pairs].sort();
}

export const hashArgs = (args: unknown): string => sha(JSON.stringify(normalizeArgs(args)));
export const hashText = (text: string): string => sha(text);

/** Where a build service's Dockerfile sits, relative to its context. */
export const dockerfileOf = (b: Record<string, unknown>): string => String(b.dockerfile ?? 'Dockerfile');

const buildOf = (svc: Record<string, unknown>): Record<string, unknown> =>
  typeof svc.build === 'string' ? { context: svc.build } : (svc.build as Record<string, unknown>);

/** The FROM lines of a Dockerfile, for the card. Pure. */
export function fromLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => /^\s*FROM\s+(.+?)\s*$/i.exec(l)?.[1])
    .filter((x): x is string => Boolean(x))
    .slice(0, 4);
}

/**
 * The shape of a checked stack. `resolve` gives an image reference's digest
 * (docker.ts resolveDigest); a service whose reference is unchanged since
 * `approved` keeps its approved digest without asking the registry.
 */
export async function stackShape(
  dir: string,
  stack: CheckedStack,
  resolve: (ref: string) => Promise<string>,
  approved: Approved | null = null,
): Promise<StackShape> {
  const services: Record<string, ServiceShape> = {};
  const lines: string[] = [];
  for (const name of Object.keys(stack.compose.services).sort()) {
    const svc = stack.compose.services[name];
    const caps = Array.isArray(svc.cap_add) && svc.cap_add.length ? (svc.cap_add as string[]) : [];
    const capLine = caps.length ? `, cap_add ${caps.join(',')}` : '';
    const capText = caps.length ? `; adds ${caps.join(', ')}` : '';
    if (svc.build === undefined) {
      const ref = String(svc.image);
      const before = approved?.services[name];
      const digest = before?.ref === ref && before.digest ? before.digest : await resolve(ref);
      const line = `${name}: image ${ref} ${digest}${capLine}`;
      lines.push(line);
      services[name] = {
        line,
        text: `${quoteForCard(ref)} (${digest.slice(0, 19)}…)${capText}`,
        ref,
        digest,
      };
      continue;
    }
    const b = buildOf(svc);
    const ctx = String(b.context ?? '.');
    const dfRel = path.join(ctx, dockerfileOf(b));
    const text = isPlainFile(dir, dfRel) ? readNoFollow(dir, dfRel) : null;
    if (text === null)
      throw new Error(`${name}: no Dockerfile at ${dfRel} (it must be a plain file in your workspace)`);
    const dockerfile = hashText(text);
    const args = hashArgs(b.args);
    const argNames = normalizeArgs(b.args).map((a) => a.slice(0, a.indexOf('=')));
    const target = b.target ? ` target ${String(b.target)}` : '';
    const line = `${name}: build ${ctx}${target}, Dockerfile ${dockerfile}, args ${args}${capLine}`;
    lines.push(line);
    const froms = fromLines(text);
    services[name] = {
      line,
      text:
        `built from ${quoteForCard(ctx)}${b.target ? ` (stage ${quoteForCard(String(b.target))})` : ''}` +
        `, Dockerfile ${dockerfile.slice(0, 12)}` +
        (froms.length ? ` FROM ${froms.map((f) => quoteForCard(f)).join(', ')}` : '') +
        (argNames.length
          ? `; build args ${argNames.map((a) => quoteForCard(a)).join(', ')} (${args.slice(0, 12)})`
          : '') +
        capText,
      dockerfile,
      args,
    };
  }
  return { services, lines, hash: sha(lines.join('\n')).slice(0, 32) };
}

/** What is stored as approved: the hash, and per service what the next deploy is held to. */
export function encodeApproved(s: StackShape): string {
  return JSON.stringify({
    hash: s.hash,
    services: Object.fromEntries(
      Object.entries(s.services).map(([n, v]) => {
        const { text: _t, ...rest } = v;
        return [n, rest];
      }),
    ),
  });
}

export function decodeApproved(v: string | null): Approved | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as Partial<Approved>;
    return { hash: o.hash ?? null, services: o.services ?? {} };
  } catch {
    return null;
  }
}

/** The card's list of services: each in words, marked new or changed against what was approved. */
export function describeShape(shape: StackShape, approved: Approved | null): string[] {
  const before = approved?.services ?? {};
  const known = approved !== null && Object.keys(before).length > 0;
  const out = Object.entries(shape.services).map(([name, s]) => {
    const mark = !known ? '' : before[name] === undefined ? ' (new)' : before[name].line !== s.line ? ' (changed)' : '';
    return `• ${name}: ${s.text}${mark}`;
  });
  for (const name of Object.keys(before)) if (known && !shape.services[name]) out.push(`• ${name}: removed`);
  return out;
}
