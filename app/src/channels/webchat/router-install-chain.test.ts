/**
 * The router rebuild, run for real: the add-litellm and add-routing installers
 * from this tree, in a scratch root, with docker and curl stubbed to record
 * what they are asked to do. Whichever path rebuilds the router — adding a
 * cloud model or a roster refresh — the container must come up with the
 * routing hook wired and mounted AND the OneCLI gateway settings, proxy auth
 * on, local hosts kept off the gateway, and a name on a network of its own
 * shared with OneCLI's container only: never OneCLI's own network (the
 * vault's database is there), never the egress filter's internal one.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/user-credentials/onecli-admin.js', async (orig) => ({
  ...(await orig<object>()),
  // Never the real vault: the chain re-scopes stored cloud keys first.
  realOnecliAdmin: { listAllSecrets: async () => [], updateSecretPathPattern: async () => {} },
}));

import { installStatus, startFeatureInstall } from './install-engine.js';
import { getRosterRefreshState, startRosterRefresh } from './ollama-manage.js';

const SKILLS = path.join(process.cwd(), '.claude/skills');
let root: string;
let log: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-chain-'));
  log = path.join(root, 'docker.log');
  for (const [skill, files] of [
    ['add-litellm', ['install-litellm.sh', 'gen-config.mjs']],
    ['add-routing', ['install-routing.sh', 'router_hook.py', 'routes.example.json']],
  ] as const) {
    const dir = path.join(root, '.claude/skills', skill, 'resources');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(SKILLS, skill, 'resources', f), path.join(dir, f));
  }
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // OneCLI sits on the egress filter's internal network and on its own routable one.
  fs.writeFileSync(
    path.join(bin, 'docker'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$1 $2 $3" in',
      '  "inspect onecli "*) echo "nanoclaw-egress onecli_onecli " ;;',
      '  "network inspect nanoclaw-egress") echo true ;;',
      '  "network inspect onecli_onecli") echo false ;;',
      '  "network inspect bridge") echo 172.17.0.1 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  vi.stubEnv('LITELLM_PORT', '4123');
  vi.stubEnv('LITELLM_CONTAINER', 'router-chain-test');

  // An install with routing on and one cloud model behind the gateway.
  const lit = path.join(root, 'data/litellm');
  fs.mkdirSync(path.join(lit, 'routing'), { recursive: true });
  fs.writeFileSync(path.join(lit, 'router_hook.py'), '# installed hook\n');
  fs.writeFileSync(
    path.join(lit, 'routing/routes.json'),
    JSON.stringify({ classifier: { url: 'http://192.0.2.50:11434/api/chat', model: 'arch' } }),
  );
  fs.writeFileSync(
    path.join(lit, 'backends.json'),
    JSON.stringify([{ model_name: 'command-a', model: 'openai/command-a', gateway: true, provider: 'cohere' }]),
  );
  fs.writeFileSync(path.join(lit, 'onecli.env'), 'HTTPS_PROXY=http://x:tok@host.docker.internal:10255\n', {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(lit, 'onecli-ca.pem'), 'CA\n');
  fs.writeFileSync(path.join(lit, 'config.yaml'), '# hosts: (none)\nmodel_list: []\nlitellm_settings:\n');
});

afterEach(() => {
  process.env.PATH = savedPath;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300 && !(await done()); i++) await new Promise((r) => setTimeout(r, 50));
}

/** The arguments of the last container start. */
const lastRun = (): string =>
  fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('run -d'))
    .at(-1) ?? '';

function expectFullRouter(): void {
  const run = lastRun();
  expect(run).toContain('--name router-chain-test');
  expect(run).toContain('127.0.0.1:4123:4000');
  // Routing: the hook is mounted and wired into the config.
  expect(run).toContain('/app/router_hook.py:ro');
  expect(run).toMatch(/routing:\/app\/routing/);
  expect(fs.readFileSync(path.join(root, 'data/litellm/config.yaml'), 'utf8')).toContain(
    'callbacks: router_hook.proxy_handler_instance',
  );
  // Gateway: proxy settings, CA trust, and local hosts kept off it.
  expect(run).toContain('--env-file data/litellm/onecli.env');
  expect(run).toContain('onecli-ca.pem:/etc/onecli/ca.pem:ro');
  expect(run).toMatch(/NO_PROXY=[^ ]*host\.docker\.internal/);
  expect(run).toMatch(/NO_PROXY=[^ ]*192\.0\.2\.50/);
  expect(run).toContain('--network router-chain-test-gateway');
  expect(run).not.toContain('onecli_onecli');
  expect(run).not.toContain('nanoclaw-egress');
  // OneCLI's container is attached to that network (again on every run: a recreate drops it).
  expect(fs.readFileSync(log, 'utf8')).toContain('network connect router-chain-test-gateway onecli');
  // Proxy auth: the master key reaches the container.
  expect(run).toContain('--env-file data/litellm/env');
  expect(fs.readFileSync(path.join(root, 'data/litellm/config.yaml'), 'utf8')).toMatch(/^\s*master_key:/m);
}

describe('router rebuild chain', () => {
  it('after a cloud model is added (the litellm install) the router keeps routing and the gateway', async () => {
    expect(await startFeatureInstall('litellm', root, { hosts: '' })).toEqual({ started: true });
    await until(async () => !(await installStatus('litellm', root)).running);
    const st = await installStatus('litellm', root);
    expect(st.lines.join('\n')).not.toContain('✗');
    expect(st.exitCode).toBe(0);
    expectFullRouter();
  });

  it('after a roster refresh the router keeps the gateway settings', async () => {
    expect(startRosterRefresh(root)).toBe(true);
    await until(() => !getRosterRefreshState(root).running);
    expect(getRosterRefreshState(root).exitCode).toBe(0);
    expectFullRouter();
  });

  it('with no gateway backend left, the router starts without the gateway and keyless', () => {
    // As removeCloudModel leaves it: no backend, no gateway settings.
    fs.writeFileSync(path.join(root, 'data/litellm/backends.json'), '[]\n');
    for (const f of ['onecli.env', 'onecli-ca.pem']) fs.rmSync(path.join(root, 'data/litellm', f));
    execFileSync('bash', [path.join(root, '.claude/skills/add-routing/resources/install-routing.sh')], {
      cwd: root,
      stdio: 'pipe',
    });
    const run = lastRun();
    expect(run).not.toContain('onecli');
    expect(run).not.toContain('NO_PROXY');
    expect(run).not.toContain('--network');
    // The router's gateway network goes with the last cloud model.
    expect(fs.readFileSync(log, 'utf8')).toMatch(/^network rm \S+-gateway$/m);
    expect(fs.existsSync(path.join(root, 'data/litellm/master.key'))).toBe(false);
  });
});
