import { arch, hostname, platform, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import { RunnerAgent, type AgentPolicy, type ImagePolicy } from './agent.js';
import { realCli, type Cli } from './docker.js';
import { DEFAULT_WORKSPACE_EXCLUDES, effectiveSlots, type WorkspaceMount } from './policy.js';
import { planUpdate, type AutoUpdate, type UpdateOffer } from './update.js';
import { userSetting } from './settings.js';
import { apiUrl } from './chat-render.js';
import { ReviewController } from './review-controller.js';
import { ChatViewProvider } from './chat-view.js';
import type { Runtime } from './realize.js';
import { RunnerLink, parseOffer, type LinkState } from './link.js';
import { scopesFor, secureOrigin, type Machine, authHeader } from './protocol.js';
import {
  CLIENT_KEYS,
  parseConnectQuery,
  resolveClientConfig,
  sanitizeClientConfig,
  type ClientConfig,
} from './client-config.js';

const AUTH_PROVIDER = 'microsoft';
let link: RunnerLink | null = null;
let chat: ChatViewProvider | null = null;
let agent: RunnerAgent | null = null;
let storageRoot = '';
let lastState: LinkState = 'disconnected';
let status: vscode.StatusBarItem;
let out: vscode.OutputChannel;
let globalState: vscode.Memento | undefined;
const CENTRAL_CONFIG = 'nanoclaw.centralClientConfig';

function log(line: string): void {
  out.appendLine(`[${new Date().toISOString()}] ${line}`);
}
/** The sign-in settings the user set themselves (user settings only); unset ones fall back to central's. */
function ownClientConfig(c: vscode.WorkspaceConfiguration): ClientConfig {
  const own: Record<string, unknown> = {};
  for (const k of CLIENT_KEYS) {
    const v = userSetting(c, k, '');
    if (v.trim()) own[k] = v.trim();
  }
  return own as ClientConfig;
}
/** Central's sign-in settings, remembered for the server they came from. */
function centralClientConfig(serverUrl: string): ClientConfig {
  const saved = globalState?.get<{ serverUrl: string; config: ClientConfig }>(CENTRAL_CONFIG);
  return saved?.serverUrl === serverUrl ? saved.config : {};
}
function cfg() {
  const c = vscode.workspace.getConfiguration('nanoclaw');
  // Everything but autoConnect comes from user settings only (see settings.ts).
  const serverUrl = userSetting(c, 'serverUrl', '').trim().replace(/\/$/, '');
  return {
    serverUrl,
    ...resolveClientConfig(ownClientConfig(c), centralClientConfig(serverUrl)),
    autoConnect: c.get<boolean>('autoConnect') ?? true,
    containerRuntime: userSetting(c, 'containerRuntime', 'auto') as 'auto' | Runtime,
    runtimePath: userSetting(c, 'runtimePath', '').trim(),
    agentImage: userSetting(c, 'agentImage', 'build') as ImagePolicy['source'],
    agentImageRef: userSetting(c, 'agentImageRef', '').trim(),
    allowUnlabeledAgentImage: userSetting(c, 'allowUnlabeledAgentImage', false),
    slots: userSetting<Record<string, string>>(c, 'slots', {}),
    mountAllowlist: userSetting<string[]>(c, 'mountAllowlist', []),
    workspaceMount: userSetting(c, 'workspaceMount', 'workspace') as WorkspaceMount,
    workspaceExcludes: userSetting<string[]>(c, 'workspaceExcludes', [...DEFAULT_WORKSPACE_EXCLUDES]),
    autoUpdate: userSetting(c, 'autoUpdate', 'prompt') as AutoUpdate,
  };
}
function machine(): Machine {
  // vscode.env.machineId is stable per VS Code installation — a far better
  // machine identity than hostname alone; hostname stays for humans.
  const fp = createHash('sha256').update(`${vscode.env.machineId}|${hostname()}|${platform()}|${arch()}`).digest('hex');
  return { fingerprint: fp, hostname: hostname(), os: platform(), arch: arch(), runner: `vscode-${ownVersion()}` };
}
/** Why a token or an update may not travel to this server, or null when it may. */
function insecureOrigin(serverUrl: string, what: string): string | null {
  if (secureOrigin(serverUrl)) return null;
  return `refusing to ${what} over plain http to ${serverUrl}: set nanoclaw.serverUrl to an https:// origin (plain http is accepted only for localhost)`;
}
const insecureWarned = new Set<string>();
/** The bearer for central, or '' under `network` sign-in (central identifies the caller by its network). */
async function getToken(createIfNone: boolean): Promise<string> {
  const { serverUrl, signIn, appIdUri, tenantId, clientId } = cfg();
  if (signIn === 'network') return '';
  const insecure = insecureOrigin(serverUrl, 'send the sign-in token');
  if (insecure) {
    if (!insecureWarned.has(serverUrl)) {
      insecureWarned.add(serverUrl);
      void vscode.window.showErrorMessage(`NanoClaw: ${insecure}.`);
    }
    throw new Error(insecure);
  }
  if (!appIdUri) throw new Error('set nanoclaw.appIdUri (api://<client-id>) in settings');
  const session = await vscode.authentication.getSession(
    AUTH_PROVIDER,
    scopesFor(appIdUri, tenantId, clientId || undefined),
    createIfNone ? { createIfNone: true } : { silent: true },
  );
  if (!session) throw new Error('not signed in — run "NanoClaw: Connect"');
  return session.accessToken;
}
function render(s: LinkState, detail?: string): void {
  void vscode.commands.executeCommand('setContext', 'nanoclaw.connected', s === 'connected');
  const icon =
    s === 'connected'
      ? '$(plug)'
      : s === 'connecting'
        ? '$(sync~spin)'
        : s === 'unauthorized'
          ? '$(shield)'
          : '$(debug-disconnect)';
  const pairing = s === 'connected' ? link?.welcome?.pairing : undefined;
  status.text = `${icon} NanoClaw${s === 'connected' && link?.welcome ? `: ${link.welcome.displayName}${pairing === 'pending' ? ' (awaiting approval)' : ''}` : ''}`;
  status.tooltip = `NanoClaw runner — ${s}${detail ? ` · ${detail}` : ''}`;
  status.backgroundColor =
    s === 'unauthorized' || pairing === 'pending'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  status.show();
}

/** Slot targets may resolve only under these roots: the explicit allowlist, else the open workspace folders. */
function policy(): AgentPolicy {
  const c = cfg();
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const allowlist = c.mountAllowlist.length ? c.mountAllowlist : folders;
  const active = vscode.window.activeTextEditor?.document.uri;
  const activeFile = active?.scheme === 'file' ? active.fsPath : undefined;
  return {
    slots: effectiveSlots(c.slots, folders, c.workspaceMount, activeFile),
    allowlist,
    excludes: c.workspaceExcludes,
  };
}
/** Which runtime answers on this machine. Explicit setting wins; auto tries docker, then podman. */
async function detectRuntime(): Promise<{ runtime: Runtime; cli: Cli }> {
  const c = cfg();
  const candidates: Runtime[] = c.containerRuntime === 'auto' ? ['docker', 'podman'] : [c.containerRuntime];
  const errors: string[] = [];
  for (const runtime of candidates) {
    const cli = realCli(c.runtimePath || runtime);
    try {
      await cli.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
      return { runtime, cli };
    } catch (e) {
      errors.push(`${runtime}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `no container runtime answered (${errors.join('; ')}). Install Docker Desktop or Podman Desktop (or set nanoclaw.runtimePath to its CLI), then set nanoclaw.containerRuntime.`,
  );
}
function localUser(): { uid: number; gid: number } | undefined {
  if (platform() === 'win32') return undefined;
  const u = userInfo();
  return u.uid >= 0 ? { uid: u.uid, gid: u.gid } : undefined;
}
async function ensureAgent(): Promise<RunnerAgent> {
  if (agent) return agent;
  const { runtime, cli } = await detectRuntime();
  log(`container runtime: ${runtime}${localUser() ? ` (uid ${localUser()!.uid})` : ''}`);
  agent = new RunnerAgent({
    cli,
    runtime,
    localUser: localUser(),
    storageRoot,
    policy,
    imagePolicy: () => {
      const c = cfg();
      return { source: c.agentImage, ref: c.agentImageRef, allowUnlabeled: c.allowUnlabeledAgentImage };
    },
    send: (frame) => {
      link?.send(frame);
    },
    proposalChanged: () => chat?.refresh(),
    log: (l) => {
      log(l);
      // Lifecycle lines go to central's log so an operator can see what a
      // laptop did; per-line build/pull progress would flood it, and a failure
      // carries its own tail in the refusal.
      if (!/^(build|pull): /.test(l)) link?.send({ type: 'log', level: 'info', message: l });
    },
  });
  return agent;
}

async function connect(interactive: boolean): Promise<void> {
  const c = cfg();
  if (!c.serverUrl) {
    if (interactive) void vscode.window.showErrorMessage('NanoClaw: set nanoclaw.serverUrl in settings.');
    return;
  }
  link?.stop();
  link = new RunnerLink({
    serverUrl: c.serverUrl,
    machine: machine(),
    getToken: () => getToken(interactive),
    onRequest: async (op, payload) => (await ensureAgent()).handle(op, payload),
    onFrame: (frame) => (chat?.handleFrame(frame) ?? false) || (agent?.handleFrame(frame) ?? false),
    events: {
      state: (s, d) => {
        lastState = s;
        render(s, d);
        chat?.setConnected(s === 'connected', d);
        if (s === 'connected') {
          agent?.centralReconnected();
          void considerUpdate();
          void refreshCentralConfig();
        }
        if (s === 'unauthorized' && interactive)
          void vscode.window.showWarningMessage(`NanoClaw: ${d ?? 'sign-in required'}`);
      },
      log,
      update: () => {
        void considerUpdate();
      },
    },
  });
  link.start();
}

/** Pick up sign-in settings central changed since the last connect. */
async function refreshCentralConfig(): Promise<void> {
  const { serverUrl } = cfg();
  try {
    const res = await fetch(apiUrl(serverUrl, '/api/runners/client-config'), {
      headers: authHeader(await getToken(false)),
    });
    if (!res.ok) return;
    await globalState?.update(CENTRAL_CONFIG, { serverUrl, config: sanitizeClientConfig(await res.json()) });
  } catch (err) {
    log(`could not refresh sign-in settings from central: ${String((err as Error).message)}`);
  }
}

/** vscode://nanoclaw.vscode/connect?server=…: webchat's "Connect VS Code" button. Asks before trusting it. */
async function handleConnectUri(uri: vscode.Uri): Promise<void> {
  if (uri.path !== '/connect') return;
  const parsed = parseConnectQuery(uri.query);
  if ('error' in parsed) {
    void vscode.window.showErrorMessage(`NanoClaw: ${parsed.error}.`);
    return;
  }
  const { serverUrl, config } = parsed;
  const pick = await vscode.window.showInformationMessage(
    `Connect to NanoClaw at ${serverUrl}?`,
    { modal: true, detail: config.tenantId ? `Microsoft tenant ${config.tenantId}` : undefined },
    'Connect',
  );
  if (pick !== 'Connect') return;
  await globalState?.update(CENTRAL_CONFIG, { serverUrl, config });
  await vscode.workspace.getConfiguration('nanoclaw').update('serverUrl', serverUrl, vscode.ConfigurationTarget.Global);
  await connect(true);
}

const offeredUpdates = new Set<string>();
let updateStorage = '';
function ownVersion(): string {
  return String(vscode.extensions.getExtension('nanoclaw.vscode')?.packageJSON.version ?? '0.0.0');
}
/** Central named a newer runner build in its welcome: offer it, or install it, per nanoclaw.autoUpdate. */
let updateItem: vscode.StatusBarItem | null = null;
async function considerUpdate(force = false): Promise<void> {
  let offer = link?.welcome?.update;
  if (force) {
    // Ask central now rather than trusting what it said at connect time.
    try {
      const res = await fetch(apiUrl(cfg().serverUrl, '/api/runners/extension'), {
        headers: authHeader(await getToken(false)),
      });
      if (res.ok) {
        const served = parseOffer(await res.json());
        if (served) {
          offer = served;
          if (link?.welcome) link.welcome.update = offer;
        }
      } else if (res.status === 404) offer = undefined;
    } catch (err) {
      log(`update check: could not ask central: ${String((err as Error).message)}`);
    }
  }
  const mine = ownVersion();
  const setting = cfg().autoUpdate;
  const plan = planUpdate(offer, mine, setting, force ? new Set() : offeredUpdates);
  log(
    `update check: central serves ${offer?.version ?? 'nothing'}, this runner is ${mine}, setting ${setting} -> ${plan.action}`,
  );
  if (plan.action === 'none') {
    if (force) {
      void vscode.window.showInformationMessage(
        offer
          ? `NanoClaw runner ${mine} is current (central serves ${offer.version}).`
          : `NanoClaw central serves no runner package yet.`,
      );
    }
    return;
  }
  offeredUpdates.add(plan.offer.version);
  // A status bar affordance that stays until acted on: a toast can be missed.
  if (!updateItem) {
    updateItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    updateItem.command = 'nanoclaw.installUpdate';
  }
  updateItem.text = `$(cloud-download) NanoClaw ${plan.offer.version}`;
  updateItem.tooltip = `NanoClaw runner ${plan.offer.version} is available (you have ${mine}). Click to install.`;
  updateItem.show();
  if (plan.action === 'prompt') {
    const pick = await vscode.window.showInformationMessage(
      `NanoClaw runner ${plan.offer.version} is available (you have ${mine}).`,
      'Install and reload',
      'Later',
    );
    if (pick !== 'Install and reload') return;
  }
  await installOffered(plan.offer);
}
async function installOffered(offer: UpdateOffer): Promise<void> {
  try {
    await installUpdate(offer);
    updateItem?.hide();
  } catch (err) {
    log(`update failed: ${String((err as Error).message)}`);
    void vscode.window.showErrorMessage(
      `NanoClaw: update to ${offer.version} failed: ${String((err as Error).message).slice(0, 200)}`,
    );
  }
}
/** Download over the same authenticated origin, verify the hash central announced, install through VS Code, offer a reload. */
async function installUpdate(offer: UpdateOffer): Promise<void> {
  const insecure = insecureOrigin(cfg().serverUrl, 'download an update');
  if (insecure) throw new Error(insecure);
  const token = await getToken(false);
  const url = apiUrl(cfg().serverUrl, '/api/runners/extension/download');
  log(`downloading runner ${offer.version}`);
  const res = await fetch(url, { headers: authHeader(token) });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== offer.sha256) throw new Error('package hash does not match what central announced');
  const dir = updateStorage;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `nanoclaw-${offer.version}.vsix`);
  fs.writeFileSync(file, bytes);
  await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
  log(`installed runner ${offer.version}; reload to activate`);
  const pick = await vscode.window.showInformationMessage(
    `NanoClaw runner ${offer.version} installed.`,
    'Reload window',
    'Later',
  );
  if (pick === 'Reload window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/** Returns the inline-review controller: the editor harness drives it without a chat panel. */
export function activate(ctx: vscode.ExtensionContext): { review: ReviewController } {
  out = vscode.window.createOutputChannel('NanoClaw');
  globalState = ctx.globalState;
  storageRoot = vscode.Uri.joinPath(ctx.globalStorageUri, 'runner').fsPath;
  updateStorage = vscode.Uri.joinPath(ctx.globalStorageUri, 'updates').fsPath;
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'nanoclaw.status';
  render('disconnected');
  const review = new ReviewController(log);
  ctx.subscriptions.push(review);
  chat = new ChatViewProvider({
    send: (f) => link?.send(f) ?? false,
    log,
    // The Changes section reviews the folder bound as the agent's workspace.
    workspaceRoot: () => policy().slots['/workspace/project'] ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    storageRoot: () => storageRoot,
    proposal: () => agent?.currentProposal() ?? null,
    // Same origin, same bearer the runner socket uses; writes carry the CSRF header central's routes expect.
    review,
    api: async (apiPath, init = {}) => {
      const headers = new Headers(init.headers);
      for (const [k, v] of Object.entries(authHeader(await getToken(false)))) headers.set(k, v);
      if (init.method && init.method !== 'GET') headers.set('X-Webchat-CSRF', '1');
      return fetch(apiUrl(cfg().serverUrl, apiPath), { ...init, headers });
    },
  });
  ctx.subscriptions.push(
    out,
    status,
    chat,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('nanoclaw.sendSelection', () => {
      chat?.attachSelection();
    }),
    vscode.commands.registerCommand('nanoclaw.checkForUpdates', () => considerUpdate(true)),
    vscode.commands.registerCommand('nanoclaw.installUpdate', () => {
      const o = link?.welcome?.update;
      if (o) void installOffered(o);
      else void vscode.window.showInformationMessage('No NanoClaw runner update is offered right now.');
    }),
    vscode.commands.registerCommand('nanoclaw.focusChat', () => {
      chat?.reveal();
    }),
    vscode.commands.registerCommand('nanoclaw.connect', () => connect(true)),
    vscode.window.registerUriHandler({ handleUri: (uri) => void handleConnectUri(uri) }),
    vscode.commands.registerCommand('nanoclaw.disconnect', () => {
      // VS Code owns the account; we can only drop our link and point at Accounts.
      link?.stop();
      link = null;
      void vscode.window.showInformationMessage(
        'NanoClaw disconnected. To sign out of the Microsoft account itself, use the Accounts menu (bottom-left).',
      );
    }),
    vscode.commands.registerCommand('nanoclaw.status', () => {
      const w = link?.welcome;
      const m = machine();
      void vscode.window
        .showInformationMessage(
          w
            ? `Connected to ${cfg().serverUrl} as ${w.displayName} (${w.userId}). Machine ${m.hostname} · ${m.fingerprint.slice(0, 12)}`
            : `Not connected. Machine ${m.hostname} · ${m.fingerprint.slice(0, 12)}`,
          'Show log',
        )
        .then((a) => {
          if (a) out.show();
        });
    }),
    vscode.commands.registerCommand('nanoclaw.openChat', () => {
      const u = cfg().serverUrl;
      if (u) void vscode.env.openExternal(vscode.Uri.parse(u));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nanoclaw') && link) void connect(false);
    }),
    // Sign-in itself fires several session-change events; rebuilding the link
    // on each one opened a socket per event. Only a refused link needs the new
    // session — a connecting/connected one already holds a valid token.
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id !== AUTH_PROVIDER || !link) return;
      if (lastState === 'unauthorized') void connect(false);
      else link.nudge();
    }),
    // Coming back to the window is usually coming back to the laptop: reconnect now, not at the end of the backoff.
    vscode.window.onDidChangeWindowState((w) => {
      if (w.focused) link?.nudge();
    }),
  );
  if (cfg().autoConnect && cfg().serverUrl) void connect(false); // silent: only if already signed in
  return { review };
}
export function deactivate(): void {
  link?.stop();
  link = null;
  agent?.dispose();
  agent = null;
}
