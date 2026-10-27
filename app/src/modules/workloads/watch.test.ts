import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INSTALL_SLUG } from '../../config.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { networkName } from './docker.js';
import { MAX_NETWORKS } from './override.js';
import { claimNetwork } from './store.js';
import { onStart, parseStart } from './watch.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});
afterEach(async () => {
  await closeDb();
});

describe('the start watcher', () => {
  it('takes agent starts of this install only', () => {
    const ev = (attrs: Record<string, string>, Action = 'start') =>
      JSON.stringify({ Action, Actor: { Attributes: attrs } });
    const agent = `ncl-${INSTALL_SLUG}-sess-1`;
    expect(parseStart(ev({ 'nanoclaw-install': INSTALL_SLUG, 'nanoclaw-group': 'ag1', name: agent }))).toEqual({
      agentGroupId: 'ag1',
      container: agent,
    });
    // Labels baked into a workload image do not make it an agent container.
    expect(
      parseStart(ev({ 'nanoclaw-install': INSTALL_SLUG, 'nanoclaw-group': 'ag1', name: `nc-${INSTALL_SLUG}-x-web-1` })),
    ).toBeNull();
    expect(parseStart(ev({ 'nanoclaw-install': 'other', 'nanoclaw-group': 'ag1', name: 'ncl-x' }))).toBeNull();
    expect(parseStart(ev({ 'nanoclaw-install': INSTALL_SLUG, name: 'gw' }))).toBeNull();
    expect(
      parseStart(ev({ 'nanoclaw-install': INSTALL_SLUG, 'nanoclaw-group': 'ag1', name: agent }, 'die')),
    ).toBeNull();
    expect(parseStart('not json')).toBeNull();
  });

  it('joins a started agent container to its own agent’s network only', async () => {
    const joined: string[] = [];
    const connect = async (network: string, container: string) => joined.push(`${network} ${container}`);
    await onStart('ag-none', 'ncl-x-1', connect);
    expect(joined).toEqual([]);
    const net = await claimNetwork('ag-1', networkName, MAX_NETWORKS);
    await onStart('ag-1', 'ncl-x-2', connect);
    expect(joined).toEqual([`${net.network} ncl-x-2`]);
    // An "already attached" answer is not an error worth a warning; other failures do not throw either.
    await onStart('ag-1', 'ncl-x-3', async () => {
      throw new Error('endpoint already exists');
    });
  });
});
