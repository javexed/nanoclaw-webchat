/**
 * The local-model wiring file (`local-model.json`, legacy `opencode-model.json`)
 * that `writeLocalModelForAgent` writes for pi groups only. Two-sided contract:
 *
 *   - the WRITER emits only the new name and REMOVES the legacy one — the
 *     clearing path too, or the readers' fallback serves stale wiring;
 *   - the READERS (skill payloads, tested by their own shape) accept either
 *     name, new first.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-localmodel-'));
});

afterEach(async () => {
  try {
    const conn = await import('../../db/connection.js');
    await conn.closeDb();
  } catch {
    // ignore
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

const GROUP = 'ag-local';

/** A group on a local harness with an ollama-kind model assigned. */
async function seed(kind: 'ollama' | 'anthropic', provider: string | null) {
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  await migrations.runMigrations(conn.getDb());
  await conn
    .getDb()
    .run(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?,?,?,NULL,'t')`,
      GROUP,
      GROUP,
      GROUP,
    );

  const db = await import('./db.js');
  await db.createWebchatModel({
    id: 'm-1',
    name: 'm-1',
    kind,
    endpoint: kind === 'anthropic' ? null : 'http://127.0.0.1:11434',
    model_id: 'qwen3:8b',
    credential_ref: null,
    created_at: Date.now(),
  });
  await db.assignModelToAgent(GROUP, 'm-1');

  const cc = await import('../../db/container-configs.js');
  await cc.ensureContainerConfig(GROUP);
  if (provider) {
    await cc.updateContainerConfigScalars(GROUP, { provider });
    // Setting the column is not enough: the writer asks whether the harness is
    // INSTALLED (registered in the provider-container registry), because a
    // composed tree carries no optional provider — they arrive as skill payload.
    const reg = await import('../../providers/provider-container-registry.js');
    reg.registerProviderContainerConfig(provider, () => ({ env: {} }));
  }
  return await import('./models.js');
}

/** The .claude-shared dir the writer targets — it only writes if this exists. */
async function sharedDir(): Promise<string> {
  const { DATA_DIR } = await import('../../config.js');
  const dir = path.join(DATA_DIR, 'v2-sessions', GROUP, '.claude-shared');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('local-model wiring file', () => {
  it('writes the new name and leaves no legacy file behind', async () => {
    const models = await seed('ollama', 'pi');
    const dir = await sharedDir();
    // An install that predates the rename is still carrying the old file.
    fs.writeFileSync(path.join(dir, 'opencode-model.json'), '{"provider":"stale"}');

    await models.writeLocalModelForAgent(GROUP);

    expect(fs.existsSync(path.join(dir, 'local-model.json'))).toBe(true);
    // The legacy copy must go, or the readers' fallback could serve "stale"
    // forever while this function believes it rewrote the wiring.
    expect(fs.existsSync(path.join(dir, 'opencode-model.json'))).toBe(false);
    fs.rmSync(path.join((await import('../../config.js')).DATA_DIR, 'v2-sessions', GROUP), {
      recursive: true,
      force: true,
    });
  });

  it('clears BOTH names when the group is no longer on a local harness', async () => {
    const models = await seed('ollama', null); // default provider — not local
    const dir = await sharedDir();
    fs.writeFileSync(path.join(dir, 'local-model.json'), '{"provider":"ollama"}');
    fs.writeFileSync(path.join(dir, 'opencode-model.json'), '{"provider":"ollama"}');

    await models.writeLocalModelForAgent(GROUP);

    expect(fs.existsSync(path.join(dir, 'local-model.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'opencode-model.json'))).toBe(false);
    fs.rmSync(path.join((await import('../../config.js')).DATA_DIR, 'v2-sessions', GROUP), {
      recursive: true,
      force: true,
    });
  });

  it('writes nothing for an OpenCode group — its provider reads container_configs.model', async () => {
    const models = await seed('ollama', 'opencode');
    const dir = await sharedDir();
    fs.writeFileSync(path.join(dir, 'local-model.json'), '{"provider":"ollama"}');

    await models.writeLocalModelForAgent(GROUP);

    expect(fs.existsSync(path.join(dir, 'local-model.json'))).toBe(false);
    fs.rmSync(path.join((await import('../../config.js')).DATA_DIR, 'v2-sessions', GROUP), {
      recursive: true,
      force: true,
    });
  });

  it('exports both names, so the readers and the writer cannot drift apart', async () => {
    const models = await import('./models.js');
    expect(models.LOCAL_MODEL_FILE).toBe('local-model.json');
    expect(models.LEGACY_LOCAL_MODEL_FILE).toBe('opencode-model.json');
  });
});

describe('the skill payloads read BOTH names, new first', () => {
  // The payloads run in the host but ship as skill files, so they are asserted
  // by shape rather than executed: a reader that stops accepting the legacy
  // name would strand every install whose file predates the rename.
  it.each([['pi', '.claude/skills/add-pi-stack/files/pi.host.ts']])(
    '%s reader tries local-model.json before opencode-model.json',
    (_name, rel) => {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      const order = src.match(/\['local-model\.json', 'opencode-model\.json'\]/);
      expect(order, `${rel} must read both names, new first`).not.toBeNull();
    },
  );

  // Upstream's add-opencode owns the provider. A `files/` directory here would
  // be a re-forked provider silently shadowing upstream's payload at install
  // time (nc:copy skips a destination that already exists).
  it('add-opencode-stack ships no forked payload — upstream owns the provider', () => {
    const dir = path.join(process.cwd(), '.claude/skills/add-opencode-stack/files');
    expect(fs.existsSync(dir), `${dir} must not exist — upstream's add-opencode owns the provider`).toBe(false);
  });
});
