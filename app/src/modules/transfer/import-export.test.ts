/**
 * Room import and system export against a real (test) central DB: both went
 * wrong silently when the DB calls became async — a room-id loop that never
 * ended, and a backup manifest serialized from a Promise ({}).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { previewRoomImport, ROOM_FORMAT, ROOM_VERSION } from './room-transfer.js';
import { carrySecretsForward, previewSystemImport, stageSystemExport, systemTarArgs } from './system-transfer.js';

let tmp: string;

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-transfer-'));
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const withTimeout = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms))]);

describe('room import preview', () => {
  it('suggests a free room id when the exported one is taken, and returns', async () => {
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'webchat',
      platform_id: 'research',
      name: 'Research',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    } as never);
    fs.writeFileSync(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({
        format: ROOM_FORMAT,
        version: ROOM_VERSION,
        createdAt: new Date().toISOString(),
        entity: { roomId: 'research', name: 'Research' },
        counts: { messages: 0, threads: 0, files: 0 },
        references: { agents: [] },
      }),
    );
    const preview = await withTimeout(previewRoomImport(tmp));
    expect(preview.suggestedRoomId).toBe('research-2');
  });
});

describe('system export', () => {
  it('writes a manifest its own import accepts', async () => {
    const stage = await stageSystemExport(true);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
      expect(manifest.format).toBe('nanoclaw-system-export');
      expect(manifest.counts).toBeDefined();
      await expect(previewSystemImport(stage)).resolves.toBeDefined();
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
});

describe('system export secrets', () => {
  const mcpAuthIn = (stage: string): unknown => {
    const db = new Database(path.join(stage, 'db', 'v2.db'), { readonly: true });
    try {
      return (db.prepare(`SELECT auth FROM webchat_mcp_servers WHERE id = 'mcp-1'`).get() as { auth: unknown }).auth;
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    await getDb().run(
      `INSERT INTO webchat_mcp_servers (id, name, transport, url, auth, created_at) VALUES ('mcp-1', 'docs', 'http', 'https://mcp.example.com', ?, 0)`,
      JSON.stringify({ kind: 'bearer', token: 'tok-secret' }),
    );
  });

  it('strips MCP tokens from the snapshot and says so, by default', async () => {
    const stage = await stageSystemExport(true);
    try {
      expect(JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8')).secretsIncluded).toBe(false);
      expect(mcpAuthIn(stage)).toBeNull();
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('keeps them when the exporter opts in', async () => {
    const stage = await stageSystemExport(true, true);
    try {
      expect(JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8')).secretsIncluded).toBe(true);
      expect(String(mcpAuthIn(stage))).toContain('tok-secret');
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('leaves key files out of the tar unless opted in', async () => {
    const without = systemTarArgs('/tmp/stage', true);
    for (const e of ['deploy_key_*', 'litellm/env', 'litellm/master.key']) expect(without).toContain(`--exclude=${e}`);
    expect(systemTarArgs('/tmp/stage', true, true).some((a) => /deploy_key|litellm\/(env|master)/.test(a))).toBe(false);
  });
});

describe('restore without secrets', () => {
  it("carries the running install's secrets into the restored state, never over the bundle's", async () => {
    const ts = 'T1';
    const data = path.join(tmp, 'data');
    const groups = path.join(tmp, 'groups');
    const write = (p: string, body: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    // What the swap left behind: the restored trees, and the old ones aside.
    write(path.join(data, 'litellm', 'config.yaml'), 'restored');
    write(path.join(data, `litellm.pre-restore-${ts}`, 'env'), 'OPENAI_API_KEY=old');
    write(path.join(data, `litellm.pre-restore-${ts}`, 'master.key'), 'mk-old');
    write(path.join(groups, 'agent-a', 'CLAUDE.md'), 'restored');
    write(path.join(groups, 'agent-a', 'deploy_key_gh'), 'from-bundle');
    write(path.join(`${groups}.pre-restore-${ts}`, 'agent-a', 'deploy_key_gh'), 'old');
    write(path.join(`${groups}.pre-restore-${ts}`, 'agent-a', 'deploy_key_ci'), 'old-ci');
    write(path.join(`${groups}.pre-restore-${ts}`, 'agent-gone', 'deploy_key_x'), 'old-x');
    for (const [file, auth] of [
      ['v2.db', null],
      [`v2.db.pre-restore-${ts}`, '{"kind":"bearer","token":"tok-old"}'],
    ] as const) {
      const db = new Database(path.join(data, file));
      db.exec('CREATE TABLE webchat_mcp_servers (id TEXT PRIMARY KEY, auth TEXT)');
      db.prepare(`INSERT INTO webchat_mcp_servers VALUES ('mcp-1', ?)`).run(auth);
      db.close();
    }

    carrySecretsForward(ts, data, groups);

    expect(fs.readFileSync(path.join(data, 'litellm', 'env'), 'utf8')).toBe('OPENAI_API_KEY=old');
    expect(fs.statSync(path.join(data, 'litellm', 'env')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(data, 'litellm', 'master.key'), 'utf8')).toBe('mk-old');
    expect(fs.readFileSync(path.join(groups, 'agent-a', 'deploy_key_gh'), 'utf8')).toBe('from-bundle');
    expect(fs.readFileSync(path.join(groups, 'agent-a', 'deploy_key_ci'), 'utf8')).toBe('old-ci');
    expect(fs.existsSync(path.join(groups, 'agent-gone'))).toBe(false);
    const db = new Database(path.join(data, 'v2.db'), { readonly: true });
    expect((db.prepare(`SELECT auth FROM webchat_mcp_servers`).get() as { auth: string }).auth).toContain('tok-old');
    db.close();
  });
});
