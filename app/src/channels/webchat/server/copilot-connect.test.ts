/**
 * GitHub Copilot connection: the sign-in driver, status and disconnect.
 *
 * The sign-in script is replaced by a fake child that prints the same JSON
 * events, so what is pinned here is this side of the contract: events become
 * progress, an unknown or malformed line is never echoed, a cancel reaches the
 * child as SIGTERM (the script's cue to remove its container and temp dir),
 * and a completed sign-in respawns the Copilot groups.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let available = true;
const restarted: string[] = [];
const groups = [
  { id: 'ag-copilot', provider: 'copilot' },
  { id: 'ag-claude', provider: null },
];

vi.mock('./providers.js', () => ({ copilotAvailable: () => available }));
vi.mock('../../../db/agent-groups.js', () => ({ getAllAgentGroups: async () => groups.map((g) => ({ id: g.id })) }));
vi.mock('../../../db/container-configs.js', () => ({
  getContainerConfig: async (id: string) => ({ provider: groups.find((g) => g.id === id)?.provider ?? null }),
}));
vi.mock('../../../container-restart-idle.js', () => ({
  restartAgentGroupContainersWhenIdle: async (id: string) => {
    restarted.push(id);
    return 1;
  },
}));

const {
  __resetCopilotLoginState,
  __setCopilotLoginSpawner,
  accountFile,
  cancelCopilotLogin,
  copilotStatus,
  disconnectCopilot,
  getCopilotLoginProgress,
  parseLoginEvent,
  startCopilotLogin,
  sweepOrphanedCopilotLoginContainers,
  sweepOrphanedCopilotLoginDirs,
} = await import('./copilot-connect.js');

let root: string;
let fake: string;

// A fake sign-in: prints events per mode, like `copilot-login.ts --json`.
const FAKE = `
const mode = process.argv[2];
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
process.on('SIGTERM', () => { out({ event: 'error', code: 'cancelled', message: 'Cancelled.' }); process.exit(1); });
out({ event: 'device', verificationUrl: 'https://github.com/login/device', userCode: 'ABCD-1234' });
process.stdout.write('not json, and must never be shown\\n');
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
setTimeout(() => {
  out({ event: 'status', message: 'Checking the Copilot seat…' });
  if (mode === 'ok') { out({ event: 'connected', login: 'octo', plan: 'business', apiUrl: 'https://api.business.githubcopilot.com' }); process.exit(0); }
  if (mode === 'expired') { out({ event: 'error', code: 'expired', message: 'The device code expired before it was confirmed. Start again.' }); process.exit(1); }
  out({ event: 'error', code: 'no-seat', message: 'GitHub refused Copilot for this account (403).' }); process.exit(1);
}, 50);
`;

beforeEach(() => {
  available = true;
  restarted.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-connect-'));
  fake = path.join(root, 'fake.cjs');
  fs.writeFileSync(fake, FAKE);
  __resetCopilotLoginState();
});

afterEach(() => {
  __setCopilotLoginSpawner(null);
  __resetCopilotLoginState();
  fs.rmSync(root, { recursive: true, force: true });
});

const useFake = (mode: string) =>
  __setCopilotLoginSpawner(() => spawn(process.execPath, [fake, mode], { stdio: ['ignore', 'pipe', 'pipe'] }));
const settled = () => vi.waitFor(() => expect(getCopilotLoginProgress().running).toBe(false), { timeout: 5000 });

describe('parseLoginEvent', () => {
  it('accepts the four events and nothing else', () => {
    expect(
      parseLoginEvent('{"event":"device","verificationUrl":"https://github.com/login/device","userCode":"AB12-CD34"}'),
    ).toEqual({ event: 'device', verificationUrl: 'https://github.com/login/device', userCode: 'AB12-CD34' });
    expect(parseLoginEvent('{"event":"status","message":"x"}')).toEqual({ event: 'status', message: 'x' });
    expect(parseLoginEvent('{"event":"error","message":"m"}')).toEqual({
      event: 'error',
      code: 'login-failed',
      message: 'm',
    });
    expect(parseLoginEvent('Waiting for authorization...')).toBeNull();
    expect(parseLoginEvent('{"event":"token","value":"x"}')).toBeNull();
  });

  it('never turns a non-GitHub URL into a link', () => {
    expect(
      parseLoginEvent(
        '{"event":"device","verificationUrl":"https://evil.example/login/device","userCode":"AB12-CD34"}',
      ),
    ).toBeNull();
  });
});

describe('startCopilotLogin', () => {
  it('reports the code, completes, and respawns only the Copilot groups', async () => {
    useFake('ok');
    expect(startCopilotLogin(root)).toEqual({ started: true });
    await vi.waitFor(() => expect(getCopilotLoginProgress().userCode).toBe('ABCD-1234'));
    expect(getCopilotLoginProgress()).toMatchObject({
      running: true,
      verificationUrl: 'https://github.com/login/device',
    });
    await settled();
    expect(getCopilotLoginProgress()).toMatchObject({ outcome: 'complete', error: null });
    await vi.waitFor(() => expect(restarted).toEqual(['ag-copilot']));
    expect(JSON.stringify(getCopilotLoginProgress())).not.toContain('must never be shown');
  });

  it("carries the script's own reason when the seat is refused", async () => {
    useFake('noseat');
    startCopilotLogin(root);
    await settled();
    expect(getCopilotLoginProgress()).toMatchObject({ outcome: 'failed', error: expect.stringContaining('403') });
    expect(restarted).toEqual([]);
  });

  it('reports an expired code as expired', async () => {
    useFake('expired');
    startCopilotLogin(root);
    await settled();
    expect(getCopilotLoginProgress().outcome).toBe('expired');
  });

  it('is single-flight, and refuses when the provider is absent', async () => {
    useFake('hang');
    expect(startCopilotLogin(root).started).toBe(true);
    expect(startCopilotLogin(root)).toEqual({ started: false, error: 'already-running' });
    cancelCopilotLogin();
    __resetCopilotLoginState();
    available = false;
    expect(startCopilotLogin(root)).toEqual({ started: false, error: 'not-installed' });
  });

  it('cancel sends SIGTERM to the script and ends the flow', async () => {
    let child: ReturnType<typeof spawn> | undefined;
    __setCopilotLoginSpawner(() => {
      child = spawn(process.execPath, [fake, 'hang'], { stdio: ['ignore', 'pipe', 'pipe'] });
      return child;
    });
    startCopilotLogin(root);
    await vi.waitFor(() => expect(getCopilotLoginProgress().userCode).toBe('ABCD-1234'));
    const killed = vi.spyOn(child!, 'kill');
    expect(cancelCopilotLogin()).toEqual({ cancelled: true });
    expect(killed).toHaveBeenCalledWith('SIGTERM');
    expect(getCopilotLoginProgress()).toMatchObject({ running: false, outcome: 'failed', error: 'Cancelled.' });
    expect(cancelCopilotLogin()).toEqual({ cancelled: false });
  });
});

describe('copilotStatus', () => {
  const writeAccount = (body: unknown) => {
    fs.mkdirSync(path.dirname(accountFile(root)), { recursive: true });
    fs.writeFileSync(accountFile(root), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const writeRecord = (ids: string[]) => {
    fs.mkdirSync(path.join(root, 'data', 'onecli'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'onecli', 'provider-credentials.json'),
      JSON.stringify({ providers: { copilot: ids }, matched: [] }),
    );
  };

  it('is not installed, then not connected, then connected', () => {
    available = false;
    expect(copilotStatus(root)).toEqual({ available: false, connected: false });
    available = true;
    expect(copilotStatus(root)).toEqual({ available: true, connected: false });
    writeAccount({
      login: 'octo',
      plan: 'business',
      apiUrl: 'https://api.business.githubcopilot.com',
      connectedAt: 'x',
    });
    expect(copilotStatus(root)).toEqual({
      available: true,
      connected: true,
      login: 'octo',
      plan: 'business',
      apiUrl: 'https://api.business.githubcopilot.com',
      connectedAt: 'x',
    });
  });

  it('reads a corrupt record, or a gateway record without ids, as not connected', () => {
    writeAccount('{half');
    expect(copilotStatus(root).connected).toBe(false);
    writeAccount({ plan: 'business', apiUrl: 'https://api.business.githubcopilot.com' });
    writeRecord([]);
    expect(copilotStatus(root).connected).toBe(false);
    writeRecord(['s1']);
    expect(copilotStatus(root).connected).toBe(true);
  });
});

describe('disconnectCopilot', () => {
  it('deletes only recorded secrets with the sign-in names, then forgets them', async () => {
    fs.mkdirSync(path.join(root, 'data', 'onecli'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'onecli', 'provider-credentials.json'),
      JSON.stringify({ providers: { copilot: ['s1', 's2', 's3'], codex: ['c1'] }, matched: [] }),
    );
    fs.mkdirSync(path.dirname(accountFile(root)), { recursive: true });
    fs.writeFileSync(accountFile(root), '{}');
    fs.writeFileSync(path.join(root, '.env'), 'A=1\nCOPILOT_API_URL=https://api.business.githubcopilot.com\n');
    const deleted: string[] = [];
    const record = { providers: { copilot: ['s1', 's2', 's3'], codex: ['c1'] } as Record<string, string[]> };
    const res = await disconnectCopilot(root, {
      admin: {
        listAllSecrets: async () => [
          { id: 's1', name: 'Copilot GitHub' },
          { id: 's2', name: 'Copilot API' },
          { id: 's3', name: 'Something else' }, // recorded but not ours by name
          { id: 'x9', name: 'Copilot API' }, // ours by name, but another install's
        ],
        deleteSecret: async (id: string) => {
          deleted.push(id);
        },
      },
      updateRecord: async (_dir, change) => change(record),
    });
    expect(res).toEqual({ deleted: 2 });
    expect(deleted).toEqual(['s1', 's2']);
    expect(record.providers).toEqual({ codex: ['c1'] });
    expect(fs.existsSync(accountFile(root))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('with nothing recorded, touches no secret', async () => {
    const listed = vi.fn(async () => []);
    await disconnectCopilot(root, { admin: { listAllSecrets: listed, deleteSecret: vi.fn() }, updateRecord: null });
    expect(listed).not.toHaveBeenCalled();
  });
});

describe('sweepOrphanedCopilotLoginDirs', () => {
  it('removes only stale login dirs', () => {
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    for (const n of ['copilot-login-old', 'copilot-login-new', 'other-old']) fs.mkdirSync(path.join(tmp, n));
    const old = (Date.now() - 60 * 60_000) / 1000;
    fs.utimesSync(path.join(tmp, 'copilot-login-old'), old, old);
    fs.utimesSync(path.join(tmp, 'other-old'), old, old);
    expect(sweepOrphanedCopilotLoginDirs(Date.now(), tmp)).toBe(1);
    expect(fs.readdirSync(tmp).sort()).toEqual(['copilot-login-new', 'other-old']);
  });
});

describe('sweepOrphanedCopilotLoginContainers', () => {
  it('removes only login containers older than the login timeout', async () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] !== 'ps') return '';
      return [
        'nanoclaw-copilot-login-aaaaaa|2026-10-26 10:00:00 +0000 UTC',
        'nanoclaw-copilot-login-bbbbbb|2026-10-26 11:55:00 +0000 UTC',
        'nanoclaw-agent-x|2026-10-26 09:00:00 +0000 UTC',
        '',
      ].join('\n');
    };
    expect(await sweepOrphanedCopilotLoginContainers(now, run)).toBe(1);
    expect(calls.filter((c) => c[0] === 'rm')).toEqual([['rm', '-f', 'nanoclaw-copilot-login-aaaaaa']]);
  });
});
