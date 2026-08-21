/**
 * The install-wide default provider.
 *
 * The property worth pinning is the one that is easy to get wrong and expensive
 * to notice: writing the value must be a no-op when it already holds, because
 * the caller restarts the host on a change and nobody should be bounced for
 * finishing the wizard on the engine they were already using.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { defaultProviderChanges, readDefaultProvider } from './default-provider.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'default-provider-'));
const envFile = path.join(ROOT, '.env');

beforeEach(() => fs.rmSync(envFile, { force: true }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('readDefaultProvider', () => {
  it('falls back to claude when there is no .env at all', () => {
    expect(readDefaultProvider(ROOT)).toBe('claude');
  });

  it('falls back to claude when the key is absent', () => {
    fs.writeFileSync(envFile, 'WEBCHAT_PORT=3100\n');
    expect(readDefaultProvider(ROOT)).toBe('claude');
  });

  it('reads the configured value, normalised', () => {
    fs.writeFileSync(envFile, 'DEFAULT_AGENT_PROVIDER=Grok\n');
    expect(readDefaultProvider(ROOT)).toBe('grok');
  });

  it('is not confused by a key that merely ends with the same name', () => {
    // A prefix match would read this as the default and quietly mis-report.
    fs.writeFileSync(envFile, 'MY_DEFAULT_AGENT_PROVIDER=codex\n');
    expect(readDefaultProvider(ROOT)).toBe('claude');
  });

  it('treats an empty value as unset rather than as a provider named ""', () => {
    fs.writeFileSync(envFile, 'DEFAULT_AGENT_PROVIDER=\n');
    expect(readDefaultProvider(ROOT)).toBe('claude');
  });
});

describe('defaultProviderChanges', () => {
  it('reports no change when the value already holds — the caller restarts on true', () => {
    fs.writeFileSync(envFile, 'DEFAULT_AGENT_PROVIDER=grok\n');
    expect(defaultProviderChanges('grok', ROOT)).toBe(false);
  });

  it('reports no change for claude on a fresh install, where claude is implied', () => {
    expect(defaultProviderChanges('claude', ROOT)).toBe(false);
  });

  it('reports a change when moving to a new provider', () => {
    expect(defaultProviderChanges('grok', ROOT)).toBe(true);
  });

  it('reports a change when moving BACK to claude — the way out must work', () => {
    fs.writeFileSync(envFile, 'DEFAULT_AGENT_PROVIDER=grok\n');
    expect(defaultProviderChanges('claude', ROOT)).toBe(true);
  });
});
