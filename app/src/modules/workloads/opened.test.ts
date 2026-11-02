/**
 * When people last opened an app: written at most once per app every few
 * minutes, whatever the page loads, and read back per workload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { __resetOpenedForTest, lastOpened, noteOpened, OPENED_EVERY_MS } from './opened.js';
import { getRoute, insertRoute } from './routes.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  __resetOpenedForTest();
});
afterEach(async () => {
  await closeDb();
});

const route = (app: string, workloadId = 'w1') =>
  insertRoute({
    app,
    workloadId,
    agentGroupId: 'ag-1',
    service: 'web',
    port: 8080,
    kind: 'tailnet',
    who: 'only-me',
    ownerUserId: null,
    ticket: null,
    createdBy: 'host',
  });

describe('noting an app as opened', () => {
  it('writes once per app per interval, each app on its own', async () => {
    const writes: Array<[string, number]> = [];
    const write = async (id: string, at: number) => void writes.push([id, at]);
    const t0 = 1_000_000;
    expect(await noteOpened('a', t0, write)).toBe(true);
    // Forty assets of the same page, a minute of clicking: no more writes.
    for (let i = 0; i < 40; i++) expect(await noteOpened('a', t0 + i * 1000, write)).toBe(false);
    expect(await noteOpened('b', t0 + 5, write)).toBe(true);
    expect(await noteOpened('a', t0 + OPENED_EVERY_MS - 1, write)).toBe(false);
    expect(await noteOpened('a', t0 + OPENED_EVERY_MS, write)).toBe(true);
    expect(writes).toEqual([
      ['a', t0],
      ['b', t0 + 5],
      ['a', t0 + OPENED_EVERY_MS],
    ]);
  });

  it('tries again on the next request when a write failed, and never throws', async () => {
    let fail = true;
    const write = async () => {
      if (fail) throw new Error('database is locked');
    };
    expect(await noteOpened('a', 1, write)).toBe(false);
    fail = false;
    expect(await noteOpened('a', 2, write)).toBe(true);
  });

  it('records it on the route, never moving it back, and reads the newest per workload', async () => {
    const a = await route('notes');
    const b = await route('notes-admin');
    await route('other', 'w2');
    expect(await lastOpened('w1')).toBeNull();
    await noteOpened(a.id, 5000);
    await noteOpened(b.id, 9000);
    expect((await getRoute(a.id))!.lastOpenedAt).toBe(5000);
    expect(await lastOpened('w1')).toBe(9000);
    expect(await lastOpened('w2')).toBeNull();
    __resetOpenedForTest();
    await noteOpened(b.id, 7000);
    expect((await getRoute(b.id))!.lastOpenedAt).toBe(9000);
  });
});
