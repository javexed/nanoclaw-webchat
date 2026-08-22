/**
 * Member Grok device login.
 *
 * The wizard's flow is deliberately not reused, so the properties that make
 * this one member-safe are not inherited from anywhere — they are pinned here:
 * two members can sign in at once, a credential is claimable exactly once, and
 * one member's login is invisible to another.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let available = true;
const spawned: FakeProc[] = [];

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  dir: string;
  constructor(args: string[]) {
    super();
    // The bind mount is the container's view of the temp dir the flow made.
    this.dir = (args.find((a) => a.includes(':/home/node/.grok')) ?? '').split(':')[0];
  }
  kill() {
    this.killed = true;
  }
  /** Drive a successful login all the way to a written auth.json. */
  succeed(cred: Record<string, unknown>) {
    fs.writeFileSync(path.join(this.dir, 'auth.json'), JSON.stringify(cred));
    this.emit('exit', 0);
  }
}

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (_cmd: string, args: string[]) => {
    const p = new FakeProc(args);
    spawned.push(p);
    return p;
  },
}));
vi.mock('./providers.js', () => ({ grokAvailable: () => available }));
vi.mock('../../../container-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../container-config.js')>()),
  getDefaultContainerImage: () => 'nanoclaw-agent:test',
}));

const { __resetMemberLogins, cancelMemberLogin, claimMemberCredential, getMemberLoginProgress, startMemberLogin } =
  await import('./grok-member-login.js');

// The real shape the Grok CLI writes: one entry keyed `issuer::clientId`, with
// the access token under `key`. Getting this wrong is exactly how a login looks
// successful and then produces nothing.
const CLI_AUTH = {
  'https://auth.x.ai::cid': {
    key: 'at-live',
    refresh_token: 'rt-live',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    create_time: new Date().toISOString(),
  },
};

beforeEach(() => {
  available = true;
  spawned.length = 0;
  __resetMemberLogins();
});
afterEach(() => __resetMemberLogins());

describe('startMemberLogin', () => {
  it('reports nothing at all for a member who never started one', () => {
    expect(getMemberLoginProgress('webchat:nobody')).toMatchObject({ running: false, outcome: null });
  });

  it('refuses when Grok is not installed, without spawning anything', () => {
    available = false;
    expect(startMemberLogin('webchat:alice')).toEqual({ started: false, error: 'not-installed' });
    expect(spawned).toHaveLength(0);
  });

  it('is single-flight per member, not globally — two members sign in at once', () => {
    expect(startMemberLogin('webchat:alice').started).toBe(true);
    expect(startMemberLogin('webchat:alice')).toEqual({ started: false, error: 'already-running' });
    // Bob is unaffected: this is the bug the wizard flow would have had.
    expect(startMemberLogin('webchat:bob').started).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it('surfaces the URL and code scraped from the CLI', () => {
    startMemberLogin('webchat:alice');
    spawned[0].stdout.emit(
      'data',
      Buffer.from('open https://accounts.x.ai/oauth2/device?user_code=H9N6-4KX3\nConfirm this code:\n  H9N6-4KX3\n'),
    );
    expect(getMemberLoginProgress('webchat:alice')).toMatchObject({
      running: true,
      outcome: 'pending',
      verificationUrl: 'https://accounts.x.ai/oauth2/device?user_code=H9N6-4KX3',
      userCode: 'H9N6-4KX3',
    });
  });
});

describe('completion', () => {
  it('holds the credential for the member who earned it and shreds the temp dir', () => {
    startMemberLogin('webchat:alice');
    const dir = spawned[0].dir;
    spawned[0].succeed(CLI_AUTH);

    expect(getMemberLoginProgress('webchat:alice')).toMatchObject({ running: false, outcome: 'complete' });
    // The refresh token must not be left lying in a world-readable temp dir.
    expect(fs.existsSync(dir)).toBe(false);

    const cred = claimMemberCredential('webchat:alice');
    expect(cred).toMatchObject({ accessToken: 'at-live', refreshToken: 'rt-live' });
  });

  it('yields the credential exactly once, so a repeated poll cannot replay it', () => {
    startMemberLogin('webchat:alice');
    spawned[0].succeed(CLI_AUTH);
    expect(claimMemberCredential('webchat:alice')).toBeTruthy();
    expect(claimMemberCredential('webchat:alice')).toBeNull();
  });

  it('never hands one member the credential another member minted', () => {
    startMemberLogin('webchat:alice');
    startMemberLogin('webchat:bob');
    spawned[0].succeed(CLI_AUTH); // alice's
    expect(claimMemberCredential('webchat:bob')).toBeNull();
    expect(getMemberLoginProgress('webchat:bob').outcome).toBe('pending');
    expect(claimMemberCredential('webchat:alice')).toBeTruthy();
  });

  it('fails cleanly when the CLI exits without writing a session', () => {
    startMemberLogin('webchat:alice');
    spawned[0].emit('exit', 0); // exit 0 but no auth.json
    const p = getMemberLoginProgress('webchat:alice');
    expect(p.outcome).toBe('failed');
    expect(p.error).toMatch(/no usable session/i);
    expect(claimMemberCredential('webchat:alice')).toBeNull();
  });

  it('reports a non-zero exit as a failure rather than hanging on pending', () => {
    startMemberLogin('webchat:alice');
    spawned[0].emit('exit', 1);
    expect(getMemberLoginProgress('webchat:alice')).toMatchObject({ outcome: 'failed', running: false });
  });
});

describe('cancelMemberLogin', () => {
  it('kills the process and stops the login', () => {
    startMemberLogin('webchat:alice');
    expect(cancelMemberLogin('webchat:alice')).toEqual({ cancelled: true });
    expect(spawned[0].killed).toBe(true);
    expect(getMemberLoginProgress('webchat:alice').running).toBe(false);
  });

  it('is a no-op for a login that already finished', () => {
    startMemberLogin('webchat:alice');
    spawned[0].succeed(CLI_AUTH);
    expect(cancelMemberLogin('webchat:alice')).toEqual({ cancelled: false });
    // Cancelling late must not discard the credential the member just earned.
    expect(claimMemberCredential('webchat:alice')).toBeTruthy();
  });

  it('does not let one member cancel another', () => {
    startMemberLogin('webchat:alice');
    expect(cancelMemberLogin('webchat:bob')).toEqual({ cancelled: false });
    expect(spawned[0].killed).toBe(false);
  });
});
