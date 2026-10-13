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
  // The CLI path: no local gateway URL, so updates are not sent to its API.
  delete process.env.ONECLI_URL;
  delete process.env.ONECLI_API_KEY;
  vi.unstubAllGlobals();
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

describe('an update to a local gateway goes to its API, not argv', () => {
  const sent: Array<{ url: string; method?: string; body: unknown }> = [];
  const respond = (fn: () => Promise<Response> | Response) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, method: init?.method, body: JSON.parse(String(init?.body ?? 'null')) });
        return fn();
      }),
    );
  const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });

  beforeEach(() => {
    sent.length = 0;
    process.env.ONECLI_URL = 'http://127.0.0.1:10254';
  });

  it('sends the value in a PATCH body to the loopback API and never runs the CLI', async () => {
    respond(ok);
    await realOnecliAdmin.updateSecretValue('sec-1', SECRET);
    expect(sent).toEqual([
      { url: 'http://127.0.0.1:10254/api/secrets/sec-1', method: 'PATCH', body: { value: SECRET } },
    ]);
    expect(cli.calls).toEqual([]);
  });

  it('carries the header settings as the injection config', async () => {
    respond(ok);
    await realOnecliAdmin.updateGenericSecret('sec-2', SECRET, { headerName: 'X-Key', valueFormat: 'Bearer {value}' });
    expect(sent[0]!.body).toEqual({
      value: SECRET,
      injectionConfig: { headerName: 'X-Key', valueFormat: 'Bearer {value}' },
    });
    expect(cli.calls).toEqual([]);
  });

  it('falls back to the CLI when the API refuses or cannot be reached', async () => {
    respond(() => new Response('{}', { status: 500 }));
    await realOnecliAdmin.updateSecretValue('sec-3', SECRET);
    expect(last().args).toEqual(['secrets', 'update', '--id', 'sec-3', '--value', SECRET]);
    respond(() => Promise.reject(new Error('ECONNREFUSED')));
    await realOnecliAdmin.updateSecretValue('sec-4', SECRET);
    expect(last().args).toContain('sec-4');
    respond(() => new Response(JSON.stringify({ success: false }), { status: 200 }));
    await realOnecliAdmin.updateSecretValue('sec-5', SECRET);
    expect(last().args).toContain('sec-5');
  });

  it('keeps the CLI for a keyed or remote gateway', async () => {
    respond(ok);
    process.env.ONECLI_API_KEY = 'k';
    await realOnecliAdmin.updateSecretValue('sec-6', SECRET);
    delete process.env.ONECLI_API_KEY;
    process.env.ONECLI_URL = 'https://vault.example.com';
    await realOnecliAdmin.updateSecretValue('sec-7', SECRET);
    expect(sent).toEqual([]);
    expect(cli.calls.map((c) => c.args[3])).toEqual(['sec-6', 'sec-7']);
  });
});
