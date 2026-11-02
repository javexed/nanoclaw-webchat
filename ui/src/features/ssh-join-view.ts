// Admin → Machines → Join over SSH: the dialog's steps and the output stream,
// pure so they are tested without a DOM (ssh-join-view.test.ts). SshJoin.vue
// renders it; the secrets themselves never enter this state.

export type JoinEvent = { t: 'out'; s: string } | { t: 'done'; ok: boolean; error?: string };

export interface SshState {
  phase: 'form' | 'confirm' | 'running' | 'done';
  host: string;
  port: string;
  username: string;
  auth: 'password' | 'key';
  probeId?: string;
  fingerprint?: string;
  address?: string;
  output: string;
  ok?: boolean;
  error?: string;
}

export type SshAction =
  | { type: 'probed'; probeId: string; fingerprint: string; address: string }
  | { type: 'start' }
  | { type: 'event'; event: JoinEvent }
  | { type: 'reset' };

/** Output kept in the box, from the end: an installer is chatty, the tail matters. */
export const OUTPUT_MAX = 200_000;

export const initialSsh = (): SshState => ({
  phase: 'form',
  host: '',
  port: '22',
  username: '',
  auth: 'password',
  output: '',
});

export function reduceSsh(s: SshState, a: SshAction): SshState {
  switch (a.type) {
    case 'probed':
      return { ...s, phase: 'confirm', probeId: a.probeId, fingerprint: a.fingerprint, address: a.address };
    case 'start':
      return { ...s, phase: 'running', output: '', ok: undefined, error: undefined };
    case 'event':
      if (a.event.t === 'out') return { ...s, output: (s.output + a.event.s).slice(-OUTPUT_MAX) };
      return { ...s, phase: 'done', ok: a.event.ok, error: a.event.error, probeId: undefined };
    case 'reset':
      return initialSsh();
  }
}

/** Connect needs a host, a port and a user; Join a password or a key. */
export const canConnect = (s: SshState): boolean =>
  !!s.host.trim() &&
  /^\d{1,5}$/.test(s.port.trim()) &&
  Number(s.port) >= 1 &&
  Number(s.port) <= 65535 &&
  !!s.username.trim();
export const canJoin = (s: SshState, secret: { password: string; privateKey: string }): boolean =>
  s.phase === 'confirm' && (s.auth === 'password' ? !!secret.password : !!secret.privateKey.trim());

/** Split a server-sent event stream: whole events out, the unfinished tail kept for the next chunk. */
export function parseSse(buf: string): { events: JoinEvent[]; rest: string } {
  const parts = buf.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: JoinEvent[] = [];
  for (const p of parts) {
    const data = p
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as JoinEvent);
    } catch {
      /* not ours: ignore */
    }
  }
  return { events, rest };
}
