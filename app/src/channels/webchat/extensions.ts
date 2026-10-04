/**
 * Extension points for optional webchat features that install as skills.
 *
 * A feature that not every install wants (the VS Code runner is the first)
 * lives in its own modules and registers here when imported; webchat's core
 * never imports it. With nothing registered, every point below is inert: no
 * routes, no startup work, no placement, no settings section, and the feature
 * list the UI reads is empty, so the UI keeps the feature's screens hidden.
 *
 * Features are imported from ./extensions-installed.ts, a barrel a skill
 * appends one line to.
 */
import { log } from '../../log.js';
import type { RouteCtx, WebchatServerHooks } from './server.js';

// ── HTTP routes ─────────────────────────────────────────────────────────────

/** An API route, with the same guards and audit semantics as core's table. */
export interface ExtensionRoute {
  method: string | string[];
  /** A string matches url.pathname exactly. */
  path: string | RegExp;
  /** Applied in order before the handler. */
  guards?: Array<'csrf' | 'owner' | 'globalAdmin' | 'anyAdmin'>;
  h: (ctx: RouteCtx, m: RegExpMatchArray) => void | Promise<void>;
  /** Record the call in the audit log under this dotted kind. */
  audit?: string;
}

const routes: ExtensionRoute[] = [];

/** Add routes, consulted after core's own table (core wins on an overlap). */
export function registerRoutes(add: ExtensionRoute[]): void {
  routes.push(...add);
}

export function extensionRoutes(): readonly ExtensionRoute[] {
  return routes;
}

// ── Startup ─────────────────────────────────────────────────────────────────

export interface ServerStartContext {
  /** Where an extension hands a chat message it received. */
  chatInbound: WebchatServerHooks['onInbound'];
}

const serverStarts: Array<(ctx: ServerStartContext) => void> = [];
const channelStarts: Array<() => void> = [];

/** Run once the HTTP server and the chat WebSocket exist, before it listens. */
export function onServerStart(fn: (ctx: ServerStartContext) => void): void {
  serverStarts.push(fn);
}

/** Run once the webchat channel has set up its own background services. */
export function onChannelStart(fn: () => void): void {
  channelStarts.push(fn);
}

// One extension failing to start must not take the others, or webchat, down.
export function runServerStart(ctx: ServerStartContext): void {
  for (const fn of serverStarts) {
    try {
      fn(ctx);
    } catch (err) {
      log.error('Webchat extension failed to start', { err });
    }
  }
}

export function runChannelStart(): void {
  for (const fn of channelStarts) {
    try {
      fn();
    } catch (err) {
      log.error('Webchat extension failed to start its channel services', { err });
    }
  }
}

// ── Sign-in settings sections ───────────────────────────────────────────────

const signinSections = new Map<string, () => Promise<Record<string, unknown>>>();

/** Contribute a named, read-only section to the Admin → Sign-in view. */
export function registerSigninSection(key: string, view: () => Promise<Record<string, unknown>>): void {
  signinSections.set(key, view);
}

export async function extensionSigninSections(): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, view] of signinSections) out[key] = await view();
  return out;
}

// ── Installed features ──────────────────────────────────────────────────────

const features = new Set<string>();

/** Name an installed feature, so the UI shows its screens. */
export function registerFeature(name: string): void {
  features.add(name);
}

export function installedFeatures(): string[] {
  return [...features].sort();
}
