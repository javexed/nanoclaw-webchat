/**
 * A project's own docker-compose.yml: what is safe is translated (and said),
 * what is not is left for policy.ts to refuse, and nothing is read from
 * outside the workspace.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { checkStack } from './policy.js';
import { ALIASES_KEY, interpolate, parseEnvFile, translateCompose } from './translate.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-translate-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-outside-'));
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const QUOTA = { memoryMb: 8192, cpus: 4 };

describe('env files and ${VAR}', () => {
  it('reads KEY=value lines as Compose does', () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x # y\'\nD=3 # note\n\nbad line')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x # y',
      D: '3',
    });
  });

  it('fills ${VAR} forms; $$ is a dollar', () => {
    const unset = new Set<string>();
    const errors: string[] = [];
    const env = { A: 'a', E: '' };
    expect(interpolate('${A} $A ${B:-def} ${E:-def} ${E-def} ${A:+on} $$x ${Z}', env, unset, errors)).toBe(
      'a a def def  on $x ',
    );
    expect([...unset]).toEqual(['Z']);
    interpolate('${Q:?needed}', env, unset, errors);
    expect(errors[0]).toMatch(/^Q must be set: needed/);
  });
});

describe('translateCompose', () => {
  it('translates a typical project file into one policy.ts accepts, and says what changed', () => {
    write('proj/.env', 'TAG=16\nDB_PASS=s3cret\n');
    write('proj/app.env', 'MODE=prod\nDB_PASS=fromfile\n');
    write('proj/web/Dockerfile', 'FROM nginx\n');
    write('proj/shared/base.txt', 'x');
    write('proj/conf/app.conf', 'listen 80;');
    write(
      'proj/docker-compose.yml',
      `
name: shop
networks: { backend: {} }
volumes:
  pgdata: { name: shop_pgdata, external: true }
configs:
  appconf: { file: ./conf/app.conf }
services:
  db:
    image: postgres:\${TAG}
    container_name: shop-db
    environment: { POSTGRES_PASSWORD: "\${DB_PASS}" }
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: { backend: { aliases: [database] } }
  web:
    build:
      context: ./web
    env_file: [app.env]
    environment: { DB_PASS: explicit }
    ports: ["8080:80", "127.0.0.1:8443:443/tcp"]
    links: ["db:pg"]
    configs: [{ source: appconf, target: /etc/nginx/conf.d/app.conf }]
    depends_on: [db]
  debug:
    image: busybox
    profiles: [debug]
`,
    );
    const text = fs.readFileSync(path.join(root, 'proj/docker-compose.yml'), 'utf8');
    const t = translateCompose(text, root, path.join(root, 'proj'));
    expect(t.errors).toEqual([]);
    const doc = parse(t.text);
    expect(doc.networks).toBeUndefined();
    expect(doc.volumes.pgdata).toEqual({});
    expect(doc.services.debug).toBeUndefined();
    expect(doc.services.db.image).toBe('postgres:16');
    expect(doc.services.db.environment).toEqual({ POSTGRES_PASSWORD: 's3cret' });
    expect(doc.services.db[ALIASES_KEY].sort()).toEqual(['database', 'pg', 'shop-db']);
    expect(doc.services.web.environment).toEqual({ MODE: 'prod', DB_PASS: 'explicit' });
    expect(doc.services.web.expose).toEqual(['80', '443']);
    expect(doc.services.web.build).toEqual({ context: 'proj/web' });
    expect(doc.configs).toEqual({ 'config-appconf': { content: 'listen 80;' } });
    expect(doc.services.web.configs).toEqual([{ source: 'config-appconf', target: '/etc/nginx/conf.d/app.conf' }]);
    expect(t.notes.join('\n')).toMatch(/ports → expose 80, 443/);
    expect(t.notes.join('\n')).toMatch(/debug: left out/);
    // The translated file passes the rules, which still see workspace-relative paths.
    const c = checkStack(t.text, root, QUOTA, { composeDir: root, allowBuild: true });
    expect(c.ok ? [] : c.errors).toEqual([]);
  });

  it('merges include and extends from workspace files, paths kept right', () => {
    write(
      'inc/common/base.yml',
      'services:\n  worker:\n    build: ./w\n    environment: { A: "1", B: "1" }\n    depends_on: [x]\n',
    );
    write('inc/common/w/Dockerfile', 'FROM busybox\n');
    write('inc/extra.yml', 'services:\n  cache:\n    image: redis:7\n');
    write(
      'inc/compose.yml',
      'include: [extra.yml]\nservices:\n  worker:\n    extends: { file: common/base.yml, service: worker }\n    environment: { B: "2" }\n',
    );
    const t = translateCompose(
      fs.readFileSync(path.join(root, 'inc/compose.yml'), 'utf8'),
      root,
      path.join(root, 'inc'),
    );
    expect(t.errors).toEqual([]);
    const doc = parse(t.text);
    expect(doc.services.cache.image).toBe('redis:7');
    expect(doc.services.worker).toEqual({ build: 'inc/common/w', environment: { A: '1', B: '2' } });
  });

  it('reads nothing from outside the workspace, and leaves unsafe settings to the rules', () => {
    fs.writeFileSync(path.join(outside, 'leak.env'), 'X=1\n');
    const rel = path.relative(path.join(root, 'proj'), path.join(outside, 'leak.env'));
    const t = translateCompose(
      `services:\n  a:\n    image: busybox\n    env_file: ["${rel}"]\n`,
      root,
      path.join(root, 'proj'),
    );
    expect(t.errors.join('\n')).toMatch(/outside your workspace/);

    const unsafe = translateCompose(
      'services:\n  a:\n    image: busybox\n    privileged: true\n    volumes: ["/etc:/host"]\n',
      root,
      path.join(root, 'proj'),
    );
    expect(unsafe.errors).toEqual([]);
    const c = checkStack(unsafe.text, root, QUOTA, { composeDir: root, allowBuild: true });
    expect(c.ok ? [] : c.errors.join('\n')).toMatch(/privileged/);
  });

  it('refuses secrets: their content would be stored with the stack', () => {
    write('proj/key.txt', 'not-for-the-database');
    const t = translateCompose(
      'secrets:\n  k: { file: ./key.txt }\nservices:\n  a:\n    image: busybox\n    secrets: [k]\n',
      root,
      path.join(root, 'proj'),
    );
    expect(t.errors.join('\n')).toMatch(/a: secrets are not supported here/);
    expect(t.text).not.toContain('not-for-the-database');
  });

  it('an optional env_file outside the workspace is refused whether or not it exists', () => {
    const missing = translateCompose(
      'services:\n  a:\n    image: busybox\n    env_file: [{ path: ../../no-such-file.env, required: false }]\n',
      root,
      path.join(root, 'proj'),
    );
    expect(missing.errors.join('\n')).toMatch(/outside your workspace/);
    expect(missing.errors.join('\n')).not.toMatch(/does not exist/);
    const inside = translateCompose(
      'services:\n  a:\n    image: busybox\n    env_file: [{ path: ./none.env, required: false }]\n',
      root,
      path.join(root, 'proj'),
    );
    expect(inside.errors).toEqual([]);
  });
});
