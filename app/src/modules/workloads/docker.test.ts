import fs from 'fs';
import path from 'path';

import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

import { INSTALL_SLUG } from '../../config.js';
import {
  bridgeName,
  builtImageName,
  dockerEnv,
  escapeInterpolation,
  groupKey,
  isAgentContainerName,
  pinRef,
  plainSegments,
  projectName,
  workDir,
  writeFiles,
} from './docker.js';
import type { Workload } from './store.js';

const created: string[] = [];
afterAll(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('what Compose is given', () => {
  it('fills in nothing from the host environment', () => {
    expect(
      escapeInterpolation({
        environment: { X: '${WEBCHAT_OIDC_CLIENT_SECRET}', Y: 'a$b' },
        command: ['echo', '$HOME'],
        n: 3,
      }),
    ).toEqual({
      environment: { X: '$${WEBCHAT_OIDC_CLIENT_SECRET}', Y: 'a$$b' },
      command: ['echo', '$$HOME'],
      n: 3,
    });
  });

  it('runs with Docker’s settings only, and NanoClaw’s own empty Docker config', () => {
    expect(
      dockerEnv(
        {
          PATH: '/bin',
          HOME: '/h',
          DOCKER_HOST: 'unix:///x',
          DOCKER_CONFIG: '/h/.docker',
          DOCKER_CONTEXT: 'remote',
          WEBCHAT_OIDC_CLIENT_SECRET: 's',
          ONECLI_API_KEY: 'k',
        },
        '/data/workloads-docker',
      ),
    ).toEqual({ PATH: '/bin', HOME: '/h', DOCKER_HOST: 'unix:///x', DOCKER_CONFIG: '/data/workloads-docker' });
  });

  it('knows agent containers by NanoClaw’s name, not by label', () => {
    expect(isAgentContainerName(`ncl-${INSTALL_SLUG}-sess-1-abc`)).toBe(true);
    expect(isAgentContainerName(`nc-${INSTALL_SLUG}-7e083819-notes-web-1`)).toBe(false);
    expect(isAgentContainerName('ncl-otherinstall-sess-1')).toBe(INSTALL_SLUG === 'otherinstall');
  });

  it('names projects from a hash of the whole agent id, so ids sharing a tail never collide', () => {
    const a = projectName({ agentGroupId: 'ag-1111-abcdefgh', name: 'notes' });
    const b = projectName({ agentGroupId: 'ag-2222-abcdefgh', name: 'notes' });
    expect(a).not.toBe(b);
    expect(groupKey('ag-1111-abcdefgh')).toMatch(/^[a-f0-9]{12}$/);
    expect(a).toMatch(/^nc-[a-z0-9]+-[a-f0-9]{12}-notes$/);
    expect(builtImageName({ agentGroupId: 'ag-1', name: 'notes' }, 'api')).toMatch(/-notes-api:built$/);
  });

  it('names workload bridges so one host rule covers them, within Linux’s 15 characters', () => {
    expect(bridgeName(0)).toMatch(/^ncw[a-f0-9]{6}0$/);
    expect(bridgeName(510).length).toBeLessThanOrEqual(15);
    expect(bridgeName('p')).toMatch(/^ncw[a-f0-9]{6}p$/);
  });

  it('pins references and refuses odd path segments', () => {
    const d = `sha256:${'c'.repeat(64)}`;
    expect(pinRef('nginx:1.27', d)).toBe(`nginx:1.27@${d}`);
    expect(pinRef(`nginx:1.27@sha256:${'a'.repeat(64)}`, d)).toBe(`nginx:1.27@${d}`);
    expect(plainSegments('./api/src', 'x')).toEqual(['api', 'src']);
    expect(() => plainSegments('api/../..', 'x')).toThrow(/plain path/);
    expect(() => plainSegments('a b', 'x')).toThrow(/plain path/);
  });

  it('writes a stack that runs only the images NanoClaw names, with no build and escaped values', () => {
    const w = {
      id: `test-${process.pid}-${Date.now()}`,
      agentGroupId: 'ag-1',
      name: 'notes',
      addresses: { web: '198.18.0.10', api: '198.18.0.11' },
      stack: {
        compose: {
          services: {
            web: { image: 'nginx:1.27', environment: { A: '${SECRET}' }, restart: 'unless-stopped' },
            api: { build: { context: 'api' }, command: ['run', '$X'] },
          },
          volumes: { data: {} },
        },
        limits: {},
        total: { memoryMb: 1024, cpus: 1 },
      },
    } as unknown as Workload;
    created.push(workDir(w.id));
    const d = `sha256:${'d'.repeat(64)}`;
    const files = writeFiles(w, 'nc-wl-x-0', { web: `nginx:1.27@${d}`, api: 'nc-x-api:built' });
    const stack = parse(fs.readFileSync(files.stack, 'utf-8')) as {
      services: Record<string, Record<string, unknown>>;
      volumes: unknown;
    };
    expect(stack.services.web.image).toBe(`nginx:1.27@${d}`);
    expect(stack.services.web.environment).toEqual({ A: '$${SECRET}' });
    expect(stack.services.api.build).toBeUndefined();
    expect(stack.services.api.image).toBe('nc-x-api:built');
    expect(stack.services.api.command).toEqual(['run', '$$X']);
    expect(stack.volumes).toEqual({ data: {} });
    const override = parse(fs.readFileSync(files.override, 'utf-8')) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(override.services.api.cap_drop).toEqual(['ALL']);
    expect((fs.statSync(files.stack).mode & 0o777).toString(8)).toBe('600');
    expect(path.dirname(files.stack)).toBe(workDir(w.id));
    expect(() => writeFiles(w, 'n', { web: 'x' })).toThrow(/api: no image/);
  });

  it("writes a translated project's configs (escaped) and its aliases on the stack network", () => {
    const w = {
      id: `test-${process.pid}-${Date.now()}-cfg`,
      agentGroupId: 'ag-1',
      name: 'shop',
      addresses: { web: '198.18.0.10', db: '198.18.0.11' },
      stack: {
        compose: {
          services: {
            web: { image: 'nginx:1.27', configs: [{ source: 'config-site', target: '/etc/nginx/conf.d/site.conf' }] },
            db: { image: 'postgres:17', 'x-nanoclaw-aliases': ['shop-db'] },
          },
          configs: { 'config-site': { content: 'proxy_set_header Host $host;' } },
        },
        limits: {},
        total: { memoryMb: 1024, cpus: 1 },
      },
    } as unknown as Workload;
    created.push(workDir(w.id));
    const files = writeFiles(w, 'nc-wl-x-0', { web: 'nginx:1.27', db: 'postgres:17' });
    const stack = parse(fs.readFileSync(files.stack, 'utf-8')) as {
      services: Record<string, Record<string, unknown>>;
      configs: Record<string, { content: string }>;
    };
    // Compose would read `$host` as a variable: written as `$$host`, the file gets `$host`.
    expect(stack.configs).toEqual({ 'config-site': { content: 'proxy_set_header Host $$host;' } });
    expect(stack.services.web.configs).toEqual([{ source: 'config-site', target: '/etc/nginx/conf.d/site.conf' }]);
    expect(stack.services.db['x-nanoclaw-aliases']).toBeUndefined();
    const override = parse(fs.readFileSync(files.override, 'utf-8')) as {
      services: Record<string, { networks: { nanoclaw: Record<string, unknown> } }>;
    };
    expect(override.services.db.networks.nanoclaw).toEqual({ ipv4_address: '198.18.0.11', aliases: ['shop-db'] });
    expect(override.services.web.networks.nanoclaw).toEqual({ ipv4_address: '198.18.0.10' });
  });
});

describe('buildFailure', () => {
  it("names the failing step's own output and error, not the Dockerfile echo", async () => {
    const { buildFailure } = await import('./docker.js');
    const text = [
      '#5 [api 2/4] RUN npm ci',
      '#5 0.512 added 120 packages',
      '#5 DONE 3.1s',
      '#7 [web 3/6] RUN apt-get update && pecl install apcu',
      '#7 1.204 Get:1 http://deb.debian.org/debian bookworm InRelease',
      '#7 9.876 No releases available for package "pecl.php.net/apcu"',
      '#7 9.877 install failed',
      '#7 ERROR: process "/bin/sh -c apt-get update && pecl install apcu" did not complete successfully: exit code: 1',
      '------',
      ' > [web 3/6] RUN apt-get update && pecl install apcu:',
      'Dockerfile:12',
      '  12 | >>> RUN apt-get update && pecl install apcu',
      'failed to solve: process "/bin/sh -c apt-get update && pecl install apcu" did not complete successfully: exit code: 1',
    ].join('\n');
    expect(buildFailure(text)).toBe(
      [
        '#7 1.204 Get:1 http://deb.debian.org/debian bookworm InRelease',
        '#7 9.876 No releases available for package "pecl.php.net/apcu"',
        '#7 9.877 install failed',
        '#7 ERROR: process "/bin/sh -c apt-get update && pecl install apcu" did not complete successfully: exit code: 1',
        'failed to solve: process "/bin/sh -c apt-get update && pecl install apcu" did not complete successfully: exit code: 1',
      ].join('\n'),
    );
    expect(buildFailure('some other error')).toBeNull();
  });
});

describe('where a stopped build stood', () => {
  it('names the step still running and the slowest finished ones', async () => {
    const { buildProgress } = await import('./docker.js');
    const text = [
      '#5 [stage-0 2/16] RUN apt-get update',
      '#5 0.512 Get:1 http://deb.debian.org trixie InRelease',
      '#5 DONE 312.4s',
      '#6 [stage-0 3/16] COPY app/ /opt/app/',
      '#6 CACHED',
      '#7 [stage-0 4/16] RUN composer require x',
      '#7 DONE 95.0s',
      '#20 exporting to docker image format',
      '#20 exporting layers',
      '#20 CANCELED',
    ].join('\n');
    expect(buildProgress(text)).toBe(
      'Still running: exporting to docker image format\nSlowest steps: [stage-0 2/16] RUN apt-get update (5 min); [stage-0 4/16] RUN composer require x (2 min)',
    );
    expect(buildProgress('Image x Building')).toBeNull();
  });
});
