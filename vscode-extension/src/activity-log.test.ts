import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVITY_FILE, ActivityLog, activityLogFile, initActivityLog, recordActivity } from './activity-log.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-activity-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const lines = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('activity log', () => {
  it('appends one JSON object per line with a timestamp and the event', () => {
    const dir = tmp();
    const log = new ActivityLog(dir, 1024, 3, () => new Date('2026-09-26T10:00:00Z'));
    log.append('session.start', { name: 'c1', session: 's1' });
    log.append('proposal.apply', { file: 'src/a.ts' });
    expect(lines(path.join(dir, ACTIVITY_FILE))).toEqual([
      { t: '2026-09-26T10:00:00.000Z', event: 'session.start', name: 'c1', session: 's1' },
      { t: '2026-09-26T10:00:00.000Z', event: 'proposal.apply', file: 'src/a.ts' },
    ]);
  });

  it('rotates at the size limit and keeps three files', () => {
    const dir = tmp();
    const log = new ActivityLog(dir, 200, 3);
    for (let i = 0; i < 40; i++) log.append('review', { file: `f${i}.ts`, pad: 'x'.repeat(40) });
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual([ACTIVITY_FILE, `${ACTIVITY_FILE}.1`, `${ACTIVITY_FILE}.2`]);
    for (const n of names) expect(fs.statSync(path.join(dir, n)).size).toBeLessThanOrEqual(200);
    // The newest entry is in the current file, the oldest ones are gone.
    expect(lines(path.join(dir, ACTIVITY_FILE)).at(-1)?.file).toBe('f39.ts');
    const all = names.flatMap((n) => lines(path.join(dir, n)).map((e) => e.file));
    expect(all).not.toContain('f0.ts');
  });

  it('recordActivity is a no-op before init and writes after it; a failing disk never throws', () => {
    recordActivity('stop-all', { names: [] }); // nothing to write to yet: fine
    const dir = tmp();
    initActivityLog(dir);
    recordActivity('stop-all', { names: ['c1'] });
    expect(activityLogFile()).toBe(path.join(dir, ACTIVITY_FILE));
    expect(lines(activityLogFile()!)[0]).toMatchObject({ event: 'stop-all', names: ['c1'] });
    const blocked = path.join(tmp(), 'file');
    fs.writeFileSync(blocked, '');
    expect(() => new ActivityLog(path.join(blocked, 'sub')).append('x')).not.toThrow();
  });
});
