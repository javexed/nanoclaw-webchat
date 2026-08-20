import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { looksAuthGated } from './mcp-probe.js';

describe('looksAuthGated — probe failures that mean "send a token"', () => {
  it('matches the SSE transport 401 shape', async () => {
    expect(looksAuthGated('SSE error: Non-200 status code (401)')).toBe(true);
  });
  it('matches the Streamable HTTP body-text shape', async () => {
    expect(
      looksAuthGated(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header. Expected: Bearer <token>"}',
      ),
    ).toBe(true);
  });
  it('matches Unauthorized / unauthorised wording', async () => {
    expect(looksAuthGated('HTTP 403: Unauthorized')).toBe(true);
    expect(looksAuthGated('request unauthorised')).toBe(true);
  });
  it('does not fire on ordinary connectivity failures', async () => {
    expect(looksAuthGated('Timed out after 8s')).toBe(false);
    expect(looksAuthGated('fetch failed: ECONNREFUSED 100.96.20.118:8000')).toBe(false);
    expect(looksAuthGated('Non-200 status code (404)')).toBe(false);
  });
  it('does not fire on incidental digit runs containing 401', async () => {
    expect(looksAuthGated('connect EHOSTUNREACH 10.4.0.14019')).toBe(false);
  });
});

/**
 * install.sh strips `hono` + `@hono/node-server` from the MCP SDK's manifest:
 * we import client entry points only, so the Hono server stack is ~4MB of code
 * that never loads while still carrying its own advisories.
 *
 * That strip is safe exactly as long as the assumption below holds. A
 * server-side import would resolve fine in a dev tree — where nothing stripped
 * anything — and then fail at runtime on a real install. This test moves that
 * failure into CI instead.
 *
 * If an MCP server entry point is ever genuinely needed, drop the strip block
 * in install.sh rather than relaxing this test.
 */
describe('MCP SDK import surface', () => {
  const SDK = '@modelcontextprotocol/sdk';
  // The HOST source root only. container/agent-runner/ is a separate Bun tree
  // with its own package.json + bun.lock, installed by bun rather than pnpm --
  // it legitimately uses server/index.js + server/stdio.js for the agent's MCP
  // tool server, and the host's .pnpmfile.cjs does not reach it.
  const root = join(import.meta.dirname, '../..');

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (entry.endsWith('.ts')) acc.push(full);
    }
    return acc;
  }

  const files = sourceFiles(root);

  it('scanned a plausible number of source files', async () => {
    // Without this, a broken walk would make the check below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
  });

  it('imports only client entry points, never server ones', async () => {
    const specifier = new RegExp(`['"]${SDK.replace(/\//g, '\\/')}\\/([^'"]+)['"]`, 'g');
    const offenders: string[] = [];

    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(specifier)) {
        const subpath = match[1];
        // `types.js` is shared schema/type material with no server deps of its
        // own; only the server/* entry points pull the Hono stack.
        if (subpath.startsWith('server/')) {
          offenders.push(`${file.slice(root.length + 1)} → ${SDK}/${subpath}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
