import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerAgent, recoverLaptopToolsProposal } from './agent.js';
import { rejectProposal } from './git-changes.js';

let tmp: string;
let slots: Record<string, string>;
let allowlist: string[];
let logs: string[];
/** The install central's welcome named (undefined: before any welcome). */
let welcomeInstall: string | undefined;
/** Set when the developer pressed Stop all on this machine. */
let haltedBy: string | null;
const agent = () =>
  new RunnerAgent({
    storageRoot: path.join(tmp, 'runner'),
    policy: () => ({ slots, allowlist }),
    installSlug: () => welcomeInstall,
    halted: () => haltedBy,
    log: (l) => logs.push(l),
  });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-agent-'));
  slots = {};
  allowlist = [];
  logs = [];
  welcomeInstall = undefined;
  haltedBy = null;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const makeRepo = () => {
  const repo = path.join(tmp, 'project');
  fs.mkdirSync(repo, { recursive: true });
  const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  sh(['init', '-q']);
  sh(['config', 'user.email', 't@t']);
  sh(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
  sh(['add', 'app.ts']);
  sh(['commit', '-qm', 'init']);
  slots = { '/workspace/project': repo };
  allowlist = [tmp];
  return repo;
};
const scope = { installSlug: 'spike', agentGroupId: 'ag-tools' };

describe('RunnerAgent: the copy follows the developer mid-session', () => {
  const quick = () =>
    new RunnerAgent({
      storageRoot: path.join(tmp, 'runner'),
      policy: () => ({ slots, allowlist }),
      installSlug: () => welcomeInstall,
      halted: () => haltedBy,
      log: (l) => logs.push(l),
      stampCheckMs: 0,
    });
  const commit = (repo: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
    const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    sh(['add', rel]);
    sh(['commit', '-qm', `add ${rel}`]);
  };

  it('a pull after the agent started reaches its next tool call', async () => {
    const repo = makeRepo();
    const a = quick();
    await a.handle('tools.list', scope);
    commit(repo, 'scripts/compare.sh', 'echo hi\n'); // as a git pull would bring it
    const read = await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'scripts/compare.sh' } });
    expect(read.isError).toBeFalsy();
    expect(String(read.text)).toContain('echo hi');
    expect(logs.some((l) => l.includes("the agent's copy was taken again"))).toBe(true);
  });

  it("a copy holding the agent's unapplied edits is not refreshed under them, and says so once", async () => {
    const repo = makeRepo();
    const a = quick();
    await a.handle('tools.list', scope);
    await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } });
    const edit = await a.handle('tools.call', {
      ...scope,
      name: 'Edit',
      input: { file_path: 'app.ts', old_string: 'x = 1', new_string: 'x = 2' },
    });
    expect(edit.isError).toBeFalsy();
    commit(repo, 'later.txt', 'new\n');
    expect((await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'later.txt' } })).isError).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(a.currentProposal()!.dir, 'app.ts'), 'utf8')).toBe('export const x = 2;\n');
    commit(repo, 'later2.txt', 'new\n');
    await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } });
    expect(logs.filter((l) => l.includes('the copy holds a proposal'))).toHaveLength(1);
    // The developer rejects the proposal; nothing moves in the folder after that,
    // yet the copy catches up with what it missed while it was held.
    await rejectProposal(a.currentProposal()!);
    const read = await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'later.txt' } });
    expect(read.isError).toBeFalsy();
    expect(String(read.text)).toContain('new');
  });
});

describe('RunnerAgent: folder consent', () => {
  it('a refusal with a reason (an untrusted folder) reaches the agent as that reason', async () => {
    makeRepo();
    const a = new RunnerAgent({
      storageRoot: path.join(tmp, 'runner'),
      policy: () => ({ slots, allowlist }),
      installSlug: () => welcomeInstall,
      log: (l) => logs.push(l),
      approveFolder: async (f) => `${f} is open in VS Code's Restricted Mode (not trusted)`,
    });
    await a.handle('tools.list', scope);
    await expect(a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } })).rejects.toThrow(
      /Restricted Mode/,
    );
  });
});

describe('RunnerAgent: the laptop tools an agent on central uses', () => {
  it('lists the tools over a proposal copy of the bound project, and edits land in the copy only', async () => {
    const repo = makeRepo();
    const a = agent();
    const listed = await a.handle('tools.list', scope);
    expect((listed.tools as Array<{ name: string }>).map((t) => t.name)).toContain('Edit');
    const read = await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } });
    expect(a.currentProposal()?.repoRoot).toBe(fs.realpathSync(repo));
    expect(read.text).toBe('     1\texport const x = 1;\n     2\t');
    const edit = await a.handle('tools.call', {
      ...scope,
      name: 'Edit',
      input: { file_path: 'app.ts', old_string: 'x = 1', new_string: 'x = 2' },
    });
    expect(edit).toEqual({ text: 'Edited app.ts (1 replacement)' });
    expect(fs.readFileSync(path.join(a.currentProposal()!.dir, 'app.ts'), 'utf8')).toBe('export const x = 2;\n');
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const x = 1;\n'); // the developer's tree is untouched
    // Secrets never reach the copy.
    expect((await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: '.env' } })).isError).toBe(true);
  });

  it('refuses while halted, for another install, when no project is bound, and anything but the tools', async () => {
    makeRepo();
    const a = agent();
    welcomeInstall = 'spike';
    await expect(a.handle('tools.call', { ...scope, installSlug: 'other', name: 'Read', input: {} })).rejects.toThrow(
      /welcome named spike/,
    );
    haltedBy = 'stop all agents';
    await expect(a.handle('tools.list', scope)).rejects.toThrow(/stopped all agents/);
    haltedBy = null;
    // What a container runner used to be asked: nothing here runs anything.
    for (const op of ['prepare', 'start', 'stop', 'bundle', 'logs'])
      await expect(a.handle(op, scope)).rejects.toThrow(/laptop tools only/);
    slots = {};
    await a.handle('tools.list', scope);
    await expect(a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } })).rejects.toThrow(
      /not bound on this machine/,
    );
    await expect(a.handle('tools.list', { ...scope, agentGroupId: '../x' })).rejects.toThrow(/bad agent group id/);
  });

  it("finds the agent's copy again after a window reload, before the agent next uses a tool", async () => {
    const repo = makeRepo();
    const a = agent();
    await a.handle('tools.list', scope);
    await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } });
    await a.handle('tools.call', {
      ...scope,
      name: 'Edit',
      input: { file_path: 'app.ts', old_string: 'x = 1', new_string: 'x = 2' },
    });
    const dir = a.currentProposal()!.dir;
    const found = await recoverLaptopToolsProposal(path.join(tmp, 'runner'), { slots, allowlist });
    expect(found?.dir).toBe(dir);
    expect(found?.repoRoot).toBe(fs.realpathSync(repo));
    // Another folder bound now: that copy is not this workspace's proposal.
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    expect(
      await recoverLaptopToolsProposal(path.join(tmp, 'runner'), { slots: { '/workspace/project': other }, allowlist }),
    ).toBeNull();
    expect(await recoverLaptopToolsProposal(path.join(tmp, 'runner'), { slots: {}, allowlist })).toBeNull();
  });

  it('serves a folder only once the developer allows it, asked with its real path', async () => {
    const repo = makeRepo();
    const asked: string[] = [];
    let allow = false;
    const a = new RunnerAgent({
      storageRoot: path.join(tmp, 'runner'),
      policy: () => ({ slots, allowlist }),
      log: () => {},
      approveFolder: async (folder) => {
        asked.push(folder);
        return allow;
      },
    });
    await a.handle('tools.list', scope);
    await expect(a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } })).rejects.toThrow(
      /has not allowed the agent to work on/,
    );
    expect(a.currentProposal()).toBeNull(); // nothing copied before the answer
    allow = true;
    await a.handle('tools.list', scope);
    await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } });
    // Asked at each start, and again by the call made while the folder was refused.
    expect(asked).toEqual([fs.realpathSync(repo), fs.realpathSync(repo), fs.realpathSync(repo)]);
    expect(a.currentProposal()?.repoRoot).toBe(fs.realpathSync(repo));
  });

  it('a copy refused at the start is taken again by the next tool call, without another tools.list', async () => {
    const repo = makeRepo();
    let answer: boolean | string = `${repo} is open in VS Code's Restricted Mode (not trusted)`;
    const a = new RunnerAgent({
      storageRoot: path.join(tmp, 'runner'),
      policy: () => ({ slots, allowlist }),
      log: (l) => logs.push(l),
      approveFolder: async () => answer,
    });
    await a.handle('tools.list', scope);
    await expect(a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } })).rejects.toThrow(
      /Restricted Mode/,
    );
    answer = true; // the developer trusts the folder
    const read = await a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } });
    expect(read.text).toContain('export const x = 1;');
    expect(a.currentProposal()?.repoRoot).toBe(fs.realpathSync(repo));
  });

  it('lists the tools without waiting for the copy; the first call waits for it', async () => {
    makeRepo();
    let release!: (v: boolean) => void;
    const a = new RunnerAgent({
      storageRoot: path.join(tmp, 'runner'),
      policy: () => ({ slots, allowlist }),
      log: () => {},
      approveFolder: () => new Promise<boolean>((r) => (release = r)),
    });
    const listed = await a.handle('tools.list', scope);
    expect((listed.tools as unknown[]).length).toBeGreaterThan(0);
    expect(a.currentProposal()).toBeNull();
    const read = a.handle('tools.call', { ...scope, name: 'Read', input: { file_path: 'app.ts' } });
    release(true);
    expect((await read).text).toContain('export const x = 1;');
  });

  it('keeps the proposal copies earlier versions made where they were', () => {
    expect(agent().proposalDir('ag-tools')).toBe(path.join(tmp, 'runner', 'proposals', 'ag-tools', 'laptop-tools'));
  });
});
