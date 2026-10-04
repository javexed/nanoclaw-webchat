import { arch, hostname, platform } from 'node:os';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import type { Proposal } from './git-changes.js';
import { RunnerAgent, recoverLaptopToolsProposal, type AgentPolicy } from './agent.js';
import { DEFAULT_WORKSPACE_EXCLUDES, workspaceSlots } from './policy.js';
import { planUpdate, type AutoUpdate, type UpdateOffer } from './update.js';
import { userSetting } from './settings.js';
import { copySettings, migrateCopySettings } from './copy-settings.js';
import { apiUrl } from './chat-render.js';
import { ReviewController } from './review-controller.js';
import { ProposalScm } from './proposal-scm.js';
import { ConflictTracker } from './conflicts.js';
import { ChatViewProvider, proposedReviewable } from './chat-view.js';
import { adoptLegacyStorage, legacyExtensionId } from './legacy.js';
import { RunnerLink, STANDBY_DETAIL, parseOffer, type LinkState } from './link.js';
import {
  decidePin,
  decodeSignatureHeader,
  keyFingerprint,
  parsePublicKey,
  pinFor,
  releaseOrigin,
  releaseTrust,
  verifyRelease,
  type ReleaseKind,
} from './release-signing.js';
import { loadOrCreateMachineKey, type MachineKey } from './machine-key.js';
import { activityLogFile, initActivityLog, recordActivity } from './activity-log.js';
import { scopesFor, secureOrigin, type Machine, authHeader } from './protocol.js';
import {
  parseConnectQuery,
  resolveClientConfig,
  sanitizeClientConfig,
  signInChanges,
  type ClientConfig,
} from './client-config.js';

const AUTH_PROVIDER = 'microsoft';
/**
 * No sign-in settings for this server yet. They arrive with its Connect link,
 * and from the server once connected — which needs them first. Typing a new
 * server into nanoclaw.serverUrl therefore cannot sign in on its own.
 */
const NO_SIGNIN_SETTINGS = 'no sign-in settings for this server yet: open it in the browser and click Connect VS Code';
let link: RunnerLink | null = null;
let chat: ChatViewProvider | null = null;
let agent: RunnerAgent | null = null;
/** The laptop-tools proposal found on disk at startup, until the runner binds one itself. */
let recoveredProposal: Proposal | null = null;
let storageRoot = '';
let lastState: LinkState = 'disconnected';
let status: vscode.StatusBarItem;
let out: vscode.OutputChannel | undefined;
/** The files the secret scan last left out, as the developer was last told. */
let lastLeftOut = '';
let globalState: vscode.Memento | undefined;
const CENTRAL_CONFIG = 'nanoclaw.centralClientConfig';
/** Release signing keys the developer confirmed, per server origin (per URL before 0.16). */
const RELEASE_KEYS = 'nanoclaw.releaseKeys';
/** Keys a server offered that the developer declined, per origin: its releases are refused. */
const RELEASE_KEYS_DECLINED = 'nanoclaw.releaseKeysDeclined';
/** Servers already told that their releases are unsigned. */
const UNSIGNED_NOTED = 'nanoclaw.unsignedReleasesNoted';
/** Folders the developer allowed the agent to work on, per server origin. */
const ALLOWED_FOLDERS = 'nanoclaw.allowedFolders';
/** Set by Stop all, on this machine: nothing is served until the developer resumes. */
const HALTED = 'nanoclaw.halted';
/** A Stop all central has not been told of yet (it was out of reach): sent on the next connect. */
let unreportedStop = false;
/** This machine's key (machine-key.ts), loaded at activation; null when secret storage is unavailable. */
let machineKey: Promise<MachineKey | null> = Promise.resolve(null);

function log(line: string): void {
  out?.appendLine(`[${new Date().toISOString()}] ${line}`);
}
/** Central's sign-in settings, remembered for the server they came from. */
function centralClientConfig(serverUrl: string): ClientConfig {
  return savedCentralConfig(serverUrl) ?? {};
}
function savedCentralConfig(serverUrl: string): ClientConfig | null {
  const saved = globalState?.get<{ serverUrl: string; config: ClientConfig }>(CENTRAL_CONFIG);
  return saved?.serverUrl === serverUrl ? saved.config : null;
}
function cfg() {
  const c = vscode.workspace.getConfiguration('nanoclaw');
  // Everything but autoConnect comes from user settings only (see settings.ts).
  const serverUrl = userSetting(c, 'serverUrl', '').trim().replace(/\/$/, '');
  return {
    serverUrl,
    ...resolveClientConfig(centralClientConfig(serverUrl)),
    autoConnect: c.get<boolean>('autoConnect') ?? true,
    workspaceExcludes: copySettings(c).exclude ?? [...DEFAULT_WORKSPACE_EXCLUDES],
    autoUpdate: userSetting(c, 'autoUpdate', 'prompt') as AutoUpdate,
    releaseSigningKey: parsePublicKey(userSetting(c, 'releaseSigningKey', '')),
  };
}
function machine(key?: MachineKey | null): Machine {
  // vscode.env.machineId is stable per VS Code installation — a far better
  // machine identity than hostname alone; hostname stays for humans. It names
  // the machine; the key proves it.
  const fp = createHash('sha256').update(`${vscode.env.machineId}|${hostname()}|${platform()}|${arch()}`).digest('hex');
  return {
    fingerprint: fp,
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    runner: `vscode-${ownVersion()}`,
    ...(key ? { publicKey: key.publicKey } : {}),
  };
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
  if (!appIdUri) throw new Error(NO_SIGNIN_SETTINGS);
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
  status.command = 'nanoclaw.status';
  if (s === 'disconnected' && detail === STANDBY_DETAIL) {
    // The agent works on the folder of the window that holds the connection.
    status.text = `${icon} NanoClaw: other window`;
    status.tooltip = 'Another VS Code window on this machine holds the NanoClaw connection. Click to use this window.';
    status.command = 'nanoclaw.connect';
  }
  status.backgroundColor =
    s === 'unauthorized' || pairing === 'pending'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  status.show();
}

/** The project is the open workspace folder; slot targets may resolve only under the open folders. */
function policy(): AgentPolicy {
  const c = cfg();
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const active = vscode.window.activeTextEditor?.document.uri;
  const activeFile = active?.scheme === 'file' ? active.fsPath : undefined;
  return {
    slots: workspaceSlots(folders, activeFile),
    allowlist: folders,
    excludes: c.workspaceExcludes,
  };
}
function ensureAgent(): RunnerAgent {
  agent ??= new RunnerAgent({
    storageRoot,
    policy,
    proposalChanged: () => chat?.refresh(),
    secretsLeftOut: (paths) => {
      for (const p of paths) out?.appendLine(`secret found, left out of the agent's copy: ${p}`);
      // Once per distinct list: each agent start re-takes the same snapshot.
      const key = paths.join('\0');
      if (key === lastLeftOut) return;
      lastLeftOut = key;
      const n = paths.length;
      void vscode.window
        .showWarningMessage(`${n} file${n === 1 ? '' : 's'} with secrets left out`, 'Show')
        .then((pick) => pick && out?.show(true));
    },
    installSlug: () => link?.welcome?.installSlug,
    halted: () => globalState?.get<{ reason: string }>(HALTED)?.reason ?? null,
    approveFolder,
    log: (l) => {
      log(l);
      // Central's log too, so an operator can see what a laptop did.
      link?.send({ type: 'log', level: 'info', message: l });
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
  const key = await machineKey;
  link?.stop();
  link = new RunnerLink({
    serverUrl: c.serverUrl,
    machine: machine(key),
    ...(key ? { signChallenge: key.signChallenge } : {}),
    getToken: () => getToken(interactive),
    // Only an explicit Connect takes the connection from another window.
    standby: !interactive,
    onRequest: (op, payload) => ensureAgent().handle(op, payload),
    onFrame: (frame) => chat?.handleFrame(frame) ?? false,
    events: {
      state: (s, d) => {
        lastState = s;
        render(s, d);
        chat?.setConnected(s === 'connected', d);
        if (s === 'connected') {
          reportStop();
          void considerUpdate();
          void refreshCentralConfig();
        }
        if (s === 'unauthorized' && interactive) {
          if (d === NO_SIGNIN_SETTINGS) {
            const open = 'Open in browser';
            void vscode.window
              .showWarningMessage(
                `NanoClaw: ${c.serverUrl} has not sent its sign-in settings yet. Open it and click Connect VS Code.`,
                open,
              )
              .then((pick) => pick === open && vscode.env.openExternal(vscode.Uri.parse(c.serverUrl)));
          } else void vscode.window.showWarningMessage(`NanoClaw: ${d ?? 'sign-in required'}`);
        }
      },
      log,
      update: () => {
        void considerUpdate();
      },
      // A machine cut off serves nothing more.
      revoked: () => void stopAll('machine revoked', false),
    },
  });
  link.start();
}

/** How releases from `serverUrl` are held (release-signing.ts releaseTrust). */
function trustFor(serverUrl: string): ReturnType<typeof releaseTrust> {
  return releaseTrust({
    own: cfg().releaseSigningKey,
    pins: globalState?.get<Record<string, string>>(RELEASE_KEYS) ?? {},
    declined: globalState?.get<Record<string, string>>(RELEASE_KEYS_DECLINED) ?? {},
    serverUrl,
  });
}

/**
 * A key central or its Connect link offers: pinned only on a modal
 * confirmation showing its fingerprint, the first time and on any change
 * (the same rule as a changed sign-in audience). Asked once per session per key.
 */
const askedReleaseKeys = new Set<string>();
async function considerReleaseKey(serverUrl: string, offered: string | null): Promise<void> {
  if (cfg().releaseSigningKey) return;
  const origin = releaseOrigin(serverUrl);
  if (!origin) return;
  const stored = globalState?.get<Record<string, string>>(RELEASE_KEYS) ?? {};
  const decision = decidePin(pinFor(stored, origin), offered);
  if (decision.action === 'none') return;
  const key = decision.action === 'confirm-first' ? decision.key : decision.to;
  if (askedReleaseKeys.has(`${origin}|${key}`)) return;
  askedReleaseKeys.add(`${origin}|${key}`);
  const pick =
    decision.action === 'confirm-first'
      ? await vscode.window.showInformationMessage(
          `Trust NanoClaw at ${origin} to sign its releases with this key?`,
          { modal: true, detail: keyFingerprint(key) },
          'Trust',
        )
      : await vscode.window.showWarningMessage(
          `NanoClaw at ${origin} changed its release signing key. Trust the new key?`,
          { modal: true, detail: `Pinned: ${keyFingerprint(decision.from)}\nNew: ${keyFingerprint(key)}` },
          'Trust',
        );
  log(`release signing key ${keyFingerprint(key)} offered by ${origin}: ${pick === 'Trust' ? 'pinned' : 'declined'}`);
  const declined = globalState?.get<Record<string, string>>(RELEASE_KEYS_DECLINED) ?? {};
  if (pick !== 'Trust') {
    // A first key declined refuses that server's releases; a declined change
    // keeps the old pin, which the new key's releases then fail.
    if (decision.action === 'confirm-first')
      await globalState?.update(RELEASE_KEYS_DECLINED, { ...declined, [origin]: key });
    return;
  }
  await globalState?.update(RELEASE_KEYS, { ...stored, [origin]: key });
  const { [origin]: _dropped, ...rest } = declined;
  await globalState?.update(RELEASE_KEYS_DECLINED, rest);
}

/**
 * Null when a release may be installed or loaded; else the one-line reason it
 * is refused. With no key pinned, releases pass as before, and the developer
 * is told once per server that they are unsigned.
 */
function checkRelease(kind: ReleaseKind, subject: string, sha256: string, signature: unknown): string | null {
  const { serverUrl } = cfg();
  const origin = releaseOrigin(serverUrl) ?? serverUrl;
  const trust = trustFor(serverUrl);
  if ('verifyWith' in trust)
    return verifyRelease(signature, { kind, server: origin, subject, sha256 }, trust.verifyWith);
  if ('refuse' in trust) return trust.refuse;
  const noted = globalState?.get<string[]>(UNSIGNED_NOTED) ?? [];
  if (!noted.includes(origin)) {
    void globalState?.update(UNSIGNED_NOTED, [...noted, origin]);
    void vscode.window.showInformationMessage(`NanoClaw: releases from ${origin} are unsigned.`);
  }
  return null;
}

/** The install a request names, wherever central put it. */
/**
 * A folder is served to a server's agents only once the developer allowed it:
 * the tools follow the folder in front of them, and opening a sensitive
 * repository must not hand it over unasked. Asked once per folder and server;
 * concurrent requests share one question.
 */
const folderQuestions = new Map<string, Promise<boolean>>();
const untrustedNoted = new Set<string>();
async function approveFolder(folder: string): Promise<boolean | string> {
  // Restricted Mode: connect and chat, but no folder VS Code does not trust goes to an agent.
  if (!vscode.workspace.isTrusted) {
    if (!untrustedNoted.has(folder)) {
      untrustedNoted.add(folder);
      void vscode.window.showWarningMessage(
        `NanoClaw: ${path.basename(folder)} is open in Restricted Mode, so the agent cannot work on it. Trust the folder to allow it.`,
      );
    }
    return `${folder} is open in VS Code's Restricted Mode (not trusted); the developer must trust it before an agent can work on it`;
  }
  const origin = releaseOrigin(cfg().serverUrl) ?? cfg().serverUrl;
  const all = globalState?.get<Record<string, string[]>>(ALLOWED_FOLDERS) ?? {};
  if (all[origin]?.includes(folder)) return true;
  const key = `${origin}\n${folder}`;
  let q = folderQuestions.get(key);
  if (!q) {
    q = (async () => {
      const pick = await vscode.window.showWarningMessage(
        `Let NanoClaw's agent work on ${path.basename(folder)}?`,
        {
          modal: true,
          detail: `${folder}\nThe agent on ${origin} can read it (secret-like files left out) and propose changes you review.`,
        },
        'Allow',
      );
      if (pick !== 'Allow') return false;
      const now = globalState?.get<Record<string, string[]>>(ALLOWED_FOLDERS) ?? {};
      await globalState?.update(ALLOWED_FOLDERS, { ...now, [origin]: [...(now[origin] ?? []), folder] });
      recordActivity('folder.allow', { folder, server: origin });
      return true;
    })().finally(() => folderQuestions.delete(key));
    folderQuestions.set(key, q);
  }
  return q;
}

/**
 * The kill switch: this machine serves the agent nothing more — no file read,
 * no change — until the developer resumes, and central is told so it stops
 * the agents placed here. Central out of reach: told on the next connect.
 */
async function stopAll(reason: string, tellCentral = true): Promise<void> {
  await globalState?.update(HALTED, { reason, at: new Date().toISOString() });
  recordActivity('stop-all', { reason });
  log(`stop all (${reason}): this machine serves the agent nothing until resumed`);
  if (tellCentral) {
    unreportedStop = true;
    reportStop();
  }
  const pick = await vscode.window.showInformationMessage('NanoClaw: agents stopped on this machine.', 'Resume');
  if (pick === 'Resume') await resumeAgents();
}
/** The developer lets agents use this machine again. */
async function resumeAgents(): Promise<void> {
  if (!globalState?.get(HALTED)) return;
  await globalState.update(HALTED, undefined);
  recordActivity('resume', {});
  log('agents may use this machine again');
}

function reportStop(): void {
  if (!unreportedStop || !link?.welcome || link.welcome.pairing === 'revoked') return;
  if (link.send({ type: 'stopAll', sessions: [] })) unreportedStop = false;
}

async function showActivityLog(): Promise<void> {
  const file = activityLogFile();
  if (!file) return;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '', { mode: 0o600 });
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), {
    preview: false,
  });
}

/** Pick up sign-in settings central changed since the last connect. */
async function refreshCentralConfig(): Promise<void> {
  const { serverUrl } = cfg();
  try {
    const res = await fetch(apiUrl(serverUrl, '/api/runners/client-config'), {
      headers: authHeader(await getToken(false)),
    });
    if (!res.ok) return;
    const body = (await res.json()) as Record<string, unknown>;
    await considerReleaseKey(serverUrl, parsePublicKey(body?.releaseKey));
    const next = sanitizeClientConfig(body);
    // The audience decides which API a token is for. A server that changes it
    // after the developer chose it does not get that silently.
    const changed = signInChanges(savedCentralConfig(serverUrl), next);
    if (changed.length) {
      const what = changed.map((k) => `${k}: ${next[k] ?? 'unset'}`).join(', ');
      log(`central changed its sign-in settings (${what}); asking before using them`);
      const pick = await vscode.window.showWarningMessage(
        `NanoClaw at ${serverUrl} changed its sign-in settings (${what}). Use them?`,
        'Use them',
      );
      if (pick !== 'Use them') return;
    }
    await globalState?.update(CENTRAL_CONFIG, { serverUrl, config: next });
  } catch (err) {
    log(`could not refresh sign-in settings from central: ${String((err as Error).message)}`);
  }
}

/** vscode://<this extension's id>/connect?server=…: webchat's "Connect VS Code" button. Asks before trusting it. */
async function handleConnectUri(uri: vscode.Uri): Promise<void> {
  if (uri.path !== '/connect') return;
  const parsed = parseConnectQuery(uri.query);
  if ('error' in parsed) {
    void vscode.window.showErrorMessage(`NanoClaw: ${parsed.error}.`);
    return;
  }
  const { serverUrl, config, releaseKey } = parsed;
  const eff = resolveClientConfig(config);
  const detail = [
    eff.signIn === 'microsoft' ? `Token for: ${eff.appIdUri || '(server default)'}` : 'Sign-in: network',
    eff.tenantId ? `Tenant: ${eff.tenantId}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const pick = await vscode.window.showInformationMessage(
    `Connect to NanoClaw at ${serverUrl}?`,
    { modal: true, detail: `${detail}\nIts agents can ask to work on the folders you open here.` },
    'Connect',
  );
  if (pick !== 'Connect') return;
  await globalState?.update(CENTRAL_CONFIG, { serverUrl, config });
  await vscode.workspace.getConfiguration('nanoclaw').update('serverUrl', serverUrl, vscode.ConfigurationTarget.Global);
  await considerReleaseKey(serverUrl, releaseKey ?? null);
  await connect(true);
}

const offeredUpdates = new Set<string>();
let updateStorage = '';
/** This build, as VS Code loaded it — whatever id it was packaged under (scripts/package.mjs). */
let self: vscode.Extension<unknown> | null = null;
function ownVersion(): string {
  return String(self?.packageJSON.version ?? '0.0.0');
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
  const refused = checkRelease(
    'vsix',
    offer.version,
    sha,
    decodeSignatureHeader(res.headers.get('x-nanoclaw-signature')),
  );
  if (refused) throw new Error(`the package is refused: ${refused}`);
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

/**
 * Move the old build's proposals and agent state into this build's storage.
 * Only once the old build is gone: while it is installed it may be running,
 * and its files are not ours to move.
 */
function takeOverStorage(globalStorageDir: string, legacyId: string): void {
  try {
    const adopted = adoptLegacyStorage(globalStorageDir, legacyId);
    if (adopted !== 'none') log(`Took over the storage of the ${legacyId} build (${adopted}).`);
  } catch (err) {
    log(`Could not take over the storage of the ${legacyId} build: ${String((err as Error).message)}`);
  }
}

/**
 * The switch from the old build, on the developer's click: remove it, reload.
 * Its storage is taken over at the next start, when it no longer runs. Never
 * done unasked — uninstalling another extension is the developer's call.
 */
let finishItem: vscode.StatusBarItem | null = null;
async function offerSwitch(legacyId: string): Promise<void> {
  // A dismissed prompt must not leave the developer stuck on the old build:
  // this stays in the status bar, and reopens the prompt, until the switch is done.
  if (!finishItem) {
    finishItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    finishItem.text = '$(warning) NanoClaw: finish update';
    finishItem.tooltip = 'The older NanoClaw extension is still installed. Click to remove it and reload.';
    finishItem.command = 'nanoclaw.finishUpdate';
    finishItem.show();
  }
  const pick = await vscode.window.showInformationMessage(
    'NanoClaw was updated; the older extension is still installed.',
    'Remove it and reload',
  );
  if (pick !== 'Remove it and reload') return;
  try {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', legacyId);
  } catch (err) {
    log(`Could not remove ${legacyId}: ${String((err as Error).message)}`);
    void vscode.window.showWarningMessage(`NanoClaw: uninstall "${legacyId}" in the Extensions view, then reload.`);
    return;
  }
  void vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/** Returns the inline-review controller and the conflict list: the editor harness drives them without a chat panel. */
export function activate(ctx: vscode.ExtensionContext): { review?: ReviewController; conflicts?: ConflictTracker } {
  try {
    return activateNow(ctx);
  } catch (err) {
    return activationFailed(ctx, err);
  }
}

/**
 * Start-up failed part-way. Every NanoClaw command still answers, with the
 * reason: otherwise VS Code reports "command 'nanoclaw.connect' not found",
 * which points nowhere.
 */
function activationFailed(ctx: vscode.ExtensionContext, err: unknown): Record<string, never> {
  const why = String((err as Error)?.message ?? err);
  out ??= vscode.window.createOutputChannel('NanoClaw');
  out.appendLine(`[${new Date().toISOString()}] NanoClaw could not start: ${String((err as Error)?.stack ?? err)}`);
  const say = (): void => {
    void vscode.window
      .showErrorMessage(`NanoClaw could not start: ${why}`, 'Show log')
      .then((pick) => pick && out?.show());
  };
  const commands = (
    (ctx.extension.packageJSON as { contributes?: { commands?: Array<{ command: string }> } }).contributes?.commands ??
    []
  ).map((c) => c.command);
  for (const id of commands) {
    try {
      ctx.subscriptions.push(vscode.commands.registerCommand(id, say));
    } catch {
      /* registered before the failure: it keeps its own handler */
    }
  }
  say();
  return {};
}

function activateNow(ctx: vscode.ExtensionContext): { review: ReviewController; conflicts?: ConflictTracker } {
  out = vscode.window.createOutputChannel('NanoClaw');
  globalState = ctx.globalState;
  self = ctx.extension;
  // The predecessor's id, when the package step named one (package.mjs); none
  // (or this build's own id: an install that kept the old id) means there is
  // nothing to take over and nothing to remove.
  const legacyId = legacyExtensionId(ctx.extension.packageJSON, ctx.extension.id);
  // The old build still installed beside this one (it just installed this
  // update): stay inactive — both register the same commands and view, and
  // both would claim this machine — and offer the switch as one click.
  if (legacyId && vscode.extensions.getExtension(legacyId)) {
    ctx.subscriptions.push(vscode.commands.registerCommand('nanoclaw.finishUpdate', () => offerSwitch(legacyId)));
    void offerSwitch(legacyId);
    return { review: new ReviewController(log) };
  }
  // The old build is gone (removed on the prompt's click, or some other way):
  // nothing of it runs any more, so its storage can move.
  if (legacyId) takeOverStorage(ctx.globalStorageUri.fsPath, legacyId);
  machineKey = loadOrCreateMachineKey(ctx.secrets).catch((err: unknown) => {
    log(`machine key unavailable (secret storage): ${String((err as Error).message)}`);
    return null;
  });
  initActivityLog(ctx.globalStorageUri.fsPath);
  // Copy settings set under their old names move to agentCopy.* (read from the old names until then).
  migrateCopySettings({
    inspect: (k) => vscode.workspace.getConfiguration('nanoclaw').inspect(k),
    update: (k, v) => vscode.workspace.getConfiguration('nanoclaw').update(k, v, vscode.ConfigurationTarget.Global),
  }).then(
    (moved) => moved.forEach((m) => log(`settings: ${m}`)),
    (err: unknown) => log(`settings: could not move the old copy settings: ${String((err as Error)?.message ?? err)}`),
  );
  storageRoot = vscode.Uri.joinPath(ctx.globalStorageUri, 'runner').fsPath;
  updateStorage = vscode.Uri.joinPath(ctx.globalStorageUri, 'updates').fsPath;
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'nanoclaw.status';
  render('disconnected');
  const review = new ReviewController(log, ctx.workspaceState);
  ctx.subscriptions.push(review);
  let scm: ProposalScm | null = null;
  const conflicts = new ConflictTracker(ctx.workspaceState);
  chat = new ChatViewProvider({
    conflicts,
    send: (f) => {
      // Writing to the agent is the developer acting: agents may start again (as central treats it).
      if (f.type === 'chat.send') void resumeAgents();
      return link?.send(f) ?? false;
    },
    log,
    // Attachments are picked from, and saved to, the folder bound as the agent's workspace.
    workspaceRoot: () => policy().slots['/workspace/project'] ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    storageRoot: () => storageRoot,
    proposal: () => agent?.currentProposal() ?? recoveredProposal,
    // Same origin, same bearer the runner socket uses; writes carry the CSRF header central's routes expect.
    review,
    proposedChanged: (repoRoot, files) =>
      scm?.update(repoRoot, files, proposedReviewable, repoRoot ? conflicts.under(repoRoot) : []),
    api: async (apiPath, init = {}) => {
      const headers = new Headers(init.headers);
      for (const [k, v] of Object.entries(authHeader(await getToken(false)))) headers.set(k, v);
      if (init.method && init.method !== 'GET') headers.set('X-Webchat-CSRF', '1');
      return fetch(apiUrl(cfg().serverUrl, apiPath), { ...init, headers });
    },
  });
  const panel = chat;
  scm = new ProposalScm({
    diff: (rel) => panel.openDiff(rel),
    review: (rel) => panel.reviewFile(rel),
    reviewAll: () => panel.reviewNext(),
    act: (what, rels) => panel.proposalAct(what, rels),
    refresh: () => panel.refreshChanges(),
    openConflict: (rel) => panel.openConflict(rel),
  });
  conflicts.onChange(() => void panel.refreshChanges());
  // Recovery runs git over the developer's folder: not in Restricted Mode, only once it is trusted.
  const recover = () =>
    void recoverLaptopToolsProposal(storageRoot, policy()).then((p) => {
      recoveredProposal = p;
      if (p) chat?.refresh();
    });
  if (vscode.workspace.isTrusted) recover();
  else ctx.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(recover));
  ctx.subscriptions.push(
    conflicts,
    scm,
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
    vscode.commands.registerCommand('nanoclaw.review.nextFile', () => chat?.reviewNextFile()),
    vscode.commands.registerCommand('nanoclaw.connect', () => connect(true)),
    vscode.commands.registerCommand('nanoclaw.stopAllAgents', () => stopAll('stop all agents')),
    vscode.commands.registerCommand('nanoclaw.forgetAllowedFolders', async () => {
      await globalState?.update(ALLOWED_FOLDERS, undefined);
      recordActivity('folder.forget-all', {});
      void vscode.window.showInformationMessage('NanoClaw: the agent will ask before working on any folder again.');
    }),
    vscode.commands.registerCommand('nanoclaw.resumeAgents', () => resumeAgents()),
    vscode.commands.registerCommand('nanoclaw.showActivityLog', () => showActivityLog()),
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
          if (a) out?.show();
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
  return { review, conflicts };
}
export function deactivate(): void {
  link?.stop();
  link = null;
  agent = null;
}
