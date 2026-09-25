import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { RunnerSessionStore } from './runner-sessions-store.js';

const key = { installSlug: 'i', agentGroupId: 'g', sessionId: 's' };

describe('runner session store', () => {
  it('survives a restart: sessions, holds and queued stops come back from disk, readable by this user only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-rss-'));
    try {
      const file = path.join(dir, 'runner-sessions.json');
      const a = new RunnerSessionStore(file);
      a.put({ key, fingerprint: 'fp', token: 'tok' });
      a.update(key, { name: 'ncl-i-s', suspendedSince: 123 });
      a.setStop('fp', 'ncl-old', 'absolute-ceiling');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);

      const b = new RunnerSessionStore(file); // a new process
      expect(b.get(key)).toEqual({ key, fingerprint: 'fp', token: 'tok', name: 'ncl-i-s', suspendedSince: 123 });
      expect(b.byToken('tok')?.key).toEqual(key);
      expect(b.byFingerprint('fp')).toHaveLength(1);
      expect(b.stops('fp')).toEqual({ 'ncl-old': 'absolute-ceiling' });

      b.update(key, { suspendedSince: undefined });
      b.clearStop('fp', 'ncl-old');
      const c = new RunnerSessionStore(file);
      expect(c.get(key)?.suspendedSince).toBeUndefined();
      expect(c.stops('fp')).toEqual({});
      c.delete(key);
      expect(new RunnerSessionStore(file).all()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable file starts empty rather than failing central', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-rss-'));
    try {
      const file = path.join(dir, 'runner-sessions.json');
      fs.writeFileSync(file, '{not json');
      expect(new RunnerSessionStore(file).all()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
