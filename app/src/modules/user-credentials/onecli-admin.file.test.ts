import fs from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// A CLI whose `secrets create` takes --file and whose `secrets update` does not
// (onecli 2.x). Every call is recorded with what any --file held at call time.
const cli = vi.hoisted(() => ({
  createTakesFile: true,
  updateTakesFile: false,
  calls: [] as Array<{ args: string[]; file?: string }>,
}));
vi.mock('child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, res?: { stdout: string }) => void) => {
      if (args.includes('--help')) {
        const flags = ['--name', '--value', '--host-pattern'];
        if ((args[1] === 'create' && cli.createTakesFile) || (args[1] === 'update' && cli.updateTakesFile))
          flags.push('--file');
        const help = { commands: [{ name: `secrets ${args[1]}`, args: flags.map((name) => ({ name })) }] };
        return cb(null, { stdout: JSON.stringify(help) });
      }
      const fi = args.indexOf('--file');
      cli.calls.push({ args: [...args], ...(fi >= 0 ? { file: fs.readFileSync(args[fi + 1]!, 'utf8') } : {}) });
      cb(null, { stdout: JSON.stringify({ data: { id: 'sec-new' } }) });
    },
  ),
}));

const { realOnecliAdmin, __allowOnecliForTest, __resetCliProbeForTest } = await import('./onecli-admin.js');
__allowOnecliForTest();

const SECRET = 'value-that-must-stay-out-of-argv';
const last = () => cli.calls.at(-1)!;

beforeEach(() => {
  cli.calls.length = 0;
  cli.createTakesFile = true;
  cli.updateTakesFile = false;
  __resetCliProbeForTest();
});

describe('secret values stay out of argv where the CLI allows', () => {
  it('creates go through a 0600 temp file, removed afterwards', async () => {
    await realOnecliAdmin.createGenericSecret('n', SECRET, { hostPattern: 'api.example.com', headerName: 'X-Key' });
    expect(last().args).not.toContain(SECRET);
    expect(last().args).not.toContain('--value');
    expect(last().file).toBe(SECRET);
    expect(last().args).toEqual(
      expect.arrayContaining(['--host-pattern', 'api.example.com', '--header-name', 'X-Key']),
    );
    const path = last().args[last().args.indexOf('--file') + 1]!;
    expect(fs.existsSync(path)).toBe(false);

    await realOnecliAdmin.createAnthropicSecret('a', SECRET);
    expect(last().args).not.toContain(SECRET);
    expect(last().file).toBe(SECRET);
    await realOnecliAdmin.createOpenAISecret('o', SECRET, 'api_key');
    expect(last().args).not.toContain(SECRET);
    expect(last().file).toBe(SECRET);
  });

  it('falls back to --value where the subcommand has no --file (an older CLI, or update)', async () => {
    await realOnecliAdmin.updateSecretValue('sec-1', SECRET);
    expect(last().args).toEqual(['secrets', 'update', '--id', 'sec-1', '--value', SECRET]);
    cli.createTakesFile = false;
    __resetCliProbeForTest();
    await realOnecliAdmin.createGenericSecret('n', SECRET, { hostPattern: 'h' });
    expect(last().args).toContain(SECRET);
  });

  it('updates use the file too once the CLI takes one', async () => {
    cli.updateTakesFile = true;
    await realOnecliAdmin.updateGenericSecret('sec-1', SECRET, { headerName: 'X-Key', valueFormat: '{value}' });
    expect(last().args).not.toContain(SECRET);
    expect(last().file).toBe(SECRET);
    expect(last().args).toEqual(expect.arrayContaining(['--id', 'sec-1', '--header-name', 'X-Key']));
  });

  it('keeps --value for a value the CLI would trim on the way in', async () => {
    await realOnecliAdmin.createGenericSecret('n', ' padded ', { hostPattern: 'h' });
    expect(last().args).toContain(' padded ');
  });
});
