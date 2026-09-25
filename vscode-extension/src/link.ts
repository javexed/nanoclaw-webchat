// One outbound WebSocket to central: hello on open, answer pings, surface
// welcome/errors, reconnect with bounded backoff, and ask for a FRESH token
// before every attempt (VS Code's auth provider refreshes silently).
// Central's `req` frames are handed to the runner agent and answered with
// `res`; the agent pushes `event`/`heartbeat` frames through `send()`.
import WebSocket from 'ws';
import { helloFrame, nextBackoff, replyFor, wsUrl, type Frame, type Machine, authHeader } from './protocol.js';
import type { UpdateOffer } from './update.js';

/** How long a superseded window waits before trying again. */
const SUPERSEDED_BACKOFF_MS = 5 * 60_000;

export type LinkState = 'disconnected' | 'connecting' | 'connected' | 'unauthorized';
export type PairingState = 'pending' | 'approved' | 'revoked';
export interface LinkEvents {
  state: (s: LinkState, detail?: string) => void;
  log: (line: string) => void;
  /** Central named a (different) served runner build, in a welcome or a later keepalive. */
  update?: () => void;
}
export interface RequestHandler {
  (op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface LinkDeps {
  serverUrl: string;
  machine: Machine;
  getToken: () => Promise<string>; // throws → stop with 'unauthorized' (before the first connect; after it, retry)
  events: LinkEvents;
  /** Serves central's requests. Throw an Error with a `failure` field to answer with a structured failure. */
  onRequest?: RequestHandler;
  /** Takes frames that are not request/response — the relay's tunnels. Returns true when handled. */
  onFrame?: (frame: Record<string, unknown>) => boolean;
  /** test seam */
  WebSocketImpl?: typeof WebSocket;
}

export class RunnerLink {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 1000;
  private timer: NodeJS.Timeout | null = null;
  /** This link has been welcomed at least once: the user is signed in, and a missing token later is transient. */
  private connectedOnce = false;
  /** Consecutive attempts that got no token; logged on the first only. */
  private tokenMisses = 0;
  welcome: {
    userId: string;
    displayName: string;
    keepaliveMs: number;
    pairing: PairingState;
    update?: UpdateOffer;
  } | null = null;

  constructor(private readonly d: LinkDeps) {}

  start(): void {
    this.stopped = false;
    void this.attempt();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close(1000, 'stopped');
    this.ws = null;
    this.welcome = null;
    this.d.events.state('disconnected', 'stopped');
  }
  /**
   * Try now instead of waiting out the backoff — the window regained focus
   * (the laptop woke and the developer is back) or the auth provider's
   * sessions changed. No-op while connected, connecting, stopped, or standing
   * by for another window.
   */
  nudge(): void {
    if (this.stopped || this.ws || !this.timer || this.backoff >= SUPERSEDED_BACKOFF_MS) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.backoff = 1000;
    this.d.events.log('reconnecting now');
    void this.attempt();
  }
  /** Push a frame upstream; dropped while disconnected (events are best-effort hints, central resyncs). */
  send(frame: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.welcome) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /**
   * One line per distinct refusal, not one per attempt. A laptop that has
   * slept, or whose container runtime is down, refuses every request central
   * makes — twice a second, identically. Repeats are counted and reported when
   * the message finally changes (or every 50th), so the log still shows the
   * outage without burying everything else.
   */
  private lastRefusal = '';
  private refusalRepeats = 0;
  private logRefusal(op: string, message: string): void {
    const line = `${op} refused: ${message}`;
    if (line === this.lastRefusal) {
      this.refusalRepeats += 1;
      if (this.refusalRepeats % 50 === 0)
        this.d.events.log(`… still refusing (${this.refusalRepeats}×): ${line.slice(0, 120)}`);
      return;
    }
    if (this.refusalRepeats > 0) this.d.events.log(`(the previous refusal repeated ${this.refusalRepeats}×)`);
    this.lastRefusal = line;
    this.refusalRepeats = 0;
    this.d.events.log(line);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.tokenMisses <= 1) this.d.events.log(`reconnecting in ${Math.round(this.backoff / 1000)}s`);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt();
    }, this.backoff);
    this.backoff = this.backoff >= SUPERSEDED_BACKOFF_MS ? this.backoff : nextBackoff(this.backoff);
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    this.d.events.state('connecting');
    let token: string;
    try {
      token = await this.d.getToken();
    } catch (e) {
      if (this.stopped) return;
      if (this.connectedOnce) {
        // Signed in minutes ago: a missing token now is the laptop waking
        // before its network, with the silent refresh failing once. Stopping
        // here left the runner offline until someone ran Connect by hand.
        this.tokenMisses += 1;
        if (this.tokenMisses === 1)
          this.d.events.log(
            `no token yet (${(e as Error).message}); retrying — the sign-in usually refreshes once the network is back`,
          );
        this.d.events.state('disconnected', 'waiting for the sign-in to refresh');
        this.schedule();
        return;
      }
      // Silent auto-connect ends here when VS Code will not hand over the
      // session without a prompt; say so in the log so it is never empty.
      this.stopped = true;
      this.d.events.log(`no token: ${(e as Error).message}`);
      this.d.events.state('unauthorized', (e as Error).message);
      return;
    }
    if (this.tokenMisses > 0) {
      this.d.events.log(`sign-in token available again after ${this.tokenMisses} attempt(s)`);
      this.tokenMisses = 0;
    }
    // stop() may have landed while the token fetch was in flight (the auth
    // provider fires session-change events during sign-in, and the extension
    // rebuilds the link on those). Opening a socket now would leak one
    // connection per superseded link — the "N upgrades in 10 ms" fan-out.
    if (this.stopped) return;

    const WS = this.d.WebSocketImpl ?? WebSocket;
    const ws = new WS(wsUrl(this.d.serverUrl), { headers: authHeader(token) });
    this.ws = ws;
    let welcomed = false;

    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      this.d.events.log(`HTTP ${code} on upgrade`);
      // Detach BEFORE terminating: the resulting 'close' event must not be
      // mistaken for a live session dropping, or it would overwrite the state
      // we set here and schedule a retry of a refusal.
      this.ws = null;
      ws.terminate();
      if (code === 401 || code === 403) {
        // A refused token is not transient. Stop until the user acts (Connect),
        // which re-requests a token from the auth provider.
        this.stopped = true;
        this.d.events.state('unauthorized', `server refused the token (HTTP ${code})`);
        return;
      }
      this.schedule();
    });
    ws.on('open', () => ws.send(JSON.stringify(helloFrame(this.d.machine))));
    ws.on('message', (data) => {
      let f: Frame;
      try {
        f = JSON.parse(String(data)) as Frame;
      } catch {
        return;
      }
      if (f.type === 'welcome') {
        welcomed = true;
        this.backoff = 1000;
        this.connectedOnce = true;
        const pairing = (f.pairing === 'pending' || f.pairing === 'revoked' ? f.pairing : 'approved') as PairingState;
        const offered = parseOffer(f.update);
        this.welcome = {
          userId: String(f.userId),
          displayName: String(f.displayName),
          keepaliveMs: Number(f.keepaliveMs),
          pairing,
          ...(offered ? { update: offered } : {}),
        };
        this.d.events.state('connected', `${this.welcome.displayName} (${this.welcome.userId})`);
        this.d.events.log(
          `connected as ${this.welcome.userId}; keepalive ${this.welcome.keepaliveMs}ms; pairing ${pairing}`,
        );
        if (pairing === 'pending')
          this.d.events.log("this machine is awaiting an owner's approval in NanoClaw (Manage → Runners)");
        return;
      }
      if (f.type === 'ping' && this.welcome) {
        const offered = parseOffer(f.update);
        if (offered && offered.version !== this.welcome.update?.version) {
          this.welcome = { ...this.welcome, update: offered };
          this.d.events.update?.();
        }
      }
      if (f.type === 'error') {
        this.d.events.log(`server: ${f.code} — ${f.message}`);
        return;
      }
      if (f.type === 'pairing' && this.welcome) {
        // An owner decided while we were connected. Revocation is followed by a
        // 4403 close from the server; the close handler treats that as terminal.
        this.welcome = {
          ...this.welcome,
          pairing: f.status === 'approved' ? 'approved' : f.status === 'pending' ? 'pending' : 'revoked',
        };
        this.d.events.log(`pairing ${this.welcome.pairing}`);
        this.d.events.state('connected', `${this.welcome.displayName} (${this.welcome.userId})`);
        return;
      }
      if (f.type === 'req') {
        void this.serve(ws, f);
        return;
      }
      if (this.d.onFrame?.(f)) return;
      const r = replyFor(f);
      if (r) ws.send(JSON.stringify(r));
    });
    ws.on('error', (e) => this.d.events.log(`socket error: ${e.message}`));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcome = null;
      this.d.events.log(`disconnected (${code}${reason.length ? ' ' + reason.toString() : ''})`);
      if (code === 4409) {
        // Another window on this machine took the connection. Both windows
        // reconnecting at once would trade it forever, so the loser waits a
        // long time — long enough to be quiet, short enough to recover when
        // the other window closes.
        this.d.events.log('another VS Code window on this machine holds the runner connection; standing by');
        this.d.events.state('disconnected', 'another window holds this machine');
        this.backoff = SUPERSEDED_BACKOFF_MS;
        this.schedule();
        return;
      }
      if (code === 4403) {
        // Refused after auth: revoked machine or fingerprint bound to another user.
        // Not transient — stop until the user acts.
        this.stopped = true;
        this.d.events.state('unauthorized', `server refused this machine (${reason.toString() || '4403'})`);
        return;
      }
      if (!this.stopped) {
        this.d.events.state('disconnected');
        if (welcomed) this.backoff = 1000;
        this.schedule();
      }
    });
  }

  private async serve(ws: WebSocket, f: Frame): Promise<void> {
    const id = String(f.id ?? '');
    const op = String(f.op ?? '');
    const { type: _t, id: _i, op: _o, ...payload } = f;
    const reply = (body: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'res', id, ...body }));
    };
    if (!this.d.onRequest) {
      reply({ ok: false, error: `this runner does not serve requests (${op})` });
      return;
    }
    try {
      const result = await this.d.onRequest(op, payload);
      reply({ ok: true, ...result });
    } catch (e) {
      const err = e as Error & { failure?: unknown };
      if (op !== 'bundle') this.logRefusal(op, err.message);
      reply({ ok: false, error: err.message, ...(err.failure ? { failure: err.failure } : {}) });
    }
  }
}

/** The served-build offer as central sends it; anything malformed is no offer. */
export function parseOffer(raw: unknown): UpdateOffer | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as { version?: unknown; sha256?: unknown; size?: unknown };
  if (typeof u.version !== 'string' || typeof u.sha256 !== 'string') return null;
  return { version: u.version, sha256: u.sha256, ...(typeof u.size === 'number' ? { size: u.size } : {}) };
}
